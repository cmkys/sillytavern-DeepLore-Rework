/**
 * DeepLore — Direct API connection mode.
 *
 * Point a DeepLore feature straight at an API endpoint (URL + key) instead of
 * routing through a SillyTavern Connection Profile. Added because Connection
 * Manager profiles are a moving target — a renamed/deleted profile, a preset
 * whose `reasoning_effort` ST rejects, or a source ST maps differently than the
 * user expects all surface as "AI search just stopped working" with no obvious
 * fix. Direct mode removes ST from the request path entirely: DLE builds the
 * body, sets the auth header, and reads the response.
 *
 * Two wire formats cover essentially every provider:
 *   - `openai`    — POST {base}/chat/completions, `Authorization: Bearer <key>`.
 *                   OpenAI, OpenRouter, Groq, DeepSeek, Mistral, xAI, Together,
 *                   Gemini's OpenAI-compat endpoint, and every local runtime
 *                   (Ollama, LM Studio, llama.cpp, TabbyAPI, KoboldCpp).
 *   - `anthropic` — POST {base}/v1/messages, `x-api-key` + `anthropic-version`.
 *
 * CORS: the browser issues these requests, so the endpoint must send
 * `Access-Control-Allow-Origin`. Most hosted providers do (Anthropic needs the
 * `anthropic-dangerous-direct-browser-access` header, which we always send);
 * local runtimes usually need their own CORS flag. When an endpoint refuses,
 * `viaCorsProxy` re-routes through SillyTavern's `/proxy/:url` bridge — that is
 * a SERVER-side fetch, so the full SSRF validator applies to it.
 *
 * NOTE: this module must stay free of SillyTavern imports (beyond the
 * diagnostics abort helper) so the builders/parsers below stay unit-testable.
 */
import { abortWith } from '../diagnostics/interceptors.js';
import { assertNoMetadataEndpoint, assertNoServerSideSsrf, hostnameOf, parseHttpUrl, scrubSecrets } from './url-safety.js';

/** Selectable values for `<tool>ApiFormat`. 'auto' resolves via detectDirectFormat(). */
export const DIRECT_API_FORMATS = ['auto', 'openai', 'anthropic'];

/** Anthropic's Messages API version pin — same value ST sends. */
const ANTHROPIC_VERSION = '2023-06-01';

/** Error bodies are echoed to the user; cap them after scrubbing. */
const ERROR_BODY_MAX = 300;

/**
 * Guess the wire format from the URL alone, for `format: 'auto'`.
 *
 * Deliberately conservative: anything not recognizably Anthropic is treated as
 * OpenAI-compatible, because that is what almost every other endpoint speaks
 * (including Anthropic-compatible relays that expose `/v1/messages`, which the
 * path check below still catches).
 */
export function detectDirectFormat(url) {
    if (typeof url !== 'string' || !url.trim()) return 'openai';
    let parsed;
    try { parsed = new URL(url); }
    catch { return 'openai'; }
    const host = hostnameOf(parsed);
    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    // An explicit `/chat/completions` path wins even on an Anthropic-ish host —
    // claude-code-proxy and friends expose OpenAI-shaped routes too.
    if (path.endsWith('/chat/completions')) return 'openai';
    if (host === 'api.anthropic.com' || host.endsWith('.anthropic.com')) return 'anthropic';
    if (path.endsWith('/messages')) return 'anthropic';
    return 'openai';
}

/**
 * Resolve the effective format. `''`/`'auto'`/unknown values fall back to
 * detection so a stale or hand-edited setting can't wedge the connection.
 */
export function resolveDirectFormat(url, configured) {
    if (configured === 'openai' || configured === 'anthropic') return configured;
    return detectDirectFormat(url);
}

/**
 * Turn whatever the user pasted into a full endpoint URL.
 *
 * Accepts a bare host (`http://127.0.0.1:11434`), a versioned base
 * (`https://api.openai.com/v1`), or an already-complete endpoint
 * (`https://api.openai.com/v1/chat/completions`) — pasting the exact URL from a
 * provider's docs is the single most common thing a user will do, so a complete
 * endpoint must pass through untouched rather than growing a second suffix.
 */
export function buildDirectEndpoint(url, format) {
    const parsed = parseHttpUrl(url, 'API URL');
    // Query/hash on a base URL is meaningless here and would land after the
    // appended path; drop it rather than building a broken URL.
    parsed.search = '';
    parsed.hash = '';
    const path = parsed.pathname.replace(/\/+$/, '');

    if (format === 'anthropic') {
        if (path.endsWith('/messages')) { parsed.pathname = path; return parsed.toString(); }
        parsed.pathname = path.endsWith('/v1') ? `${path}/messages` : `${path}/v1/messages`;
        return parsed.toString();
    }

    // OpenAI-compatible.
    if (path.endsWith('/chat/completions')) { parsed.pathname = path; return parsed.toString(); }
    if (path.endsWith('/completions')) { parsed.pathname = path; return parsed.toString(); }
    parsed.pathname = path.endsWith('/v1') ? `${path}/chat/completions` : `${path}/v1/chat/completions`;
    return parsed.toString();
}

/**
 * Validate an API URL for the transport that will actually fetch it.
 * @param {string} url
 * @param {boolean} viaCorsProxy - true when ST's server does the fetch.
 */
export function validateDirectApiUrl(url, viaCorsProxy = false) {
    return viaCorsProxy
        ? assertNoServerSideSsrf(url, 'API URL')
        : assertNoMetadataEndpoint(url, 'API URL');
}

/** Auth + protocol headers for the chosen format. */
export function buildDirectHeaders(format, apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (format === 'anthropic') {
        headers['anthropic-version'] = ANTHROPIC_VERSION;
        // Anthropic blocks browser-origin requests unless this opt-in is present.
        // Harmless on relays that don't know it.
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
        if (key) headers['x-api-key'] = key;
    } else if (key) {
        headers.Authorization = `Bearer ${key}`;
    }
    return headers;
}

/**
 * Convert OpenAI-shaped tool definitions to Anthropic's shape.
 * The Librarian authors tools in OpenAI shape (that is what ST consumes), so
 * direct-Anthropic has to translate what ST would have translated.
 */
export function toAnthropicTools(tools) {
    if (!Array.isArray(tools)) return undefined;
    return tools.map(t => {
        const fn = t?.function || t || {};
        return {
            name: fn.name,
            description: fn.description || '',
            input_schema: fn.parameters || { type: 'object', properties: {} },
        };
    });
}

/**
 * Split an OpenAI-shaped message list into Anthropic's `{system, messages}`.
 * Multiple system turns are joined — Anthropic takes exactly one system field.
 */
export function splitAnthropicMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const systemParts = [];
    const rest = [];
    for (const m of list) {
        if (m?.role === 'system') {
            if (typeof m.content === 'string') systemParts.push(m.content);
            else if (Array.isArray(m.content)) systemParts.push(m.content.map(c => c?.text || '').join('\n'));
        } else {
            // Shallow-copy: the cacheHints path below rewrites `content` on the
            // last turn, and the Librarian reuses its message array across loop
            // iterations — mutating the caller's objects would corrupt the next
            // round-trip (and any retry) with this call's cache blocks.
            rest.push({ ...m });
        }
    }
    return { system: systemParts.join('\n\n'), messages: rest };
}

/**
 * Build the request body.
 *
 * @param {string} format 'openai' | 'anthropic'
 * @param {object} opts
 * @param {string} opts.model
 * @param {Array} opts.messages OpenAI-shaped message list.
 * @param {number} opts.maxTokens
 * @param {{stablePrefix?: string, dynamicSuffix?: string}} [opts.cacheHints]
 * @param {{name: string, description?: string, value: object, strict?: boolean}} [opts.jsonSchema]
 *        ST's json_schema shape — `value` holds the JSON Schema itself.
 * @param {Array} [opts.tools] OpenAI-shaped tool definitions.
 * @param {string|object} [opts.toolChoice]
 */
export function buildDirectBody(format, opts) {
    const { model, messages, maxTokens, cacheHints, jsonSchema, tools, toolChoice } = opts;

    if (format === 'anthropic') {
        const split = splitAnthropicMessages(messages);
        const body = {
            model,
            max_tokens: maxTokens,
            messages: split.messages,
        };
        if (split.system) {
            body.system = [{ type: 'text', text: split.system, cache_control: { type: 'ephemeral' } }];
        }
        // Prompt caching: split the single user turn so the stable prefix (the
        // manifest) is cacheable and only the suffix varies per call.
        if (cacheHints?.stablePrefix && cacheHints?.dynamicSuffix && body.messages.length) {
            const last = body.messages[body.messages.length - 1];
            if (last.role === 'user' && typeof last.content === 'string') {
                last.content = [
                    { type: 'text', text: cacheHints.stablePrefix, cache_control: { type: 'ephemeral' } },
                    { type: 'text', text: cacheHints.dynamicSuffix },
                ];
            }
        }
        const anthropicTools = toAnthropicTools(tools);
        if (anthropicTools?.length) {
            body.tools = anthropicTools;
            if (typeof toolChoice === 'string') body.tool_choice = { type: toolChoice };
            else if (toolChoice) body.tool_choice = toolChoice;
        } else if (jsonSchema?.value) {
            // Anthropic has no response_format — force a single-tool call whose
            // input IS the structured object, exactly like ST does on Claude.
            body.tools = [{
                name: jsonSchema.name || 'structured_output',
                description: jsonSchema.description || 'Return the structured result.',
                input_schema: jsonSchema.value,
            }];
            body.tool_choice = { type: 'tool', name: body.tools[0].name };
        }
        return body;
    }

    const openaiMessages = Array.isArray(messages) ? messages.map(m => ({ ...m })) : [];
    if (cacheHints?.stablePrefix && cacheHints?.dynamicSuffix && openaiMessages.length) {
        const last = openaiMessages[openaiMessages.length - 1];
        if (last.role === 'user' && typeof last.content === 'string') {
            last.content = `${cacheHints.stablePrefix}${cacheHints.dynamicSuffix}`;
        }
    }
    const body = {
        model,
        messages: openaiMessages,
        max_tokens: maxTokens,
        stream: false,
    };
    if (Array.isArray(tools) && tools.length) {
        body.tools = tools;
        if (toolChoice != null) body.tool_choice = toolChoice;
    } else if (jsonSchema?.value) {
        body.response_format = {
            type: 'json_schema',
            json_schema: {
                name: jsonSchema.name || 'structured_output',
                strict: jsonSchema.strict !== false,
                schema: jsonSchema.value,
            },
        };
    }
    return body;
}

/**
 * Extract `{text, usage}` from a raw provider response.
 * Tolerates both formats regardless of `format` so a mis-set format flag still
 * yields text rather than an empty string.
 */
export function parseDirectResponse(data) {
    if (!data || typeof data !== 'object') return { text: '', usage: { input_tokens: 0, output_tokens: 0 } };

    let text = '';
    if (Array.isArray(data.content)) {
        // Anthropic: prefer text blocks; fall back to a forced tool_use payload
        // (that is where schema-constrained output lands).
        text = data.content.filter(c => c?.type === 'text').map(c => c.text || '').join('');
        if (!text) {
            const toolUse = data.content.find(c => c?.type === 'tool_use');
            if (toolUse) { try { text = JSON.stringify(toolUse.input ?? {}); } catch { text = ''; } }
        }
    } else if (data.choices?.[0]) {
        const msg = data.choices[0].message || {};
        text = typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content) ? msg.content.map(c => c?.text || '').join('') : '';
        if (!text && Array.isArray(msg.tool_calls) && msg.tool_calls[0]?.function?.arguments) {
            text = msg.tool_calls[0].function.arguments;
        }
        if (!text && typeof data.choices[0].text === 'string') text = data.choices[0].text;
    }

    const u = data.usage || {};
    return {
        text: text || '',
        usage: {
            // Anthropic uses input_tokens/output_tokens; OpenAI prompt_/completion_.
            input_tokens: u.input_tokens ?? u.prompt_tokens ?? 0,
            output_tokens: u.output_tokens ?? u.completion_tokens ?? 0,
        },
    };
}

/** Scrub then truncate — never the other way round (gotchas.md #56). */
function safeErrorBody(text) {
    return scrubSecrets(text).substring(0, ERROR_BODY_MAX);
}

/**
 * Turn a non-ok response into an error whose message is actionable and whose
 * flags feed the shared breaker classifier (401/403/429 must not trip it).
 */
function httpError(status, bodyText, endpointHost) {
    const safe = safeErrorBody(bodyText);
    let hint = '';
    if (status === 401 || status === 403) hint = ' — check the API key';
    else if (status === 404) hint = ` — check the API URL (tried ${endpointHost})`;
    else if (status === 429) hint = ' — rate limited by the provider';
    const err = new Error(`Direct API returned HTTP ${status}${hint}: ${safe}`);
    err.status = status;
    return err;
}

/**
 * Issue one Direct API request and return the RAW provider JSON.
 * Callers wanting `{text, usage}` should use `callDirectApi` instead; the raw
 * shape exists for the Librarian's tool-calling loop, whose parsers already
 * understand both providers' native envelopes.
 *
 * @param {object} opts
 * @param {string} opts.apiUrl      Base URL or full endpoint.
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array}  opts.messages    OpenAI-shaped messages.
 * @param {number} opts.maxTokens
 * @param {number} [opts.timeout=30000]
 * @param {string} [opts.format='auto']
 * @param {boolean} [opts.viaCorsProxy=false]
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.cacheHints]
 * @param {object} [opts.jsonSchema]
 * @param {Array}  [opts.tools]
 * @param {string|object} [opts.toolChoice]
 * @returns {Promise<object>} Raw provider response JSON.
 */
export async function callDirectApiRaw(opts) {
    const {
        apiUrl, apiKey, model, messages, maxTokens,
        timeout = 30000, format = 'auto', viaCorsProxy = false,
        signal, cacheHints, jsonSchema, tools, toolChoice,
    } = opts || {};

    if (!apiUrl || !String(apiUrl).trim()) {
        throw new Error('Direct API mode needs an API URL. Set one in DLE Settings → Setup → AI Connections.');
    }
    if (!model || !String(model).trim()) {
        // The model is never implied in direct mode — there is no profile to read
        // it from, and providers reject the request with an opaque 400.
        throw new Error('Direct API mode needs a model name. Set one in DLE Settings → Setup → AI Connections.');
    }

    validateDirectApiUrl(apiUrl, viaCorsProxy);
    const resolvedFormat = resolveDirectFormat(apiUrl, format);
    const endpoint = buildDirectEndpoint(apiUrl, resolvedFormat);
    const endpointHost = hostnameOf(new URL(endpoint));
    // ST's bridge takes the target URL encoded, so Express doesn't collapse `://`.
    const requestUrl = viaCorsProxy ? `/proxy/${encodeURIComponent(endpoint)}` : endpoint;

    const body = buildDirectBody(resolvedFormat, {
        model: String(model).trim(), messages, maxTokens, cacheHints, jsonSchema, tools, toolChoice,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => abortWith(controller, 'direct:timeout'), timeout);
    let onExternalAbort = null;
    if (signal) {
        if (signal.aborted) {
            clearTimeout(timer);
            const err = new Error('Request aborted by user');
            err.name = 'AbortError';
            err.userAborted = true;
            err.abortReason = signal.reason?.message || 'direct:external_pre_aborted';
            throw err;
        }
        onExternalAbort = () => abortWith(controller, signal.reason?.message || 'direct:external');
        signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
        const response = await fetch(requestUrl, {
            method: 'POST',
            headers: buildDirectHeaders(resolvedFormat, apiKey),
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!response.ok) {
            const text = await response.text();
            if (response.status === 404 && viaCorsProxy && text.includes('CORS proxy is disabled')) {
                throw new Error('SillyTavern\'s CORS proxy is disabled. Set enableCorsProxy: true in config.yaml, or untick "Route through SillyTavern\'s CORS proxy".');
            }
            throw httpError(response.status, text, endpointHost);
        }

        // Read then parse separately so a transport failure and a malformed body
        // produce distinguishable errors.
        const text = await response.text();
        let parsed;
        try { parsed = JSON.parse(text); }
        catch (e) { throw new Error(`Failed to parse Direct API response as JSON: ${e.message}`); }
        if (parsed?.error) {
            throw new Error(safeErrorBody(parsed.error.message || JSON.stringify(parsed.error)));
        }
        return parsed;
    } catch (err) {
        const abortReason = controller.signal.reason?.message || signal?.reason?.message || null;
        if (err.name === 'AbortError') {
            if (signal?.aborted) {
                const abortErr = new Error('Request aborted by user');
                abortErr.name = 'AbortError';
                abortErr.userAborted = true;
                abortErr.abortReason = abortReason;
                throw abortErr;
            }
            const timeoutErr = new Error(`Direct API request timed out (${Math.round(timeout / 1000)}s)`, { cause: err });
            timeoutErr.name = 'AbortError';
            timeoutErr.timedOut = true;
            timeoutErr.abortReason = abortReason;
            throw timeoutErr;
        }
        // A browser CORS rejection surfaces as an opaque TypeError ("Failed to
        // fetch") with no status — the single most likely direct-mode failure,
        // and undiagnosable without this rewrite.
        if (err instanceof TypeError && !viaCorsProxy) {
            const corsErr = new Error(`Could not reach ${endpointHost} from the browser — the endpoint refused the request or blocked it via CORS. Tick "Route through SillyTavern's CORS proxy" in AI Connections, or enable CORS on the endpoint.`, { cause: err });
            corsErr.corsSuspected = true;
            throw corsErr;
        }
        if (abortReason) err.abortReason = abortReason;
        throw err;
    } finally {
        if (signal && onExternalAbort) signal.removeEventListener('abort', onExternalAbort);
        clearTimeout(timer);
    }
}

/**
 * Direct API call shaped like the rest of DLE's AI layer.
 * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}}>}
 */
export async function callDirectApi(systemPrompt, userMessage, opts) {
    const { forceUserRole, ...rest } = opts || {};
    // Mirrors `aiForceUserRole` on the profile path: some providers reject the
    // system role outright, so fold it into the user turn on request.
    const messages = forceUserRole
        ? [{ role: 'user', content: `[Instructions]\n${systemPrompt}\n\n---\n\n${userMessage}` }]
        : [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
        ];
    const data = await callDirectApiRaw({ ...rest, messages });
    return parseDirectResponse(data);
}

/**
 * One-line connectivity probe used by the settings "Test message" button.
 * @returns {Promise<{ok: boolean, response?: string, error?: string, aborted?: boolean}>}
 */
export async function testDirectConnection(opts) {
    try {
        const result = await callDirectApi('You are a connection test. Reply with one short word.', 'Reply with exactly: OK', {
            ...opts,
            maxTokens: 16,
            timeout: opts?.timeout || 15000,
        });
        return { ok: true, response: (result.text || '').substring(0, 100) };
    } catch (err) {
        return { ok: false, error: err.message, aborted: !!(err && (err.userAborted || opts?.signal?.aborted)) };
    }
}
