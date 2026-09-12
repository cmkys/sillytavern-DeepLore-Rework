/**
 * DeepLore — Direct API connection mode tests.
 *
 * Covers the pure builders/parsers in src/ai/direct-api.js and src/ai/url-safety.js,
 * the fetch-level behavior of callDirectApiRaw (mocked globalThis.fetch), and the
 * source-level wiring that makes 'direct' a first-class connection mode
 * (settings keys, dispatch branches, per-tool routers).
 *
 * Run with: node test/direct-api.test.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assert, assertEqual, assertMatch, assertThrows, assertNotNull,
    test, section, summary,
} from './helpers.mjs';

import {
    DIRECT_API_FORMATS,
    detectDirectFormat, resolveDirectFormat, buildDirectEndpoint,
    validateDirectApiUrl, buildDirectHeaders, buildDirectBody,
    parseDirectResponse, toAnthropicTools, splitAnthropicMessages,
    callDirectApi, callDirectApiRaw, testDirectConnection,
} from '../src/ai/direct-api.js';
import {
    assertNoMetadataEndpoint, assertNoServerSideSsrf, parseHttpUrl, scrubSecrets,
} from '../src/ai/url-safety.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Swap globalThis.fetch for the duration of `fn`, always restoring it. */
async function withFetch(impl, fn) {
    const orig = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return impl(url, init); };
    try { return await fn(calls); }
    finally { globalThis.fetch = orig; }
}

const okResponse = (json) => ({ ok: true, status: 200, text: async () => JSON.stringify(json) });

// ════════════════════════════════════════════════════════════════════════════
section('DIRECT-FMT — format detection');

test('DIRECT-FMT-1: bare host and OpenAI bases detect as openai', () => {
    assertEqual(detectDirectFormat('https://api.openai.com/v1'), 'openai', 'openai base');
    assertEqual(detectDirectFormat('http://127.0.0.1:11434'), 'openai', 'ollama bare host');
    assertEqual(detectDirectFormat('https://openrouter.ai/api/v1'), 'openai', 'openrouter');
    assertEqual(detectDirectFormat('https://generativelanguage.googleapis.com/v1beta/openai'), 'openai', 'gemini openai-compat');
});

test('DIRECT-FMT-2: anthropic host and /messages paths detect as anthropic', () => {
    assertEqual(detectDirectFormat('https://api.anthropic.com'), 'anthropic', 'anthropic host');
    assertEqual(detectDirectFormat('https://api.anthropic.com/v1'), 'anthropic', 'anthropic base');
    assertEqual(detectDirectFormat('http://127.0.0.1:42069/v1/messages'), 'anthropic', 'relay /v1/messages');
});

test('DIRECT-FMT-3: an explicit /chat/completions path beats an anthropic-ish host', () => {
    // claude-code-proxy and similar relays expose BOTH routes; the path the user
    // actually pasted is the stronger signal.
    assertEqual(detectDirectFormat('https://api.anthropic.com/v1/chat/completions'), 'openai',
        'explicit openai path wins over host');
});

test('DIRECT-FMT-4: junk input degrades to openai instead of throwing', () => {
    assertEqual(detectDirectFormat(''), 'openai', 'empty string');
    assertEqual(detectDirectFormat(null), 'openai', 'null');
    assertEqual(detectDirectFormat('not a url'), 'openai', 'unparseable');
});

test('DIRECT-FMT-5: resolveDirectFormat honors an explicit choice, else detects', () => {
    assertEqual(resolveDirectFormat('https://api.openai.com/v1', 'anthropic'), 'anthropic', 'explicit anthropic');
    assertEqual(resolveDirectFormat('https://api.anthropic.com', 'openai'), 'openai', 'explicit openai');
    assertEqual(resolveDirectFormat('https://api.anthropic.com', 'auto'), 'anthropic', 'auto detects');
    // A hand-edited / stale settings value must not wedge the connection.
    assertEqual(resolveDirectFormat('https://api.anthropic.com', 'gibberish'), 'anthropic', 'unknown falls back to detect');
    assertEqual(resolveDirectFormat('https://api.openai.com/v1', ''), 'openai', 'empty falls back to detect');
});

test('DIRECT-FMT-6: DIRECT_API_FORMATS is the UI whitelist', () => {
    assert(Array.isArray(DIRECT_API_FORMATS), 'exported as an array');
    for (const f of ['auto', 'openai', 'anthropic']) {
        assert(DIRECT_API_FORMATS.includes(f), `includes ${f}`);
    }
});

// ════════════════════════════════════════════════════════════════════════════
section('DIRECT-EP — endpoint building');

test('DIRECT-EP-1: openai base URLs grow /chat/completions exactly once', () => {
    assertEqual(buildDirectEndpoint('https://api.openai.com/v1', 'openai'), 'https://api.openai.com/v1/chat/completions');
    assertEqual(buildDirectEndpoint('https://api.openai.com/v1/', 'openai'), 'https://api.openai.com/v1/chat/completions', 'trailing slash');
    assertEqual(buildDirectEndpoint('http://127.0.0.1:11434', 'openai'), 'http://127.0.0.1:11434/v1/chat/completions', 'bare host gets /v1');
    assertEqual(buildDirectEndpoint('https://openrouter.ai/api/v1', 'openai'), 'https://openrouter.ai/api/v1/chat/completions');
});

test('DIRECT-EP-2: a full openai endpoint passes through untouched', () => {
    // Pasting the exact URL from a provider's docs is the most common input;
    // a second appended suffix would 404 with no obvious cause.
    assertEqual(buildDirectEndpoint('https://api.openai.com/v1/chat/completions', 'openai'),
        'https://api.openai.com/v1/chat/completions');
    assertEqual(buildDirectEndpoint('https://api.openai.com/v1/chat/completions/', 'openai'),
        'https://api.openai.com/v1/chat/completions', 'trailing slash stripped, no double-append');
});

test('DIRECT-EP-3: anthropic bases grow /v1/messages exactly once', () => {
    assertEqual(buildDirectEndpoint('https://api.anthropic.com', 'anthropic'), 'https://api.anthropic.com/v1/messages');
    assertEqual(buildDirectEndpoint('https://api.anthropic.com/v1', 'anthropic'), 'https://api.anthropic.com/v1/messages');
    assertEqual(buildDirectEndpoint('https://api.anthropic.com/v1/messages', 'anthropic'), 'https://api.anthropic.com/v1/messages',
        'full endpoint passes through');
});

test('DIRECT-EP-4: query strings and hashes on a base URL are dropped', () => {
    // They would otherwise land BEFORE the appended path and build a broken URL.
    assertEqual(buildDirectEndpoint('https://api.openai.com/v1?foo=bar#frag', 'openai'),
        'https://api.openai.com/v1/chat/completions');
});

test('DIRECT-EP-5: a non-http(s) or empty URL throws with an "API URL" label', () => {
    assertThrows(() => buildDirectEndpoint('', 'openai'), 'empty URL throws');
    assertThrows(() => buildDirectEndpoint('ftp://example.com', 'openai'), 'ftp throws');
    let msg = '';
    try { buildDirectEndpoint('', 'openai'); } catch (e) { msg = e.message; }
    assertMatch(msg, /API URL/, 'error names the API URL, not the proxy URL');
});

// ════════════════════════════════════════════════════════════════════════════
section('DIRECT-SAFE — URL safety, per transport');

test('DIRECT-SAFE-1: browser-issued requests ALLOW localhost and private ranges', () => {
    // Local model runtimes are a first-class direct-mode use case; the browser
    // reaching its own machine is not SSRF.
    for (const url of ['http://127.0.0.1:11434', 'http://localhost:1234/v1', 'http://192.168.1.50:5000', 'http://10.0.0.4:8080']) {
        validateDirectApiUrl(url, false);
    }
    assert(true, 'no throw for local/private hosts on the browser path');
});

test('DIRECT-SAFE-2: browser-issued requests still block cloud metadata endpoints', () => {
    for (const host of ['http://169.254.169.254/latest', 'http://metadata.google.internal', 'http://100.100.100.200']) {
        assertThrows(() => validateDirectApiUrl(host, false), `${host} blocked`);
    }
    let msg = '';
    try { validateDirectApiUrl('http://169.254.169.254', false); } catch (e) { msg = e.message; }
    assertMatch(msg, /metadata/i, 'error says why');
});

test('DIRECT-SAFE-3: CORS-proxied requests apply the full server-side SSRF check', () => {
    // ST's server does the fetch here, so the LAN it can reach is not the
    // browser's — private ranges go back to being blocked.
    assertThrows(() => validateDirectApiUrl('http://192.168.1.50:5000', true), 'private blocked via proxy');
    assertThrows(() => validateDirectApiUrl('http://localhost:1234', true), 'localhost blocked via proxy');
    assertThrows(() => validateDirectApiUrl('http://169.254.169.254', true), 'metadata blocked via proxy');
    validateDirectApiUrl('http://127.0.0.1:11434', true); // explicit loopback stays allowed
    validateDirectApiUrl('https://api.openai.com/v1', true);
    assert(true, '127.0.0.1 and public hosts still allowed via the proxy');
});

test('DIRECT-SAFE-4: url-safety keeps the proxy validator behavior it was extracted from', () => {
    // WHATWG URL normalizes IPv4 shorthand before the validator sees it
    // (0300.0250.0.1 → 192.168.0.1), so the octal/decimal forms are caught as
    // their normalized private address rather than by the shorthand regexes.
    assertThrows(() => assertNoServerSideSsrf('http://0300.0250.0.1', 'Proxy URL'), 'octal form of a private address');
    assertThrows(() => assertNoServerSideSsrf('http://3232235777', 'Proxy URL'), 'decimal form of a private address');
    assertThrows(() => assertNoServerSideSsrf('http://100.64.1.1', 'Proxy URL'), 'CGNAT');
    let msg = '';
    try { assertNoServerSideSsrf('http://10.0.0.1', 'Proxy URL'); } catch (e) { msg = e.message; }
    assertMatch(msg, /^Proxy URL "10\.0\.0\.1" points to a private\/reserved network address$/,
        'message wording unchanged after the extraction');
});

test('DIRECT-SAFE-5: parseHttpUrl labels every failure with the caller\'s noun', () => {
    for (const [bad, re] of [['', /^API URL is empty$/], ['nope', /not a valid URL/], ['ws://x.dev', /must use http/]]) {
        let msg = '';
        try { parseHttpUrl(bad, 'API URL'); } catch (e) { msg = e.message; }
        assertMatch(msg, re, `"${bad}" reported with the API URL label`);
    }
    assertNotNull(assertNoMetadataEndpoint('https://api.openai.com/v1'), 'valid URL returns the parsed URL');
});

test('DIRECT-SAFE-6: scrubSecrets redacts provider keys, longest prefix first', () => {
    assertEqual(scrubSecrets('key=sk-proj-abcdefghijklmnop rest'), 'key=sk-proj-*** rest', 'sk-proj before sk-');
    assertEqual(scrubSecrets('key=sk-ant-abcdefghijklmnop'), 'key=sk-ant-***', 'anthropic');
    assertMatch(scrubSecrets('AIzaSyDABCDEFGHIJKLMNOP'), /AIza\*\*\*/, 'google');
    assertMatch(scrubSecrets('Authorization: Bearer abcdefghijklmnop'), /Bearer \*\*\*/, 'bearer');
    assertEqual(scrubSecrets(null), '', 'non-string is safe');
});

// ════════════════════════════════════════════════════════════════════════════
section('DIRECT-HDR — headers');

test('DIRECT-HDR-1: openai format uses Authorization: Bearer', () => {
    const h = buildDirectHeaders('openai', 'sk-test-key');
    assertEqual(h.Authorization, 'Bearer sk-test-key', 'bearer header');
    assertEqual(h['Content-Type'], 'application/json', 'json content type');
    assert(!h['x-api-key'], 'no anthropic key header');
});

test('DIRECT-HDR-2: anthropic format uses x-api-key + version + browser opt-in', () => {
    const h = buildDirectHeaders('anthropic', 'sk-ant-test');
    assertEqual(h['x-api-key'], 'sk-ant-test', 'x-api-key');
    assertEqual(h['anthropic-version'], '2023-06-01', 'version pin');
    // Anthropic rejects browser-origin requests without this opt-in — direct
    // mode fetches from the page, so it is mandatory, not optional.
    assertEqual(h['anthropic-dangerous-direct-browser-access'], 'true', 'browser access opt-in');
    assert(!h.Authorization, 'no bearer header');
});

test('DIRECT-HDR-3: a blank/whitespace key sends no auth header at all', () => {
    // Local runtimes take no key; sending "Bearer " would be a malformed header.
    assert(!buildDirectHeaders('openai', '').Authorization, 'empty key → no header');
    assert(!buildDirectHeaders('openai', '   ').Authorization, 'whitespace key → no header');
    assert(!buildDirectHeaders('anthropic', undefined)['x-api-key'], 'undefined key → no header');
    assertEqual(buildDirectHeaders('openai', '  sk-pad  ').Authorization, 'Bearer sk-pad', 'padding trimmed');
});

// ════════════════════════════════════════════════════════════════════════════
section('DIRECT-BODY — request bodies');

const MSGS = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'USER' },
];

test('DIRECT-BODY-1: openai body carries model, messages, max_tokens, stream:false', () => {
    const b = buildDirectBody('openai', { model: 'gpt-4o-mini', messages: MSGS, maxTokens: 512 });
    assertEqual(b.model, 'gpt-4o-mini', 'model');
    assertEqual(b.max_tokens, 512, 'max_tokens');
    assertEqual(b.stream, false, 'streaming off — callers parse a whole JSON body');
    assertEqual(b.messages.length, 2, 'system stays inline for openai');
    assertEqual(b.messages[0].role, 'system', 'system role preserved');
});

test('DIRECT-BODY-2: anthropic body hoists system out of messages', () => {
    const b = buildDirectBody('anthropic', { model: 'claude-haiku-4-5', messages: MSGS, maxTokens: 512 });
    assertEqual(b.messages.length, 1, 'only the user turn remains in messages');
    assertEqual(b.messages[0].role, 'user', 'user turn');
    assertEqual(b.system[0].text, 'SYS', 'system hoisted to its own field');
    assertEqual(b.system[0].cache_control.type, 'ephemeral', 'system block is cacheable');
});

test('DIRECT-BODY-3: multiple system turns are joined, not dropped', () => {
    const split = splitAnthropicMessages([
        { role: 'system', content: 'A' },
        { role: 'user', content: 'U' },
        { role: 'system', content: 'B' },
    ]);
    assertEqual(split.system, 'A\n\nB', 'both system turns survive');
    assertEqual(split.messages.length, 1, 'non-system turns kept in order');
});

test('DIRECT-BODY-4: cacheHints split the anthropic user turn into prefix + suffix', () => {
    const b = buildDirectBody('anthropic', {
        model: 'm', messages: MSGS, maxTokens: 64,
        cacheHints: { stablePrefix: 'PREFIX', dynamicSuffix: 'SUFFIX' },
    });
    const content = b.messages[0].content;
    assert(Array.isArray(content), 'user content becomes a block array');
    assertEqual(content[0].text, 'PREFIX', 'stable prefix first');
    assertEqual(content[0].cache_control.type, 'ephemeral', 'prefix is the cached block');
    assertEqual(content[1].text, 'SUFFIX', 'dynamic suffix uncached');
});

test('DIRECT-BODY-5: cacheHints concatenate on openai (no block-level caching)', () => {
    const b = buildDirectBody('openai', {
        model: 'm', messages: MSGS, maxTokens: 64,
        cacheHints: { stablePrefix: 'PREFIX', dynamicSuffix: 'SUFFIX' },
    });
    assertEqual(b.messages[1].content, 'PREFIXSUFFIX', 'prefix+suffix concatenated');
    assertEqual(MSGS[1].content, 'USER', 'caller message objects are not mutated');
});

const SCHEMA = {
    name: 'lore_selection',
    description: 'Selected lore',
    value: { type: 'object', properties: { selected: { type: 'array', items: { type: 'string' } } }, required: ['selected'] },
    strict: true,
};

test('DIRECT-BODY-6: jsonSchema becomes response_format on openai', () => {
    const b = buildDirectBody('openai', { model: 'm', messages: MSGS, maxTokens: 64, jsonSchema: SCHEMA });
    assertEqual(b.response_format.type, 'json_schema', 'json_schema response format');
    assertEqual(b.response_format.json_schema.name, 'lore_selection', 'schema name');
    assertEqual(b.response_format.json_schema.strict, true, 'strict');
    // ST's json_schema shape nests the schema under `value`; OpenAI wants `schema`.
    assertEqual(b.response_format.json_schema.schema, SCHEMA.value, 'value unwrapped to schema');
});

test('DIRECT-BODY-7: jsonSchema becomes a forced single tool on anthropic', () => {
    // Anthropic has no response_format — ST forces a tool call for structured
    // output and so do we.
    const b = buildDirectBody('anthropic', { model: 'm', messages: MSGS, maxTokens: 64, jsonSchema: SCHEMA });
    assertEqual(b.tools.length, 1, 'one synthetic tool');
    assertEqual(b.tools[0].name, 'lore_selection', 'named after the schema');
    assertEqual(b.tools[0].input_schema, SCHEMA.value, 'schema becomes input_schema');
    assertEqual(b.tool_choice.type, 'tool', 'forced');
    assertEqual(b.tool_choice.name, 'lore_selection', 'forced onto that tool');
    assert(!b.response_format, 'no openai-only field leaks into the anthropic body');
});

const OA_TOOLS = [{
    type: 'function',
    function: { name: 'search', description: 'Search lore', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
}];

test('DIRECT-BODY-8: real tools win over jsonSchema and pass through on openai', () => {
    const b = buildDirectBody('openai', { model: 'm', messages: MSGS, maxTokens: 64, tools: OA_TOOLS, toolChoice: 'auto', jsonSchema: SCHEMA });
    assertEqual(b.tools, OA_TOOLS, 'openai tools passed through unchanged');
    assertEqual(b.tool_choice, 'auto', 'tool_choice passed through');
    assert(!b.response_format, 'response_format suppressed when real tools are present');
});

test('DIRECT-BODY-9: openai tools are translated to anthropic shape', () => {
    const converted = toAnthropicTools(OA_TOOLS);
    assertEqual(converted[0].name, 'search', 'name lifted out of .function');
    assertEqual(converted[0].description, 'Search lore', 'description lifted');
    assertEqual(converted[0].input_schema, OA_TOOLS[0].function.parameters, 'parameters → input_schema');
    assertEqual(toAnthropicTools(undefined), undefined, 'undefined in, undefined out');
});

test('DIRECT-BODY-10: a Claude-shaped tool_choice string is wrapped into object form', () => {
    const b = buildDirectBody('anthropic', { model: 'm', messages: MSGS, maxTokens: 64, tools: OA_TOOLS, toolChoice: 'any' });
    assertEqual(b.tool_choice.type, 'any', 'string wrapped as {type}');
    const b2 = buildDirectBody('anthropic', { model: 'm', messages: MSGS, maxTokens: 64, tools: OA_TOOLS, toolChoice: { type: 'tool', name: 'search' } });
    assertEqual(b2.tool_choice.name, 'search', 'object form passed through');
});

// ════════════════════════════════════════════════════════════════════════════
section('DIRECT-PARSE — response parsing');

test('DIRECT-PARSE-1: openai choices are read with prompt/completion token mapping', () => {
    const r = parseDirectResponse({
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
    });
    assertEqual(r.text, 'hello', 'text');
    assertEqual(r.usage.input_tokens, 11, 'prompt_tokens → input_tokens');
    assertEqual(r.usage.output_tokens, 3, 'completion_tokens → output_tokens');
});

test('DIRECT-PARSE-2: anthropic content blocks are concatenated', () => {
    const r = parseDirectResponse({
        content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
        usage: { input_tokens: 7, output_tokens: 2 },
    });
    assertEqual(r.text, 'ab', 'text blocks joined');
    assertEqual(r.usage.input_tokens, 7, 'native token names pass through');
});

test('DIRECT-PARSE-3: a forced tool_use payload is returned as JSON text', () => {
    // This is how schema-constrained output arrives on Anthropic — callers run
    // extractAiResponseClient over it, so it must be a JSON string.
    const r = parseDirectResponse({ content: [{ type: 'tool_use', input: { selected: ['A'] } }] });
    assertEqual(r.text, '{"selected":["A"]}', 'tool_use input serialized');
});

test('DIRECT-PARSE-4: openai tool_call arguments fill in for empty content', () => {
    const r = parseDirectResponse({
        choices: [{ message: { content: null, tool_calls: [{ function: { name: 'x', arguments: '{"selected":[]}' } }] } }],
    });
    assertEqual(r.text, '{"selected":[]}', 'arguments used as text');
});

test('DIRECT-PARSE-5: array-shaped openai content and junk input are handled', () => {
    assertEqual(parseDirectResponse({ choices: [{ message: { content: [{ text: 'x' }, { text: 'y' }] } }] }).text, 'xy', 'array content joined');
    assertEqual(parseDirectResponse(null).text, '', 'null → empty text');
    assertEqual(parseDirectResponse({}).usage.input_tokens, 0, 'missing usage → zeros');
    assertEqual(parseDirectResponse('nope').text, '', 'non-object → empty text');
});

// ════════════════════════════════════════════════════════════════════════════
section('DIRECT-CALL — fetch behavior');

test('DIRECT-CALL-1: an openai call posts to the built endpoint with the bearer header', async () => {
    await withFetch(() => okResponse({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        async (calls) => {
            const r = await callDirectApi('SYS', 'USER', {
                apiUrl: 'https://api.openai.com/v1', apiKey: 'sk-test-abcdefghij', model: 'gpt-4o-mini', maxTokens: 32,
            });
            assertEqual(r.text, 'OK', 'text extracted');
            assertEqual(calls.length, 1, 'exactly one request');
            assertEqual(calls[0].url, 'https://api.openai.com/v1/chat/completions', 'endpoint built');
            assertEqual(calls[0].init.headers.Authorization, 'Bearer sk-test-abcdefghij', 'auth sent');
            const body = JSON.parse(calls[0].init.body);
            assertEqual(body.messages[0].content, 'SYS', 'system prompt sent');
            assertEqual(body.messages[1].content, 'USER', 'user message sent');
        });
});

test('DIRECT-CALL-2: forceUserRole folds the system prompt into the user turn', async () => {
    await withFetch(() => okResponse({ choices: [{ message: { content: 'OK' } }] }), async (calls) => {
        await callDirectApi('SYS', 'USER', {
            apiUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'm', maxTokens: 16, forceUserRole: true,
        });
        const body = JSON.parse(calls[0].init.body);
        assertEqual(body.messages.length, 1, 'single merged turn');
        assertEqual(body.messages[0].role, 'user', 'merged into the user role');
        assertMatch(body.messages[0].content, /\[Instructions\][\s\S]*SYS[\s\S]*USER/, 'both parts present');
    });
});

test('DIRECT-CALL-3: viaCorsProxy routes through ST\'s encoded /proxy bridge', async () => {
    await withFetch(() => okResponse({ choices: [{ message: { content: 'OK' } }] }), async (calls) => {
        await callDirectApi('S', 'U', {
            apiUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'm', maxTokens: 16, viaCorsProxy: true,
        });
        assertEqual(calls[0].url, `/proxy/${encodeURIComponent('https://api.openai.com/v1/chat/completions')}`,
            'target URL is encoded so Express does not collapse ://');
    });
});

test('DIRECT-CALL-4: a missing URL or model fails before any fetch', async () => {
    await withFetch(() => { throw new Error('fetch must not run'); }, async (calls) => {
        let e1 = null, e2 = null;
        try { await callDirectApiRaw({ apiUrl: '', model: 'm', messages: [], maxTokens: 8 }); } catch (e) { e1 = e; }
        try { await callDirectApiRaw({ apiUrl: 'https://api.openai.com/v1', model: '', messages: [], maxTokens: 8 }); } catch (e) { e2 = e; }
        assertMatch(e1.message, /needs an API URL/, 'URL error is actionable');
        assertMatch(e2.message, /needs a model name/, 'model error is actionable');
        assertEqual(calls.length, 0, 'no request attempted');
    });
});

test('DIRECT-CALL-5: an HTTP error is scrubbed, truncated, and given a status hint', async () => {
    const key = 'sk-proj-SUPERSECRETKEY1234567890';
    const body = `${'x'.repeat(120)} auth failed for ${key} end`;
    await withFetch(() => ({ ok: false, status: 401, text: async () => body }), async () => {
        let caught = null;
        try {
            await callDirectApi('S', 'U', { apiUrl: 'https://api.openai.com/v1', apiKey: key, model: 'm', maxTokens: 8 });
        } catch (e) { caught = e; }
        assertNotNull(caught, 'throws on non-ok');
        assert(!caught.message.includes(key), `key leaked into the error: ${caught.message}`);
        assert(!caught.message.includes('sk-proj-S'), 'no partial key prefix leaked');
        assertMatch(caught.message, /HTTP 401/, 'status reported');
        assertMatch(caught.message, /check the API key/, '401 carries the actionable hint');
        assertEqual(caught.status, 401, 'status attached for the breaker classifier');
    });
});

test('DIRECT-CALL-6: a 404 names the URL it actually tried', async () => {
    await withFetch(() => ({ ok: false, status: 404, text: async () => 'Not Found' }), async () => {
        let caught = null;
        try {
            await callDirectApi('S', 'U', { apiUrl: 'https://wrong.example.com/v1', apiKey: 'k', model: 'm', maxTokens: 8 });
        } catch (e) { caught = e; }
        assertMatch(caught.message, /check the API URL \(tried wrong\.example\.com\)/, 'names the host');
    });
});

test('DIRECT-CALL-7: a browser CORS rejection is rewritten into an actionable error', async () => {
    // The single most likely direct-mode failure, and undiagnosable raw: the
    // browser reports only an opaque TypeError with no status.
    await withFetch(() => { throw new TypeError('Failed to fetch'); }, async () => {
        let caught = null;
        try {
            await callDirectApi('S', 'U', { apiUrl: 'http://127.0.0.1:11434', model: 'm', maxTokens: 8 });
        } catch (e) { caught = e; }
        assertNotNull(caught, 'throws');
        assert(caught.corsSuspected === true, 'flagged as a suspected CORS failure');
        assertMatch(caught.message, /CORS proxy/, 'points at the CORS proxy toggle');
        assertMatch(caught.message, /127\.0\.0\.1/, 'names the endpoint host');
    });
});

test('DIRECT-CALL-8: the CORS rewrite is suppressed when already proxied', async () => {
    // Via the proxy the fetch is same-origin, so a TypeError means something
    // else — rewriting it would send the user to a toggle they already ticked.
    await withFetch(() => { throw new TypeError('Failed to fetch'); }, async () => {
        let caught = null;
        try {
            await callDirectApi('S', 'U', { apiUrl: 'https://api.openai.com/v1', model: 'm', maxTokens: 8, viaCorsProxy: true });
        } catch (e) { caught = e; }
        assert(!caught.corsSuspected, 'not flagged as CORS when proxied');
    });
});

test('DIRECT-CALL-9: a disabled ST CORS proxy is reported as such, not as a 404', async () => {
    await withFetch(() => ({ ok: false, status: 404, text: async () => 'CORS proxy is disabled.' }), async () => {
        let caught = null;
        try {
            await callDirectApi('S', 'U', { apiUrl: 'https://api.openai.com/v1', model: 'm', maxTokens: 8, viaCorsProxy: true });
        } catch (e) { caught = e; }
        assertMatch(caught.message, /enableCorsProxy/, 'names the config.yaml flag');
    });
});

test('DIRECT-CALL-10: a pre-aborted signal throws a user-abort, not a timeout', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('user:cancel'));
    await withFetch(() => { throw new Error('fetch must not run'); }, async (calls) => {
        let caught = null;
        try {
            await callDirectApi('S', 'U', { apiUrl: 'https://api.openai.com/v1', model: 'm', maxTokens: 8, signal: ctrl.signal });
        } catch (e) { caught = e; }
        assertEqual(caught.name, 'AbortError', 'AbortError');
        assertEqual(caught.userAborted, true, 'flagged as a user abort — not a timeout');
        assert(!caught.timedOut, 'not marked as a timeout');
        assertEqual(calls.length, 0, 'no request attempted');
    });
});

test('DIRECT-CALL-11: an in-flight abort resolves as a user abort', async () => {
    const ctrl = new AbortController();
    await withFetch((url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
            const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        });
        setTimeout(() => ctrl.abort(new Error('user:cancel')), 5);
    }), async () => {
        let caught = null;
        try {
            await callDirectApi('S', 'U', { apiUrl: 'https://api.openai.com/v1', model: 'm', maxTokens: 8, signal: ctrl.signal, timeout: 5000 });
        } catch (e) { caught = e; }
        assertEqual(caught.userAborted, true, 'user abort, not timeout');
    });
});

test('DIRECT-CALL-12: a timeout is flagged timedOut (breaker-excluded classification)', async () => {
    await withFetch((url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
            const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        });
    }), async () => {
        let caught = null;
        try {
            await callDirectApi('S', 'U', { apiUrl: 'https://api.openai.com/v1', model: 'm', maxTokens: 8, timeout: 20 });
        } catch (e) { caught = e; }
        assertEqual(caught.timedOut, true, 'timedOut set');
        assert(!caught.userAborted, 'not a user abort');
        assertMatch(caught.message, /timed out/, 'message says timed out');
    });
});

test('DIRECT-CALL-13: a JSON-level provider error is surfaced scrubbed', async () => {
    await withFetch(() => okResponse({ error: { message: 'Bad key sk-abcdefghijklmnop here' } }), async () => {
        let caught = null;
        try {
            await callDirectApi('S', 'U', { apiUrl: 'https://api.openai.com/v1', model: 'm', maxTokens: 8 });
        } catch (e) { caught = e; }
        assertMatch(caught.message, /Bad key sk-\*\*\* here/, 'provider error text scrubbed');
    });
});

test('DIRECT-CALL-14: a non-JSON 200 body is a distinct, named failure', async () => {
    await withFetch(() => ({ ok: true, status: 200, text: async () => '<html>gateway</html>' }), async () => {
        let caught = null;
        try {
            await callDirectApi('S', 'U', { apiUrl: 'https://api.openai.com/v1', model: 'm', maxTokens: 8 });
        } catch (e) { caught = e; }
        assertMatch(caught.message, /parse Direct API response as JSON/, 'parse failure is distinguishable from a transport failure');
    });
});

test('DIRECT-CALL-15: callDirectApiRaw returns the provider envelope untouched', async () => {
    // The Librarian's parseToolCalls/getTextContent read native shapes, so the
    // raw envelope must survive the round trip unmodified.
    const raw = { content: [{ type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } }], stop_reason: 'tool_use' };
    await withFetch(() => okResponse(raw), async () => {
        const out = await callDirectApiRaw({
            apiUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-haiku-4-5',
            messages: [{ role: 'user', content: 'hi' }], maxTokens: 64, tools: OA_TOOLS, toolChoice: 'auto',
        });
        assertEqual(out.stop_reason, 'tool_use', 'envelope preserved');
        assertEqual(out.content[0].name, 'search', 'tool_use block preserved');
    });
});

test('DIRECT-CALL-16: testDirectConnection reports ok / error instead of throwing', async () => {
    await withFetch(() => okResponse({ choices: [{ message: { content: 'OK' } }] }), async () => {
        const r = await testDirectConnection({ apiUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'm' });
        assertEqual(r.ok, true, 'ok on success');
        assertEqual(r.response, 'OK', 'reply echoed back for the status line');
    });
    await withFetch(() => ({ ok: false, status: 401, text: async () => 'nope' }), async () => {
        const r = await testDirectConnection({ apiUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'm' });
        assertEqual(r.ok, false, 'ok:false on failure');
        assertMatch(r.error, /HTTP 401/, 'error text carried');
    });
});

// ════════════════════════════════════════════════════════════════════════════
section('DIRECT-BRK — circuit-breaker classification');

test('DIRECT-BRK-1: auth, rate-limit, timeout and user-abort failures do NOT trip the breaker', async () => {
    // A bad key or a rate limit is not a service-down signal; without this the
    // second direct call after a typo'd key would lock every AI feature for 30s.
    const { isExcludedFromBreaker } = await import('../src/ai/breaker-pure.js');
    const collect = async (impl, opts = {}) => {
        let caught = null;
        await withFetch(impl, async () => {
            try {
                await callDirectApi('S', 'U', { apiUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'm', maxTokens: 8, ...opts });
            } catch (e) { caught = e; }
        });
        return caught;
    };

    const e401 = await collect(() => ({ ok: false, status: 401, text: async () => 'bad key' }));
    assert(isExcludedFromBreaker(e401), '401 excluded');
    const e429 = await collect(() => ({ ok: false, status: 429, text: async () => 'slow down' }));
    assert(isExcludedFromBreaker(e429), '429 excluded');

    const ctrl = new AbortController();
    ctrl.abort(new Error('user:cancel'));
    const eAbort = await collect(() => ({ ok: true, status: 200, text: async () => '{}' }), { signal: ctrl.signal });
    assert(isExcludedFromBreaker(eAbort), 'user abort excluded');

    const eTimeout = await collect((url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    }), { timeout: 20 });
    assert(isExcludedFromBreaker(eTimeout), 'timeout excluded');
});

test('DIRECT-BRK-2: a 500 DOES trip the breaker (real service-down still sheds load)', async () => {
    const { isExcludedFromBreaker } = await import('../src/ai/breaker-pure.js');
    let caught = null;
    await withFetch(() => ({ ok: false, status: 500, text: async () => 'upstream exploded' }), async () => {
        try {
            await callDirectApi('S', 'U', { apiUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'm', maxTokens: 8 });
        } catch (e) { caught = e; }
    });
    assert(!isExcludedFromBreaker(caught), '500 counts as a breaker failure');
});

// ════════════════════════════════════════════════════════════════════════════
section('DIRECT-WIRE — source wiring');

test('DIRECT-WIRE-1: every tool has the four direct settings keys with safe defaults', () => {
    const src = read('settings.js');
    for (const tool of ['aiSearch', 'scribe', 'autoSuggest', 'aiNotepad', 'librarian', 'optimizeKeys']) {
        assertMatch(src, new RegExp(`${tool}ApiUrl: ''`), `${tool}ApiUrl defaults empty`);
        assertMatch(src, new RegExp(`${tool}ApiKey: ''`), `${tool}ApiKey defaults empty`);
        assertMatch(src, new RegExp(`${tool}ApiFormat: 'auto'`), `${tool}ApiFormat defaults to auto`);
        assertMatch(src, new RegExp(`${tool}ApiViaCorsProxy: false`), `${tool}ApiViaCorsProxy defaults off`);
        assertMatch(src, new RegExp(`apiUrl: '${tool}ApiUrl'`), `${tool} wired into TOOL_SETTINGS_KEYS`);
    }
});

test('DIRECT-WIRE-2: direct mode is whitelisted wherever connection modes are validated', () => {
    const src = read('settings.js');
    assertMatch(src, /aiSearchConnectionMode: \{ enum: \[[^\]]*'direct'/, 'aiSearch root mode accepts direct');
    assertMatch(src, /librarianConnectionMode: \{ enum: \[[^\]]*'direct'/, 'librarian mode accepts direct');
    for (const tool of ['aiSearch', 'scribe', 'autoSuggest', 'aiNotepad', 'librarian', 'optimizeKeys']) {
        assertMatch(src, new RegExp(`${tool}ApiFormat: \\{ enum: \\['auto', 'openai', 'anthropic'\\] \\}`),
            `${tool}ApiFormat has an enum whitelist`);
    }
});

test('DIRECT-WIRE-3: inherit mode takes all four direct fields from AI Search', () => {
    // A per-field cascade would (a) route an "inheriting" tool to a stale
    // per-tool endpoint the UI never shows, and (b) allow AI Search's KEY to be
    // paired with the tool's URL — posting one provider's credential to another.
    const src = read('settings.js');
    assertMatch(src, /const directFrom = \(k\) => \(\{/, 'directFrom helper exists');
    const inheritBranch = src.slice(src.indexOf("if (mode === 'inherit' && toolKey !== 'aiSearch')"));
    assertMatch(inheritBranch.slice(0, 600), /\.\.\.directFrom\(ai\)/, 'inherit branch reads AI Search wholesale');
    assert(!/directFrom\(toolApiUrl/.test(src), 'no per-field mixing of tool URL with inherited key');
});

test('DIRECT-WIRE-4: callAI dispatches direct mode to callDirectApi', () => {
    const src = read('src/ai/ai.js');
    assertMatch(src, /import \{ callDirectApi \} from '\.\/direct-api\.js'/, 'imports the direct module');
    assertMatch(src, /\} else if \(mode === 'direct'\) \{[\s\S]{0,600}?callDirectApi\(/, 'direct branch calls callDirectApi');
    assertMatch(src, /unknown connection mode[\s\S]{0,80}'direct'/, 'the unknown-mode error lists direct');
});

test('DIRECT-WIRE-5: per-tool routers send direct through callAI, not ST\'s quiet prompt', () => {
    // Without an explicit arm, 'direct' falls through to the 'st' branch and
    // silently uses ST's active connection instead of the user's endpoint.
    for (const f of ['src/ai/scribe.js', 'src/ai/auto-suggest.js', 'src/ai/summarize.js']) {
        assertMatch(read(f), /mode === 'profile' \|\| mode === 'direct'/, `${f} routes direct through callAI`);
    }
});

test('DIRECT-WIRE-6: the Librarian resolves model, source, format and tools for direct mode', () => {
    const src = read('src/librarian/agentic-api.js');
    assertMatch(src, /import \{ callDirectApiRaw, resolveDirectFormat \}/, 'imports the direct module');
    assertMatch(src, /export async function callWithTools\([\s\S]*?connConfig\.mode === 'direct'[\s\S]*?callDirectApiRaw\(/,
        'callWithTools dispatches direct mode');
    // getResolvedModel must NOT fall back to an ST global in direct mode — there
    // is no profile, and a global model name the endpoint never heard of 400s.
    assertMatch(src, /export function getResolvedModel\([\s\S]{0,900}?mode === 'direct'[\s\S]{0,400}?return connConfig\.model \|\| ''/,
        'getResolvedModel returns the configured model only');
});

test('DIRECT-WIRE-7: the connections UI offers direct mode for every tool', () => {
    const src = read('src/ui/settings-ui.js');
    assertMatch(src, /direct: 'Direct API \(URL \+ key\)'/, 'mode label present');
    for (const tool of ['aiSearch', 'scribe', 'autoSuggest', 'aiNotepad', 'librarian', 'optimizeKeys']) {
        assertMatch(src, new RegExp(`apiUrlKey: '${tool}ApiUrl'`), `${tool} accordion knows its apiUrl key`);
    }
    const modeLists = src.match(/supportedModes: \[[^\]]+\]/g) || [];
    assertEqual(modeLists.length, 6, 'six tools declare supported modes');
    for (const list of modeLists) assert(list.includes("'direct'"), `direct offered in ${list}`);
    assertMatch(src, /id="\$\{id\}-api-key" type="password"/, 'the key field is masked by default');
    assertMatch(src, /dle-conn-key-reveal/, 'a reveal toggle exists');
});

test('DIRECT-WIRE-8: a settings reset preserves direct endpoints and keys', () => {
    const src = read('src/ui/settings-ui.js');
    assertMatch(src, /'ApiUrl', 'ApiKey', 'ApiFormat', 'ApiViaCorsProxy'/,
        'reset-defaults carries the direct fields alongside mode/profile/model');
});

test('DIRECT-WIRE-9: health checks flag an unconfigured direct connection', () => {
    const src = read('src/ui/diagnostics.js');
    assertMatch(src, /aiSearchConnectionMode === 'direct'[\s\S]{0,900}?aiSearchApiUrl/, 'missing URL is checked');
    assertMatch(src, /Direct API mode but no model is set/, 'missing model is an error');
    assertMatch(src, /severity: 'warning'[\s\S]{0,200}?no API key/, 'missing key is only a warning (local endpoints need none)');
});

test('DIRECT-WIRE-10: diagnostics report the direct endpoint without the key', () => {
    const snap = read('src/diagnostics/state-snapshot.js');
    assertMatch(snap, /directHasKey = !!\(resolved\.apiKey \|\| ''\)\.trim\(\)/, 'presence only, never the value');
    assert(!/apiKey: resolved\.apiKey/.test(snap), 'the raw key is never copied into the snapshot');
    assertMatch(snap, /\$\{u\.protocol\}\/\/\$\{u\.host\}\$\{u\.pathname\}/, 'URL is reduced to origin+path (drops any query credential)');
    const exp = read('src/diagnostics/export.js');
    assertMatch(exp, /mode === 'direct'/, 'export renders a direct target');
});

test('DIRECT-WIRE-11: the AI-search cache key includes the direct endpoint', () => {
    // Otherwise switching endpoint or format would serve results cached from the
    // previous connection.
    assertMatch(read('src/ai/ai.js'), /aiSearchApiUrl \|\| ''\}[\s\S]{0,60}aiSearchApiFormat/, 'apiUrl + format in the cache key');
});

test('DIRECT-WIRE-12: the extracted validator still backs the legacy proxy path', () => {
    const src = read('src/ai/proxy-api.js');
    assertMatch(src, /assertNoServerSideSsrf\(url, 'Proxy URL'\)/, 'validateProxyUrl delegates to the shared rules');
    assertMatch(src, /scrubSecrets\(text\)\.substring\(0, 150\)/, 'scrub-before-truncate preserved');
});

await summary('Direct API Tests');
