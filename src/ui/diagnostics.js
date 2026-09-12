/** DeepLore — Self-Healing Diagnostics & Why Not? */
import { getCurrentChatId } from '../../../../../../script.js';
import { getSettings } from '../../settings.js';
import { buildScanText } from '../../core/utils.js';
import { testEntryMatch, countKeywordOccurrences, applySelectiveLogic } from '../../core/matching.js';
import {
    vaultIndex, indexTimestamp, cooldownTracker, injectionHistory,
    generationCount, trackerKey,
} from '../state.js';
import { getCurrentForChat as getCurrentVerdictForChat } from '../verdict/verdict-store.js';

// Local helper — UI consumers must read the CURRENT CHAT's verdict, not the
// ring-global newest. See docs/gotchas.md #46 ("UI consumer rule").
function _currentVerdictForChat() {
    let cid = null;
    try { cid = getCurrentChatId() ?? null; } catch { cid = null; }
    return getCurrentVerdictForChat(cid);
}

/**
 * @returns {{ issues: Array<{type: string, severity: 'error'|'warning'|'info', entry: string, detail: string}>, errors: number, warnings: number }}
 */
export function runHealthCheck() {
    const settings = getSettings();
    const issues = [];

    const enabledVaults = (settings.vaults || []).filter(v => v.enabled);
    if (enabledVaults.length === 0) {
        issues.push({ type: 'Settings', severity: 'error', entry: '—', detail: 'No enabled vaults configured. Go to DeepLore settings → Vault Connections and click "Add Vault".' });
    }
    for (const vault of enabledVaults) {
        if (!vault.apiKey) {
            issues.push({ type: 'Settings', severity: 'warning', entry: '—', detail: `Vault "${vault.name}" has no API key` });
        }
    }

    if (settings.scanDepth === 0 && !settings.aiSearchEnabled) {
        issues.push({ type: 'Settings', severity: 'error', entry: '—', detail: 'Scan depth is 0 and AI search is disabled — nothing will ever match' });
    }

    if (settings.aiSearchEnabled && settings.aiSearchMode === 'ai-only' && settings.aiSearchConnectionMode === 'profile' && !settings.aiSearchProfileId) {
        issues.push({ type: 'Settings', severity: 'error', entry: '—', detail: 'AI-only mode enabled but no connection profile selected' });
    }

    // Direct API mode has two hard prerequisites and one soft one. URL and model
    // are errors — the call cannot be built without them. A missing key is only a
    // warning: local runtimes (Ollama, LM Studio, llama.cpp) legitimately want none.
    if (settings.aiSearchEnabled && settings.aiSearchConnectionMode === 'direct') {
        if (!settings.aiSearchApiUrl) {
            issues.push({ type: 'Settings', severity: 'error', entry: '—', detail: 'AI search is set to Direct API mode but no API URL is set. Add one in DLE Settings → Setup → AI Connections.' });
        }
        if (!settings.aiSearchModel) {
            issues.push({ type: 'Settings', severity: 'error', entry: '—', detail: 'AI search is set to Direct API mode but no model is set — Direct API mode has no profile to read a model from.' });
        }
        if (!settings.aiSearchApiKey) {
            issues.push({ type: 'Settings', severity: 'warning', entry: '—', detail: 'AI search Direct API mode has no API key. Fine for a local endpoint; hosted providers will return 401.' });
        }
    }

    // v2.5 dead-head: Custom Proxy mode removed. Surface a migration-pointing
    // error if a legacy proxy-mode setting is still saved on an enabled feature
    // — the old "no proxy URL set" warning is moot since users can no longer
    // pick proxy mode in the UI; the actionable signal is "switch to a profile".
    if (settings.aiSearchEnabled && settings.aiSearchConnectionMode === 'proxy') {
        issues.push({ type: 'Settings', severity: 'error', entry: '—', detail: 'AI search is set to Custom Proxy mode, which was removed in v2.5. Pick a Connection Profile in DLE Settings → Setup → AI Connections.' });
    }

    if (settings.scribeEnabled && settings.scribeConnectionMode === 'profile' && !settings.scribeProfileId) {
        issues.push({ type: 'Settings', severity: 'error', entry: '—', detail: 'Scribe enabled in profile mode but no profile selected' });
    }

    if (settings.scribeEnabled && settings.scribeConnectionMode === 'direct' && !settings.scribeApiUrl) {
        issues.push({ type: 'Settings', severity: 'error', entry: '—', detail: 'Scribe is set to Direct API mode but no API URL is set.' });
    }

    if (settings.scribeEnabled && settings.scribeConnectionMode === 'proxy') {
        issues.push({ type: 'Settings', severity: 'error', entry: '—', detail: 'Scribe is set to Custom Proxy mode, which was removed in v2.5. Pick a Connection Profile in DLE Settings → Setup → AI Connections.' });
    }

    if (!settings.unlimitedBudget && settings.maxTokensBudget < 200) {
        issues.push({ type: 'Settings', severity: 'warning', entry: '—', detail: `Token budget very low (${settings.maxTokensBudget})` });
    }

    if (settings.recursiveScan && settings.maxRecursionSteps === 1) {
        issues.push({ type: 'Settings', severity: 'info', entry: '—', detail: 'Recursive scan enabled but max steps is 1 — only one extra pass' });
    }

    if (settings.cacheTTL === 0) {
        issues.push({ type: 'Settings', severity: 'info', entry: '—', detail: 'Cache disabled — vault will be fetched every generation' });
    }

    if (indexTimestamp > 0 && settings.cacheTTL > 0 && Date.now() - indexTimestamp > settings.cacheTTL * 1000 * 3) {
        issues.push({ type: 'Settings', severity: 'warning', entry: '—', detail: 'Index is very stale (more than 3x cache TTL old)' });
    }

    if (vaultIndex.length === 0) {
        const errors = issues.filter(i => i.severity === 'error').length;
        const warnings = issues.filter(i => i.severity === 'warning').length;
        return { issues, errors, warnings };
    }

    const allTitlesLower = new Set(vaultIndex.map(e => e.title.toLowerCase()));
    const allFilenamesLower = new Set(vaultIndex.map(e => {
        const parts = e.filename.split('/');
        return parts[parts.length - 1].replace(/\.md$/, '').toLowerCase();
    }));
    // Vault-aware duplicate detection: same-vault dupes are authoring errors,
    // cross-vault dupes are valid in multiVaultConflictResolution='all' (the
    // documented default) — flag those as info, not error.
    const titleCounts = new Map();      // trackerKey → count (within-vault)
    const inVaultDupes = new Map();      // title → Set<vaultSource> (cross-vault)
    const keywordMap = new Map();
    let constantTokenTotal = 0;

    for (const entry of vaultIndex) {
        const tk = `${entry.vaultSource || ''}:${entry.title}`;
        titleCounts.set(tk, (titleCounts.get(tk) || 0) + 1);
        if (!inVaultDupes.has(entry.title)) inVaultDupes.set(entry.title, new Set());
        inVaultDupes.get(entry.title).add(entry.vaultSource || '');

        if (!entry.constant && !entry.bootstrap && entry.keys.length === 0) {
            issues.push({ type: 'Entry Config', severity: 'warning', entry: entry.title, detail: 'No trigger keywords defined' });
        }

        if (!entry.content || !entry.content.trim()) {
            issues.push({ type: 'Entry Config', severity: 'warning', entry: entry.title, detail: 'Entry has no content' });
        }

        // Read _originalRequires if present so dangling refs stripped at finalizeIndex still surface.
        // Case-insensitive to match applyRequiresExcludesGating behaviour.
        const requiresForCheck = entry._originalRequires || entry.requires;
        for (const req of requiresForCheck) {
            if (!allTitlesLower.has(req.toLowerCase())) {
                issues.push({ type: 'Gating', severity: 'error', entry: entry.title, detail: `Requires "${req}" which doesn't exist in the vault` });
            }
        }

        const excludesForCheck = entry._originalExcludes || entry.excludes;
        for (const exc of excludesForCheck) {
            if (!allTitlesLower.has(exc.toLowerCase())) {
                issues.push({ type: 'Gating', severity: 'error', entry: entry.title, detail: `Excludes "${exc}" which doesn't exist in the vault` });
            }
        }

        const cascadeForCheck = entry._originalCascadeLinks || entry.cascadeLinks;
        if (cascadeForCheck) {
            for (const cl of cascadeForCheck) {
                if (!allTitlesLower.has(cl.toLowerCase()) && !allFilenamesLower.has(cl.toLowerCase())) {
                    issues.push({ type: 'Gating', severity: 'warning', entry: entry.title, detail: `Cascade link "${cl}" doesn't exist in the vault` });
                }
            }
        }

        if (entry.excludes.length > 0 && entry.excludes.some(exc => exc.toLowerCase() === entry.title.toLowerCase())) {
            issues.push({ type: 'Gating', severity: 'error', entry: entry.title, detail: 'This entry can never trigger because it excludes itself' });
        }

        if (entry.requires.length > 0 && entry.excludes.length > 0) {
            for (const req of entry.requires) {
                if (entry.excludes.some(exc => exc.toLowerCase() === req.toLowerCase())) {
                    issues.push({ type: 'Gating', severity: 'error', entry: entry.title, detail: `Requires and excludes "${req}" simultaneously` });
                }
            }
        }

        // BUG-AUDIT-H22: excluding a force-injected entry (constant/seed/bootstrap)
        // permanently blocks this one — force-injected is always present.
        if (entry.excludes.length > 0) {
            for (const exc of entry.excludes) {
                const target = vaultIndex.find(e => e.title.toLowerCase() === exc.toLowerCase());
                if (target && (target.constant || target.seed || target.bootstrap)) {
                    const kind = target.constant ? 'constant' : target.seed ? 'seed' : 'bootstrap';
                    issues.push({ type: 'Gating', severity: 'warning', entry: entry.title, detail: `Excludes "${exc}" which is a ${kind} (always injected) — this entry will always be blocked` });
                }
            }
        }

        if (entry.tokenEstimate > 1500) {
            issues.push({ type: 'Size', severity: 'warning', entry: entry.title, detail: `~${entry.tokenEstimate} tokens (>1500)` });
        }

        if (settings.aiSearchEnabled && !entry.summary) {
            issues.push({ type: 'AI Search', severity: 'warning', entry: entry.title, detail: 'No AI selection summary defined' });
        }

        for (const key of entry.keys) {
            if (key.length <= 2) {
                issues.push({ type: 'Keywords', severity: 'info', entry: entry.title, detail: `Keyword "${key}" is ${key.length} char(s) — may cause false matches` });
            }
            const lower = key.toLowerCase();
            if (!keywordMap.has(lower)) keywordMap.set(lower, []);
            keywordMap.get(lower).push(entry.title);
        }

        if (entry.constant && entry.cooldown !== null) {
            issues.push({ type: 'Entry Config', severity: 'info', entry: entry.title, detail: 'Cooldown on constant entry has no effect' });
        }

        if (entry.warmup !== null && entry.warmup > 1 && entry.keys.length > 0 && entry.keys.every(k => k.length <= 3)) {
            issues.push({ type: 'Entry Config', severity: 'warning', entry: entry.title, detail: `Warmup ${entry.warmup} unlikely to trigger — all keywords are 3 chars or fewer` });
        }

        if (entry.bootstrap && !entry.constant && entry.keys.length === 0) {
            issues.push({ type: 'Entry Config', severity: 'warning', entry: entry.title, detail: 'Bootstrap entry has no keywords — only active during cold start' });
        }

        if (entry.seed && entry.tokenEstimate > 2000) {
            issues.push({ type: 'Size', severity: 'warning', entry: entry.title, detail: `Seed entry is large — ~${entry.tokenEstimate} tokens sent as AI context on new chats` });
        }

        // Use entry override or fall back to global default.
        const effectivePosition = entry.injectionPosition ?? settings.injectionPosition;
        if (entry.injectionDepth !== null && effectivePosition !== 1) {
            issues.push({ type: 'Injection', severity: 'warning', entry: entry.title, detail: 'Depth override ignored — effective position is not in_chat' });
        }

        if (entry.injectionRole !== null && effectivePosition !== 1) {
            issues.push({ type: 'Injection', severity: 'warning', entry: entry.title, detail: 'Role override ignored — effective position is not in_chat' });
        }

        // Case-insensitive — resolveLinks lowercases.
        if (entry.links.length > 0 && entry.resolvedLinks.length < entry.links.length) {
            const resolvedLower = new Set(entry.resolvedLinks.map(r => r.toLowerCase()));
            const unresolved = entry.links.filter(l => !resolvedLower.has(l.toLowerCase()));
            if (unresolved.length > 0) {
                issues.push({ type: 'Links', severity: 'info', entry: entry.title, detail: `Unresolved wiki-links: ${unresolved.join(', ')}` });
            }
        }

        if (entry.excludeRecursion && entry.keys.length === 0 && !entry.constant) {
            issues.push({ type: 'Entry Config', severity: 'warning', entry: entry.title, detail: "Entry won't match via recursion and has no keywords" });
        }

        if (entry.probability === 0) {
            issues.push({ type: 'Entry Config', severity: 'warning', entry: entry.title, detail: 'Entry will never trigger (probability is 0)' });
        }

        if (entry.constant) {
            constantTokenTotal += entry.tokenEstimate;
        }
    }

    for (const [tk, count] of titleCounts) {
        if (count > 1) {
            const colonIdx = tk.indexOf(':');
            const titleOnly = colonIdx >= 0 ? tk.slice(colonIdx + 1) : tk;
            issues.push({ type: 'Entry Config', severity: 'error', entry: titleOnly, detail: `Duplicate title within vault — ${count} entries share this name` });
        }
    }
    // Cross-vault dupes are info-only in conflictResolution='all'; other modes
    // collapse them at index time via deduplicateMultiVault.
    if (settings.multiVaultConflictResolution === 'all') {
        for (const [title, vaults] of inVaultDupes) {
            if (vaults.size > 1) {
                issues.push({ type: 'Entry Config', severity: 'info', entry: title, detail: `Title "${title}" appears in ${vaults.size} vaults — disambiguated by vault source.` });
            }
        }
    }

    for (const [keyword, titles] of keywordMap) {
        if (titles.length > 1) {
            issues.push({ type: 'Keywords', severity: 'info', entry: titles.join(', '), detail: `Keyword "${keyword}" shared by ${titles.length} entries` });
        }
    }

    // Circular requires (A↔B). Pre-build a Map for O(n) lookups vs O(n²) .find() per entry.
    const requiresMap = new Map();
    for (const entry of vaultIndex) {
        if (entry.requires.length > 0) {
            requiresMap.set(entry.title.toLowerCase(), { title: entry.title, requires: entry.requires });
        }
    }
    for (const [titleLower, { title, requires }] of requiresMap) {
        for (const req of requires) {
            const target = requiresMap.get(req.toLowerCase());
            if (target && target.requires.some(r => r.toLowerCase() === titleLower)) {
                // Report once — alphabetically first wins.
                if (title < target.title) {
                    issues.push({ type: 'Gating', severity: 'error', entry: `${title} ↔ ${target.title}`, detail: 'Neither entry can trigger because they each require the other' });
                }
            }
        }
    }

    if (!settings.unlimitedBudget && constantTokenTotal > settings.maxTokensBudget) {
        issues.push({ type: 'Size', severity: 'warning', entry: '—', detail: `Constants alone total ~${constantTokenTotal} tokens, exceeding budget of ${settings.maxTokensBudget}` });
    }

    try {
        const unmet = settings.analyticsData?._librarian?.topUnmetQueries || [];
        const frequentMisses = unmet.filter(u => u.count >= 3);
        for (const miss of frequentMisses) {
            issues.push({ type: 'Librarian', severity: 'info', entry: '—', detail: `AI searched for "${miss.query}" ${miss.count} times with no results — consider creating an entry` });
        }
    } catch { /* noop */ }

    const errors = issues.filter(i => i.severity === 'error').length;
    const warnings = issues.filter(i => i.severity === 'warning').length;
    return { issues, errors, warnings };
}

/**
 * @param {import('../core/pipeline.js').VaultEntry} entry
 * @returns {{ stage: string, detail: string, suggestions: string[] }}
 */
export function diagnoseEntry(entry, chatMsgs) {
    const settings = getSettings();
    const result = { stage: 'unknown', detail: '', suggestions: [] };
    // Verdict store carries the trace; replaces the old lastPipelineTrace global.
    const _diagTrace = _currentVerdictForChat()?.trace ?? null;
    // L-20: trackerKey-shape key (vaultSource:title.toLowerCase()) so cross-vault
    // same-title entries are diagnosed distinctly. Trace entries carry vaultSource
    // (pipeline.js / match.js), so comparing on bare exact-case title misattributes.
    const tkKey = (o) => `${o?.vaultSource || ''}:${(o?.title || '').toLowerCase()}`;
    const _entryKey = tkKey(entry);

    if (entry.keys.length === 0 && !entry.constant) {
        result.stage = 'no_keywords';
        result.detail = 'Entry has no trigger keywords defined.';
        result.suggestions.push('Add keywords to the entry frontmatter.');
        return result;
    }

    const scanDepth = entry.scanDepth !== null ? entry.scanDepth : settings.scanDepth;
    if (scanDepth === 0) {
        result.stage = 'scan_depth_zero';
        result.detail = 'Scan depth is 0 — keyword matching is disabled.';
        result.suggestions.push('Increase scan depth or enable AI-only mode.');
        return result;
    }

    const scanText = buildScanText(chatMsgs, scanDepth);
    const matchedKey = testEntryMatch(entry, scanText, settings);

    if (!matchedKey) {
        const keyList = entry.keys.map(k => `"${k}"`).join(', ');
        result.stage = 'keyword_miss';
        result.detail = `None of the keywords (${keyList}) were found in the last ${scanDepth} messages.`;

        const widerText = buildScanText(chatMsgs, Math.min(chatMsgs.length, scanDepth * 3));
        const widerMatch = testEntryMatch(entry, widerText, settings);
        if (widerMatch) {
            result.suggestions.push(`Keyword "${widerMatch}" appears in older messages. Increase scan depth from ${scanDepth} to reach it.`);
        } else {
            result.suggestions.push('Add more relevant keywords or wait for these keywords to appear in chat.');
        }
        return result;
    }

    if (entry.refineKeys && entry.refineKeys.length > 0) {
        // Audit fix-up: route through applySelectiveLogic so the diagnostic
        // matches whatever mode the entry actually uses. Pre-fix this hand-
        // rolled AND_ANY semantics + reported "none of the refine keys were
        // found" even for not_any/not_all entries where a refine MATCH was
        // what blocked the entry — exactly the "pin the predicate" drift the
        // gotchas.md #69 invariant warns about.
        //
        // Round-2 perf fix: hoist haystack out of the filter closure — pre-fix
        // re-lowercased the scanText per refine key (50 refines × 50KB =
        // 2.5MB transient allocation per diagnostic call).
        const diagHaystack = settings.caseSensitive ? scanText : scanText.toLowerCase();
        const matchedRefines = entry.refineKeys.filter(rk => {
            const rKey = settings.caseSensitive ? rk : rk.toLowerCase();
            return diagHaystack.includes(rKey);
        });
        const matchedCount = matchedRefines.length;
        const total = entry.refineKeys.length;
        const logic = entry.selectiveLogic || 'and_any';
        const passes = applySelectiveLogic(matchedCount, total, logic);
        if (!passes) {
            result.stage = 'refine_keys';
            const matchedStr = matchedRefines.length > 0 ? `[${matchedRefines.join(', ')}]` : 'none';
            switch (logic) {
                case 'and_all':
                    result.detail = `Primary keyword matched, but selective_logic=and_all requires ALL refine keys (${entry.refineKeys.join(', ')}). Only ${matchedCount}/${total} matched: ${matchedStr}.`;
                    result.suggestions.push('All refine keys must appear in recent messages. Either add the missing keys to the chat or relax the gate to selective_logic: and_any.');
                    break;
                case 'not_any':
                    result.detail = `Primary keyword matched, but selective_logic=not_any blocks when ANY refine key is present. Matched: ${matchedStr}.`;
                    result.suggestions.push('A refine key match BLOCKS this entry (inverse gate). Remove the matching refine key, or change selective_logic if the inverse was unintended.');
                    break;
                case 'not_all':
                    result.detail = `Primary keyword matched, but selective_logic=not_all blocks when ALL refine keys are present. All ${total} matched.`;
                    result.suggestions.push('All refine keys matching BLOCKS this entry (inverse gate). Remove one of the refine keys from the chat, or change selective_logic if the inverse was unintended.');
                    break;
                case 'and_any':
                default:
                    result.detail = `Primary keyword matched but none of the refine keys (${entry.refineKeys.join(', ')}) were found.`;
                    result.suggestions.push('The refine keys narrow the match — check if they are too restrictive.');
            }
            return result;
        }
    }

    if (entry.warmup !== null) {
        const occurrences = countKeywordOccurrences(entry, scanText, settings);
        if (occurrences < entry.warmup) {
            result.stage = 'warmup';
            result.detail = `Needs ${entry.warmup} keyword occurrences, found ${occurrences}.`;
            result.suggestions.push('The keyword needs to appear more times in recent messages.');
            return result;
        }
    }

    if (entry.probability !== null && entry.probability < 1.0) {
        result.stage = 'probability';
        result.detail = `Entry has ${Math.round(entry.probability * 100)}% probability — it was rolled out this time.`;
        return result;
    }

    const cooldownRemaining = cooldownTracker.get(trackerKey(entry));
    if (cooldownRemaining !== undefined && cooldownRemaining > 0) {
        result.stage = 'cooldown';
        result.detail = `Per-entry cooldown: ${cooldownRemaining} generations remaining.`;
        return result;
    }

    if (settings.reinjectionCooldown > 0) {
        const lastGen = injectionHistory.get(trackerKey(entry));
        if (lastGen !== undefined && (generationCount - lastGen) < settings.reinjectionCooldown) {
            result.stage = 'reinjection_cooldown';
            result.detail = `Re-injection cooldown: injected ${generationCount - lastGen} gen(s) ago, cooldown is ${settings.reinjectionCooldown}.`;
            return result;
        }
    }

    if (_diagTrace) {
        const allMatchedTitles = new Set([
            ..._diagTrace.keywordMatched.map(m => m.title.toLowerCase()),
            ..._diagTrace.aiSelected.map(m => m.title.toLowerCase()),
        ]);

        if (entry.requires && entry.requires.length > 0) {
            const missing = entry.requires.filter(r => !allMatchedTitles.has(r.toLowerCase()));
            if (missing.length > 0) {
                result.stage = 'gating_requires';
                result.detail = `Requires entries not currently matched: ${missing.join(', ')}`;
                result.suggestions.push(`These required entries must also match: ${missing.join(', ')}`);
                return result;
            }
        }
        if (entry.excludes && entry.excludes.length > 0) {
            const present = entry.excludes.filter(r => allMatchedTitles.has(r.toLowerCase()));
            if (present.length > 0) {
                result.stage = 'gating_excludes';
                result.detail = `Excluded by matched entries: ${present.join(', ')}`;
                return result;
            }
        }
    }

    if (_diagTrace && _diagTrace.aiSelected) {
        // L-20: identity match on trackerKey shape, not exact-case bare title.
        const wasCandidate = _diagTrace.keywordMatched?.some(m => tkKey(m) === _entryKey);
        const wasSelected = _diagTrace.aiSelected.some(m => tkKey(m) === _entryKey);
        if (wasCandidate && !wasSelected) {
            result.stage = 'ai_rejected';
            result.detail = 'Entry was in the AI search candidate list but was not selected by the AI.';
            result.suggestions.push('Improve the entry summary to help the AI understand when to select it.');
            return result;
        }
    }

    // Guide entries never reach the writing AI through any path.
    if (entry.guide) {
        result.stage = 'guide_entry';
        result.detail = 'This is a lorebook-guide entry — it is only available to the Librarian, never injected into the writing AI prompt.';
        result.suggestions.push('Remove the lorebook-guide tag if you want this entry to be injected normally.');
        return result;
    }

    try {
        const cm = globalThis.chat_metadata || {};
        const folderFilter = cm.deeplore_folder_filter;
        if (Array.isArray(folderFilter) && folderFilter.length > 0 && entry.folderPath) {
            // Mirrors stages.js applyFolderFilter: exact OR slash-bounded prefix.
            // Raw startsWith would falsely pass "CharactersOld" against filter ['Characters'].
            if (!folderFilter.some(f => entry.folderPath === f || entry.folderPath.startsWith(f + '/'))) {
                result.stage = 'folder_filter';
                result.detail = `Entry is in folder "${entry.folderPath}" which is not in the active folder filter.`;
                result.suggestions.push('Clear the folder filter or add this entry\'s folder to the filter.');
                return result;
            }
        }
    } catch { /* chat_metadata may not be available */ }

    try {
        const cm = globalThis.chat_metadata || {};
        const blocks = cm.deeplore_blocks;
        // L-20: blocks are {title, vaultSource} (or legacy bare strings) — compare on
        // trackerKey shape (vaultSource:title.toLowerCase()) so a same-titled entry from
        // another vault isn't falsely reported as blocked, and case differences still match.
        if (Array.isArray(blocks) && blocks.some(b => tkKey(typeof b === 'string' ? { title: b } : b) === _entryKey)) {
            result.stage = 'blocked';
            result.detail = 'Entry is explicitly blocked in this chat (via pin/block controls).';
            result.suggestions.push('Unblock the entry using the drawer or /dle-unblock command.');
            return result;
        }
    } catch { /* chat_metadata may not be available */ }

    if (_diagTrace && Array.isArray(_diagTrace.contextualGatingRemoved)) {
        // L-20: removal entries carry vaultSource — identity match on trackerKey shape.
        if (_diagTrace.contextualGatingRemoved.some(e => tkKey(e) === _entryKey)) {
            result.stage = 'contextual_gating';
            result.detail = 'Entry was removed by contextual gating (era, location, scene type, or character filter).';
            result.suggestions.push('Check the entry\'s custom fields against the current gating state (/dle-context-state).');
            return result;
        }
    }

    if (_diagTrace && Array.isArray(_diagTrace.stripDedupRemoved)) {
        // L-20: removal entries carry vaultSource — identity match on trackerKey shape.
        if (_diagTrace.stripDedupRemoved.some(e => tkKey(e) === _entryKey)) {
            result.stage = 'strip_dedup';
            result.detail = 'Entry was already injected in a recent generation and was stripped as a duplicate.';
            result.suggestions.push('This is normal behavior. Increase stripLookbackDepth if you want entries to re-inject sooner.');
            return result;
        }
    }

    // Fallback: budget or max cut.
    result.stage = 'budget_cut';
    result.detail = 'Entry matched but was cut by budget limit or max entries cap.';
    result.suggestions.push('Increase token budget or max entries, or raise this entry\'s priority (lower number = higher priority).');
    return result;
}
