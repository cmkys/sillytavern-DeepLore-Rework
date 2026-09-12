/**
 * DeepLore — Auto Lorebook Creation
 */
import {
    generateQuietPrompt,
    chat,
    saveSettingsDebounced,
    eventSource,
    event_types,
} from '../../../../../../script.js';
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { getSettings, resolveConnectionConfig, resolveWriteVault } from '../../settings.js';
import { writeNote } from '../vault/obsidian-api.js';
import { buildAiChatContext, yamlEscape, classifyError } from '../../core/utils.js';
import { callAI, isExcludedFromBreaker } from './ai.js';
import { extractAiResponseClient, stripObsidianSyntax } from '../helpers.js';
import { getWriterVisibleEntries, chatEpoch, tryAcquireHalfOpenProbe, recordAiSuccess, recordAiFailure, releaseHalfOpenProbe } from '../state.js';
import { ensureIndexFresh, buildIndex } from '../vault/vault.js';
import { pushEvent } from '../diagnostics/interceptors.js';
import { tr, trf } from '../i18n/i18n.js';
import { notify } from '../toast-dedup.js';
import { resolvePromptOrOverride } from '../prompts/prompt-store.js';

// Auto-Suggest default prompt moved to src/i18n/prompts/en.js as
// AUTO_SUGGEST_PROMPT and resolved at call time via
// getPrompt('AUTO_SUGGEST_PROMPT'). See the editable-prompts feature (v2.5).

/** Route an Auto Suggest AI call by connection mode (mirrors callScribe). */
export async function callAutoSuggest(systemPrompt, userMessage, toolKey = 'autoSuggest') {
    const resolved = resolveConnectionConfig(toolKey);
    const mode = resolved.mode;
    const timeout = resolved.timeout;
    const maxTokens = resolved.maxTokens;

    if (mode === 'st') {
        // S4-2: mutation gate — tryAcquireHalfOpenProbe, not isAiCircuitOpen
        // (would leak the probe slot in half-open-no-probe state).
        if (!tryAcquireHalfOpenProbe()) throw new Error('AI circuit breaker is open — skipping auto-suggest');
        // BUG-244: generateQuietPrompt cannot be aborted mid-flight. Mirror scribe's
        // GENERATION_STOPPED race so our await resolves early on user stop and the
        // lock releases promptly instead of waiting out the orphaned background gen.
        const quietPrompt = `${systemPrompt}\n\n${userMessage}`;
        // timeout=0 means "no timeout" — setTimeout(fn, 0) would fire immediately.
        const effectiveTimeout = timeout || 60000;
        const quietPromise = generateQuietPrompt({ quietPrompt, skipWIAN: true, responseLength: maxTokens });
        let suggestTimer;
        let onStop;
        try {
            const response = await Promise.race([
                quietPromise.finally(() => clearTimeout(suggestTimer)),
                new Promise((_, reject) => { suggestTimer = setTimeout(() => {
                    console.warn('[DLE] Auto-suggest quiet prompt timed out — orphaned generation may still complete in background');
                    const err = new Error(`Auto-suggest quiet prompt timed out (${Math.round(effectiveTimeout / 1000)}s)`);
                    err.timedOut = true;
                    reject(err);
                }, effectiveTimeout); }),
                new Promise((_, reject) => {
                    onStop = () => {
                        const err = new Error('Auto-suggest aborted by user (GENERATION_STOPPED)');
                        err.name = 'AbortError';
                        err.userAborted = true;
                        reject(err);
                    };
                    // BUG-AUDIT: null onStop on registration failure so finally
                    // doesn't remove a listener that was never added.
                    try {
                        eventSource.on(event_types.GENERATION_STOPPED, onStop);
                    } catch (regErr) {
                        console.warn('[DLE] Auto-suggest stop-listener registration failed:', regErr?.message);
                        onStop = null;
                    }
                }),
            ]);
            recordAiSuccess();
            return { text: response, usage: null };
        } catch (err) {
            // BUG-252 + Wave-B contract: shared classifier covers throttled / userAborted /
            // timedOut PLUS HTTP 401/403 (auth) and 429 (rate-limit). See scribe.js.
            if (!isExcludedFromBreaker(err)) recordAiFailure(); else releaseHalfOpenProbe(); // #11: free dangling half-open probe
            throw err;
        } finally {
            if (onStop) { try { eventSource.removeListener(event_types.GENERATION_STOPPED, onStop); } catch { /* noop */ } }
        }
    } else if (mode === 'profile' || mode === 'direct') {
        // 'direct' shares this branch — callAI owns mode dispatch (see callScribe).
        // v2.5 dead-head: 'proxy' removed from the dispatch whitelist. callAI's
        // proxy branch throws a migration error; the unknown-mode `else` below
        // also throws clearly if a legacy 'proxy' value slips through here.
        // S4-2: mutation gate (see above).
        if (!tryAcquireHalfOpenProbe()) throw new Error('AI circuit breaker is open — skipping auto-suggest');
        try {
            // disableThinkingOnClaude: this profile path serves both autoSuggest
            // (JSON-parsed at line ~135) and optimizeKeys keyword-gen (popups.js).
            // Both extractAiResponseClient the result, so forced Claude thinking
            // (ST staging #5236) breaks the parse → keyword fallback. Suppress it.
            const result = await callAI(systemPrompt, userMessage, { ...resolved, caller: 'autoSuggest', disableThinkingOnClaude: true });
            recordAiSuccess();
            return result;
        } catch (err) {
            // Wave-B contract: shared classifier — see scribe.js.
            if (!isExcludedFromBreaker(err)) recordAiFailure(); else releaseHalfOpenProbe(); // #11: free dangling half-open probe
            throw err;
        }
    }
    throw new Error(`Unknown auto-suggest connection mode: ${mode}`);
}

let autoSuggestInProgress = false;
let autoSuggestInProgressEpoch = -1;

/** Analyze chat for missing entities and return suggested entries. */
export async function runAutoSuggest() {
    // Reset stuck flag from a previous run abandoned by chat switch.
    if (autoSuggestInProgress && autoSuggestInProgressEpoch !== chatEpoch) {
        autoSuggestInProgress = false;
    }
    if (autoSuggestInProgress) return [];
    autoSuggestInProgress = true;
    autoSuggestInProgressEpoch = chatEpoch;
    const epoch = chatEpoch;
    pushEvent('auto_suggest', { action: 'start' });
    try {
    const settings = getSettings();
    await ensureIndexFresh();
    // BUG-398: snapshot the writer-visible set BEFORE the epoch check — a concurrent
    // rebuild landing between check and read could otherwise inject new entries into
    // our "existing" list, causing duplicate suggestions (or silent dup writes under
    // skipReview).
    const visibleEntries = getWriterVisibleEntries();
    if (epoch !== chatEpoch) return [];
    const existingTitles = visibleEntries.map(e => `"${e.title.replace(/"/g, '\\"')}"`).join(', ');
    const chatContext = buildAiChatContext(chat, settings.aiSearchScanDepth || 20);

    const systemPrompt = resolvePromptOrOverride('AUTO_SUGGEST_PROMPT', settings.autoSuggestPrompt);
    const userMessage = `## Existing lorebook entries (do NOT suggest these):\n${existingTitles}\n\n## Recent Chat:\n${chatContext}\n\nSuggest new lorebook entries as a JSON array.`;

    const result = await callAutoSuggest(systemPrompt, userMessage);
    // BUG-023: post-await epoch guard — chat switch during the call would mis-tag
    // these against chat B (and silently write them under skipReview).
    if (epoch !== chatEpoch) return [];
    const parsed = extractAiResponseClient(result.text);

    if (!Array.isArray(parsed)) return [];

    // M-11: dedup suggestion-vs-suggestion by lowercased title BEFORE the
    // existing-entries filter (keep first occurrence). Two suggestions differing
    // only by case (e.g. "Castle"/"castle") preserve case in _buildSuggestionFile's
    // filename → on case-insensitive filesystems (Windows/default macOS) Castle.md
    // and castle.md collide and the second write silently overwrites the first,
    // so the user sees "2 created" but only one file exists.
    const seenLower = new Set();
    const deduped = parsed.filter(s => {
        if (!(s && typeof s === 'object' && s.title)) return false;
        const key = s.title.toLowerCase();
        if (seenLower.has(key)) return false;
        seenLower.add(key);
        return true;
    });

    const existingLower = new Set(visibleEntries.map(e => e.title.toLowerCase()));
    const filtered = deduped.filter(s =>
        !existingLower.has(s.title.toLowerCase())
    );
    pushEvent('auto_suggest', { action: 'completed', count: filtered.length });
    return filtered;
    } finally {
        autoSuggestInProgress = false;
    }
}

/**
 * Pure file-content + filename builder for one suggestion. No UI/network/state.
 * Shared by the review-popup path and the skip-review batch path.
 * @returns {{ filename: string, fileContent: string, safeTitle: string }}
 */
function _buildSuggestionFile(s, settings) {
    const folder = settings.autoSuggestFolder || '';
    let safeTitle = s.title.replace(/[<>:"/\\|?*]/g, '_');
    safeTitle = safeTitle.replace(/^\.+|\.+$/g, '');
    safeTitle = safeTitle.trimEnd();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(safeTitle)) safeTitle = '_' + safeTitle;
    if (!safeTitle) safeTitle = 'Untitled';
    const filename = folder ? `${folder}/${safeTitle}.md` : `${safeTitle}.md`;
    const keysYaml = (s.keys || []).map(k => `  - ${yamlEscape(k)}`).join('\n');
    const safeContent = stripObsidianSyntax(s.content || '').replace(/^---$/gm, '- - -');
    const fileContent = `---
type: ${yamlEscape(s.type || 'lore')}
priority: 50
tags:
  - ${settings.lorebookTag}
keys:
${keysYaml}
summary: "${(s.summary || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
---
# ${s.title}

${safeContent}`;
    return { filename, fileContent, safeTitle };
}

/** Write a single suggestion to the vault; returns outcome shape. */
async function writeSuggestionToVault(s, settings) {
    try {
        const { filename, fileContent } = _buildSuggestionFile(s, settings);
        const suggestVault = resolveWriteVault('autoSuggest', settings);
        const data = await writeNote(suggestVault.host, suggestVault.port, suggestVault.apiKey, filename, fileContent, !!suggestVault.https);
        if (data?.ok) return { ok: true, title: s.title, filename };
        return { ok: false, title: s.title, filename, error: data?.error || 'unknown' };
    } catch (err) {
        return { ok: false, title: s.title, error: err?.message || String(err) };
    }
}

/**
 * Show review popup. With `settings.autoSuggestSkipReview`, batch-writes all
 * suggestions and shows a summary toast.
 */
export async function showSuggestionPopup(suggestions) {
    if (!suggestions || suggestions.length === 0) {
        toastr.info(tr('dle_suggest_toast_none'), 'DeepLore');
        return;
    }

    // BUG-272: capture epoch at popup open — auto-suggest is chat-scoped (vault writes
    // are global but conceptual ownership is per-chat). Switching chats before Accept
    // mis-tags suggestions against the new character.
    const popupEpoch = chatEpoch;

    const settings = getSettings();

    if (settings.autoSuggestSkipReview) {
        // Continue-on-failure: write all, summarize at end.
        const results = [];
        for (const s of suggestions) {
            // Stale-chat bail: same epoch contract as per-card Accept.
            if (popupEpoch !== chatEpoch) {
                toastr.warning(tr('dle_suggest_toast_chat_changed'), 'DeepLore');
                break;
            }
            const r = await writeSuggestionToVault(s, settings);
            results.push(r);
        }
        const successes = results.filter(r => r.ok);
        const failures = results.filter(r => !r.ok);
        if (successes.length > 0) {
            const failNote = failures.length > 0 ? `, ${failures.length} failed: ${failures.map(f => f.title).join(', ')}` : '';
            toastr.success(trf('dle_suggest_toast_batch_success', successes.length, results.length, failNote), 'DeepLore');
            // Reindex once at end (per-card flow does one per accept).
            try { await buildIndex(); } catch (reidxErr) {
                console.warn('[DLE] Auto-suggest batch reindex failed:', reidxErr?.message);
                try {
                    toastr.warning(
                        trf('dle_suggest_toast_batch_reindex_failed', reidxErr?.message || 'unknown error'),
                        'DeepLore',
                        { timeOut: 10000 },
                    );
                } catch { /* toastr unavailable */ }
            }
        } else if (failures.length > 0) {
            toastr.error(trf('dle_suggest_toast_batch_all_failed', failures.length), 'DeepLore');
        }
        return;
    }
    const container = document.createElement('div');
    container.classList.add('dle-popup');

    let cardsHtml = '';
    for (let i = 0; i < suggestions.length; i++) {
        const s = suggestions[i];
        cardsHtml += `
            <div id="dle-suggest-${i}" class="dle-suggest-card dle-card">
                <div class="dle-card-header dle-mb-1">
                    <strong>${escapeHtml(s.title || 'Untitled')}</strong>
                    <span class="dle-text-xs dle-muted">${escapeHtml(s.type || 'lore')}</span>
                </div>
                <div class="dle-text-sm dle-mb-1">
                    <strong>Keywords:</strong> ${escapeHtml((s.keys || []).join(', '))}
                </div>
                <div class="dle-text-sm dle-mb-1">
                    <strong>Summary:</strong> ${escapeHtml(s.summary || '')}
                </div>
                <details>
                    <summary class="dle-text-sm dle-cursor-pointer">Content preview</summary>
                    <div class="dle-preview dle-preview--short dle-mt-1">${escapeHtml(s.content || '')}</div>
                </details>
                <div class="dle-flex dle-mt-1 dle-gap-1">
                    <button type="button" class="menu_button dle-accept-suggest dle-text-sm" data-index="${i}">Accept</button>
                    <button type="button" class="menu_button dle-reject-suggest dle-text-sm dle-muted" data-index="${i}">Reject</button>
                </div>
            </div>`;
    }

    container.innerHTML = `
        <h3>Suggested Entries (${suggestions.length})</h3>
        <p class="dle-muted dle-text-sm">Review each suggestion. Accept to write to Obsidian, reject to skip.</p>
        <label class="checkbox_label dle-text-sm dle-checkbox-row">
            <input type="checkbox" class="checkbox" id="dle-suggest-skip-review" ${settings.autoSuggestSkipReview ? 'checked' : ''}>
            <span>Write directly (skip review)</span>
        </label>
        ${cardsHtml}
    `;

    await callGenericPopup(container, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        onOpen: () => {
            // E11: sync skip-review checkbox to settings.
            const skipCheckbox = container.querySelector('#dle-suggest-skip-review');
            if (skipCheckbox) {
                skipCheckbox.addEventListener('change', function () {
                    settings.autoSuggestSkipReview = this.checked;
                    saveSettingsDebounced();
                });
            }

            container.querySelectorAll('.dle-accept-suggest').forEach(btn => {
                btn.addEventListener('click', async function () {
                    if (this.disabled) return;
                    // BUG-272: chat switched since suggestions were generated — refuse to write.
                    if (popupEpoch !== chatEpoch) {
                        toastr.warning(tr('dle_suggest_toast_stale_chat'), 'DeepLore');
                        this.disabled = true;
                        return;
                    }
                    this.disabled = true;
                    const idx = Number(this.dataset.index);
                    const s = suggestions[idx];
                    const card = document.getElementById(`dle-suggest-${idx}`);
                    if (!card) { this.disabled = false; return; }

                    const folder = settings.autoSuggestFolder || '';
                    // Filesystem-safe title (same pattern as Scribe).
                    let safeTitle = s.title.replace(/[<>:"/\\|?*]/g, '_');
                    safeTitle = safeTitle.replace(/^\.+|\.+$/g, '');
                    safeTitle = safeTitle.trimEnd();
                    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(safeTitle)) safeTitle = '_' + safeTitle;
                    if (!safeTitle) safeTitle = 'Untitled';
                    const filename = folder
                        ? `${folder}/${safeTitle}.md`
                        : `${safeTitle}.md`;

                    const keysYaml = (s.keys || []).map(k => `  - ${yamlEscape(k)}`).join('\n');
                    // Strip Obsidian syntax + neutralize bare YAML delimiters in AI content.
                    const safeContent = stripObsidianSyntax(s.content || '').replace(/^---$/gm, '- - -');
                    const fileContent = `---
type: ${yamlEscape(s.type || 'lore')}
priority: 50
tags:
  - ${settings.lorebookTag}
keys:
${keysYaml}
summary: "${(s.summary || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
---
# ${s.title}

${safeContent}`;

                    try {
                        const suggestVault = resolveWriteVault('autoSuggest', settings);
                        const data = await writeNote(suggestVault.host, suggestVault.port, suggestVault.apiKey, filename, fileContent, !!suggestVault.https);
                        if (data.ok) {
                            card.classList.add('dle-suggest-card--accepted');
                            this.disabled = true;
                            this.textContent = 'Accepted';
                            toastr.success(trf('dle_suggest_toast_created', s.title), 'DeepLore');
                            try { await buildIndex(); } catch (reidxErr) {
                                console.warn('[DLE] Auto-suggest reindex after write failed:', reidxErr?.message);
                                // BUG-AUDIT: without surfacing this, the new entry is
                                // unretrievable until the next manual refresh.
                                try {
                                    toastr.warning(
                                        trf('dle_suggest_toast_reindex_failed_single', reidxErr?.message || 'unknown error'),
                                        'DeepLore',
                                        { timeOut: 10000 },
                                    );
                                } catch { /* toastr unavailable */ }
                            }
                        } else {
                            console.warn('[DLE] Auto-suggest write failed:', data && data.error);
                            toastr.error(tr('dle_suggest_toast_write_fail_single'), 'DeepLore');
                        }
                    } catch (err) {
                        notify.error(classifyError(err), { copyable: true });
                        this.disabled = false;
                    }
                });
            });

            container.querySelectorAll('.dle-reject-suggest').forEach(btn => {
                btn.addEventListener('click', function () {
                    const idx = Number(this.dataset.index);
                    const card = document.getElementById(`dle-suggest-${idx}`);
                    if (card) {
                        card.classList.add('dle-suggest-card--rejected');
                        card.querySelectorAll('button').forEach(b => b.disabled = true);
                        this.textContent = 'Rejected';
                    }
                });
            });
        },
    });
}
