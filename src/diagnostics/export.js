/**
 * export.js — Build the diagnostic markdown report.
 *
 * Output shape:
 *   1. Header / privacy (plaintext — humans read this on GitHub)
 *   2. Scrubber report (plaintext — what was redacted)
 *   3. Summary data section (plaintext, scrubbed)
 *   4. AI instructions block (base64 — schema, form, patterns)
 *   5. ---DLE-DATA-BEGIN---
 *      base64(gzip(JSON(verbose data, scrubbed)))
 *      ---DLE-DATA-END---
 */

import { scrubDeep, makeCtx } from './scrubber.js';
import { TRACE_ENTRY_ARRAY_KEYS } from './pseudonymize-trace.js';
import { captureStateSnapshot } from './state-snapshot.js';
import { consoleBuffer, networkBuffer, errorBuffer, eventBuffer, aiCallBuffer, aiPromptBuffer, installFailures } from './interceptors.js';
import { generationBuffer } from './flight-recorder.js';
import { longTaskBuffer, captureMemorySnapshot } from './performance.js';

const ISSUE_URL = 'https://github.com/pixelnull/sillytavern-DeepLore/issues/new';

/** Length-only descriptor for a redacted prompt/chat body. */
function redactedLen(v) {
    return typeof v === 'string' ? `[redacted len=${v.length}]` : v;
}

/**
 * Redact the prose bodies of a captured AI-prompt log entry to metadata only.
 * `systemPrompt` / `userMessage` / `response` string bodies become
 * `[redacted len=N]`; everything else (timestamps, caller, model, error) is
 * passed through. Full prose can never reach the export JSON.
 *
 * @param {object} entry
 * @returns {object}
 */
export function redactAiPromptEntry(entry) {
    if (!entry || typeof entry !== 'object') return entry;
    const out = { ...entry };
    if ('systemPrompt' in out) out.systemPrompt = redactedLen(out.systemPrompt);
    if ('userMessage' in out) out.userMessage = redactedLen(out.userMessage);
    if ('response' in out) out.response = redactedLen(out.response);
    return out;
}

/**
 * gzip + base64 via CompressionStream. Falls back to uncompressed base64 on
 * Safari <16.4 / Firefox <113 / compression failure.
 */
async function gzipBase64(str) {
    if (typeof CompressionStream === 'undefined') {
        return { b64: btoa(unescape(encodeURIComponent(str))), compressed: false };
    }
    try {
        const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
        const buf = await new Response(stream).arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        const CHUNK = 0x8000; // chunked to avoid stack overflow on large inputs
        for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return { b64: btoa(bin), compressed: true };
    } catch {
        return { b64: btoa(unescape(encodeURIComponent(str))), compressed: false };
    }
}

/** Build a compact, human-readable summary section for the top of the report. */
function buildSummarySection(snapshot, scrubbedGenerations) {
    const lines = [];
    const push = (s) => lines.push(s);

    const issues = { critical: [], warning: [] };

    push('## Summary Data (human-readable)');
    push('');
    push(`- Captured: ${snapshot.capturedAt}`);
    const dleVer = snapshot.dleVersion || 'unknown';
    push(`- DLE version: ${dleVer === 'unknown' ? '**unknown** ⚠' : dleVer}`);
    if (dleVer === 'unknown') issues.warning.push('DLE version unknown');
    if (snapshot.system) {
        const stVer = snapshot.system.stVersion;
        push(`- ST version: ${stVer || '**unknown** ⚠'}`);
        push(`- Browser: ${snapshot.system.userAgent || 'unknown'}`);
        push(`- URL: ${snapshot.system.url || 'unknown'}`);
    }
    if (snapshot.staleness?.capturedDuringGeneration) {
        push(`- **WARNING: Snapshot captured during active generation** (lock held ${Math.round((snapshot.staleness.generationLockAgeMs || 0) / 1000)}s)`);
    }
    push('');

    if (snapshot.setupState) {
        push('### Setup');
        const ss = snapshot.setupState;
        const wizardStatus = ss.wizardCompleted ? '✓ completed' : '**not completed**';
        push(`- Wizard: ${wizardStatus} | Settings v${ss.settingsVersion ?? '?'}`);
        if (ss.wizardCompleted && !ss.localStorageSentinel) push('  - ⚠ localStorage sentinel missing (wizard completed in settings but not localStorage)');
        if (ss.possiblyIncomplete) { push('  - **⚠ Wizard marked complete but no vaults enabled** — likely skipped or partial setup'); issues.critical.push('Wizard complete but no vaults enabled'); }
        push(`- Vaults configured: ${ss.vaultCount} (${ss.vaultSummary?.filter(v => v.enabled).length || 0} enabled)`);
        if (ss.vaultSummary?.length > 0) {
            for (const [i, v] of ss.vaultSummary.entries()) {
                const status = v.enabled ? '✓' : '✗';
                const issues = [];
                if (!v.hasHost) issues.push('no host');
                if (!v.hasApiKey) issues.push('no API key');
                push(`  - Vault ${i}: ${status} ${v.name || '(unnamed)'}${issues.length ? ` — **${issues.join(', ')}**` : ''}`);
            }
        }
        if (ss.vaultsMigrated || !ss.indexEverLoaded) {
            if (ss.vaultsMigrated) push('- Migrated from legacy vault format');
            if (!ss.indexEverLoaded) push('- **Index never loaded** — vault may not be reachable');
        }
        push('');
    }

    if (snapshot.connections) {
        push('### Connections');
        const conn = snapshot.connections;

        if (conn.stActiveConnection) {
            const st = conn.stActiveConnection;
            push(`- **ST active:** ${st.mainApi || '?'} → ${st.chatCompletionSource || '?'} (${st.totalProfiles} profiles configured)`);
            if (st.reverseProxy) push(`  - Reverse proxy: ${st.reverseProxy}`);
            if (st.selectedModel) push(`  - Model: ${st.selectedModel}`);
            if (st.claudeModel) push(`  - Claude model: ${st.claudeModel}`);
            if (st.openrouterModel) push(`  - OpenRouter model: ${st.openrouterModel}`);
        }
        push('');

        if (conn.tools) {
            push('| Tool | Mode | Target | Model | Timeout | Status |');
            push('|------|------|--------|-------|---------|--------|');

            const aiMode = conn.tools.aiSearch?.effectiveMode;
            const aiProfileId = conn.tools.aiSearch?.profileId;

            for (const [key, t] of Object.entries(conn.tools)) {
                if (t.__error) {
                    push(`| ${key} | ⚠ ERROR | — | — | — | ${t.__error} |`);
                    continue;
                }
                const mode = t.effectiveMode || '?';
                let target = '—';
                let status = '✓';
                let inherited = '';

                // Same resolved mode+profileId as aiSearch → inherited.
                if (key !== 'aiSearch' && mode === aiMode && t.profileId === aiProfileId) {
                    inherited = ' ↑';
                }

                if (mode === 'profile') {
                    target = t.profileName || t.profileId || '(none)';
                    if (t.profileExists === false) {
                        status = '**❌ MISSING**';
                        issues.critical.push(`${key}: connection profile missing`);
                    }
                } else if (mode === 'direct') {
                    // Host+path only — the key never appears, and a URL with a
                    // query-string credential was already stripped upstream.
                    target = t.directEndpoint || '(no URL)';
                    if (t.directFormat) target += ` [${t.directFormat}${t.directViaCorsProxy ? ' via ST proxy' : ''}]`;
                    if (!t.directEndpoint) {
                        status = '**❌ NO URL**';
                        issues.critical.push(`${key}: Direct API mode with no API URL`);
                    } else if (!t.directHasKey) {
                        status = '⚠ no key';
                    }
                } else if (mode === 'proxy') {
                    target = t.proxyUrl || '(no URL)';
                }
                const model = t.model || t.profileModel || '(default)';
                const timeout = t.timeout ? `${Math.round(t.timeout / 1000)}s` : '—';
                push(`| ${key} | ${mode}${inherited} | ${target} | ${model} | ${timeout} | ${status} |`);
            }
            const inheritCount = Object.entries(conn.tools).filter(([k, t]) => k !== 'aiSearch' && t.effectiveMode === aiMode && t.profileId === aiProfileId).length;
            if (inheritCount > 0) push(`\n_↑ = inherited from aiSearch_`);
        }

        if (conn.issues && conn.issues.length > 0) {
            push('');
            push('**⚠ Connection Issues:**');
            for (const issue of conn.issues) push(`- ${issue}`);
        }
        push('');
    }

    if (snapshot.chatContext) {
        push('### Chat Context');
        const cc = snapshot.chatContext;
        push(`- ${cc.isGroupChat ? `Group chat (groupId: ${cc.groupId})` : `1-on-1 with ${cc.characterName || '?'}`} (characterId: ${cc.characterId ?? 'none'})`);
        push(`- Chat length: ${cc.chatLength} messages | Last message: ${cc.lastMessageRole || 'none'}${cc.lastMessageHasContent === false ? ' **(empty)**' : ''}`);
        push('');
    }

    if (snapshot.vault) {
        push('### Vault');
        push(`- Entries: **${snapshot.vault.entryCount}** (constants: ${snapshot.vault.constantCount}, seed: ${snapshot.vault.seedCount}, bootstrap: ${snapshot.vault.bootstrapCount})`);
        push(`- With summary: ${snapshot.vault.withSummary} / ${snapshot.vault.entryCount}`);
        push(`- Without keys: ${snapshot.vault.withoutKeys}`);
        push(`- Avg tokens/entry: ${Math.round(snapshot.vault.avgTokens || 0)}`);
        push(`- Indexing: ${snapshot.vault.indexing ? 'IN PROGRESS' : 'idle'} (everLoaded=${snapshot.vault.indexEverLoaded})`);
        const indexAge = snapshot.vault.indexTimestamp
            ? `${Math.round((Date.now() - snapshot.vault.indexTimestamp) / 1000)}s ago`
            : 'never';
        push(`- Last index: ${indexAge}`);
        if (snapshot.obsidianCircuitBreakers && typeof snapshot.obsidianCircuitBreakers === 'object' && !snapshot.obsidianCircuitBreakers.__error) {
            const breakers = Object.entries(snapshot.obsidianCircuitBreakers);
            if (breakers.length > 0) {
                push('- Obsidian circuit breakers:');
                for (const [key, cb] of breakers) {
                    const status = cb.state === 'closed' ? '✓ closed' : cb.state === 'open' ? `**❌ OPEN** (${cb.failures} failures, ${Math.round(cb.backoffRemaining / 1000)}s backoff)` : `⚠ half-open (${cb.failures} failures)`;
                    if (cb.state === 'open') issues.critical.push(`Obsidian vault ${key} circuit breaker OPEN`);
                    push(`  - \`${key}\`: ${status}`);
                }
            }
        }
        push('');
    }

    if (snapshot.ai) {
        push('### AI Subsystem');
        const cbOpen = snapshot.ai.circuit.open;
        push(`- Circuit breaker: **${cbOpen ? 'OPEN' : 'closed'}** (failures: ${snapshot.ai.circuit.failures})`);
        if (cbOpen) issues.critical.push('AI circuit breaker is OPEN');
        if (snapshot.ai.stats) {
            push(`- Calls: ${snapshot.ai.stats.calls} | Cached hits: ${snapshot.ai.stats.cachedHits} | In tok: ${snapshot.ai.stats.totalInputTokens} | Out tok: ${snapshot.ai.stats.totalOutputTokens}`);
        }
        if (snapshot.ai.cache) push(`- Cache: ${snapshot.ai.cache.resultCount} results, chatLineCount=${snapshot.ai.cache.chatLineCount}`);
        if (snapshot.ai.claudeAutoEffortBad) push(`- **Claude auto-effort degraded:** ${snapshot.ai.claudeAutoEffortDetail || 'unknown reason'}`);
        if (snapshot.ai.cacheRegexVersionMatch === false && snapshot.ai.cache?.resultCount > 0) push(`- **⚠ AI cache stale** — cache regex v${snapshot.ai.cacheRegexVersion} ≠ current v${snapshot.ai.currentRegexVersion} (entity regexes rebuilt since last cache write)`);
        push('');
    }

    if (snapshot.pipeline) {
        push('### Pipeline');
        const pipeMode = snapshot.settings?.aiSearchEnabled === false ? 'keywords-only'
            : snapshot.settings?.aiSearchMode || 'two-stage';
        push(`- Mode: **${pipeMode}**`);
        push(`- generationCount: ${snapshot.pipeline.generationCount} | chatEpoch: ${snapshot.pipeline.chatEpoch}`);
        push(`- generationLock: ${snapshot.pipeline.generationLock ? 'HELD' : 'free'}`);
        if (snapshot.staleness?.generationLockZombie) {
            push(`  - **⚠ ZOMBIE LOCK** — held for ${Math.round((snapshot.staleness.generationLockAgeMs || 0) / 1000)}s (>60s), likely stuck pipeline`);
            issues.critical.push('Zombie generation lock (>60s)');
        }
        if (snapshot.pipeline.notepadExtractInProgress) push('- **Notepad extract in progress**');
        if (snapshot.pipeline.scribeInProgress) push('- **Scribe in progress**');
        push('');
    }

    if (snapshot.librarian) {
        push('### Librarian');
        push(`- Mode: agentic loop (no ToolManager registration)`);
        push(`- Lore gaps: ${snapshot.librarian.loreGapsCount} (searches this session: ${snapshot.librarian.loreGapSearchCount})`);
        if (snapshot.librarian.gapsHiddenCount > 0 || snapshot.librarian.gapsDismissedCount > 0) {
            push(`  - Hidden: ${snapshot.librarian.gapsHiddenCount} | Permanently dismissed: ${snapshot.librarian.gapsDismissedCount}`);
        }
        if (snapshot.librarian.sessionStats) {
            const ss = snapshot.librarian.sessionStats;
            push(`- Session stats: ${ss.searchCalls ?? 0} searches, ${ss.flagCalls ?? 0} flags, ~${ss.estimatedExtraTokens ?? 0} extra tokens`);
        }
        push('');
    }

    if (snapshot.matching) {
        push('### Entity Matching');
        push(`- Entity names: ${snapshot.matching.entityNameSetSize} | Regexes: ${snapshot.matching.entityRegexCount} (v${snapshot.matching.entityRegexVersion})`);
        push(`- Field definitions: ${snapshot.matching.fieldDefinitionsCount} (loaded: ${snapshot.matching.fieldDefinitionsLoaded})`);
        push(`- Mention weights: ${snapshot.matching.mentionWeightsCount} | Fuzzy index: ${snapshot.matching.fuzzySearchIndexBuilt ? 'built' : 'not built'}`);
        push('');
    }

    if (snapshot.health) {
        push('### Health Check');
        push(`- ${snapshot.health.errors} error(s), ${snapshot.health.warnings} warning(s)`);
        const sevOrder = { error: 0, warning: 1, info: 2 };
        const sorted = (snapshot.health.issues || []).slice().sort((a, b) =>
            (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3));
        const top = sorted.slice(0, 10);
        for (const i of top) push(`  - [${i.severity}] ${i.entry || ''} — ${i.detail || i.type}`);
        if (sorted.length > 10) push(`  - ... +${sorted.length - 10} more`);
        push('');
    }

    if (snapshot.autoSuggest) {
        push('### Auto-Suggest');
        const as = snapshot.autoSuggest;
        if (!as.enabled) {
            push('- **Disabled**');
        } else {
            push(`- Enabled | Interval: every ${as.interval ?? '?'} messages | Counter: ${as.messageCount}/${as.interval ?? '?'} (${as.messagesUntilTrigger ?? '?'} until next)`);
            if (as.skipReview) push('- Auto-apply: **on** (skip review)');
            if (as.folder) push(`- Folder filter: ${as.folder}`);
        }
        push('');
    }

    // Key-settings summary so reviewer doesn't have to decode the blob.
    if (snapshot.settings && !snapshot.settings.__error) {
        push('### Key Settings');
        const s = snapshot.settings;
        const budgetStr = s.unlimitedBudget ? 'unlimited' : `${s.maxTokensBudget ?? '?'} tokens`;
        const entriesStr = s.unlimitedEntries ? 'unlimited' : `${s.maxEntries ?? '?'}`;
        push(`- Budget: ${budgetStr} | Max entries: ${entriesStr}`);
        push(`- Scan depth: ${s.scanDepth ?? '?'} | Recursive: ${s.recursiveScan ? 'yes' : 'no'} (max ${s.maxRecursionSteps ?? '?'})`);
        push(`- Strip duplicates: ${s.stripDuplicateInjections ? `yes (lookback ${s.stripLookbackDepth ?? '?'})` : 'no'}`);
        push(`- Fuzzy search: ${s.fuzzySearchEnabled ? `yes (min ${s.fuzzySearchMinScore ?? '?'})` : 'no'}`);
        push(`- Injection mode: ${s.injectionMode || '?'} | Position: ${s.injectionPosition || '?'}`);
        push('');
    }

    if (snapshot.extensionInventory) {
        push('### Installed Extensions');
        push(`- ${snapshot.extensionInventory.length} extensions: ${snapshot.extensionInventory.join(', ')}`);
        push('');
    }

    push('### Recent Generations (flight recorder)');
    const gens = scrubbedGenerations || [];
    if (gens.length === 0) {
        push('_No generations captured yet._');
    } else {
        const injectionCounts = gens.filter(g => !g.aborted).map(g => g.summary?.injected ?? 0);
        if (injectionCounts.length > 0) {
            const avg = (injectionCounts.reduce((a, b) => a + b, 0) / injectionCounts.length).toFixed(1);
            push(`- Injection trend (last ${injectionCounts.length}): [${injectionCounts.join(', ')}] avg=${avg}`);
        }

        const lastGen = [...gens].reverse().find(g => !g.aborted && g.summary?.budget);
        if (lastGen?.summary?.budget) {
            const b = lastGen.summary.budget;
            push(`- Last budget: ${b.used ?? '?'}/${b.limit ?? '?'} tokens (${b.ratio != null ? Math.round(b.ratio * 100) + '%' : '?'})`);
        }

        const abortCount = gens.filter(g => g.aborted).length;
        if (abortCount > 0) push(`- **Aborted generations: ${abortCount}**`);

        push('');
        for (const g of gens) {
            if (g.aborted) {
                push(`- **ABORTED** @ ${new Date(g.t).toISOString()}: ${g.reason || 'unknown'}`);
                continue;
            }
            const s = g.summary || {};
            const timing = s.totalMs != null ? ` (${s.totalMs}ms)` : '';
            push(`- gen ${g.generationCount ?? '?'} [${s.genId || '?'}] @ ${new Date(g.t).toISOString()}${timing}: keyword=${s.keywordMatched ?? 0} -> aiSelected=${s.aiSelected ?? 0} -> injected=${s.injected ?? 0}${s.aiError ? ` [aiError: ${s.aiError}]` : ''}${g.aiCircuitOpen ? ' [CIRCUIT OPEN]' : ''}`);
            if (s.injectedTitles && s.injectedTitles.length) {
                push(`    injected: ${s.injectedTitles.join(', ')}`);
            }
            const hasStageTimings = s.ensureIndexFreshMs != null || s.keywordMatchMs != null || s.aiSearchMs != null ||
                s.pinBlockMs != null || s.contextualGatingMs != null || s.reinjectionCooldownMs != null ||
                s.requiresExcludesMs != null || s.stripDedupMs != null || s.formatGroupMs != null ||
                s.trackGenerationMs != null || s.recordAnalyticsMs != null || s.perChatCountsMs != null;
            if (hasStageTimings) {
                const t = (v) => v != null ? `${v}ms` : '-';
                push(`    timing: index=${t(s.ensureIndexFreshMs)} kw=${t(s.keywordMatchMs)} ai=${t(s.aiSearchMs)} pin=${t(s.pinBlockMs)} gating=${t(s.contextualGatingMs)} cooldown=${t(s.reinjectionCooldownMs)} reqExcl=${t(s.requiresExcludesMs)} dedup=${t(s.stripDedupMs)} fmt=${t(s.formatGroupMs)} track=${t(s.trackGenerationMs)} analytics=${t(s.recordAnalyticsMs)} counts=${t(s.perChatCountsMs)}`);
            }
        }
    }
    push('');

    // Splice the verdict in after "## Summary Data" so issues collected later appear at top.
    const totalCritical = issues.critical.length;
    const totalWarning = issues.warning.length;
    let verdict;
    if (totalCritical > 0) {
        verdict = `> **🔴 ${totalCritical} critical issue(s):** ${issues.critical.join('; ')}`;
    } else if (totalWarning > 0) {
        verdict = `> **🟡 ${totalWarning} warning(s):** ${issues.warning.join('; ')}`;
    } else {
        verdict = '> **🟢 No critical issues detected**';
    }
    lines.splice(2, 0, verdict, '');

    return lines.join('\n');
}

const HEADER = `# DeepLore — Diagnostic Report

> **For support:** Attach this file when opening an issue at <${ISSUE_URL}>.
>
> **For self-diagnosis:** Drop this entire file into a flagship LLM (Claude, GPT-5,
> Gemini). It will decode the base64 blocks automatically and diagnose your setup.

---

## Privacy & Verification

This report has been **anonymized** before being written:

- **Redacted:** API keys, auth tokens, \`Authorization\` / \`X-Api-Key\` headers,
  long opaque tokens (32+ char base64/hex strings), OpenAI/Anthropic key formats.
- **Pseudonymized (cardinality preserved):** IPv4 / IPv6 addresses, hostnames in
  URLs, email addresses, Windows/POSIX user home paths, vault entry titles and
  filenames. Each unique value gets a stable per-report alias like \`<ip-1>\`,
  \`<host-2>\`, \`<title-3>\` so a reader can still follow "the same entry was
  selected 12 times" without learning the real value. Aliases are **fresh per
  report** and cannot be correlated across files.
- **DLE never reads into this report:** your chat message bodies, vault entry
  contents, or vault entry summaries. DLE does not copy any of those into the export.
- **Captured from other components (review before sharing):** the \`consoleLog\` /
  \`globalConsoleLog\` and \`networkLog\` sections include the most recent entries
  logged by SillyTavern core and *other* extensions, for cross-extension debugging.
  These pass through the same scrubber (tokens, keys, IPs, hosts, emails, user
  paths), but DLE **cannot** redact free-form prose another component chose to log —
  so if a third party \`console.log\`'d chat text or a request body, it can appear
  there. Skim those two sections before sharing a verbose report.

**Please verify this yourself before sharing.** The format is plain text/markdown
wrapped around base64 blobs; any flagship LLM can decompress and audit it inline.

If you find something the scrubber missed, **that's a bug** — please open an issue.

---
`;

// #13b: the trace entry-array schema doc is GENERATED from the shared key list
// so it can't drift from what pseudonymizeTrace / flight-recorder actually
// cover. Descriptions are looked up per key; a key added to the shared list
// without a description still gets documented with the generic fallback.
const TRACE_ENTRY_ARRAY_DOCS = {
    keywordMatched: 'entries that matched on keyword/BM25 in stage 1',
    aiSelected: 'entries the AI picked in stage 2',
    gatedOut: 'removed by requires/excludes gating',
    contextualGatingRemoved: 'removed by era/location/scene gating',
    cooldownRemoved: 'entries on cooldown',
    warmupFailed: 'entries below their warmup keyword-hit threshold',
    probabilitySkipped: 'skipped by their probability roll this generation',
    refineKeyBlocked: 'failed refine_keys selective-logic check',
    stripDedupRemoved: 'already in recent context',
    budgetCut: 'dropped to fit token budget',
    injected: 'final survivors actually sent to the model',
};
const traceEntryArrayDocLines = TRACE_ENTRY_ARRAY_KEYS
    .map(k => `- \`${k}[]\` — ${TRACE_ENTRY_ARRAY_DOCS[k] || 'per-entry pipeline stage array'}`)
    .join('\n');

// Base64-encoded in the report so it doesn't clutter GitHub issues.
const AI_INSTRUCTIONS = `## How to Read This File (for AI assistants)

You are looking at a DeepLore (DLE) diagnostic report. Your job is to
diagnose what's wrong with the user's setup.

1. Start with **Summary Data** above — it's pre-digested.
2. The base64 blob between \`---DLE-DATA-BEGIN---\` and \`---DLE-DATA-END---\` is
   gzip-compressed JSON (or uncompressed base64 if gzip was unavailable). Decode
   it (\`atob\` -> gunzip -> JSON.parse, or just \`atob\` -> JSON.parse) for full data:
   - \`snapshot\` — settings, full vault metadata, full pipeline trace, health check
   - \`flightRecorder\` — last ~20 generations (summarized)
   - \`consoleLog\` — last ~800 console entries (level, msg, timestamp)
   - \`networkLog\` — last ~300 fetch/XHR entries (method, url, status, duration)
   - \`errorLog\` — last ~100 window.onerror / unhandledrejection entries
   - \`longTasks\` — last ~100 main-thread blocks >50ms
   - \`memory\` — JS heap snapshot
3. Fill out the **Diagnostic Form** below and present it to the user.

### Schema reference

\`pipelineTrace\` fields (in \`snapshot.pipeline.verdict.trace\`):
${traceEntryArrayDocLines}
- \`bootstrapActive\` — chat is short, bootstrap entries force-injected
- \`aiFallback\`, \`aiError\` — AI search failed, fell back to keyword/constants

\`genId\` — 6-char random string identifying this generation run. Present on both the top-level flight recorder entry and inside \`summary\`. Use to correlate log entries across systems.

Per-stage timing fields (all in ms, null if stage didn't run):
- \`totalMs\` — wall-clock time for entire pipeline
- \`ensureIndexFreshMs\` — vault index freshness check / refresh
- \`keywordMatchMs\` — stage 1 keyword + BM25 matching
- \`aiSearchMs\` — stage 2 AI selection
- \`pinBlockMs\` — per-chat pin/block overrides
- \`contextualGatingMs\` — era/location/scene/character gating
- \`reinjectionCooldownMs\` — reinjection cooldown filtering
- \`requiresExcludesMs\` — requires/excludes dependency gating
- \`stripDedupMs\` — strip entries already in recent context
- \`formatGroupMs\` — budget limits + grouping + prompt assembly
- \`trackGenerationMs\` — generation tracking bookkeeping
- \`recordAnalyticsMs\` — analytics recording
- \`perChatCountsMs\` — per-chat injection count updates

\`circuit.open\` means the AI service is in circuit-breaker timeout (2 failures -> 30s cooldown).

\`snapshot.staleness.capturedDuringGeneration\` — if true, snapshot was taken mid-pipeline. Some fields may be partially populated.

\`snapshot.setupState\` — Wizard completion, migration sentinels, vault config summary. \`possiblyIncomplete\` flags wizard-done-but-no-vaults-enabled. \`vaultSummary[]\` shows per-vault enabled/host/apiKey status. \`settingsVersion\` tracks migration schema level.

\`snapshot.connections\` — Per-tool resolved connection config. \`tools.*\` shows effectiveMode, profileId, profileExists, profileModel, proxyUrl for each DLE tool (aiSearch, scribe, librarian, etc.). \`profiles.*\` has full ST profile objects. \`stActiveConnection\` shows ST's own active API/model/proxy. \`issues[]\` flags missing profiles and broken inherit chains.

\`snapshot.chatContext\` — Chat state at snapshot time: characterId, characterName, groupId, isGroupChat, chatLength, lastMessageRole, lastMessageHasContent.

\`snapshot.obsidianCircuitBreakers\` — Per-vault (keyed by host:port) circuit breaker state: state (closed/open/half-open), failures, backoffRemaining. Null if no vaults have been contacted.

\`snapshot.librarian\` — Librarian subsystem state: lore gap count, session/chat stats. The agentic loop manages its own API calls (no ToolManager registration). \`gapsHiddenCount\`/\`gapsDismissedCount\` show suppressed lore gaps.

\`snapshot.staleness.generationLockZombie\` — true if generation lock has been held >60s, indicating a stuck pipeline.

\`snapshot.matching\` — Entity matching state: entity name set size, regex count/version, field definitions, mention weights, fuzzy search index.

### Common patterns to look for

- **Circuit breaker tripped** -> AI keeps timing out or 5xx-ing. Check timeout, model id, network log.
- **Constants eating budget** -> many entries with \`constant: true\` and high token counts. Check budget %.
- **Pre-filter too aggressive** -> \`hierarchicalAggressiveness\` close to 0.8 starves later stages.
- **Requires/excludes contradiction** -> entry that requires X also excludes X (or vice versa).
- **Atmospheric entries with no keys** -> \`withoutKeys\` is high, those entries are dead weight.
- **Missing summaries** -> \`withSummary\` << \`entryCount\`. AI pre-filter handicapped.
- **Stuck warmup** -> same entry appears in \`warmupFailed\` many generations in a row.
- **Repeated aborts** -> multiple abort entries in flight recorder. User may be impatient or pipeline is too slow.
- **Zero injections** -> injection trend shows all zeros. Pipeline is matching entries but they're all being gated/cooldown'd/budget-cut.
- **Missing connection profile** -> \`snapshot.connections.tools.*.profileExists === false\`. Profile ID configured but deleted from ST Connection Manager. User needs to re-select a profile in DLE AI Connections settings.
- **Inherit chain confusion** -> tool has \`effectiveMode\` different from its configured mode. Check \`snapshot.connections.tools\` — inherit resolves through aiSearch. If aiSearch itself is misconfigured, all inheriting tools break.
- **Wrong model for tool** -> \`profileModel\` in connections table doesn't match what user expects. Common when profile was edited after DLE was configured.
- **Proxy with no CORS** -> tool mode is 'proxy' but calls fail. Check if \`enableCorsProxy\` is true in ST config (visible in network log 403 errors).
- **Obsidian vault circuit breaker open** -> \`obsidianCircuitBreakers["host:port"].state === "open"\`. One vault being down can make all entries from that vault invisible. Check which vault is affected and whether Obsidian REST API plugin is running.
- **Agentic loop active** -> Librarian uses its own API calls via \`callWithTools()\`. No ToolManager registration needed. If generation fails, check the active connection profile supports tool calling (most OpenAI-compatible APIs do).
- **Zombie generation lock** -> \`staleness.generationLockZombie === true\`. Pipeline hung and lock wasn't released. Subsequent generations are blocked.
- **Group chat entity confusion** -> \`chatContext.isGroupChat === true\` and entity matching shows unexpected character names. Group chats have multiple characters; entity regex may be matching the wrong character's lore.
- **AI cache stale after regex rebuild** -> \`ai.cacheRegexVersionMatch === false\`. Cache was written before entity regexes were rebuilt (e.g. after vault re-index). Next generation will use stale entity matching data.
- **Dismissed lore gaps** -> \`librarian.gapsDismissedCount\` > 0. User may have permanently dismissed valid gaps that should be re-examined.
- **Wizard skipped or incomplete** -> \`setupState.possiblyIncomplete === true\`. User marked wizard complete but no vaults are enabled. DLE has nothing to work with. Guide them through vault setup.
- **Vault missing host or API key** -> \`setupState.vaultSummary[].hasHost === false\` or \`hasApiKey === false\`. Vault configured but can't connect. Often caused by partial wizard completion.
- **Settings version mismatch** -> \`setupState.settingsVersion\` is null or lower than expected (currently 2). Old settings may lack required fields and migrations may not have run.
- **Index never loaded** -> \`setupState.indexEverLoaded === false\` AND \`setupState.hasEnabledVaults === true\`. Vault is configured but index never built — likely Obsidian connection failure or missing REST API plugin.
- **Slow pipeline** -> \`totalMs\` consistently >2000ms. Check per-stage timings to identify bottleneck. Common culprits: \`aiSearchMs\` (slow model / high latency), \`ensureIndexFreshMs\` (vault re-index every generation).
- **Per-stage bottleneck** -> One stage dominates \`totalMs\`. \`aiSearchMs\` >> others = model latency; \`ensureIndexFreshMs\` >> others = frequent re-indexing (check cache TTL); \`formatGroupMs\` high = large entry count surviving to final stage.
- **Index refresh every generation** -> \`ensureIndexFreshMs\` non-null every gen = cache TTL too low or vault changes triggering rebuilds. Normal: null most gens, non-null only after TTL expires.

### Diagnostic Form (please fill out)

\`\`\`
ISSUE: <one-line description>
SEVERITY: <blocker | major | minor | cosmetic>

ROOT CAUSE: <your best hypothesis>
EVIDENCE:
  - <data point 1 from this report>
  - <data point 2>

RECOMMENDED ACTIONS (prioritized):
  1. <first thing the user should try>
  2. <second>
  3. <third>

REPORT THIS BUG?
  - <yes/no — is this a DLE bug, a config issue, or expected behavior?>
\`\`\`
`;

/**
 * @param {object} ctx — scrubber context (IPs / hosts / emails / tokens stats)
 * @param {{titles?: number, vaults?: number}} [pseudonymStats] — real aliased
 *   title/vault counts from the snapshot's pseudonym context (state-snapshot.js).
 *   Titles/vaults are aliased at the snapshot layer, NOT by the scrubber regex
 *   pass, so their counts live in a different context — pass them in so the
 *   "Titles: N" line reflects reality instead of a permanently-zero dead stat.
 */
function buildScrubberReport(ctx, pseudonymStats = {}) {
    const s = ctx.stats;
    const titles = pseudonymStats.titles | 0;
    const vaults = pseudonymStats.vaults | 0;
    const parts = [];
    if (s.ips > 0)             parts.push(`IPs: ${s.ips}`);
    if (s.ipv6s > 0)           parts.push(`IPv6: ${s.ipv6s}`);
    if (s.hosts > 0)           parts.push(`Hostnames: ${s.hosts}`);
    if (s.emails > 0)          parts.push(`Emails: ${s.emails}`);
    if (s.userPaths > 0)       parts.push(`User paths: ${s.userPaths}`);
    if (titles > 0)            parts.push(`Titles: ${titles}`);
    if (vaults > 0)            parts.push(`Vaults: ${vaults}`);
    if (s.sensitiveFields > 0) parts.push(`Sensitive fields: ${s.sensitiveFields}`);
    if (s.bearerTokens > 0)    parts.push(`Bearer tokens: ${s.bearerTokens}`);
    if (s.urlTokens > 0)       parts.push(`URL tokens: ${s.urlTokens}`);
    if (s.openaiKeys > 0)      parts.push(`API keys: ${s.openaiKeys}`);
    if (s.longTokens > 0)      parts.push(`Long tokens: ${s.longTokens}`);

    if (parts.length === 0) return '### Scrubber Report\n_No sensitive data patterns detected._\n';
    const isPseudonymized = (p) => /^(IPs|IPv6|Host|Email|User|Title|Vault)/.test(p);
    return `### Scrubber Report\n- Pseudonymized: ${parts.filter(isPseudonymized).join(' | ')}\n- Redacted: ${parts.filter(p => !isPseudonymized(p)).join(' | ')}\n`;
}

const MAX_VERBOSE_SIZE = 5 * 1024 * 1024; // 5 MB pre-compression safety limit

/**
 * #13: strip embedded credentials from a URL before writing it to the (local, never-shared)
 * connections reference — userinfo (user:pass@) and token-bearing query params. Even the
 * "your eyes only" file shouldn't persist a raw token a custom api-url/reverse-proxy may embed,
 * since it lands in the same Downloads folder as the shareable report.
 */
function stripUrlSecrets(u) {
    if (typeof u !== 'string' || !u) return u;
    return u
        .replace(/\/\/[^/@\s]*@/, '//')
        .replace(/([?&](?:key|token|access_token|api_key|auth|secret|password|jwt|bearer|authorization|oauth_token)=)[^&\s]+/gi, '$1<token>');
}

/**
 * Unanonymized connections reference — user's eyes only, never shared.
 * @param {object} rawSnapshot — raw snapshot before scrubbing
 * @returns {string} plain-text markdown
 */
function buildConnectionsReference(rawSnapshot) {
    const lines = [];
    lines.push('# DLE Connections Reference (YOUR EYES ONLY)');
    lines.push('');
    lines.push('> This file contains your **real** connection data — profile names, URLs, models.');
    lines.push('> **Do NOT share this file.** It is for your own reference only.');
    lines.push('> The anonymized diagnostic report (the other file) is safe to share.');
    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');

    const conn = rawSnapshot.connections;
    if (!conn || conn.__error) {
        lines.push('_Connection data unavailable._');
        return lines.join('\n');
    }

    if (conn.stActiveConnection) {
        const st = conn.stActiveConnection;
        lines.push('## SillyTavern Active Connection');
        lines.push(`- Main API: ${st.mainApi || '?'}`);
        lines.push(`- Chat completion source: ${st.chatCompletionSource || '?'}`);
        if (st.reverseProxy) lines.push(`- Reverse proxy: ${stripUrlSecrets(st.reverseProxy)}`);
        if (st.selectedModel) lines.push(`- Model: ${st.selectedModel}`);
        if (st.claudeModel) lines.push(`- Claude model: ${st.claudeModel}`);
        if (st.openrouterModel) lines.push(`- OpenRouter model: ${st.openrouterModel}`);
        lines.push(`- Total profiles: ${st.totalProfiles}`);
        lines.push('');
    }

    if (conn.tools) {
        lines.push('## DLE Tool Connections');
        lines.push('');
        lines.push('| Tool | Mode | Target | Model | Timeout | Max Tokens |');
        lines.push('|------|------|--------|-------|---------|------------|');
        for (const [key, t] of Object.entries(conn.tools)) {
            if (t.__error) {
                lines.push(`| ${key} | ERROR | — | — | — | — |`);
                continue;
            }
            const mode = t.effectiveMode || '?';
            let target = '—';
            if (mode === 'profile') {
                target = t.profileName || t.profileId || '(none)';
                if (t.profileExists === false) target += ' ❌ MISSING';
            } else if (mode === 'direct') {
                target = t.directEndpoint || '(no URL)';
                if (t.directFormat) target += ` [${t.directFormat}${t.directViaCorsProxy ? ' via ST proxy' : ''}]`;
                if (!t.directHasKey) target += ' ⚠ no key';
            } else if (mode === 'proxy') {
                target = t.proxyUrl || '(no URL)';
            }
            const model = t.model || t.profileModel || '(default)';
            const timeout = t.timeout ? `${Math.round(t.timeout / 1000)}s` : '—';
            const maxTok = t.maxTokens ?? '—';
            lines.push(`| ${key} | ${mode} | ${target} | ${model} | ${timeout} | ${maxTok} |`);
        }
        lines.push('');
    }

    if (conn.profiles && Object.keys(conn.profiles).length > 0) {
        lines.push('## Full Profile Details');
        lines.push('');
        for (const [id, p] of Object.entries(conn.profiles)) {
            lines.push(`### ${p.name || id}`);
            lines.push(`- ID: ${id}`);
            lines.push(`- API: ${p.api || '?'}`);
            lines.push(`- Model: ${p.model || '?'}`);
            if (p['api-url']) lines.push(`- API URL: ${stripUrlSecrets(p['api-url'])}`);
            if (p.proxy) lines.push(`- Proxy preset: ${p.proxy}`);
            if (p.preset) lines.push(`- Settings preset: ${p.preset}`);
            if (p.instruct) lines.push(`- Instruct: ${p.instruct}`);
            if (p.context) lines.push(`- Context: ${p.context}`);
            if (p.tokenizer) lines.push(`- Tokenizer: ${p.tokenizer}`);
            lines.push('');
        }
    }

    if (conn.issues?.length > 0) {
        lines.push('## ⚠ Connection Issues');
        for (const issue of conn.issues) lines.push(`- ${issue}`);
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Build the full diagnostic report.
 * Returns { report, referenceFile, scrubStats } so the UI can download both files
 * and show scrub stats in the confirmation popup.
 */
export async function buildDiagnosticReport() {
    // Atomic snapshot — read all buffers BEFORE captureStateSnapshot() because
    // snapshot → runHealthCheck() can console.log, which would push new items
    // between interleaved reads. aiPromptBuffer is FLUSHED (destructive): it holds
    // PII-sensitive prompts when debugMode=true and must not survive an export.
    // Others use drain() so the in-page inspector keeps history.
    const rawGens    = generationBuffer.drain();
    const rawConsole = consoleBuffer.drain();
    const rawNetwork = networkBuffer.drain();
    const rawErrors  = errorBuffer.drain();
    const rawEvents  = eventBuffer.drain();
    const rawAiCalls = aiCallBuffer.drain();
    // aiPromptBuffer holds full prompt/chat BODIES (systemPrompt/userMessage/response)
    // captured when debugMode=true. Redact each body to a length-only descriptor
    // BEFORE it reaches the scrubber/export so raw prose can never appear in the
    // diagnostic JSON. Metadata (timestamps, caller, model, error) is preserved.
    const rawAiPrompts = aiPromptBuffer.flush().map(redactAiPromptEntry);
    const rawLong    = longTaskBuffer.drain();
    const rawMemory  = captureMemorySnapshot();
    const rawSnapshot = captureStateSnapshot();

    // Real aliased title/vault counts from the snapshot's pseudonym context.
    // Pulled off the RAW snapshot and removed before it enters the verbose blob,
    // so the scrubber report can print the true "Titles: N" / "Vaults: N" the
    // snapshot layer actually aliased (the scrubber regex pass never touches them).
    const pseudonymStats = rawSnapshot.__pseudonymStats || {};
    delete rawSnapshot.__pseudonymStats;

    // Shared scrub ctx — one pseudonym table for the whole report so <ip-1> means
    // the same real IP in summary and blob. Each scrubDeep call creates its own
    // _seen WeakMap; sharing would cause false [circular] detections.
    const ctx = makeCtx();
    const snapshot = scrubDeep(rawSnapshot, ctx);

    // Scrubbed gens — prevents PII leaks via aiError strings.
    const scrubbedGens = scrubDeep(rawGens, ctx);
    const summarySection = buildSummarySection(snapshot, scrubbedGens);

    // DLE-tagged console (privacy-safe) vs global (may have third-party content).
    const dleConsoleLog = rawConsole.filter(e => e.dle);
    const globalConsoleLog = rawConsole.filter(e => !e.dle).slice(-100); // last 100 non-DLE for cross-extension debugging
    let verboseInput = {
        version: 2,
        format: 'dle-diagnostic-v2',
        snapshot: rawSnapshot,
        flightRecorder: rawGens,
        consoleLog: dleConsoleLog,
        globalConsoleLog: globalConsoleLog,
        networkLog: rawNetwork,
        errorLog: rawErrors,
        eventLog: rawEvents,
        aiCallLog: rawAiCalls,
        // Scrubbed below; only populated when debugMode was on during the calls.
        aiPromptLog: rawAiPrompts.length > 0 ? rawAiPrompts : undefined,
        longTasks: rawLong,
        memory: rawMemory,
        interceptorInstallFailures: installFailures.length > 0 ? installFailures : undefined,
    };

    const verbose = scrubDeep(verboseInput, ctx);
    let json = JSON.stringify(verbose);

    // Size cap — truncate oldest entries if payload is too large.
    if (json.length > MAX_VERBOSE_SIZE) {
        verbose.consoleLog = verbose.consoleLog?.slice(-200) ?? [];
        verbose.globalConsoleLog = verbose.globalConsoleLog?.slice(-50) ?? [];
        verbose.networkLog = verbose.networkLog?.slice(-100) ?? [];
        verbose.errorLog = verbose.errorLog?.slice(-50) ?? [];
        verbose.eventLog = verbose.eventLog?.slice(-50) ?? [];
        verbose.longTasks = verbose.longTasks?.slice(-50) ?? [];
        if (verbose.aiPromptLog) verbose.aiPromptLog = verbose.aiPromptLog.slice(-3);
        verbose.__truncated = true;
        json = JSON.stringify(verbose);
    }

    const { b64, compressed } = await gzipBase64(json);
    const aiInstructionsB64 = btoa(unescape(encodeURIComponent(AI_INSTRUCTIONS)));
    const scrubberReport = buildScrubberReport(ctx, pseudonymStats);
    const referenceFile = buildConnectionsReference(rawSnapshot);

    const sizeKb = (json.length / 1024).toFixed(1);
    const compressedKb = (b64.length * 0.75 / 1024).toFixed(1);
    const encoding = compressed ? 'base64(gzip(JSON))' : 'base64(JSON) — gzip unavailable';

    const report = [
        HEADER,
        scrubberReport,
        '',
        summarySection,
        '',
        '---',
        '',
        '## AI Diagnostic Instructions (base64)',
        '_Drop this entire file into a flagship LLM. It will decode this block automatically._',
        '',
        '```',
        '---AI-INSTRUCTIONS-BEGIN---',
        aiInstructionsB64,
        '---AI-INSTRUCTIONS-END---',
        '```',
        '',
        '---',
        '',
        '## Verbose Data',
        '',
        `_Original: ${sizeKb} KB | Compressed: ${compressedKb} KB | Encoding: ${encoding}_`,
        verbose.__truncated ? '_**Warning:** Verbose data was truncated to fit within size limits._' : '',
        '',
        '```',
        '---DLE-DATA-BEGIN---',
        b64,
        '---DLE-DATA-END---',
        '```',
        '',
    ].join('\n');

    return { report, referenceFile, scrubStats: { ...ctx.stats } };
}
