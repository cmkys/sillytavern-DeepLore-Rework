/**
 * DeepLore — URL safety helpers (pure, no ST globals).
 *
 * Two audiences, two threat models:
 *
 *   1. `assertNoServerSideSsrf(url, label)` — for URLs the SILLYTAVERN SERVER
 *      fetches on our behalf (the `/proxy/:url` CORS bridge). The ST host may
 *      sit on a cloud VM or a LAN the browser can't otherwise reach, so cloud
 *      metadata endpoints and private/CGNAT/link-local ranges are blocked, plus
 *      octal/decimal IP shorthand that would sneak past a naive dotted-quad
 *      check. 127.0.0.1 stays allowed (local relays are the common case).
 *
 *   2. `assertNoMetadataEndpoint(url, label)` — for URLs the BROWSER fetches
 *      directly (Direct API mode). Private addresses are the user's own network
 *      and are a first-class use case here (Ollama / LM Studio / llama.cpp /
 *      TabbyAPI on 127.0.0.1 or a LAN box), so only the cloud metadata services
 *      are refused — nothing there is ever a chat-completions endpoint, and a
 *      mistyped-or-pasted metadata URL is pure downside.
 *
 * Extracted from proxy-api.js (v2.5) so Direct API mode can share the exact
 * same validator without importing the dead-headed proxy module.
 */

/** Cloud instance-metadata services — never a legitimate AI endpoint. */
const METADATA_HOSTS = ['169.254.169.254', 'metadata.google.internal', '100.100.100.200'];

const PRIVATE_HOST_PATTERNS = [
    /^10\./,
    /^127\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
    /^169\.254\./,
    /^0\./,
    /^::ffff:/,
    /^fd[0-9a-f]{2}:/,
    /^fe80:/,
];

/**
 * Parse + basic shape check. Throws with `label`-prefixed messages so callers
 * keep their own wording ("Proxy URL …" vs "API URL …").
 * @returns {URL}
 */
export function parseHttpUrl(url, label = 'URL') {
    if (typeof url !== 'string' || !url.trim()) {
        throw new Error(`${label} is empty`);
    }
    let parsed;
    try { parsed = new URL(url); }
    catch { throw new Error(`${label} "${url}" is not a valid URL`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`${label} "${url}" must use http:// or https://`);
    }
    return parsed;
}

/** Lowercased hostname with IPv6 brackets stripped. */
export function hostnameOf(parsed) {
    return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

/**
 * Refuse cloud instance-metadata endpoints. Safe for browser-issued fetches —
 * does NOT block localhost / LAN / private ranges.
 */
export function assertNoMetadataEndpoint(url, label = 'API URL') {
    const parsed = parseHttpUrl(url, label);
    const hostname = hostnameOf(parsed);
    if (METADATA_HOSTS.includes(hostname)) {
        throw new Error(`${label} "${hostname}" is blocked (cloud metadata endpoint)`);
    }
    return parsed;
}

/**
 * Full SSRF validator for URLs fetched SERVER-side (ST's CORS bridge).
 * Blocks metadata hosts, private/CGNAT/link-local ranges, and numeric/octal IP
 * shorthand. Allows 127.0.0.1 (local proxies) but blocks the rest of 127.0.0.0/8.
 */
export function assertNoServerSideSsrf(url, label = 'Proxy URL') {
    const parsed = parseHttpUrl(url, label);
    const hostname = hostnameOf(parsed);
    if (METADATA_HOSTS.includes(hostname)) {
        throw new Error(`${label} "${hostname}" is blocked (potential SSRF target)`);
    }
    if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1'
        || hostname === '::ffff:127.0.0.1') {
        throw new Error(`${label} "${hostname}" is blocked — use 127.0.0.1 for local proxies`);
    }
    if (PRIVATE_HOST_PATTERNS.some(p => p.test(hostname)) && hostname !== '127.0.0.1') {
        throw new Error(`${label} "${hostname}" points to a private/reserved network address`);
    }
    // Belt-and-braces. In practice WHATWG `URL` already normalizes IPv4
    // shorthand before we see it (`0300.0250.0.1` → `192.168.0.1`,
    // `2130706433` → `127.0.0.1`), so the dotted patterns above catch the
    // normalized form and these two rarely fire. They remain for hostnames that
    // survive parsing un-normalized on some engine — cheap, and the failure mode
    // they guard is a private address slipping through.
    if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) {
        throw new Error(`${label} "${hostname}" uses a numeric IP shorthand — use dotted notation`);
    }
    if (/(?:^|\.)0\d+(?:\.|$)/.test(hostname)) {
        throw new Error(`${label} "${hostname}" uses octal IP notation — use standard dotted decimal`);
    }
    return parsed;
}

/**
 * Scrub provider secrets out of an error body BEFORE truncation.
 *
 * Order matters: `sk-proj-` is matched first because `sk-` is a superset that
 * would otherwise leave the `proj-…` tail exposed. Truncating first would cut a
 * token below the `{10,}` floor and leak a partial — see gotchas.md #56.
 */
export function scrubSecrets(text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/sk-proj-[a-zA-Z0-9_-]{10,}/g, 'sk-proj-***') // OpenAI (superset of sk-)
        .replace(/sk-ant-[a-zA-Z0-9_-]{10,}/g, 'sk-ant-***')   // Anthropic (superset of sk-)
        .replace(/sk-[a-zA-Z0-9_-]{10,}/g, 'sk-***')
        .replace(/AIza[a-zA-Z0-9_-]{10,}/g, 'AIza***')         // Google
        .replace(/gsk_[a-zA-Z0-9_-]{10,}/g, 'gsk_***')         // Groq
        .replace(/xai-[a-zA-Z0-9_-]{10,}/g, 'xai-***')         // xAI
        .replace(/Bearer\s+[A-Za-z0-9_\-./]{10,}/g, 'Bearer ***');
}
