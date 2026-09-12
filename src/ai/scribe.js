/**
 * DeepLore — Session Scribe
 */
import {
    generateQuietPrompt,
    chat,
    chat_metadata,
    name2,
    eventSource,
    event_types,
} from '../../../../../../script.js';
import { getContext, saveMetadataDebounced } from '../../../../../extensions.js';
import { getSettings, resolveConnectionConfig, resolveWriteVault } from '../../settings.js';
import { writeNote } from '../vault/obsidian-api.js';
import { buildIndex } from '../vault/vault.js';
import { buildAiChatContext } from '../../core/utils.js';
import { callAI, isExcludedFromBreaker } from './ai.js';
import { stripObsidianSyntax } from '../helpers.js';
import {
    scribeInProgress, lastScribeSummary, chatEpoch,
    setScribeInProgress, setLastScribeSummary, setLastScribeChatLength,
    tryAcquireHalfOpenProbe, recordAiSuccess, recordAiFailure, releaseHalfOpenProbe,
} from '../state.js';
import { dedupError, dedupWarning } from '../toast-dedup.js';
import { pushEvent } from '../diagnostics/interceptors.js';
import { resolvePromptOrOverride } from '../prompts/prompt-store.js';
import { trf } from '../i18n/i18n.js';

// Scribe default prompt moved to src/i18n/prompts/en.js as SCRIBE_PROMPT
// and resolved at call time via getPrompt('SCRIBE_PROMPT'). See the
// editable-prompts feature (v2.5) for the new contract.

/**
 * Route a Scribe AI call by configured connection mode.
 * @returns {Promise<string>} Generated summary text.
 */
export async function callScribe(systemPrompt, userMessage, _settings) {
    const resolved = resolveConnectionConfig('scribe');
    const mode = resolved.mode;

    // 'direct' rides the same callAI path as 'profile' — callAI owns the mode
    // dispatch. Listing it here is load-bearing: without it, direct mode falls
    // through to the 'st' branch below and silently uses ST's active connection
    // instead of the endpoint the user configured.
    if (mode === 'profile' || mode === 'direct') {
        // v2.5 dead-head: 'proxy' removed from the dispatch whitelist. callAI's
        // proxy branch throws a migration error if a legacy 'proxy' value reaches it.
        // S4-1: mutation gate — tryAcquireHalfOpenProbe, not isAiCircuitOpen
        // (returns false in half-open-no-probe → would leak the probe slot).
        if (!tryAcquireHalfOpenProbe()) throw new Error('AI circuit breaker is open — skipping scribe');
        try {
            const result = await callAI(systemPrompt, userMessage, { ...resolved, caller: 'scribe' });
            recordAiSuccess();
            return result.text || '';
        } catch (err) {
            // BUG-252 + Wave-B contract: shared classifier covers throttled / userAborted /
            // timedOut PLUS HTTP 401/403 (auth) and 429 (rate-limit). Bad API key isn't a
            // service-down signal; without this, the second scribe call after a typo'd key
            // tripped the breaker and locked every AI feature for 30s.
            if (!isExcludedFromBreaker(err)) recordAiFailure(); else releaseHalfOpenProbe(); // #11: free dangling half-open probe
            throw err;
        }
    }

    // v2.5 dead-head: refuse legacy proxy mode explicitly so it doesn't silently
    // fall through to ST's active-connection 'st' path below (which would mask
    // the misconfiguration and use whatever connection ST happens to have).
    if (mode === 'proxy') {
        throw new Error('Custom Proxy mode was removed in v2.5. Pick a Connection Profile in DLE Settings → Setup → AI Connections.');
    }

    // 'st' mode — ST's active connection via generateQuietPrompt.
    // BUG-116: breaker integration to match profile/proxy. S4-1 mutation gate (above).
    if (!tryAcquireHalfOpenProbe()) throw new Error('AI circuit breaker is open — skipping scribe');
    // generateQuietPrompt can't be aborted — the background gen will complete regardless,
    // but BUG-241 wires GENERATION_STOPPED so our await resolves early and the
    // scribeInProgress lock releases promptly instead of waiting the full timeout.
    const quietPrompt = `${systemPrompt}\n\n${userMessage}`;
    // timeout=0 means "no timeout" — setTimeout(fn, 0) would fire immediately.
    const timeout = resolved.timeout || 60000;
    const quietPromise = generateQuietPrompt({ quietPrompt, skipWIAN: true, responseLength: resolved.maxTokens });
    let scribeTimer;
    let onStop;
    try {
        const result = await Promise.race([
            quietPromise.finally(() => clearTimeout(scribeTimer)),
            new Promise((_, reject) => { scribeTimer = setTimeout(() => {
                console.warn('[DLE] Scribe quiet prompt timed out — orphaned generation may still complete in background');
                const err = new Error(`Scribe quiet prompt timed out (${Math.round(timeout / 1000)}s)`);
                err.timedOut = true;
                reject(err);
            }, timeout); }),
            new Promise((_, reject) => {
                onStop = () => {
                    const err = new Error('Scribe aborted by user (GENERATION_STOPPED)');
                    err.name = 'AbortError';
                    err.userAborted = true;
                    reject(err);
                };
                // BUG-AUDIT: null onStop on registration failure so finally doesn't
                // remove a listener that was never added.
                try {
                    eventSource.on(event_types.GENERATION_STOPPED, onStop);
                } catch (regErr) {
                    console.warn('[DLE] Scribe stop-listener registration failed:', regErr?.message);
                    onStop = null;
                }
            }),
        ]);
        // BUG-116: breaker integration to match profile/proxy.
        recordAiSuccess();
        return result;
    } catch (err) {
        // BUG-116/BUG-252 + Wave-B contract: shared classifier — see note above.
        if (!isExcludedFromBreaker(err)) recordAiFailure(); else releaseHalfOpenProbe(); // #11: free dangling half-open probe
        throw err;
    } finally {
        if (onStop) { try { eventSource.removeListener(event_types.GENERATION_STOPPED, onStop); } catch { /* noop */ } }
    }
}

/** Summarize recent chat and write to Obsidian. */
export async function runScribe(customPrompt) {
    if (scribeInProgress) return;
    setScribeInProgress(true);
    pushEvent('scribe', { action: 'start' });

    const epoch = chatEpoch;

    try {
        const settings = getSettings();
        if (!chat || chat.length === 0) {
            dedupWarning('No active chat to summarize.', 'scribe_no_chat');
            return;
        }

        const context = buildAiChatContext(chat, settings.scribeScanDepth);
        if (!context.trim()) {
            dedupWarning('No messages to summarize.', 'scribe_no_messages');
            return;
        }

        const systemPrompt = resolvePromptOrOverride('SCRIBE_PROMPT', settings.scribePrompt);

        const parts = [];
        if (lastScribeSummary) {
            parts.push(`[PREVIOUS SESSION NOTE]\n${lastScribeSummary}`);
        }
        parts.push(`[RECENT CONVERSATION]\n${context}`);
        if (customPrompt) {
            parts.push(`[ADDITIONAL FOCUS]\n${customPrompt}`);
        }
        const userMessage = parts.join('\n\n');

        const summary = await callScribe(systemPrompt, userMessage, settings);

        if (!summary || !summary.trim()) {
            dedupWarning('Session Scribe couldn\'t finish — your chat is unchanged.', 'scribe_empty_summary', { hint: 'Scribe returned empty summary.' });
            return;
        }

        // Strip Obsidian syntax + neutralize bare YAML delimiters in AI output.
        const sanitizedSummary = stripObsidianSyntax(summary).replace(/^---$/gm, '- - -');

        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');
        let charName = (name2 || 'Unknown').replace(/[<>:"/\\|?*]/g, '_');
        charName = charName.replace(/^\.+|\.+$/g, '');
        charName = charName.trimEnd();
        // Prefix Windows reserved names to avoid filesystem collisions.
        if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(charName)) {
            charName = '_' + charName;
        }
        if (!charName) charName = 'Unknown';
        const filename = `${settings.scribeFolder}/${charName} - ${dateStr} ${timeStr}.md`;

        const noteContent = `---\ntags:\n  - lorebook-session\ndate: ${now.toISOString()}\ncharacter: "${charName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n---\n# Session: ${charName} - ${dateStr} ${timeStr}\n\n${sanitizedSummary.trim()}\n`;

        if (epoch !== chatEpoch) {
            if (getSettings().debugMode) console.log('[DLE] Scribe: chat changed during generation, discarding result');
            return;
        }

        const scribeVault = resolveWriteVault('scribe', settings);
        const data = await writeNote(scribeVault.host, scribeVault.port, scribeVault.apiKey, filename, noteContent, !!scribeVault.https);

        if (data.ok) {
            // Re-check epoch after the async write — would otherwise persist to wrong chat's metadata.
            if (epoch !== chatEpoch) {
                if (getSettings().debugMode) console.log('[DLE] Scribe: chat changed during note write, skipping metadata update');
                return;
            }
            const finalSummary = sanitizedSummary.trim();
            setLastScribeSummary(finalSummary);
            const chatLenAtWrite = chat?.length || 0;
            setLastScribeChatLength(chatLenAtWrite);
            // BUG-056: write the local computed value, not the live `lastScribeSummary` binding —
            // a future debounced/setter migration would otherwise persist the previous summary.
            chat_metadata.deeplore_lastScribeSummary = finalSummary;
            // BUG-308: persist the "scribed at length N" guard so CHAT_CHANGED / reload can
            // hydrate it. In-memory-only previously let returning to a chat re-trigger
            // scribe immediately on the next render despite no growth.
            chat_metadata.deeplore_lastScribeChatLength = chatLenAtWrite;
            // BUG-AUDIT: flush synchronously. Debounced save reads live chat_metadata at
            // flush time — CHAT_CHANGED in the debounce window would orphan the write to
            // the old object and it would never hit disk.
            try {
                await getContext().saveMetadata();
            } catch (saveErr) {
                console.warn('[DLE] Scribe: sync saveMetadata failed, falling back to debounced:', saveErr?.message);
                saveMetadataDebounced();
            }
            pushEvent('scribe', { action: 'completed', chatLength: chatLenAtWrite });
            toastr.success(trf('dle_scribe_toast_saved', filename), 'DeepLore', { timeOut: 5000 });
            if (epoch !== chatEpoch) {
                if (getSettings().debugMode) console.log('[DLE] Scribe: chat changed before reindex, skipping buildIndex');
                return;
            }
            try { await buildIndex(); } catch (reidxErr) {
                console.warn('[DLE] Scribe reindex after write failed:', reidxErr?.message);
                // BUG-AUDIT: without surfacing this, the note is on disk but unretrievable
                // until the next manual refresh.
                try {
                    toastr.warning(
                        trf('dle_scribe_toast_reindex_failed', reidxErr?.message || 'unknown error'),
                        'DeepLore',
                        { timeOut: 10000 },
                    );
                } catch { /* toastr unavailable */ }
            }
        } else {
            dedupError('Couldn\'t save the session note to your vault.', 'scribe_write_fail', { hint: data && data.error });
        }
    } catch (err) {
        console.error('[DLE] Session Scribe error:', err);
        pushEvent('scribe', { action: 'error', error: err?.message });
        dedupError('Session Scribe couldn\'t finish — your chat is unchanged.', 'scribe_runtime_error', { hint: err && err.message });
    } finally {
        // BUG-275: always release. This invocation owns the flag from acquisition to
        // here; CHAT_CHANGED no longer touches it, so an epoch-guarded reset would
        // have leaked it forever on chat switch mid-scribe.
        setScribeInProgress(false);
    }
}
