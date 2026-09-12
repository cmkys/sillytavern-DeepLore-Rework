/**
 * DeepLore — Agentic Loop API Layer
 * Wraps CMRS for tool-calling. 4 provider formats: Claude, Google
 * (Gemini/Vertex), OpenAI-compatible, Cohere. Proxy mode hits the Anthropic
 * Messages API directly via the ST CORS bridge.
 */
import { ConnectionManagerRequestService } from '../../../../shared.js';
import { oai_settings } from '../../../../../openai.js';
import { main_api, CONNECT_API_MAP } from '../../../../../../script.js';
import { getContext } from '../../../../../extensions.js';
import { resolveConnectionConfig } from '../../settings.js';
import { validateProxyUrl } from '../ai/proxy-api.js';
import { callDirectApiRaw, resolveDirectFormat } from '../ai/direct-api.js';
import { abortWith } from '../diagnostics/interceptors.js';
import { isUnderlyingClaudeModel } from './agentic-api-pure.js';

// ════════════════════════════════════════════════════════════════════════════
// Provider Detection
// ════════════════════════════════════════════════════════════════════════════

/**
 * Sources that don't support tool calling.
 *
 * Audited against SillyTavern's own tool-calling `supportedSources` list
 * (public/scripts/tool-calling.js) on 2026-06-27. ST lists nanogpt, ai21,
 * pollinations, and moonshot as tool-capable, so it sends `tools` for them and
 * OpenAI-compatible tool-capable models behind them round-trip fine. They were
 * stale entries here that hard-disabled the Librarian for those sources
 * regardless of model — the source gate tripped before the model check ever ran
 * (the NanoGPT report that surfaced this). Removed.
 *
 * Only `perplexity` remains: it is genuinely absent from ST's supportedSources.
 *
 * Why removing source entries is low-risk: a source that accepts `tools` but
 * whose model never calls one degrades gracefully — the agentic loop captures
 * the model's plain text as prose and breaks (agentic-loop.js, the
 * `toolCalls.length === 0` path; MAX_ITERATIONS caps any runaway). Reasoning-only
 * models that leak narrative instead of tool calls are caught independently by
 * `NO_TOOLS_MODELS` below, regardless of source. A wrong *block*, by contrast,
 * silently kills the feature — the asymmetry that motivated this audit.
 */
const NO_TOOLS_SOURCES = new Set([
    'perplexity',
]);

/**
 * Reasoning-only models that silently fail when sent `tools` — no tool_calls,
 * and reasoning narrative leaks as prose. ST has no per-model gate (verified
 * against ST staging tool-calling.js, 2026-04-24); DLE must maintain this list.
 * Source-prefixed entries cover OpenRouter relays.
 *
 * BUG-AUDIT (Fix 29): narrowed from `^o[1-9]` to `^o1`. o3, o3-mini, o4-mini
 * all support function calling per current docs — the broad pattern was
 * over-blocking. o1 alone is the genuine reasoning-only model.
 */
const NO_TOOLS_MODELS = [
    /^deepseek-reasoner/i,
    /^deepseek\/.*r1/i,
    /-r1(-|$|:)/i,
    /^o1(-|$)/i,
    /^openai\/o1/i,
    /^anthropic\/.*-thinking/i,
];

export function isReasoningOnlyModel(model) {
    if (!model || typeof model !== 'string') return false;
    return NO_TOOLS_MODELS.some(re => re.test(model));
}

/**
 * Resolve the active model id for the Librarian connection.
 * Proxy: configured model. Profile: CMRS profile model first (most accurate),
 * then `oai_settings.{source}_model` fallback.
 *
 * Reads `resolveConnectionConfig('librarian').profileId` — Librarian's *configured*
 * profile, not ST's globally-active profile. Using getActiveProfileId() here would
 * silently mis-resolve the model whenever the user's active profile differs from
 * the one wired into Librarian (the same root cause as #27 sym 2).
 */
export function getResolvedModel(connConfig) {
    connConfig = connConfig || resolveConnectionConfig('librarian');
    if (connConfig.mode === 'direct') {
        // Direct API: the configured model IS the model — there is no profile
        // and no ST global to fall back to (a global fallback would silently
        // send a model the endpoint has never heard of).
        return connConfig.model || '';
    }
    if (connConfig.mode === 'proxy') {
        // v2.5 dead-head: Custom Proxy removed. Don't claim a proxy model exists —
        // dispatch (callAI / callWithTools) will refuse before any model is needed.
        // Returning '' matches the existing "model unknown" fallback for profile mode
        // with empty settings, so callers that branch on truthiness behave consistently.
        return '';
    }
    try {
        const profileId = connConfig.profileId;
        if (profileId) {
            const profile = ConnectionManagerRequestService.getProfile?.(profileId);
            if (profile?.model) return profile.model;
        }
    } catch { /* noop */ }
    const source = oai_settings?.chat_completion_source;
    if (source) return oai_settings[`${source}_model`] || '';
    return '';
}

/**
 * Resolve the Librarian connection config. Thin wrapper so the agentic loop can
 * resolve it ONCE per round-trip and thread it into `getProviderFormat` (P1-6)
 * without importing `settings.js` itself (which would break the loop's test
 * import — the loop's stub for this module omits this export and the loop
 * accesses it defensively off the namespace).
 * @returns {object} Resolved Librarian connection config.
 */
export function resolveLibrarianConnConfig() {
    return resolveConnectionConfig('librarian');
}

/**
 * Map a CM profile's `api` field to the chat-completion source string ST would
 * use for it (the same value as `oai_settings.chat_completion_source` when that
 * profile is active). Pure — takes the already-resolved `CONNECT_API_MAP` entry.
 *
 * `profile.api` is a CONNECT_API_MAP *key* (e.g. `'claude'`, `'openrouter'`, or
 * an alias like `'oai'`/`'google'`), NOT the raw source. For chat-completion
 * profiles the map entry is `{ selected: 'openai', source: <chat_completion_source> }`;
 * for text-completion profiles `selected !== 'openai'` and there is no source
 * (tool calling via the OpenAI path is unsupported → return null).
 *
 * @param {object|undefined} apiMapEntry - `CONNECT_API_MAP[profile.api]`
 * @returns {string|null} chat_completion_source, or null when not a chat-completion API
 */
export function _chatCompletionSourceFromApiMapEntry(apiMapEntry) {
    if (!apiMapEntry || apiMapEntry.selected !== 'openai') return null;
    return apiMapEntry.source || null;
}

/**
 * Map a chat-completion source to the agentic provider message format.
 * Pure mirror of the source→format switch in `getProviderFormat`; shared so
 * both the live wrapper and the P1-6 fix derive format from the SAME logic.
 *
 * @param {string|null|undefined} source - chat_completion_source
 * @returns {'claude'|'google'|'openai'} provider format
 */
export function _providerFormatForSource(source) {
    if (source === 'claude') return 'claude';
    if (source === 'makersuite' || source === 'vertexai') return 'google';
    return 'openai';
}

/**
 * Resolve the chat-completion source for the Librarian connection, mirroring
 * `getResolvedModel`'s profile-lookup mechanism. Reads the Librarian's
 * *configured* profile (`connConfig.profileId`) — NOT ST's globally-active
 * profile / `oai_settings.chat_completion_source` (the P1-5/P1-6 root cause:
 * Librarian decisions were derived from global state, so a Librarian→Claude
 * profile under a global→OpenAI session got the wrong tool gate + message
 * format, and vice-versa — same class as #27 sym 2).
 *
 * Profile path: `getProfile(profileId).api` → `CONNECT_API_MAP[api].source`.
 * Falls back to the global `oai_settings.chat_completion_source` only when the
 * Librarian profile can't be resolved (unset profile, lookup throw), matching
 * `getResolvedModel`'s own global fallback so both stay consistent.
 *
 * @param {object} [connConfig] Pre-resolved Librarian connection config.
 * @returns {string|null} chat_completion_source, or null when unresolvable
 */
export function getResolvedLibrarianSource(connConfig) {
    connConfig = connConfig || resolveConnectionConfig('librarian');
    if (connConfig.mode === 'direct') {
        // No ST chat_completion_source exists for a direct endpoint. Map the
        // wire format onto the closest source token so downstream format logic
        // (getProviderFormat) resolves 'claude' vs 'openai' correctly.
        return resolveDirectFormat(connConfig.apiUrl, connConfig.apiFormat) === 'anthropic'
            ? 'claude'
            : 'openai';
    }
    if (connConfig.mode === 'proxy') {
        // v2.5 dead-head: Custom Proxy removed. No source — dispatch refuses first.
        return null;
    }
    try {
        const profileId = connConfig.profileId;
        if (profileId) {
            const profile = ConnectionManagerRequestService.getProfile?.(profileId);
            if (profile?.api) {
                const source = _chatCompletionSourceFromApiMapEntry(CONNECT_API_MAP?.[profile.api]);
                if (source) return source;
            }
        }
    } catch { /* noop */ }
    // Fallback mirrors getResolvedModel: when the Librarian profile is
    // unresolvable, fall back to the global source rather than guessing.
    return oai_settings?.chat_completion_source || null;
}

/**
 * Proxy: Anthropic Messages API, always supports tools. Profile: gates on ST
 * source AND resolved model — reasoner-only models silently fail tool calls
 * and leak reasoning as prose.
 */
export function isToolCallingSupported(model) {
    // BUG-AUDIT (Fix 1): resolved mode gates inherit→profile too. Reach into
    // context directly rather than calling getActiveProfileId, which throws
    // when no profile is selected — this gate must return false, not raise.
    const resolved = resolveConnectionConfig('librarian');
    if (resolved.mode === 'direct') {
        // Both wire formats support tools natively; DLE builds the request
        // itself, so ST's main_api/source gates below don't apply. The only
        // real disqualifier is a reasoning-only model that can't call tools.
        if (!resolved.apiUrl) return false;
        const directModel = model || getResolvedModel(resolved);
        return !(directModel && isReasoningOnlyModel(directModel));
    }
    if (resolved.mode === 'proxy') {
        // v2.5 dead-head: Custom Proxy removed. Report no tool support so the
        // Librarian falls back to its non-tool path — that path then ALSO refuses
        // on the actual call via callAI/callWithTools. Either way the error
        // surfaces clearly; this just avoids a misleading "tools supported" claim.
        return false;
    }
    if (main_api !== 'openai') return false;
    // P1-5: gate on the RESOLVED Librarian profile, not ST's global connection
    // state. Previously this read `oai_settings.chat_completion_source` (global)
    // and `connectionManager.selectedProfile` (global) — so a configured
    // Librarian profile under an EMPTY global selectedProfile wrongly returned
    // false, and a global tool-capable source under a Librarian profile pointing
    // at a no-tools source wrongly returned true. Derive both the profile gate
    // and the source gate from THIS profile so the source check + model check
    // (getResolvedModel, same profileId) answer about the SAME connection.
    if (resolved.mode === 'profile') {
        if (!resolved.profileId) return false;
    }
    const source = getResolvedLibrarianSource(resolved);
    if (!source) return false;
    if (NO_TOOLS_SOURCES.has(source)) return false;
    const resolvedModel = model || getResolvedModel(resolved);
    if (resolvedModel && isReasoningOnlyModel(resolvedModel)) return false;
    return true;
}

/**
 * Proxy mode is always Claude format.
 * @param {object} [connConfig] Pre-resolved Librarian connection config. When
 *   omitted, resolves it (one `getSettings()`); callers in a hot loop should
 *   pass the config they already resolved to avoid redundant resolves per
 *   round-trip (the message builders thread it through).
 */
export function getProviderFormat(connConfig) {
    // v2.5 dead-head: Custom Proxy removed. Return null rather than 'claude' so
    // we don't suggest a working format for a refused-dispatch path. Callers
    // (buildAssistantMessage / buildToolResults) only run after callWithTools
    // would have dispatched — in proxy mode the dispatch throws first, so a
    // null format here is never reached at runtime.
    const resolved = connConfig || resolveConnectionConfig('librarian');
    if (resolved.mode === 'direct') {
        return resolveDirectFormat(resolved.apiUrl, resolved.apiFormat) === 'anthropic' ? 'claude' : 'openai';
    }
    if (resolved.mode === 'proxy') return null;
    // P1-6: derive the format from the RESOLVED Librarian profile's source, NOT
    // global `oai_settings.chat_completion_source`. Otherwise a Librarian→Claude
    // profile under a global→OpenAI session built OpenAI-shaped assistant/
    // tool-result messages (and vice-versa), corrupting multi-turn tool loops.
    // Mirrors the request-side `isUnderlyingClaude(undefined, connConfig)` which
    // is already profile-aware.
    return _providerFormatForSource(getResolvedLibrarianSource(resolved));
}

/**
 * Detect Claude regardless of source — covers OpenRouter relays
 * (`anthropic/claude-*`) that source-only `getProviderFormat()` misses. Gates
 * Claude-specific mitigations (thinking-vs-tool_choice 400) without changing
 * the message parser, which must stay OpenAI-shape for OR responses.
 */
export function isUnderlyingClaude(model, connConfig) {
    // Delegate the regex contract to the pure helper; only the ST-context
    // fallback (getResolvedModel) lives here. `connConfig`, when supplied,
    // is threaded so the fallback doesn't re-resolve the connection.
    return isUnderlyingClaudeModel(model || getResolvedModel(connConfig));
}

/**
 * BUG-AUDIT (Fix 33): always honor librarianSessionMaxTokens (default 4096).
 * Profile mode previously read oai_settings.openai_max_tokens — the user's main
 * chat preset, often a low fallback like 300 — making the dedicated Librarian
 * budget dead. CMRS accepts the third argument as a real override.
 */
export function getActiveMaxTokens() {
    return resolveConnectionConfig('librarian').maxTokens || 4096;
}

/**
 * Profile mode only — proxy mode bypasses CMRS.
 * @throws {Error} If no profile is selected
 */
export function getActiveProfileId() {
    const ctx = getContext();
    const profileId = ctx.extensionSettings?.connectionManager?.selectedProfile;
    if (!profileId) {
        throw new Error('No active connection profile selected in SillyTavern. Select one in the Connection Manager.');
    }
    return profileId;
}

// ════════════════════════════════════════════════════════════════════════════
// API Call
// ════════════════════════════════════════════════════════════════════════════

/**
 * @param {Array<object>} tools - [{type:'function', function:{...}}]
 * @returns {Array<object>} [{name, description, input_schema}]
 */
function toAnthropicTools(tools) {
    return tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
    }));
}

function toAnthropicToolChoice(toolChoice) {
    if (toolChoice == null) return undefined;
    if (typeof toolChoice === 'string') {
        const map = { auto: 'auto', required: 'any', none: 'none' };
        return { type: map[toolChoice] || 'auto' };
    }
    return toolChoice;
}

/**
 * Direct Anthropic Messages API call via CORS bridge. Used in proxy mode.
 * Tools arrive in OpenAI function-calling format; converted on the way out.
 * @returns {Promise<object>} Raw Anthropic API response
 */
async function callWithToolsViaProxy(connConfig, messages, tools, toolChoice, maxTokens, signal) {
    const { proxyUrl, model, timeout = 120000 } = connConfig;
    validateProxyUrl(proxyUrl);

    if (!model) throw new Error('Librarian proxy mode requires a model name. Set it in DLE Librarian settings.');

    let systemContent = [];
    const apiMessages = [];
    for (const msg of messages) {
        if (msg.role === 'system') {
            systemContent.push({ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } });
        } else {
            apiMessages.push(msg);
        }
    }

    const targetUrl = proxyUrl.replace(/\/+$/, '') + '/v1/messages';
    const corsProxyUrl = `/proxy/${encodeURIComponent(targetUrl)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => abortWith(controller, 'agentic-api:timeout'), timeout);
    let onExternalAbort = null;

    if (signal) {
        if (signal.aborted) {
            const reason = signal.reason?.message || 'agentic-api:external_pre_aborted';
            abortWith(controller, reason);
        } else {
            onExternalAbort = () => {
                const reason = signal.reason?.message || 'agentic-api:external';
                abortWith(controller, reason);
            };
            signal.addEventListener('abort', onExternalAbort, { once: true });
        }
    }

    const body = {
        model,
        max_tokens: maxTokens,
        ...(systemContent.length > 0 && { system: systemContent }),
        messages: apiMessages,
        tools: toAnthropicTools(tools),
    };
    const anthropicToolChoice = toAnthropicToolChoice(toolChoice);
    if (anthropicToolChoice) body.tool_choice = anthropicToolChoice;

    try {
        const response = await fetch(corsProxyUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!response.ok) {
            const text = await response.text();
            if (response.status === 404 && text.includes('CORS proxy is disabled')) {
                throw new Error('SillyTavern CORS proxy is not enabled. Set enableCorsProxy: true in config.yaml, or use a Connection Profile instead of Custom Proxy mode.');
            }
            // HIGH-LIB-2 (2026-05-22): scrub BEFORE truncating. If a token starts in
            // the last ~15 chars of the 200-char window, slicing first cuts the token
            // below the regex's {10,} minimum so it never matches — and a partial
            // token leaks into Error.message. Real Anthropic 401/403 bodies do quote
            // the offending header. Always scrub-then-slice for error shaping.
            // See gotchas.md #67.
            const safeText = text
                .replace(/sk-[a-zA-Z0-9_-]{10,}/g, 'sk-***')
                .replace(/Bearer\s+[A-Za-z0-9_\-./]{10,}/g, 'Bearer ***')
                .substring(0, 200);
            throw new Error(`Proxy returned HTTP ${response.status}: ${safeText}`);
        }

        const text = await response.text();
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            throw new Error(`Failed to parse proxy response as JSON: ${e.message}`);
        }
        if (parsed.error) {
            throw new Error(parsed.error.message || JSON.stringify(parsed.error));
        }

        // Return raw Anthropic response — parseToolCalls/getTextContent/getUsage handle Claude format
        return parsed;
    } catch (err) {
        const controllerReason = controller.signal.reason?.message || null;
        const externalReason = signal?.reason?.message || null;
        const abortReason = controllerReason || externalReason || null;
        if (err.name === 'AbortError') {
            if (signal?.aborted) {
                const abortErr = new Error('Request aborted by user');
                abortErr.name = 'AbortError';
                abortErr.userAborted = true;
                abortErr.abortReason = abortReason;
                throw abortErr;
            }
            const timeoutErr = new Error(`Proxy request timed out (${Math.round(timeout / 1000)}s)`, { cause: err });
            timeoutErr.name = 'AbortError';
            timeoutErr.timedOut = true;
            timeoutErr.abortReason = abortReason;
            throw timeoutErr;
        }
        if (abortReason) err.abortReason = abortReason;
        throw err;
    } finally {
        if (signal && onExternalAbort) signal.removeEventListener('abort', onExternalAbort);
        clearTimeout(timer);
    }
}

/**
 * Routes to proxy or CMRS based on Librarian config.
 * @returns {Promise<object>} Raw API response (extractData: false)
 */
export async function callWithTools(messages, tools, toolChoice, maxTokens, signal) {
    const connConfig = resolveConnectionConfig('librarian');
    if (connConfig.mode === 'proxy') {
        // v2.5 dead-head: Custom Proxy removed. `callWithToolsViaProxy` is kept
        // for rollback safety but unreachable from runtime dispatch — throw the
        // same clear error as callAI so users get a consistent migration message.
        throw new Error('Custom Proxy mode was removed in v2.5. Pick a Connection Profile in DLE Settings → Setup → AI Connections.');
    }

    // Resolve once: `connConfig` (above) is the single resolve for this call.
    // Thread it into format + underlying-Claude detection so neither re-calls
    // resolveConnectionConfig('librarian') (→ getSettings()) again this round-trip.
    const format = getProviderFormat(connConfig);

    if (connConfig.mode === 'direct') {
        // Direct API: we issue the request ourselves. The raw provider envelope
        // is returned unchanged because parseToolCalls / getTextContent / getUsage
        // already read both native shapes (Anthropic content[] and OpenAI
        // choices[]) — the same envelopes ST hands back with extractData:false.
        //
        // tool_choice: the caller-side normalization below runs for CMRS. Here
        // the Claude-shaped string ('auto'|'any'|'none') is wrapped into the
        // object form Anthropic expects inside direct-api.js, and OpenAI-shaped
        // values pass through untouched.
        let directToolChoice = toolChoice;
        if (typeof toolChoice === 'string' && format === 'claude') {
            const claudeModeMap = { auto: 'auto', required: 'any', none: 'none' };
            directToolChoice = claudeModeMap[toolChoice] || 'auto';
        }
        return await callDirectApiRaw({
            apiUrl: connConfig.apiUrl,
            apiKey: connConfig.apiKey,
            model: connConfig.model,
            messages,
            maxTokens,
            timeout: connConfig.timeout || 120000,
            format: resolveDirectFormat(connConfig.apiUrl, connConfig.apiFormat),
            viaCorsProxy: connConfig.apiViaCorsProxy,
            tools,
            toolChoice: directToolChoice,
            signal,
        });
    }

    // #27 sym 2: Librarian must use its own configured profile, not ST's globally-active one.
    // No silent fallback — if Librarian's profile (or inherited aiSearch profile) is unset,
    // the user should be told to set it rather than silently inheriting whichever profile
    // happens to be active when Librarian runs.
    if (!connConfig.profileId) {
        throw new Error('Librarian needs a profile in AI Connections settings.');
    }

    // Normalize tool_choice per provider — ST wraps differently per backend:
    //   Claude backend: `{ type: request.body.tool_choice }` — needs Claude type strings.
    //   Google backend (Fix 32): ST's chat-completions.js translates string
    //     'auto'/'required'/'none' to body.toolConfig.functionCallingConfig with the
    //     correct Gemini AUTO/ANY/NONE mapping. The adapter's `typeof === 'string'`
    //     check rejects object form — pre-translating to {mode:'AUTO'} bypasses the
    //     adapter and makes required/none silently degrade to AUTO. Pass raw string.
    //   OpenAI/Cohere: pass through.
    let normalizedToolChoice = toolChoice;
    if (typeof toolChoice === 'string') {
        if (format === 'claude') {
            const claudeModeMap = { auto: 'auto', required: 'any', none: 'none' };
            normalizedToolChoice = claudeModeMap[toolChoice] || 'auto';
        }
    }

    const overridePayload = {
        tools,
        ...(normalizedToolChoice != null && { tool_choice: normalizedToolChoice }),
    };

    // Anthropic rejects forced tool_choice when extended thinking is on
    // ("Thinking may not be enabled when tool_choice forces tool use." — 400).
    // Even with tool_choice='auto', ST may translate json_schema from the active
    // preset into a forced choice on Claude. reasoning_effort='auto' makes
    // calculateClaudeBudgetTokens (prompt-converters.js) return null, so ST does
    // NOT add requestBody.thinking — sidesteps the conflict. Per-request only.
    //
    // OR-Claude path: source is openrouter (format='openai'), but the underlying
    // model is Claude and OR forwards reasoning.effort to Anthropic. Without the
    // second arm, OR users on anthropic/claude-* hit the same 400. Parser stays
    // OpenAI-shape because OR returns OpenAI-shape regardless of upstream.
    if (format === 'claude' || isUnderlyingClaude(undefined, connConfig)) {
        overridePayload.reasoning_effort = 'auto';
    }

    let result;
    try {
        result = await ConnectionManagerRequestService.sendRequest(
            connConfig.profileId,
            messages,
            maxTokens,
            {
                stream: false,
                signal,
                extractData: false,
                includePreset: true,
                includeInstruct: true,
            },
            overridePayload,
        );
    } catch (err) {
        // Tag Gemini safety blocks distinctly. Without typed throw, callers
        // show a generic toast that hides the actionable cause (relax safety,
        // rephrase). Also catches "Candidate text empty" — Gemini returning
        // only thought parts deserves distinct guidance.
        //
        // BUG-AUDIT (Fix 31): walk the cause chain. CMRS wraps backend failures
        // as `new Error('API request failed', { cause: realError })`, so reading
        // err.message alone always gets "API request failed" and the regex never
        // matches. Provider detail lives in err.cause. Bounded depth guards cycles.
        const messages = [];
        let cur = err;
        let depth = 0;
        while (cur && depth++ < 10) {
            if (cur.message) messages.push(String(cur.message));
            cur = cur.cause;
        }
        const combined = messages.join(' | ');
        if (/blocked|SAFETY|RECITATION|promptFeedback|Candidate text empty/i.test(combined)) {
            const tagged = new Error(messages[0] || 'Safety block');
            tagged.name = 'SafetyBlockError';
            tagged.cause = err;
            throw tagged;
        }
        throw err;
    }

    return result;
}

// ════════════════════════════════════════════════════════════════════════════
// Response Parsing (replicates ST's private ToolManager.#getToolCallsFromData)
// ════════════════════════════════════════════════════════════════════════════

/** Falls back on malformed JSON. */
function safeParseArgs(args, fallbackInput) {
    if (typeof args === 'string') {
        try { return JSON.parse(args); }
        catch { console.warn('[DLE] Malformed tool call arguments, skipping:', args.slice(0, 200)); }
    }
    return args || fallbackInput || {};
}

// HIGH-LIB-3 (2026-05-22): synthetic-id storage for Google Gemini function-call
// parts. The previous implementation stamped `p._dleSyntheticId` directly onto
// the raw provider response, which (a) made `parseToolCalls` non-pure despite
// its name, (b) would crash under strict mode if ST ever froze responses, and
// (c) leaked stamped ids into any diagnostic re-serialization of the response.
// The WeakMap keeps the same lookup contract (parseToolCalls writes,
// buildAssistantMessage reads) without mutating raw data. Keyed by part object
// reference — parts only need to be GC'd when the whole response is, so weak
// references are correct here. Cleared in tests via `_resetSyntheticIdsForTests`.
// See gotchas.md #67.
const _syntheticIds = new WeakMap();

/**
 * Read-only accessor — returns an id only if one was previously assigned.
 * `buildAssistantMessage` uses this without forcing assignment so cases where
 * `parseToolCalls` was never called still produce a fresh id at the call site.
 */
export function _getSyntheticId(part) {
    return _syntheticIds.get(part);
}

/**
 * Lifts id stamping out of `parseToolCalls`. Walks Gemini parts, assigns each
 * functionCall part a stable synthetic id (existing one if already assigned),
 * and returns a Map<part, id> for the caller. Does NOT mutate `data` or parts.
 */
export function _ensureSyntheticIds(data) {
    const out = new Map();
    if (!data?.responseContent?.parts) return out;
    for (const p of data.responseContent.parts) {
        if (!p?.functionCall) continue;
        let id = _syntheticIds.get(p);
        if (!id) {
            id = `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            _syntheticIds.set(p, id);
        }
        out.set(p, id);
    }
    return out;
}

/** Test-only — clears the WeakMap by re-instantiating its closure semantics is impossible,
 *  but tests can verify isolation by always passing fresh part objects. Exposed here
 *  so HIGH-LIB-3 regression tests can assert mutation-freeness without touching prod state. */
export function _isWeakMapBacked() {
    return _syntheticIds instanceof WeakMap;
}

/**
 * Normalizes 4 provider formats to [{id, name, input}].
 */
export function parseToolCalls(data) {
    if (!data) return [];

    // 1. Claude: content[].type === 'tool_use'
    if (Array.isArray(data.content)) {
        const toolUses = data.content.filter(c => c.type === 'tool_use');
        if (toolUses.length > 0) {
            return toolUses.map(t => ({
                id: t.id,
                name: t.name,
                input: t.input || {},
            }));
        }
    }

    // 2. Google Gemini/Vertex: responseContent.parts[].functionCall
    // Synthetic id is assigned via the module-level WeakMap (see
    // `_ensureSyntheticIds`) so `buildAssistantMessage` can reuse it for
    // OpenAI-shape `tool_calls[].id` WITHOUT mutating the raw provider
    // response. Closes the round-trip: buildToolResults emits tool_call_id
    // matching that id, and ST's convertGooglePrompt.toolNameMap resolves the
    // function name from the id on the next turn. HIGH-LIB-3 fix (2026-05-22).
    if (data.responseContent?.parts) {
        const functionCalls = data.responseContent.parts.filter(p => p.functionCall);
        if (functionCalls.length > 0) {
            const idMap = _ensureSyntheticIds(data);
            return functionCalls.map(p => ({
                id: idMap.get(p),
                name: p.functionCall.name,
                input: p.functionCall.args || {},
            }));
        }
    }

    // 3. OpenAI-compatible
    if (data.choices?.[0]?.message?.tool_calls) {
        return data.choices[0].message.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function?.name || tc.name,
            input: safeParseArgs(tc.function?.arguments, tc.input),
        }));
    }

    // 4. Cohere
    if (data.message?.tool_calls) {
        return data.message.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function?.name || tc.name,
            input: safeParseArgs(tc.function?.arguments, tc.input),
        }));
    }

    return [];
}

/**
 * Defensive second pass for partial-reasoning models that still emit
 * <think>...</think> alongside tool use (Claude 3.7+, deepseek-chat with
 * thinking on, GLM-4.6). Pure reasoning-only models are gated upstream.
 */
function stripReasoningTags(text) {
    if (!text || typeof text !== 'string') return text || '';
    return text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
}

/**
 * Filters Gemini `p.thought=true` parts (2.5/3 reasoning blocks) and strips
 * <think> tags from prose.
 */
export function getTextContent(data) {
    if (!data) return '';

    let text = '';

    if (Array.isArray(data.content)) {
        // Claude
        const textBlocks = data.content.filter(b => b.type === 'text');
        if (textBlocks.length > 0) text = textBlocks.map(b => b.text).join('');
    }
    else if (data.responseContent?.parts) {
        // Google — drop thought parts so reasoning doesn't leak.
        const textParts = data.responseContent.parts.filter(p => p.text != null && p.thought !== true);
        if (textParts.length > 0) text = textParts.map(p => p.text).join('');
    }
    else if (data.choices?.[0]?.message?.content != null) {
        text = data.choices[0].message.content;
    }
    else if (data.message?.content?.[0]?.text != null) {
        text = data.message.content[0].text;
    }

    return stripReasoningTags(text);
}

export function getUsage(data) {
    if (!data) return { input_tokens: 0, output_tokens: 0 };

    const u = data.usage || data.usageMetadata || {};
    return {
        input_tokens: u.input_tokens || u.prompt_tokens || u.promptTokenCount || 0,
        output_tokens: u.output_tokens || u.completion_tokens || u.candidatesTokenCount || 0,
    };
}

// ════════════════════════════════════════════════════════════════════════════
// Message Building (provider-native formats for multi-turn tool conversations)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Preserves provider-native format so the API sees its own output shape on
 * the next turn.
 * @param {object} data Raw provider response.
 * @param {'claude'|'google'|'openai'|null} [format] Pre-resolved provider
 *   format. When omitted, resolves it (one `getSettings()`); the agentic loop
 *   resolves it once per round-trip and threads it here to avoid that.
 */
export function buildAssistantMessage(data, format = getProviderFormat()) {

    if (format === 'claude') {
        return { role: 'assistant', content: data.content };
    }

    if (format === 'google') {
        // Emit OpenAI shape — convertGooglePrompt only reads message.content
        // and silently drops native {role:'model', parts:[]} (verified ST
        // staging prompt-converters.js, 2026-04-24). Without this, every
        // assistant turn after the first becomes parts:[{text:''}], breaking
        // multi-turn tool loops on Gemini entirely.
        const parts = data.responseContent?.parts || [];
        const textParts = parts.filter(p => typeof p.text === 'string' && p.thought !== true);
        const fnParts = parts.filter(p => p.functionCall);
        const result = { role: 'assistant' };
        if (textParts.length > 0) result.content = textParts.map(p => p.text).join('\n\n');
        if (fnParts.length > 0) {
            // Reuse parseToolCalls's synthetic id (stored in module WeakMap, not
            // on the part) so buildToolResults's tool_call_id matches on the next
            // turn. If parseToolCalls was somehow not called first (defensive),
            // fall back to a deterministic-per-call id so the message still
            // round-trips. HIGH-LIB-3 fix (2026-05-22).
            result.tool_calls = fnParts.map((p, i) => {
                const id = _getSyntheticId(p) || `gemini-${Date.now()}-${i}`;
                return {
                    id,
                    type: 'function',
                    function: {
                        name: p.functionCall.name,
                        arguments: JSON.stringify(p.functionCall.args || {}),
                    },
                };
            });
        }
        return result;
    }

    // OpenAI / Cohere
    const msg = data.choices?.[0]?.message || data.message;
    const result = { role: 'assistant' };
    if (msg?.content) result.content = msg.content;
    if (msg?.tool_calls) result.tool_calls = msg.tool_calls;
    return result;
}

/**
 * C4: Claude requires all tool_result blocks in ONE user message.
 * @param {Array<object>} results Tool results.
 * @param {'claude'|'google'|'openai'|null} [format] Pre-resolved provider
 *   format. When omitted, resolves it (one `getSettings()`); the agentic loop
 *   resolves it once per round-trip and threads it here to avoid that.
 * @returns {object|Array<object>} Message(s) to append
 */
export function buildToolResults(results, format = getProviderFormat()) {

    if (format === 'claude') {
        return {
            role: 'user',
            content: results.map(r => ({
                type: 'tool_result',
                tool_use_id: r.id,
                content: r.result,
            })),
        };
    }

    if (format === 'google') {
        // OpenAI shape — matches the google branch of buildAssistantMessage.
        // ST's convertGooglePrompt resolves tool_call_id → function name via
        // its toolNameMap built from the prior assistant turn's tool_calls.
        return results.map(r => ({
            role: 'tool',
            tool_call_id: r.id,
            content: r.result,
        }));
    }

    return results.map(r => ({
        role: 'tool',
        tool_call_id: r.id,
        content: r.result,
    }));
}
