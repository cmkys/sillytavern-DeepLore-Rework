/**
 * state-snapshot.js — Capture a point-in-time snapshot of DLE + ST state.
 *
 * Pulls only metadata, counts, and structural info — never chat content,
 * never vault entry content. The result is then handed to scrubber.scrubDeep()
 * before being included in the export.
 */

import { getCurrentChatId } from '../../../../../../script.js';
import * as state from '../state.js';
import { getSettings, resolveConnectionConfig } from '../../settings.js';
import { runHealthCheck } from '../ui/diagnostics.js';
import { getAllCircuitStates } from '../vault/obsidian-api.js';
import { resolveDirectFormat } from '../ai/direct-api.js';
import { getCurrentForChat as getCurrentVerdictForChat, _debugRingSnapshot } from '../verdict/verdict-store.js';

// Diagnostic snapshot reads the CURRENT CHAT's verdict so "what's DLE's current
// state" reflects the chat the user is in, not whatever was last written to ring.
// See docs/gotchas.md #46 ("UI consumer rule").
function _currentVerdictForChat() {
    let cid = null;
    try { cid = getCurrentChatId() ?? null; } catch { cid = null; }
    return getCurrentVerdictForChat(cid);
}
import {
    createPseudonymContext,
    pseudonymizeTrace as pseudonymizeTracePure,
    pseudonymizeTitle as pseudonymizeTitlePure,
    pseudonymizeVaultSource as pseudonymizeVaultSourcePure,
    pseudonymizeHealth as pseudonymizeHealthPure,
} from './pseudonymize-trace.js';

// DLE version — fetched once from manifest.json and cached.
let _cachedDleVersion = null;
try {
    fetch(new URL('../../manifest.json', import.meta.url))
        .then(r => r.ok ? r.json() : null)
        .then(m => { if (m?.version) _cachedDleVersion = m.version; })
        .catch(() => {});
} catch { /* import.meta.url may not be available */ }

/**
 * Strip embedded credentials from a URL before it enters the SHARED snapshot.
 * Removes `//user:pass@` userinfo and token-bearing query params. The scrubber's
 * regex pass pseudonymizes the hostname but does NOT strip userinfo creds, so a
 * raw `https://user:pass@host/...` api-url / reverse-proxy would otherwise leak
 * the credentials into the shareable diagnostic blob. Mirrors the eyes-only
 * helper in export.js (#13) — kept local since that one isn't exported.
 * @param {*} u
 * @returns {*}
 */
function stripUrlSecrets(u) {
    if (typeof u !== 'string' || !u) return u;
    return u
        .replace(/\/\/[^/@\s]*@/, '//')
        .replace(/([?&](?:key|token|access_token|api_key|auth|secret|password|jwt|bearer|authorization|oauth_token)=)[^&\s]+/gi, '$1<token>');
}

/**
 * Partial-mask: show first `keep` chars, replace the rest with `*`. Preserves
 * length so a reader can spot "this is short" vs "this is a 40-char key" without
 * seeing the value. Collisions get a random-word suffix (e.g. "John***-oak").
 */
const _maskCache = new Map(); // masked → original
const _maskResult = new Map(); // original → result
const DECOLIDE_WORDS = [
    'oak', 'elm', 'ash', 'bay', 'fir', 'yew', 'ivy', 'rue', 'fox', 'owl',
    'jay', 'wren', 'lark', 'dove', 'hare', 'moth', 'fern', 'moss', 'reed', 'sage',
];
let _decolideIdx = 0;
function maskString(s, keep = 4) {
    if (!s || typeof s !== 'string') return s;
    if (_maskResult.has(s)) return _maskResult.get(s);
    const masked = s.length <= keep
        ? '*'.repeat(s.length)
        : s.slice(0, keep) + '*'.repeat(s.length - keep);
    const existing = _maskCache.get(masked);
    if (existing !== undefined && existing !== s) {
        const word = DECOLIDE_WORDS[_decolideIdx++ % DECOLIDE_WORDS.length];
        const result = `${masked}-${word}`;
        _maskResult.set(s, result);
        return result;
    }
    _maskCache.set(masked, s);
    _maskResult.set(s, masked);
    return masked;
}
/** Reset per snapshot — fresh aliases each export, no cross-export correlation. */
function resetMaskCaches() {
    _maskCache.clear();
    _maskResult.clear();
    _decolideIdx = 0;
}

// Per-snapshot pseudonym context — fresh per snapshot, cardinality preserved
// so "entry X was selected → entry X hit cooldown" is still traceable.
// Title and vaultSource aliasing is SINGLE-SOURCED in `./pseudonymize-trace.js`
// (the only `<title-N>` / `<vault-N>` minter) — these thin wrappers just thread
// the per-snapshot `_pseudoCtx` into the shared, unit-tested aliasers.
let _pseudoCtx;
function pseudonymizeTitle(title) {
    return pseudonymizeTitlePure(_pseudoCtx, title);
}
function pseudonymizeVaultSource(vs) {
    return pseudonymizeVaultSourcePure(_pseudoCtx, vs);
}

/**
 * Summarize a VaultEntry to metadata only — NEVER `content` or `summary` body.
 * Titles and filenames are pseudonymized.
 */
function summarizeEntry(e) {
    if (!e || typeof e !== 'object') return null;
    return {
        title: pseudonymizeTitle(e.title),
        filename: pseudonymizeTitle(e.filename),
        vaultSource: pseudonymizeVaultSource(e.vaultSource),
        priority: e.priority,
        constant: !!e.constant,
        seed: !!e.seed,
        bootstrap: !!e.bootstrap,
        tokenEstimate: e.tokenEstimate,
        keyCount: Array.isArray(e.keys) ? e.keys.length : 0,
        hasSummary: !!(e.summary && e.summary.length),
        tagCount: Array.isArray(e.tags) ? e.tags.length : 0,
        requiresCount: Array.isArray(e.requires) ? e.requires.length : 0,
        excludesCount: Array.isArray(e.excludes) ? e.excludes.length : 0,
        linksCount: Array.isArray(e.links) ? e.links.length : 0,
        scanDepth: e.scanDepth ?? null,
        injectionPosition: e.injectionPosition ?? null,
        cooldown: e.cooldown ?? null,
        warmup: e.warmup ?? null,
        probability: e.probability ?? null,
        eraCount: Array.isArray(e.era) ? e.era.length : 0,
        locationCount: Array.isArray(e.location) ? e.location.length : 0,
    };
}

/** Map → plain object capped at `maxEntries`. Tracker keys (vaultSource:title)
 *  pseudonymize BOTH halves — vault name leaks identity just like titles. */
function mapToObj(m, maxEntries = 200) {
    if (!m || typeof m.entries !== 'function') return null;
    const out = {};
    let n = 0;
    for (const [k, v] of m.entries()) {
        if (n++ >= maxEntries) { out.__truncated = true; break; }
        const ks = String(k);
        const colonIdx = ks.indexOf(':');
        const safeKey = colonIdx >= 0
            ? `${pseudonymizeVaultSource(ks.slice(0, colonIdx))}:${pseudonymizeTitle(ks.slice(colonIdx + 1))}`
            : ks;
        out[safeKey] = v;
    }
    return out;
}

/**
 * Pseudonymize a pipeline trace using the per-snapshot context. Thin wrapper
 * around the pure `pseudonymizeTracePure()` — extracted so it can be
 * unit-tested without ST imports. See `./pseudonymize-trace.js` for the
 * scrubbing contract and gotchas.md #19 regression coverage.
 */
function pseudonymizeTrace(trace) {
    return pseudonymizeTracePure(trace, _pseudoCtx);
}

/** Inventory of installed third-party extensions, if available via getContext(). */
function extensionInventory() {
    try {
        const ctx = (typeof globalThis.SillyTavern?.getContext === 'function')
            ? globalThis.SillyTavern.getContext()
            : null;
        const ext = ctx?.extensionSettings || globalThis.extension_settings;
        if (!ext || typeof ext !== 'object') return null;
        return Object.keys(ext).sort();
    } catch { return null; }
}

/** chat_metadata snapshot — only DLE keys, only shape (no values). */
function chatMetadataSnapshot() {
    try {
        const cm = globalThis.chat_metadata || {};
        const dleKeys = Object.keys(cm).filter(k => k.startsWith('deeplore_'));
        const out = {};
        for (const k of dleKeys) {
            const v = cm[k];
            // Even DLE keys can hold user text — record shape only (type/length/key count).
            if (v == null) { out[k] = null; continue; }
            if (Array.isArray(v)) { out[k] = { __type: 'array', length: v.length }; continue; }
            if (typeof v === 'object') { out[k] = { __type: 'object', keys: Object.keys(v) }; continue; }
            if (typeof v === 'string') { out[k] = { __type: 'string', length: v.length }; continue; }
            out[k] = v;
        }
        return out;
    } catch { return null; }
}

function systemInfo() {
    try {
        // ST version comes from the #version_display element (set by ST at runtime).
        let stVersion = null;
        try {
            const el = document.querySelector('#version_display');
            if (el) stVersion = el.textContent?.trim() || null;
        } catch { /* noop */ }
        return {
            userAgent: (typeof navigator !== 'undefined') ? navigator.userAgent : null,
            language: (typeof navigator !== 'undefined') ? navigator.language : null,
            platform: (typeof navigator !== 'undefined') ? navigator.platform : null,
            url: (typeof location !== 'undefined') ? `${location.protocol}//${location.host}${location.pathname}` : null,
            screen: (typeof screen !== 'undefined') ? { w: screen.width, h: screen.height } : null,
            stVersion,
        };
    } catch { return null; }
}

/** Look up a connection profile by ID from ST's Connection Manager. */
function lookupProfile(profileId) {
    try {
        const ctx = (typeof globalThis.SillyTavern?.getContext === 'function')
            ? globalThis.SillyTavern.getContext() : null;
        const ext = ctx?.extensionSettings || globalThis.extension_settings;
        const profiles = ext?.connectionManager?.profiles;
        if (!Array.isArray(profiles) || !profileId) return null;
        return profiles.find(p => p.id === profileId) || null;
    } catch { return null; }
}

/** Summarize a ST connection profile for diagnostics (strip secrets, mask freeform names). */
function summarizeProfile(profile) {
    if (!profile) return null;
    return {
        id: profile.id,
        name: maskString(profile.name),
        api: profile.api,
        model: profile.model,
        preset: profile.preset,
        proxy: profile.proxy, // preset name, not URL
        instruct: profile.instruct,
        context: profile.context,
        tokenizer: profile.tokenizer,
        'api-url': stripUrlSecrets(profile['api-url']),  // strip userinfo creds; scrubber pseudonymizes the hostname
        'instruct-state': profile['instruct-state'],
        'reasoning-template': profile['reasoning-template'],
    };
}

function resolveApiMap(apiType) {
    try {
        const ctx = (typeof globalThis.SillyTavern?.getContext === 'function')
            ? globalThis.SillyTavern.getContext() : null;
        const map = ctx?.CONNECT_API_MAP;
        if (!map || !apiType) return null;
        const entry = map[apiType];
        if (!entry) return { __error: `'${apiType}' not in CONNECT_API_MAP` };
        return { selected: entry.selected, source: entry.source, type: entry.type };
    } catch { return null; }
}

/**
 * Resolved per-tool config + underlying ST profile objects + ST's active main API
 * state. Flags missing/stale profiles.
 */
function connectionSnapshot() {
    try {
        const toolKeys = ['aiSearch', 'scribe', 'autoSuggest', 'aiNotepad', 'librarian', 'optimizeKeys'];
        const tools = {};
        const seenProfileIds = new Set();
        const issues = [];

        for (const key of toolKeys) {
            try {
                const resolved = resolveConnectionConfig(key);
                const tool = {
                    effectiveMode: resolved.mode,
                    profileId: resolved.profileId || null,
                    proxyUrl: resolved.proxyUrl || null,
                    model: resolved.model || null,
                    maxTokens: resolved.maxTokens,
                    timeout: resolved.timeout,
                };

                if (resolved.mode === 'direct') {
                    // Direct API: report enough to diagnose (host, wire format,
                    // whether a key is present) and NOTHING that leaks the key.
                    // The URL can carry credentials in a query string, so only the
                    // host+path is surfaced, never the full URL.
                    tool.directFormat = resolveDirectFormat(resolved.apiUrl, resolved.apiFormat);
                    tool.directViaCorsProxy = !!resolved.apiViaCorsProxy;
                    tool.directHasKey = !!(resolved.apiKey || '').trim();
                    try {
                        const u = new URL(resolved.apiUrl);
                        tool.directEndpoint = `${u.protocol}//${u.host}${u.pathname}`;
                    } catch {
                        tool.directEndpoint = null;
                    }
                    if (!tool.directEndpoint) {
                        issues.push(`${key}: Direct API mode with no valid API URL`);
                    }
                    if (!resolved.model) {
                        issues.push(`${key}: Direct API mode requires a model name — none set`);
                    }
                }

                if (resolved.mode === 'profile' && resolved.profileId) {
                    const profile = lookupProfile(resolved.profileId);
                    if (!profile) {
                        tool.profileExists = false;
                        issues.push(`${key}: profileId '${resolved.profileId}' not found in Connection Manager`);
                    } else {
                        tool.profileExists = true;
                        tool.profileName = maskString(profile.name);
                        tool.profileApi = profile.api;
                        tool.profileModel = profile.model;
                        seenProfileIds.add(resolved.profileId);
                    }
                }

                tools[key] = tool;
            } catch (e) {
                tools[key] = { __error: String(e) };
            }
        }

        const profiles = {};
        for (const id of seenProfileIds) {
            const p = lookupProfile(id);
            if (p) profiles[id] = summarizeProfile(p);
        }

        const apiMapResolutions = {};
        for (const [id, prof] of Object.entries(profiles)) {
            if (prof?.api) {
                apiMapResolutions[id] = resolveApiMap(prof.api);
            }
        }

        // What 'inherit'/'st' mode actually hits.
        let stActiveConnection = null;
        try {
            const ctx = (typeof globalThis.SillyTavern?.getContext === 'function')
                ? globalThis.SillyTavern.getContext() : null;
            const oai = ctx?.chatCompletionSettings;
            stActiveConnection = {
                mainApi: ctx?.mainApi || null,
                chatCompletionSource: oai?.chat_completion_source || null,
                reverseProxy: stripUrlSecrets(oai?.reverse_proxy) || null,
                openrouterModel: oai?.openrouter_model || null,
                selectedModel: oai?.openai_model || null,
                claudeModel: oai?.claude_model || null,
            };
            const ext = ctx?.extensionSettings || globalThis.extension_settings;
            stActiveConnection.selectedProfileId = ext?.connectionManager?.selectedProfile || null;
            stActiveConnection.totalProfiles = Array.isArray(ext?.connectionManager?.profiles)
                ? ext.connectionManager.profiles.length : 0;
        } catch { /* noop */ }

        return {
            tools,
            profiles,
            apiMapResolutions,
            stActiveConnection,
            issues: issues.length > 0 ? issues : null,
        };
    } catch (e) { return { __error: String(e) }; }
}

/**
 * Build the full state snapshot. Returned NOT-yet-scrubbed — export pipeline
 * runs scrubDeep() on the whole thing before serializing.
 */
export function captureStateSnapshot() {
    // Fresh pseudonym/mask tables per snapshot — no cross-export correlation.
    _pseudoCtx = createPseudonymContext();
    resetMaskCaches();

    const snap = {
        capturedAt: new Date().toISOString(),
        capturedAtMs: Date.now(),
        system: systemInfo(),
        extensionInventory: extensionInventory(),
    };

    // Captured early so setupState/uiCascadeState reference the same object
    // (avoids double getSettings() TOCTOU). Scrubber redacts API keys by name.
    // #13c: `vaults[].name` IS the vaultSource (vault.js assigns
    // `entry.vaultSource = vault.name`), so it gets the same <vault-N> alias
    // entries carry in the trace/health sections. `host`/`url` are bare
    // hostnames/IPs the scrubber's `https?://` hostname pattern never sees, so
    // they're masked here. Shallow copies — live settings are never mutated.
    try {
        const rawSettings = getSettings();
        snap.settings = { ...rawSettings };
        if (Array.isArray(rawSettings.vaults)) {
            snap.settings.vaults = rawSettings.vaults.map(v => (v && typeof v === 'object') ? {
                ...v,
                name: pseudonymizeVaultSource(v.name),
                host: maskString(v.host),
                url: maskString(v.url),
            } : v);
        }
    } catch (e) { snap.settings = { __error: String(e) }; }

    try {
        const s = snap.settings && !snap.settings.__error ? snap.settings : getSettings();
        snap.setupState = {
            wizardCompleted: !!s._wizardCompleted,
            localStorageSentinel: typeof localStorage !== 'undefined' && localStorage.getItem('dle-wizard-completed') === '1',
            settingsVersion: s.settingsVersion ?? null,
            vaultsMigrated: !!s._vaultsMigrated,
            advancedVisibleMigrated: !!s._advancedVisibleMigratedD4,
            hasEnabledVaults: Array.isArray(s.vaults) ? s.vaults.some(v => v.enabled) : false,
            vaultCount: Array.isArray(s.vaults) ? s.vaults.length : 0,
            vaultSummary: Array.isArray(s.vaults) ? s.vaults.map(v => ({
                enabled: !!v.enabled,
                hasHost: !!(v.host || v.url),
                hasApiKey: !!(v.apiKey),
                // s.vaults is normally snap.settings.vaults, whose names are
                // already <vault-N> (#13c) — keep the alias so the summary
                // matches trace/health. The raw getSettings() fallback path
                // (settings capture __error'd) still masks defensively.
                name: (s === snap.settings ? v.name : maskString(v.name)) || null,
            })) : [],
            indexEverLoaded: state.indexEverLoaded,
            // Wizard done + no vaults enabled = likely skipped/partial setup.
            possiblyIncomplete: !!s._wizardCompleted && !(Array.isArray(s.vaults) && s.vaults.some(v => v.enabled)),
        };
    } catch (e) { snap.setupState = { __error: String(e) }; }

    try { snap.connections = connectionSnapshot(); } catch (e) { snap.connections = { __error: String(e) }; }

    // Derived UI cascade state — explains why specific controls are disabled/hidden.
    try {
        const s = snap.settings || {};
        snap.uiCascadeState = {
            maxEntries: { disabled: !!s.unlimitedEntries, reason: 'unlimitedEntries' },
            maxTokensBudget: { disabled: !!s.unlimitedBudget, reason: 'unlimitedBudget' },
            aiNotepadConnection: { hidden: s.aiNotepadMode === 'tag', reason: 'aiNotepadMode=tag' },
            keywordMatchingSettings: { disabled: s.aiSearchEnabled && s.aiSearchMode === 'ai-only', reason: 'aiSearchMode=ai-only' },
            scanDepth: { hidden: s.aiSearchEnabled && s.aiSearchMode === 'ai-only', reason: 'aiSearchMode=ai-only' },
            fuzzyMinScore: { hidden: !s.fuzzySearchEnabled, reason: 'fuzzySearchEnabled' },
            maxRecursion: { disabled: !s.recursiveScan, reason: 'recursiveScan' },
            stripLookback: { disabled: !s.stripDuplicateInjections, reason: 'stripDuplicateInjections' },
        };
    } catch (e) { snap.uiCascadeState = { __error: String(e) }; }

    try {
        snap.dleVersion = _cachedDleVersion || 'unknown';
    } catch { snap.dleVersion = 'unknown'; }

    try {
        const idx = state.vaultIndex || [];
        snap.vault = {
            entryCount: idx.length,
            indexTimestamp: state.indexTimestamp,
            indexEverLoaded: state.indexEverLoaded,
            indexing: state.indexing,
            buildPromiseActive: state.buildPromise !== null,
            buildEpoch: state.buildEpoch,
            syncActive: state.syncIntervalId !== null,
            avgTokens: state.vaultAvgTokens,
            constantCount: idx.filter(e => e.constant).length,
            seedCount: idx.filter(e => e.seed).length,
            bootstrapCount: idx.filter(e => e.bootstrap).length,
            withSummary: idx.filter(e => e.summary && e.summary.length).length,
            withRequires: idx.filter(e => Array.isArray(e.requires) && e.requires.length).length,
            withExcludes: idx.filter(e => Array.isArray(e.excludes) && e.excludes.length).length,
            withoutKeys: idx.filter(e => !Array.isArray(e.keys) || e.keys.length === 0).length,
            // First ~200 entries of metadata (oldest-first arbitrary order — fine for diag).
            entries: idx.slice(0, 200).map(summarizeEntry),
            entriesTruncated: idx.length > 200,
            folderDistribution: (state.folderList || []).map(f => ({
                path: pseudonymizeTitle(f.path || '?'),
                entryCount: f.entryCount ?? 0,
            })),
        };
    } catch (e) { snap.vault = { __error: String(e) }; }

    // Pipeline runtime state
    try {
        snap.pipeline = {
            generationCount: state.generationCount,
            chatEpoch: state.chatEpoch,
            cooldownTracker: mapToObj(state.cooldownTracker),
            chatInjectionCounts: mapToObj(state.chatInjectionCounts),
            consecutiveInjections: mapToObj(state.consecutiveInjections),
            decayTracker: mapToObj(state.decayTracker),
            injectionHistory: mapToObj(state.injectionHistory),
            generationLock: state.generationLock,
            generationLockEpoch: state.generationLockEpoch,
            generationLockTimestamp: state.generationLockTimestamp,
            lastIndexGenerationCount: state.lastIndexGenerationCount,
            lastWarningRatio: state.lastWarningRatio,
            notepadExtractInProgress: state.notepadExtractInProgress,
            scribeInProgress: state.scribeInProgress,
            lastScribeChatLength: state.lastScribeChatLength ?? null,
            hasLastScribeSummary: !!state.lastScribeSummary,
            perSwipeInjectedKeysCount: state.perSwipeInjectedKeys?.size ?? 0,
            verdict: (() => {
                const v = _currentVerdictForChat();
                return v ? {
                    genId: v.genId,
                    msgIdx: v.msgIdx,
                    epoch: v.epoch,
                    lockEpoch: v.lockEpoch,
                    ts: v.ts,
                    injectedSourceCount: v.injectedSources?.length ?? 0,
                    perEntryCount: v.perEntry?.length ?? 0,
                    epochMatchesChatEpoch: v.epoch === state.chatEpoch,
                    trace: pseudonymizeTrace(v.trace),
                } : null;
            })(),
            verdictRingDepth: _debugRingSnapshot().length,
        };
    } catch (e) { snap.pipeline = { __error: String(e) }; }

    try {
        snap.ai = {
            cache: state.aiSearchCache ? {
                hash: state.aiSearchCache.hash,
                manifestHash: state.aiSearchCache.manifestHash,
                chatLineCount: state.aiSearchCache.chatLineCount,
                resultCount: Array.isArray(state.aiSearchCache.results) ? state.aiSearchCache.results.length : 0,
            } : null,
            stats: state.aiSearchStats,
            circuit: {
                open: state.aiCircuitOpen,
                failures: state.aiCircuitFailures,
                openedAt: state.aiCircuitOpenedAt,
            },
        };
        if (state.claudeAutoEffortBad !== undefined) {
            snap.ai.claudeAutoEffortBad = state.claudeAutoEffortBad;
            snap.ai.claudeAutoEffortDetail = state.claudeAutoEffortDetail;
        }
    } catch (e) { snap.ai = { __error: String(e) }; }

    try {
        snap.librarian = {
            sessionStats: state.librarianSessionStats,
            chatStats: state.librarianChatStats,
            loreGapsCount: Array.isArray(state.loreGaps) ? state.loreGaps.length : 0,
            loreGapSearchCount: state.loreGapSearchCount,
        };
    } catch (e) { snap.librarian = { __error: String(e) }; }

    try {
        snap.matching = {
            entityNameSetSize: state.entityNameSet?.size ?? 0,
            entityRegexCount: state.entityShortNameRegexes?.size ?? 0,
            entityRegexVersion: state.entityRegexVersion,
            fieldDefinitionsCount: Array.isArray(state.fieldDefinitions) ? state.fieldDefinitions.length : 0,
            fieldDefinitionsLoaded: state.fieldDefinitionsLoaded,
            mentionWeightsCount: state.mentionWeights?.size ?? 0,
            fuzzySearchIndexBuilt: !!state.fuzzySearchIndex,
        };
    } catch (e) { snap.matching = { __error: String(e) }; }

    try {
        const s = snap.settings && !snap.settings.__error ? snap.settings : {};
        snap.autoSuggest = {
            enabled: !!s.autoSuggestEnabled,
            interval: s.autoSuggestInterval ?? null,
            messageCount: state.autoSuggestMessageCount ?? 0,
            messagesUntilTrigger: s.autoSuggestEnabled
                ? Math.max(0, (s.autoSuggestInterval ?? 10) - (state.autoSuggestMessageCount ?? 0))
                : null,
            skipReview: !!s.autoSuggestSkipReview,
            folder: s.autoSuggestFolder || null,
        };
    } catch (e) { snap.autoSuggest = { __error: String(e) }; }

    // Was the snapshot captured mid-generation?
    try {
        snap.staleness = {
            capturedDuringGeneration: !!state.generationLock,
            generationLockAgeMs: state.generationLock ? Date.now() - state.generationLockTimestamp : null,
            generationLockZombie: state.generationLock && (Date.now() - state.generationLockTimestamp > 60000),
            capturedDuringIndexBuild: !!state.indexing || state.buildPromise !== null,
        };
    } catch {}

    try {
        snap.vaultFetch = {
            lastVaultFailureCount: state.lastVaultFailureCount,
            lastVaultAttemptCount: state.lastVaultAttemptCount,
        };
    } catch {}
    try {
        const perVault = getAllCircuitStates();
        if (Object.keys(perVault).length > 0) {
            // Pseudonymize host:port keys to prevent IP/hostname leakage.
            const masked = {};
            let vaultIdx = 0;
            for (const [, val] of Object.entries(perVault)) {
                masked[`<vault-${++vaultIdx}>`] = val;
            }
            snap.obsidianCircuitBreakers = masked;
        } else {
            snap.obsidianCircuitBreakers = null;
        }
    } catch (e) { snap.obsidianCircuitBreakers = { __error: String(e) }; }

    try {
        const ctx = (typeof globalThis.SillyTavern?.getContext === 'function')
            ? globalThis.SillyTavern.getContext() : null;
        if (ctx) {
            const chatArr = ctx.chat;
            const lastMsg = Array.isArray(chatArr) && chatArr.length > 0 ? chatArr[chatArr.length - 1] : null;
            snap.chatContext = {
                characterId: ctx.characterId ?? null,
                characterName: maskString(ctx.name2) ?? null,
                groupId: ctx.groupId ?? null,
                isGroupChat: !!ctx.groupId,
                chatLength: Array.isArray(chatArr) ? chatArr.length : 0,
                lastMessageRole: lastMsg?.is_user ? 'user' : lastMsg?.is_system ? 'system' : lastMsg ? 'assistant' : null,
                lastMessageHasContent: lastMsg ? !!(lastMsg.mes && lastMsg.mes.length > 0) : null,
            };
        }
    } catch (e) { snap.chatContext = { __error: String(e) }; }

    try {
        if (snap.ai && typeof snap.ai === 'object' && !snap.ai.__error
            && state.aiSearchCache && state.entityRegexVersion !== undefined) {
            const cacheRegexVersion = state.aiSearchCache.entityRegexVersion;
            snap.ai.cacheRegexVersionMatch = cacheRegexVersion === state.entityRegexVersion;
            snap.ai.cacheRegexVersion = cacheRegexVersion;
            snap.ai.currentRegexVersion = state.entityRegexVersion;
        }
    } catch {}

    try {
        if (snap.librarian && typeof snap.librarian === 'object' && !snap.librarian.__error) {
            const cm = globalThis.chat_metadata || {};
            const hidden = cm.deeplore_lore_gaps_hidden;
            const dismissed = cm.deeplore_lore_gaps_dismissed;
            snap.librarian.gapsHiddenCount = Array.isArray(hidden) ? hidden.length : 0;
            snap.librarian.gapsDismissedCount = Array.isArray(dismissed) ? dismissed.length : 0;
        }
    } catch {}

    // Verifies pipeline output vs the prompts ST actually has registered.
    try {
        const ep = globalThis.extension_prompts || {};
        const dlePrompts = Object.entries(ep)
            .filter(([k]) => k.startsWith('deeplore'))
            .map(([k, v]) => ({ tag: k, length: (v?.value || '').length, position: v?.position, depth: v?.depth, role: v?.role }));
        snap.registeredPrompts = {
            count: dlePrompts.length,
            prompts: dlePrompts,
        };
    } catch (e) { snap.registeredPrompts = { __error: String(e) }; }

    // User-set gating metadata (not PII) — critical for "why didn't entry X fire?"
    try {
        const cm = globalThis.chat_metadata || {};
        const gatingCtx = cm.deeplore_context;
        if (gatingCtx && typeof gatingCtx === 'object') {
            snap.gatingContext = { ...gatingCtx };
            // characterPresent may contain character names.
            if (Array.isArray(snap.gatingContext.characterPresent)) {
                snap.gatingContext.characterPresent = snap.gatingContext.characterPresent.map(c => pseudonymizeTitle(c));
            }
        } else {
            snap.gatingContext = null;
        }
    } catch (e) { snap.gatingContext = { __error: String(e) }; }

    // #13a: health issues carry raw entry titles/keywords/vault names in
    // `entry` and `detail` — pseudonymize through the SAME per-snapshot context
    // as the trace, so "<title-N>" is stable across pipeline + health sections.
    try { snap.health = pseudonymizeHealthPure(runHealthCheck(), _pseudoCtx); } catch (e) { snap.health = { __error: String(e) }; }

    try { snap.chatMetadata = chatMetadataSnapshot(); } catch (e) { snap.chatMetadata = { __error: String(e) }; }

    // Real aliased-title / -vault counts from THIS snapshot's pseudonym context —
    // the single source the scrubber report reads to print "Titles: N" / "Vaults: N".
    // Captured last so it reflects every pseudonymizeTitle/VaultSource call above.
    // Read off the RAW snapshot before scrubDeep() (export.js) and stripped there,
    // so it never reaches the shared verbose blob.
    snap.__pseudonymStats = {
        titles: _pseudoCtx.titleCounter,
        vaults: _pseudoCtx.vaultSourceCounter,
    };

    return snap;
}
