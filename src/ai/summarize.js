/**
 * DeepLore — Dedicated summary feature (#15).
 *
 * `/dle-summarize-range start-end | N` runs an AI summary of the named chat range,
 * hides the originals via ST's is_system flag, and inserts the summary as a new
 * message at the start of the range. Each operation is recorded in
 * chat_metadata.deeplore_summary_log so `/dle-summarize-rollback` can undo by id
 * or all-at-once.
 *
 * Hidden originals stay in chat[] so ST's reload + AI-context skip both honor
 * them — same mechanic as the built-in /hide command. Rollback flips is_system
 * back to its pre-summary value and removes the summary message.
 */

import { chat, chat_metadata, saveChatConditional, reloadCurrentChat, saveMetadata, generateQuietPrompt, eventSource, event_types } from '../../../../../../script.js';
import { saveMetadataDebounced } from '../../../../../extensions.js';
import { getSettings, resolveConnectionConfig } from '../../settings.js';
import { tryAcquireHalfOpenProbe, recordAiSuccess, recordAiFailure, releaseHalfOpenProbe } from '../state.js';
import { callAI, isExcludedFromBreaker } from './ai.js';
import { classifyError } from '../../core/utils.js';
import { parseRange, buildSummaryUserMessage, applyHideAndPrepend, rollbackById, rangeOverlapsSummary } from './summarize-pure.js';
import { resolvePromptOrOverride } from '../prompts/prompt-store.js';

export { parseRange, buildSummaryUserMessage };

// Default summarize prompt moved to src/i18n/prompts/en.js as SUMMARIZE_PROMPT
// and resolved at call time via getPrompt('SUMMARIZE_PROMPT').

/**
 * Generate a short id for the summary record. Not cryptographic — just unique
 * enough that two summaries in the same chat won't collide.
 */
function makeSummaryId() {
    return 'sum_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Module-level in-flight guard. Two concurrent summarizeRange calls (slash +
 * UI button, or two rapid invocations) would interleave chat.splice() and
 * corrupt each other's records. Audit H1.
 */
let _summarizing = false;

/**
 * Run the summary AI call against the resolved scribe connection (reuses the
 * user's already-configured connection; no separate dedicated profile yet).
 *
 * @param {string} userMessage
 * @returns {Promise<string>}
 */
async function callSummaryAI(userMessage, signal) {
    const settings = getSettings();
    const conn = resolveConnectionConfig('scribe');
    const systemPrompt = resolvePromptOrOverride('SUMMARIZE_PROMPT', settings.summarySystemPrompt);
    const mode = conn.mode;
    const maxTokens = settings.summaryMaxTokens || 400;
    const timeout = settings.summaryTimeout || 30000;

    // v2.5 dead-head: refuse legacy proxy mode explicitly (mirrors callScribe) so it
    // doesn't fall through to the 'st' path and silently use ST's active connection.
    if (mode === 'proxy') {
        throw new Error('Custom Proxy mode was removed in v2.5. Pick a Connection Profile in DLE Settings → Setup → AI Connections.');
    }

    // Wave-B contract: summarize was bypassing the breaker entirely. Match the
    // scribe/auto-suggest pattern — gate via tryAcquireHalfOpenProbe (the mutation
    // gate, not isAiCircuitOpen) and route the trip decision through the shared
    // isExcludedFromBreaker classifier so 401/403/429 don't count as failures.
    if (!tryAcquireHalfOpenProbe()) throw new Error('AI circuit breaker is open — skipping summarize');
    try {
        let text;
        // 'direct' routes through callAI exactly like 'profile' — without this
        // it would fall into the 'st' generateQuietPrompt branch below and use
        // ST's active connection instead of the configured endpoint.
        if (mode === 'profile' || mode === 'direct') {
            const result = await callAI(systemPrompt, userMessage, {
                ...conn,
                caller: 'summarize',
                maxTokens,
                timeout,
                signal,
            });
            text = (result.text || '').trim();
        } else {
            // H-2: summarize reuses the Scribe connection config, which can resolve to
            // 'st' (ST's active connection) — directly or via 'inherit'. callAI's mode
            // whitelist only accepts 'profile', so routing 'st' through it threw
            // "unknown connection mode"; that error isn't breaker-excluded, so two
            // /dle-summarize-range calls tripped the circuit breaker and locked ALL AI
            // features for ~30s. Dispatch 'st' via generateQuietPrompt, exactly like
            // callScribe. generateQuietPrompt can't be aborted, so race the passed
            // signal, GENERATION_STOPPED, and a timeout to release the in-flight guard.
            const quietPrompt = `${systemPrompt}\n\n${userMessage}`;
            const quietPromise = generateQuietPrompt({ quietPrompt, skipWIAN: true, responseLength: maxTokens });
            let summaryTimer;
            let onStop = null;
            let onAbort = null;
            try {
                const result = await Promise.race([
                    quietPromise.finally(() => clearTimeout(summaryTimer)),
                    new Promise((_, reject) => { summaryTimer = setTimeout(() => {
                        const err = new Error(`Summarize quiet prompt timed out (${Math.round(timeout / 1000)}s)`);
                        err.timedOut = true;
                        reject(err);
                    }, timeout); }),
                    new Promise((_, reject) => {
                        onStop = () => {
                            const err = new Error('Summarize aborted by user (GENERATION_STOPPED)');
                            err.name = 'AbortError';
                            err.userAborted = true;
                            reject(err);
                        };
                        try { eventSource.on(event_types.GENERATION_STOPPED, onStop); }
                        catch { onStop = null; }
                    }),
                    new Promise((_, reject) => {
                        if (!signal) return;
                        onAbort = () => {
                            const err = new Error('Summarize aborted');
                            err.name = 'AbortError';
                            err.userAborted = true;
                            reject(err);
                        };
                        if (signal.aborted) onAbort();
                        else signal.addEventListener('abort', onAbort, { once: true });
                    }),
                ]);
                text = (result || '').trim();
            } finally {
                clearTimeout(summaryTimer);
                if (onStop) { try { eventSource.removeListener(event_types.GENERATION_STOPPED, onStop); } catch { /* noop */ } }
                if (onAbort && signal) { try { signal.removeEventListener('abort', onAbort); } catch { /* noop */ } }
            }
        }
        recordAiSuccess();
        return text;
    } catch (err) {
        if (!isExcludedFromBreaker(err)) recordAiFailure(); else releaseHalfOpenProbe(); // #11: free dangling half-open probe
        throw err;
    }
}

/**
 * Summarize a chat range and apply the hide+prepend mutation.
 *
 * @param {{start: number, end: number}} range
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok: boolean, summaryId?: string, summary?: string, error?: string, hiddenCount?: number}>}
 */
export async function summarizeRange(range, signal) {
    if (_summarizing) {
        return { ok: false, error: 'A summary is already in progress — wait for it to finish before starting another.' };
    }
    if (!range || typeof range.start !== 'number' || typeof range.end !== 'number') {
        return { ok: false, error: 'Invalid range' };
    }
    if (!Array.isArray(chat)) return { ok: false, error: 'No chat loaded' };
    if (range.start < 0 || range.end >= chat.length || range.start > range.end) {
        return { ok: false, error: `Range out of bounds (chat length ${chat.length})` };
    }
    // M-10: reject a range overlapping an existing un-rolled-back summary. Overlap
    // corrupts the per-message rollback markers and would hide the shared messages
    // permanently. Overlapping summaries have no coherent semantics anyway.
    if (rangeOverlapsSummary(chat, range)) {
        return { ok: false, error: 'That range overlaps an existing summary — roll it back first (/dle-summarize-rollback) before re-summarizing these messages.' };
    }

    const userMessage = buildSummaryUserMessage(chat, range.start, range.end);
    if (!userMessage.trim()) {
        return { ok: false, error: 'Selected range has no visible messages to summarize' };
    }

    _summarizing = true;
    try {
        if (signal?.aborted) return { ok: false, error: 'Aborted before AI call' };

        let summaryText;
        try {
            summaryText = await callSummaryAI(userMessage, signal);
        } catch (err) {
            return { ok: false, error: `AI call failed: ${classifyError(err)}` };
        }
        // Audit H2: AI may resolve after user aborted. Don't mutate chat in that case.
        if (signal?.aborted) return { ok: false, error: 'Aborted after AI call' };
        if (!summaryText) {
            return { ok: false, error: 'AI returned empty summary' };
        }
        // Chat could have changed underneath us (CHAT_CHANGED) — re-check bounds.
        if (!Array.isArray(chat) || range.end >= chat.length) {
            return { ok: false, error: 'Chat changed during summary; aborting to avoid corruption.' };
        }

        const summaryId = makeSummaryId();
        // Audit F1+M3+M6 fix: applyHideAndPrepend writes the prior is_system value to
        // each hidden message's `.extra.dle_original_is_system`. Pure helper, tested
        // separately in test/unit.mjs.
        const { hiddenCount } = applyHideAndPrepend(chat, range, summaryId, summaryText);

        // Persist record for rollback — only the metadata needed to FIND the messages,
        // not their pre-summary state (that's on the messages themselves now).
        if (!Array.isArray(chat_metadata.deeplore_summary_log)) chat_metadata.deeplore_summary_log = [];
        chat_metadata.deeplore_summary_log.push({
            id: summaryId,
            createdAt: Date.now(),
            summaryIndex: range.start,
            hiddenCount,
        });
        // Audit H3: reloadCurrentChat re-reads from disk; debounced metadata save may not
        // have flushed yet. Try sync save first; fall back to debounced on failure.
        try { saveMetadata(); } catch { saveMetadataDebounced(); }
        await saveChatConditional();

        // Force UI redraw — splice doesn't trigger ST's incremental render.
        await reloadCurrentChat();

        return { ok: true, summaryId, summary: summaryText, hiddenCount };
    } finally {
        _summarizing = false;
    }
}

/**
 * Roll back one summary (by id) or all summaries in the current chat. Removes
 * the inserted summary message and restores each hidden original's pre-summary
 * is_system value.
 *
 * @param {string} [summaryId] - if omitted or 'all', rolls back every summary.
 * @returns {Promise<{ok: boolean, restored: number, removed: number, error?: string}>}
 */
export async function rollbackSummary(summaryId) {
    if (!Array.isArray(chat_metadata.deeplore_summary_log) || chat_metadata.deeplore_summary_log.length === 0) {
        return { ok: false, restored: 0, removed: 0, error: 'No summaries to roll back' };
    }
    const targets = (!summaryId || summaryId === 'all')
        ? [...chat_metadata.deeplore_summary_log]
        : chat_metadata.deeplore_summary_log.filter(r => r.id === summaryId);
    if (targets.length === 0) {
        return { ok: false, restored: 0, removed: 0, error: `Summary id "${summaryId}" not found` };
    }

    let restored = 0;
    let removed = 0;
    // Newest-first: even single-id rollback walks newer summaries' index spaces first
    // so removals never drift older summaries' message lookups. With the on-message
    // is_system storage (audit F1+M3 fix), index math no longer matters for the restore
    // step itself — but reverse order still keeps `chat.findIndex` deterministic.
    targets.sort((a, b) => b.createdAt - a.createdAt);
    for (const record of targets) {
        // Audit F1+M3 fix: rollbackById restores is_system from each message's own
        // .extra.dle_original_is_system — no index math, no cross-record coupling.
        const { restored: r, removed: x } = rollbackById(chat, record.id);
        restored += r;
        removed += x;
        // Drop the record from the log.
        chat_metadata.deeplore_summary_log = chat_metadata.deeplore_summary_log.filter(r => r.id !== record.id);
    }

    // Audit H3: same sync-save pattern as summarizeRange — reloadCurrentChat re-reads
    // from disk and could lose the log update if only debounced.
    try { saveMetadata(); } catch { saveMetadataDebounced(); }
    await saveChatConditional();
    await reloadCurrentChat();

    return { ok: true, restored, removed };
}

/**
 * List recorded summaries in this chat (for picker / status display).
 * @returns {Array<{id: string, createdAt: number, summaryIndex: number, hiddenCount: number}>}
 */
export function listSummaries() {
    if (!Array.isArray(chat_metadata.deeplore_summary_log)) return [];
    return chat_metadata.deeplore_summary_log.map(r => ({
        id: r.id,
        createdAt: r.createdAt,
        summaryIndex: r.summaryIndex,
        // New shape uses hiddenCount; older legacy records had hiddenIndices array.
        hiddenCount: typeof r.hiddenCount === 'number'
            ? r.hiddenCount
            : (Array.isArray(r.hiddenIndices) ? r.hiddenIndices.length : 0),
    }));
}
