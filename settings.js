import {
    extension_settings,
} from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { validateSettings } from './core/utils.js';
// Re-export pure migration helpers for call-site compatibility (index.js, tests).
// `runMigrations` and `PROXY_DEPRECATION_MODE_KEYS` live in the pure module so
// regression tests can import them without ST globals.
import { runMigrations, PROXY_DEPRECATION_MODE_KEYS } from './src/settings-migrations-pure.js';
export { runMigrations, PROXY_DEPRECATION_MODE_KEYS };

export const MODULE_NAME = 'deeplore_enhanced';

export const PROMPT_TAG = 'deeplore_enhanced';
export const PROMPT_TAG_PREFIX = 'deeplore_';

// AI search system prompt moved to src/i18n/prompts/en.js as
// AI_SEARCH_SYSTEM_PROMPT and resolved at call time via
// getPrompt('AI_SEARCH_SYSTEM_PROMPT'). See src/ai/ai.js and the editable-
// prompts feature (v2.5) for the new contract.

// AI Notepad instruction prompt moved to src/i18n/prompts/en.js as
// AI_NOTEPAD_PROMPT and resolved at call time via getPrompt('AI_NOTEPAD_PROMPT').
// See src/librarian/agentic-messages.js and index.js (notepad extraction)
// for the new contract.

export const defaultSettings = {
    enabled: false,
    obsidianPort: 27123,
    obsidianApiKey: '',
    lorebookTag: 'lorebook',
    constantTag: 'lorebook-always',
    neverInsertTag: 'lorebook-never',
    seedTag: 'lorebook-seed',
    bootstrapTag: 'lorebook-bootstrap',
    librarianGuideTag: 'lorebook-guide',
    newChatThreshold: 3,
    scanDepth: 4,
    maxEntries: 10,
    unlimitedEntries: false,
    maxTokensBudget: 3072,
    unlimitedBudget: false,
    injectionMode: 'extension', // 'extension' or 'prompt_list' (PM integration)
    injectionPosition: 1,   // extension_prompt_types.IN_CHAT
    injectionDepth: 4,
    injectionRole: 0,        // extension_prompt_roles.SYSTEM
    injectionTemplate: '<{{title}}>\n{{content}}\n</{{title}}>',
    allowWIScan: false,
    recursiveScan: false,
    maxRecursionSteps: 3,
    matchWholeWords: false,
    caseSensitive: false,
    cacheTTL: 300,
    reviewResponseTokens: 0,
    debugMode: false,
    // i18n: AI prompt locale (separate from UI locale). Empty = follow ST UI locale.
    // Values: '' (follow UI), 'en', 'es-es', 'fr-fr', 'de-de', 'ja-jp', 'zh-cn', 'ru-ru'.
    // Affects which translated default prompts the AI features use; user-overridden
    // prompt text (settings.aiSystemPrompt, scribePrompt, etc.) is unaffected.
    aiPromptLocale: '',
    // Editable prompts (v2.5): folder inside Obsidian vault where prompt
    // override .md files live. Default 'DeepLore/prompts/' — sibling to
    // field-definitions.yaml. Sanitized via sanitizePromptsFolderPath() before
    // every I/O call. Empty/null = use the default.
    promptsFolderPath: 'DeepLore/prompts/',
    // Author's Notebook (user-written)
    notebookEnabled: false,
    notebookPosition: 1,
    notebookDepth: 4,
    notebookRole: 0,
    // AI Notepad (AI-written session notes)
    aiNotepadEnabled: false,
    aiNotepadMode: 'tag',    // 'tag' = AI emits <dle-notes>; 'extract' = post-gen API call extracts notes
    aiNotepadPosition: 1,
    aiNotepadDepth: 4,
    aiNotepadRole: 0,
    aiNotepadPrompt: '',      // tag-mode instruction (empty = default)
    aiNotepadExtractPrompt: '', // extract-mode prompt (empty = default)
    aiNotepadConnectionMode: 'inherit', // 'inherit' | 'st' | 'profile' | 'direct' | 'proxy' (legacy)
    aiNotepadProfileId: '',
    aiNotepadProxyUrl: 'http://127.0.0.1:42069',
    aiNotepadApiUrl: '',
    aiNotepadApiKey: '',
    aiNotepadApiFormat: 'auto',
    aiNotepadApiViaCorsProxy: false,
    aiNotepadModel: '',
    aiNotepadMaxTokens: 1024,
    aiNotepadTimeout: 30000,
    // FIFO cap on AI Notepad entries (lines) per chat. New entries bump the oldest
    // non-pinned line when the cap is reached. 0 disables the entry cap (the legacy
    // 64KB char cap still applies as a backstop).
    aiNotepadMaxEntries: 50,
    // Bigram-Dice similarity threshold for the manual "Deduplicate" button in the
    // AI Notepad popup. 0.0 = identical only; 1.0 = exact strings; ~0.85 catches
    // near-duplicates without merging distinct notes that happen to share words.
    aiNotepadFuzzyDedupThreshold: 0.85,
    // AI Search
    aiSearchEnabled: false,
    aiSearchConnectionMode: 'profile',
    aiSearchProfileId: '',
    aiSearchProxyUrl: 'http://127.0.0.1:42069',
    // Direct API mode (v2.6.3): talk to an endpoint directly instead of going
    // through a SillyTavern Connection Profile. `aiSearchApiUrl` accepts a base
    // ('https://api.openai.com/v1') or a full endpoint; `aiSearchApiFormat` is
    // 'auto' | 'openai' | 'anthropic'; `aiSearchApiViaCorsProxy` re-routes
    // through ST's /proxy bridge for endpoints that refuse browser CORS.
    // NOTE: aiSearchModel is REQUIRED in direct mode — there is no profile to
    // read a model from.
    aiSearchApiUrl: '',
    aiSearchApiKey: '',
    aiSearchApiFormat: 'auto',
    aiSearchApiViaCorsProxy: false,
    aiSearchModel: '',
    aiSearchMaxTokens: 1024,
    aiSearchTimeout: 20000,
    aiSearchMode: 'two-stage',
    aiSearchScanDepth: 4,
    aiSearchSystemPrompt: '',
    aiSearchManifestSummaryLength: 600,
    aiSearchClaudeCodePrefix: false,
    aiForceUserRole: false, // merge system prompt into user message for providers that lack a system role
    scribeInformedRetrieval: false, // feed Scribe session summary into AI search context
    // Context Cartographer
    showLoreSources: true,
    // Session Scribe
    scribeEnabled: false,
    scribeInterval: 5,
    scribeFolder: 'Sessions',
    scribePrompt: '',
    scribeConnectionMode: 'inherit',
    scribeProfileId: '',
    scribeProxyUrl: 'http://127.0.0.1:42069',
    scribeApiUrl: '',
    scribeApiKey: '',
    scribeApiFormat: 'auto',
    scribeApiViaCorsProxy: false,
    scribeModel: '',
    scribeMaxTokens: 1024,
    scribeTimeout: 60000,
    scribeScanDepth: 20,
    // Vault name to write Scribe summaries to. '' = use primary (first enabled) vault.
    // The value is a vault.name string (vaults are identified by name, not numeric id).
    scribeWriteVaultId: '',
    // Vault Sync
    syncPollingInterval: 0,
    showSyncToasts: true,
    reinjectionCooldown: 0,
    // Auto Lorebook Creation
    autoSuggestEnabled: false,
    autoSuggestInterval: 10,
    autoSuggestConnectionMode: 'inherit',
    autoSuggestProfileId: '',
    autoSuggestProxyUrl: 'http://127.0.0.1:42069',
    autoSuggestApiUrl: '',
    autoSuggestApiKey: '',
    autoSuggestApiFormat: 'auto',
    autoSuggestApiViaCorsProxy: false,
    autoSuggestModel: '',
    autoSuggestMaxTokens: 2048,
    autoSuggestTimeout: 30000,
    autoSuggestFolder: '',
    autoSuggestPrompt: '',
    // Vault name to write auto-suggest entries to. '' = use primary vault.
    autoSuggestWriteVaultId: '',
    stripDuplicateInjections: true,
    stripLookbackDepth: 2,
    // BUG-AUDIT-H20: must match HTML <option value="keyword">, NOT "keyword-only".
    optimizeKeysMode: 'keyword',
    optimizeKeysPrompt: '',
    optimizeKeysConnectionMode: 'inherit',
    optimizeKeysProfileId: '',
    optimizeKeysProxyUrl: 'http://127.0.0.1:42069',
    optimizeKeysApiUrl: '',
    optimizeKeysApiKey: '',
    optimizeKeysApiFormat: 'auto',
    optimizeKeysApiViaCorsProxy: false,
    optimizeKeysModel: '',
    optimizeKeysMaxTokens: 1024,
    optimizeKeysTimeout: 30000,
    characterContextScan: false,
    // Fuzzy BM25 — TF-IDF supplement to keyword matching.
    fuzzySearchEnabled: false,
    fuzzySearchMinScore: 0.5,
    vaults: [],
    drawerPinned: false,
    drawerCompactTabs: false,              // false = icon + text (default), true = icon-only
    // Authoring leniency: parser auto-fixes case-mismatched field names, quoted numbers, and
    // comma-string keys, recording a warning. False = pre-v2 strict mode (silent drops).
    lenientAuthoring: true,
    advancedVisible: {},
    aiConfidenceThreshold: 'low',          // E1: low (all), medium (medium+high), high (high only)
    hierarchicalPreFilter: false,          // E2a: enable hierarchical category pre-filter for large candidate sets
    hierarchicalAggressiveness: 0.8,       // E2: 0.0 (keep all) to 0.8 (aggressive); min retention = 1 - this
    manifestSummaryMode: 'prefer_summary', // E8: prefer_summary, summary_only, content_only
    aiErrorFallback: 'keyword',            // E4: keyword, constants_only, bootstrap_only, none
    aiEmptyFallback: 'constants',          // E4: constants, constants_bootstrap, keyword, none
    contextualGatingTolerance: 'strict',   // E5: strict, moderate, lenient
    multiVaultConflictResolution: 'all',   // E6: all, first, last, merge
    keywordOccurrenceWeighting: false,     // E7
    indexRebuildTrigger: 'ttl',            // E9: ttl, generation, manual
    indexRebuildGenerationInterval: 10,
    autoSuggestSkipReview: false,          // E11
    promptPresets: {},                     // { [toolKey]: { [presetName]: promptText } }
    // Graph
    graphRepulsion: 0.3,               // FA2 repulsion coefficient (0.1-5.0)
    graphGravity: 11.0,                // FA2 strong gravity (0.1-20)
    graphDamping: 0.50,                // velocity damping (0.3-0.98)
    graphHoverDimDistance: 3,          // BFS hops kept visible on hover (0-8)
    graphHoverFalloff: 0.55,           // mirrors-and-lasers transmission per hop: E[d] = t^d (0.3-0.85). NOT a linear factor.
    graphHoverAmbient: 0.06,           // ambient floor for off-set elements (0.0-0.2)
    graphNodeSizeMode: 'centrality',   // centrality / priority / uniform
    graphFocusTreeDepth: 2,            // focus-tree N-hop depth (1-15)
    graphDefaultColorMode: 'type',     // type, priority, centrality, frequency
    graphShowLabels: true,
    graphEdgeFilterAlpha: 0.05,        // disparity-filter alpha (0.01-0.5, lower = sparser backbone)
    graphSavedLayout: null,            // { positions: {title: {x,y}}, timestamp }
    fieldDefinitionsPath: 'DeepLore/field-definitions.yaml',
    decayEnabled: false,
    decayBoostThreshold: 5,    // generations without injection before freshness boost
    decayPenaltyThreshold: 2,  // consecutive injections before frequency penalty
    // Librarian — defaults to OFF. Tools register at boot (registration happens before
    // extension_settings finishes loading), but shouldRegister() gates each generation
    // request on this flag. Users opt in via Settings → Features → Librarian.
    librarianEnabled: false,
    librarianSearchEnabled: true,       // search_lore tool (gated by librarianEnabled)
    librarianFlagEnabled: true,         // flag_lore tool (gated by librarianEnabled)
    librarianMaxSearches: 2,
    librarianMaxResults: 5,
    librarianResultTokenBudget: 1500,
    librarianAutoSendOnGap: true,
    librarianWriteFolder: '',
    // Default vault (by name) the Librarian writes new entries to. '' = primary.
    // Librarian popup also exposes a per-write override dropdown when multiple
    // vaults are configured.
    librarianWriteVaultId: '',
    librarianConnectionMode: 'inherit', // intentionally separate from aiSearchConnectionMode — see CLAUDE.md
    librarianProfileId: '',
    librarianProxyUrl: 'http://127.0.0.1:42069',
    librarianApiUrl: '',
    librarianApiKey: '',
    librarianApiFormat: 'auto',
    librarianApiViaCorsProxy: false,
    librarianModel: '',                  // blank = inherit from AI Search.
    librarianSessionMaxTokens: 4096,
    librarianSessionTimeout: 120000,    // 120s headroom — opus-4-6 forced-final-response with thinking can exceed 60s.
    // Hard caps on the Emma agentic loop, surfaced for users who hit them.
    librarianMaxToolCallsPerTurn: 10,
    librarianMaxValidationRetries: 3,
    librarianSessionHistoryMessages: 10,    // Emma's own session memory window
    librarianAgenticHistoryMessages: 40,    // writing-AI grounding window (buildChatMessages)
    librarianSessionToolCallCap: null,      // null = unlimited; otherwise total search+flag calls allowed per session
    librarianManifestMaxChars: 8000,
    librarianRelatedEntriesMaxChars: 4000,
    librarianDraftMaxChars: 4000,
    librarianChatContextMaxChars: 4000,
    librarianSystemPromptMode: 'default', // 'default' | 'append' | 'override' | 'strict-override'
    librarianCustomSystemPrompt: '',
    librarianShowToolCalls: true,
    // librarianPerMessageActivity: ON ties gap/flag records to messages (clear on new gen, keep on swipe, delete with msg).
    // OFF = legacy behavior (gaps accumulate, dropdowns ephemeral). See CLAUDE.md "non-obvious settings semantics".
    // Default flipped false→true in v2.5 Wave E — the OFF default showed new users stale accumulating
    // gaps + vanishing tool history. Existing users who persisted `false` keep it (their stored value wins).
    librarianPerMessageActivity: true,
    // #16: global priority-order toggle. false = lower priority number wins (Obsidian/WI convention).
    // true = higher wins. Affects pipeline budget allocation, Librarian view, Cartographer display.
    // Browse popup's explicit priority_asc/desc dropdown bypasses this — user-typed sort always wins literal.
    priorityReversed: false,
    // #18: when true, importEntries / upsertConvertedEntry caveman-compress each entry's body
    // before writing to the vault. Per-import option can still override per call. Stored
    // entries are annotated with `compress: caveman` in frontmatter for audit.
    importCompressByDefault: false,
    // Wave 4 (WI parity): how WI import handles Example Messages entries (ST
    // position 5 = before_example_messages, 6 = after_example_messages). DLE
    // has no EM injection slot, so:
    //   'append' (default) — convert to normal entry, prepend "## Example
    //     Dialogue" subheader to the body, map injection position to before/
    //     after based on original ST value. Most natural for character entries
    //     where a flavor quote helps the LLM nail the voice.
    //   'skip' — drop these entries entirely. Most users find a single flavor
    //     line inside the parent character entry is enough; ST's EM slot is
    //     often noise once the model has the character description.
    // Per-import override available via importEntries options.
    wiImportEmHandling: 'append',
    // Custom Fields in AI Manifest: whitelist of custom-field names sent to the AI
    // alongside each candidate entry. Empty array = include ALL custom fields with
    // values (current behavior). Populate to prune the manifest for token control —
    // e.g. ['era', 'faction'] sends only those even if entries have more.
    aiManifestIncludeFields: [],
    // DLE-Side Response Prefill: inject seed text as the last assistant message so
    // the writing AI continues from it instead of starting with "Certainly, here's…".
    // Mode: off (no injection), anthropic-only (only when underlying model is Claude
    // — native prefill behavior), all-providers (applies to every chat-completion
    // source — some accept it as continuation, others may ignore).
    responsePrefillSeed: '',
    responsePrefillMode: 'off',
    // #15: dedicated summary feature — /dle-summarize-range AI prompt + budgets.
    summarySystemPrompt: '',     // empty = use built-in default in summarize.js
    summaryMaxTokens: 400,
    summaryTimeout: 30000,
    analyticsData: {},
    _wizardCompleted: false,
    // Increment to trigger migrations in runMigrations().
    settingsVersion: 5,
};

/**
 * Per-tool settings-key map for resolveConnectionConfig().
 *
 * `apiUrl` / `apiKey` / `apiFormat` / `apiViaCorsProxy` back the Direct API
 * connection mode (v2.6.3) — the endpoint DLE calls itself, with no Connection
 * Profile in the path.
 */
const TOOL_SETTINGS_KEYS = {
    aiSearch:    { mode: 'aiSearchConnectionMode', profileId: 'aiSearchProfileId', proxyUrl: 'aiSearchProxyUrl', model: 'aiSearchModel', maxTokens: 'aiSearchMaxTokens', timeout: 'aiSearchTimeout', apiUrl: 'aiSearchApiUrl', apiKey: 'aiSearchApiKey', apiFormat: 'aiSearchApiFormat', apiViaCorsProxy: 'aiSearchApiViaCorsProxy' },
    scribe:     { mode: 'scribeConnectionMode', profileId: 'scribeProfileId', proxyUrl: 'scribeProxyUrl', model: 'scribeModel', maxTokens: 'scribeMaxTokens', timeout: 'scribeTimeout', apiUrl: 'scribeApiUrl', apiKey: 'scribeApiKey', apiFormat: 'scribeApiFormat', apiViaCorsProxy: 'scribeApiViaCorsProxy' },
    autoSuggest: { mode: 'autoSuggestConnectionMode', profileId: 'autoSuggestProfileId', proxyUrl: 'autoSuggestProxyUrl', model: 'autoSuggestModel', maxTokens: 'autoSuggestMaxTokens', timeout: 'autoSuggestTimeout', apiUrl: 'autoSuggestApiUrl', apiKey: 'autoSuggestApiKey', apiFormat: 'autoSuggestApiFormat', apiViaCorsProxy: 'autoSuggestApiViaCorsProxy' },
    aiNotepad:  { mode: 'aiNotepadConnectionMode', profileId: 'aiNotepadProfileId', proxyUrl: 'aiNotepadProxyUrl', model: 'aiNotepadModel', maxTokens: 'aiNotepadMaxTokens', timeout: 'aiNotepadTimeout', apiUrl: 'aiNotepadApiUrl', apiKey: 'aiNotepadApiKey', apiFormat: 'aiNotepadApiFormat', apiViaCorsProxy: 'aiNotepadApiViaCorsProxy' },
    librarian:  { mode: 'librarianConnectionMode', profileId: 'librarianProfileId', proxyUrl: 'librarianProxyUrl', model: 'librarianModel', maxTokens: 'librarianSessionMaxTokens', timeout: 'librarianSessionTimeout', apiUrl: 'librarianApiUrl', apiKey: 'librarianApiKey', apiFormat: 'librarianApiFormat', apiViaCorsProxy: 'librarianApiViaCorsProxy' },
    optimizeKeys: { mode: 'optimizeKeysConnectionMode', profileId: 'optimizeKeysProfileId', proxyUrl: 'optimizeKeysProxyUrl', model: 'optimizeKeysModel', maxTokens: 'optimizeKeysMaxTokens', timeout: 'optimizeKeysTimeout', apiUrl: 'optimizeKeysApiUrl', apiKey: 'optimizeKeysApiKey', apiFormat: 'optimizeKeysApiFormat', apiViaCorsProxy: 'optimizeKeysApiViaCorsProxy' },
};
/**
 * Resolve effective connection config. `inherit` mode pulls mode+profileId from aiSearch and
 * cascades model/proxyUrl (tool's own value wins if set, else aiSearch's). maxTokens/timeout
 * are always the tool's own — those tune the per-feature behavior, not the shared connection.
 *
 * Direct API mode (v2.6.3): in `inherit` mode ALL FOUR direct fields come from
 * AI Search — a tool's own apiUrl/apiKey are ignored until it explicitly selects
 * `direct` itself. Two reasons. (1) The UI only shows a tool's direct fields in
 * direct mode, so a per-field cascade would silently route an "inheriting" tool
 * to a stale endpoint the user can't see. (2) Mixing them — AI Search's key with
 * the tool's URL — would post one provider's credential to another. The per-tool
 * MODEL override still applies (same endpoint, different model), which is the
 * override people actually want.
 *
 * @param {string} toolKey  'aiSearch' | 'scribe' | 'autoSuggest' | 'aiNotepad' | 'librarian' | 'optimizeKeys'
 * @returns {{ mode: string, profileId: string, proxyUrl: string, model: string, maxTokens: number,
 *            timeout: number, apiUrl: string, apiKey: string, apiFormat: string, apiViaCorsProxy: boolean }}
 */
export function resolveConnectionConfig(toolKey) {
    const s = getSettings();
    const keys = TOOL_SETTINGS_KEYS[toolKey];
    if (!keys) throw new Error(`[DLE] Unknown tool key for connection config: ${toolKey}`);

    const mode = s[keys.mode];
    const toolModel = s[keys.model] || '';
    const toolProxyUrl = s[keys.proxyUrl] || '';
    const maxTokens = s[keys.maxTokens];
    const timeout = s[keys.timeout];

    /** The four direct-API fields, taken from whichever tool owns the endpoint. */
    const directFrom = (k) => ({
        apiUrl: (s[k.apiUrl] || '').trim(),
        apiKey: s[k.apiKey] || '',
        apiFormat: s[k.apiFormat] || 'auto',
        apiViaCorsProxy: !!s[k.apiViaCorsProxy],
    });

    if (mode === 'inherit' && toolKey !== 'aiSearch') {
        const ai = TOOL_SETTINGS_KEYS.aiSearch;
        return {
            mode: s[ai.mode],
            profileId: s[ai.profileId],
            proxyUrl: toolProxyUrl || s[ai.proxyUrl],
            model: toolModel || s[ai.model],
            maxTokens,
            timeout,
            ...directFrom(ai),
        };
    }

    return {
        mode,
        profileId: s[keys.profileId],
        proxyUrl: toolProxyUrl || defaultSettings[keys.proxyUrl],
        model: toolModel,
        maxTokens,
        timeout,
        ...directFrom(keys),
    };
}

// runMigrations + PROXY_DEPRECATION_MODE_KEYS now live in
// src/settings-migrations-pure.js so they're importable in test envs without
// pulling in ST globals. Re-exported at the top of this file.

/** Numeric range constraints + enum whitelists for validateSettings(). */
export const settingsConstraints = {
    obsidianPort: { min: 1, max: 65535 },
    scanDepth: { min: 0, max: 100 },
    maxEntries: { min: 1, max: 100 },
    maxTokensBudget: { min: 100, max: 100000 },
    injectionDepth: { min: 0, max: 9999 },
    notebookDepth: { min: 0, max: 9999 },
    aiNotepadDepth: { min: 0, max: 9999 },
    maxRecursionSteps: { min: 1, max: 10 },
    cacheTTL: { min: 0, max: 86400 },
    reviewResponseTokens: { min: 0, max: 100000 },
    aiNotepadMaxTokens: { min: 256, max: 8192 },
    aiNotepadTimeout: { min: 5000, max: 999999 },
    aiNotepadMaxEntries: { min: 0, max: 1000 },
    aiNotepadFuzzyDedupThreshold: { min: 0.1, max: 1 },
    librarianMaxToolCallsPerTurn: { min: 1, max: 50 },
    librarianMaxValidationRetries: { min: 0, max: 10 },
    librarianSessionHistoryMessages: { min: 5, max: 100 },
    librarianAgenticHistoryMessages: { min: 10, max: 200 },
    librarianSessionToolCallCap: { min: 0, max: 1000 },
    aiSearchMaxTokens: { min: 64, max: 4096 },
    aiSearchTimeout: { min: 1000, max: 999999 },
    aiSearchScanDepth: { min: 1, max: 100 },
    aiSearchManifestSummaryLength: { min: 100, max: 1000 },
    scribeInterval: { min: 1, max: 50 },
    scribeMaxTokens: { min: 256, max: 4096 },
    scribeTimeout: { min: 5000, max: 999999 },
    scribeScanDepth: { min: 5, max: 100 },
    newChatThreshold: { min: 1, max: 20 },
    syncPollingInterval: { min: 0, max: 3600 },
    reinjectionCooldown: { min: 0, max: 50 },
    stripLookbackDepth: { min: 1, max: 10 },
    autoSuggestInterval: { min: 3, max: 50 },
    autoSuggestMaxTokens: { min: 256, max: 4096 },
    autoSuggestTimeout: { min: 5000, max: 999999 },
    optimizeKeysMaxTokens: { min: 256, max: 8192 },
    optimizeKeysTimeout: { min: 5000, max: 999999 },
    graphRepulsion: { min: 0.1, max: 5.0 },
    graphGravity: { min: 0.1, max: 20 },
    graphDamping: { min: 0.3, max: 0.98 },
    graphHoverDimDistance: { min: 0, max: 15 },
    graphHoverFalloff: { min: 0.3, max: 0.85 },
    graphHoverAmbient: { min: 0.0, max: 0.2 },
    graphFocusTreeDepth: { min: 1, max: 15 },
    graphEdgeFilterAlpha: { min: 0.01, max: 0.5 },
    decayBoostThreshold: { min: 2, max: 20 },
    decayPenaltyThreshold: { min: 2, max: 10 },
    librarianMaxSearches: { min: 1, max: 10 },
    librarianMaxResults: { min: 1, max: 20 },
    librarianResultTokenBudget: { min: 500, max: 5000 },
    librarianSessionMaxTokens: { min: 1024, max: 16384 },
    librarianSessionTimeout: { min: 10000, max: 999999 },
    // BUG-335: librarian *MaxChars previously had no constraints; "4000" string coerced to NaN.
    librarianManifestMaxChars: { min: 0, max: 200000 },
    librarianRelatedEntriesMaxChars: { min: 0, max: 200000 },
    librarianDraftMaxChars: { min: 0, max: 200000 },
    librarianChatContextMaxChars: { min: 0, max: 200000 },
    fuzzySearchMinScore: { min: 0.1, max: 2.0 },
    hierarchicalAggressiveness: { min: 0.0, max: 0.8 },
    indexRebuildGenerationInterval: { min: 1, max: 100 },
    // BUG-344: string-enum whitelist — validateSettings resets to defaults on mismatch.
    injectionMode: { enum: ['extension', 'prompt_list'] },
    // L-41: aiSearch is the inheritance ROOT — it must never be 'inherit' (a tool
    // resolving 'inherit' cascades to s[aiSearch.mode]; if that were 'inherit' too,
    // callAI receives 'inherit' and throws "unknown connection mode"). The UI only
    // offers profile/proxy for the root (settings-ui.js supportedModes), but without
    // an enum whitelist an import/migration could land 'inherit'/'st'. Reset to the
    // 'profile' default on mismatch.
    aiSearchConnectionMode: { enum: ['profile', 'direct', 'proxy'] },
    librarianConnectionMode: { enum: ['inherit', 'profile', 'direct', 'proxy'] },
    librarianSystemPromptMode: { enum: ['default', 'append', 'override', 'strict-override'] },
    // BUG-AUDIT (Fix 12): missing whitelist would let invalid imports/migrations land an
    // unrecognized value, which deduplicateMultiVault then silently treated like 'first'
    // (drop duplicates instead of preserving). Safe default 'all' restored on mismatch.
    multiVaultConflictResolution: { enum: ['all', 'first', 'last', 'merge'] },
    responsePrefillMode: { enum: ['off', 'anthropic-only', 'all-providers'] },
    aiSearchApiFormat: { enum: ['auto', 'openai', 'anthropic'] },
    scribeApiFormat: { enum: ['auto', 'openai', 'anthropic'] },
    autoSuggestApiFormat: { enum: ['auto', 'openai', 'anthropic'] },
    aiNotepadApiFormat: { enum: ['auto', 'openai', 'anthropic'] },
    librarianApiFormat: { enum: ['auto', 'openai', 'anthropic'] },
    optimizeKeysApiFormat: { enum: ['auto', 'openai', 'anthropic'] },
};

// BUG-088: settings cache REMOVED. ST's native pattern is direct read of
// `extension_settings[MODULE_NAME]`; a cache flag required every mutator to remember
// invalidateSettingsCache(), which drifted. All getSettings() passes are now idempotent
// — numeric coercion, default-fill (=== undefined gate), validateSettings (clamps in
// place), migrations (self-gated by settingsVersion), vaults SSOT mirror, and the
// vaults[] migration (guarded by _vaultsMigrated) — so running them on every call is
// safe and cheap (~60-key scan). invalidateSettingsCache is kept as a no-op for
// call-site compatibility; removing it would touch every feature.

/** No-op (BUG-088). Retained for call-site compatibility. */
export function invalidateSettingsCache() {
    /* no-op — see BUG-088 comment above */
}

/** @returns {typeof defaultSettings} */
export function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    const s = extension_settings[MODULE_NAME];

    // BUG-071: coerce string-typed numbers (e.g. JSON imports) or reset to default if non-numeric.
    // Skip null — used as a sentinel meaning "unset / unlimited" for some keys
    // (e.g. librarianSessionToolCallCap). Without this skip, Number(null) === 0
    // would silently persist 0, which downstream code may treat as a hard cap.
    for (const key of Object.keys(settingsConstraints)) {
        // Enum keys are validated by validateSettings() below.
        if (Array.isArray(settingsConstraints[key].enum)) continue;
        if (s[key] !== undefined && s[key] !== null && typeof s[key] !== 'number') {
            const num = Number(s[key]);
            if (!Number.isNaN(num)) {
                s[key] = num;
            } else {
                s[key] = defaultSettings[key];
            }
        }
    }

    // Fill missing defaults — idempotent, only touches undefined keys.
    // L-37: ALSO re-fill when the default is an OBJECT/array but the stored value is
    // null. A persisted `null` (corrupt import / manual edit) survived the
    // `=== undefined` gate, and a null `analyticsData` then threw in
    // `Object.hasOwn(null, …)` at commit — surfacing a misleading "Couldn't load
    // your lore" toast even though lore was injected. Numeric/string/boolean
    // null-sentinels (e.g. librarianSessionToolCallCap) are left untouched.
    for (const [key, value] of Object.entries(defaultSettings)) {
        const defaultIsObject = (typeof value === 'object' && value !== null);
        if (s[key] === undefined || (defaultIsObject && s[key] === null)) {
            s[key] = defaultIsObject
                ? JSON.parse(JSON.stringify(value))
                : value;
        }
    }
    validateSettings(s, settingsConstraints, defaultSettings);

    const currentVersion = defaultSettings.settingsVersion;
    const storedVersion = s.settingsVersion || 0;
    if (storedVersion < currentVersion) {
        runMigrations(s, storedVersion, currentVersion);
        s.settingsVersion = currentVersion;
        // Re-validate post-migration — mutated values must be clamped against the current whitelist before first use.
        validateSettings(s, settingsConstraints, defaultSettings);
        try { saveSettingsDebounced(); } catch { /* may not be available pre-init */ }
    }

    // Multi-vault migration: legacy obsidianPort+apiKey → vaults[0]. Requires apiKey to avoid
    // phantom vaults for brand-new users (default port is always set, apiKey signals real config).
    let _migrationDirty = false;
    if (!s._vaultsMigrated && (!Array.isArray(s.vaults) || s.vaults.length === 0) && s.obsidianPort && s.obsidianApiKey) {
        // BUG-339: 27124 is Obsidian Local REST API's HTTPS default; other ports default to HTTP.
        s.vaults = [{
            name: 'Primary',
            host: '127.0.0.1',
            port: s.obsidianPort,
            apiKey: s.obsidianApiKey || '',
            https: s.obsidianPort === 27124,
            enabled: true,
        }];
        s._vaultsMigrated = true;
        _migrationDirty = true;
    }

    // Backfill `host` on legacy vault entries (added when remote Obsidian became supported).
    if (Array.isArray(s.vaults)) {
        for (const v of s.vaults) {
            if (!v.host) { v.host = '127.0.0.1'; _migrationDirty = true; }
        }
    }
    if (_migrationDirty) {
        try { saveSettingsDebounced(); } catch { /* may not be available pre-init */ }
    }

    // BUG-075: vaults[primary] is the SSOT for obsidianPort and obsidianApiKey. Mirror runs every
    // getSettings() call so any code path mutating vaults[0] (or vice versa) can't cause drift.
    // vaults[] wins on conflict.
    if (Array.isArray(s.vaults) && s.vaults.length > 0) {
        const primary = s.vaults.find(v => v.enabled) || s.vaults[0];
        if (primary) {
            if (typeof primary.port === 'number' && s.obsidianPort !== primary.port) {
                s.obsidianPort = primary.port;
            }
            if (typeof primary.apiKey === 'string' && s.obsidianApiKey !== primary.apiKey) {
                s.obsidianApiKey = primary.apiKey;
            }
        }
    }

    return s;
}

/**
 * First enabled vault, or a disabled-default placeholder.
 * @param {typeof defaultSettings} [settings]
 * @returns {{ name: string, port: number, apiKey: string, enabled: boolean }}
 */
export function getPrimaryVault(settings) {
    const s = settings || getSettings();
    return (s.vaults && s.vaults.find(v => v.enabled)) || s.vaults?.[0] || { name: 'Default', host: '127.0.0.1', port: 27123, apiKey: '', https: false, enabled: false };
}

/**
 * Resolve vault by name (entry's vaultSource), falling back to primary if unknown/disabled.
 * @param {typeof defaultSettings} settings
 * @param {string} vaultName
 * @returns {{ name: string, port: number, apiKey: string, enabled: boolean }}
 */
export function getVaultByName(settings, vaultName) {
    if (vaultName && settings.vaults) {
        const match = settings.vaults.find(v => v.name === vaultName && v.enabled);
        if (match) return match;
    }
    return getPrimaryVault(settings);
}

const WRITE_VAULT_KEYS = {
    librarian: 'librarianWriteVaultId',
    scribe: 'scribeWriteVaultId',
    autoSuggest: 'autoSuggestWriteVaultId',
};

/**
 * Resolve which vault a write-capable tool should target.
 *
 * Precedence: explicit override (per-write picker) > tool's configured default
 * (settings.{tool}WriteVaultId) > primary enabled vault. Each step falls back
 * to the next on miss/disabled — never throws so writes can't fail because
 * config drifted from the vault list.
 *
 * @param {'librarian'|'scribe'|'autoSuggest'} toolKey
 * @param {typeof defaultSettings} [settings]
 * @param {string} [overrideName]  Per-call override (e.g. Librarian popup picker)
 * @returns {{ name: string, host: string, port: number, apiKey: string, https: boolean, enabled: boolean }}
 */
export function resolveWriteVault(toolKey, settings, overrideName) {
    const s = settings || getSettings();
    if (overrideName) {
        const match = s.vaults?.find(v => v.name === overrideName && v.enabled);
        if (match) return match;
    }
    const key = WRITE_VAULT_KEYS[toolKey];
    const configuredName = key ? s[key] : '';
    if (configuredName) {
        const match = s.vaults?.find(v => v.name === configuredName && v.enabled);
        if (match) return match;
    }
    return getPrimaryVault(s);
}
