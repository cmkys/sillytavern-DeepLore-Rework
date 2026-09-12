# Changelog

All notable changes to DeepLore are documented here. This file follows
[Keep a Changelog](https://keepachangelog.com/) conventions.

> **Older releases** (`1.0.0-beta` and all pre-1.0 `ALPHA` builds) live in
> **[CHANGELOG-archive.md](CHANGELOG-archive.md)**.

---

## [Unreleased]

### Added

- **Direct API connection mode** — every AI feature can now connect straight to an API endpoint with a URL and key, instead of going through a SillyTavern Connection Profile. Pick **Direct API (URL + key)** in DLE Settings → Setup → AI Connections, paste an API URL (a base like `https://api.openai.com/v1` or the full endpoint), a key, and a model. The wire format is auto-detected — OpenAI-compatible (`/chat/completions`) or Anthropic (`/v1/messages`) — and can be overridden. That covers OpenAI, OpenRouter, Anthropic, Groq, DeepSeek, Mistral, xAI, Together, Gemini's OpenAI-compatible endpoint, and local runtimes (Ollama, LM Studio, llama.cpp, TabbyAPI — leave the key blank).

  Available for all six tools (AI Search, Session Scribe, Auto Lorebook, AI Notepad, Librarian, Optimize Keys), including the Librarian's tool-calling loop. Tools set to **Inherit** take the whole direct connection (URL, key, format, CORS flag) from AI Search, with the usual per-tool model override on top — so a tool can never end up pairing AI Search's key with a different endpoint.

  Direct requests are issued by the browser, so the endpoint has to allow CORS. When it doesn't, tick **Route through SillyTavern's CORS proxy** (requires `enableCorsProxy: true` in `config.yaml`); a browser CORS rejection — otherwise an opaque `TypeError` with no status — is rewritten into an error that names the host and points at that toggle. Private and loopback addresses are allowed on the browser path (local model runtimes are the point); the CORS-proxied path keeps the full server-side SSRF validator, since ST's server does that fetch. Cloud metadata endpoints are refused either way.

  Diagnostics report the endpoint's host and path, the format, and whether a key is set — never the key itself. "Test message" and the AI Search "Test connection" button both probe direct connections live.

### Changed

- The SSRF validator and secret scrubber shared by the connection paths moved into `src/ai/url-safety.js`; `validateProxyUrl()` delegates to it with unchanged error messages.
- Re-running the setup wizard no longer silently switches an existing Direct API setup back to (empty) profile mode — it only takes the wizard's answer when a profile is actually picked there.

---

## [2.6.2] - 2026-07-04

### Fixed
- **Librarian gap flags never reached the inbox** — the gap-finder ran and found real gaps, but the flagging prompt described the `flag` tool in prose without naming its schema fields (`title`/`reason`), so some models (observed: Opus 4.6) emitted a batched `{flags:[{note,…}]}` shape instead of the flat call. `flagLoreAction` read `title` → undefined → every flag was silently dropped and the Librarian → Flags panel stayed empty. Fixed on two axes: (1) the flagging prompts (`buildFlaggingInstructions` and the `flag` tool description) now name the flat fields with an example and instruct "one call per gap"; (2) the backgrounded gap-finder now detects a malformed flag call, feeds the model a corrective message naming the exact format, and retries once so the gaps are recovered instead of dropped. (See `docs/gotchas.md` #105.)

---

## [2.6.1] - 2026-07-04

### Fixed
- **Librarian ghost flags** — the reply header could say "N gaps noted" while the drawer's Librarian → Flags panel stayed empty. Models sometimes omit the flag's `reason` argument (not every backend enforces the tool schema's `required` list); DLE discarded those gaps but still rendered them in the per-message dropdown. Flags with a missing reason are now recorded (empty reason, drawer shows its "No reason provided" fallback), and the dropdown only renders flags that actually landed in the gap store — the chat header and the Flags panel can no longer disagree. (`flagLoreAction` now returns `{ ok, message }`; both agentic-loop call paths gate activity on `ok`. See `docs/gotchas.md` #104.)

---

## [2.6.0] - 2026-07-03

> An interface release: a full settings-popup overhaul, a deep UI/UX polish pass across every surface, Issue #39 fixed (clearable vault cache + overlay drawer on phones), and a batch of long-standing bug fixes from a release-readiness audit. No pipeline-behavior changes.

### Added

- **`/dle-clear`** — clearing the vault cache now wipes the IndexedDB cache AND the live index (wipe-and-stop; run `/dle-refresh` to re-index), so an intentionally emptied vault finally stays empty. The Clear Cache button does the same; failures report honestly instead of toasting success. Phantom `/dle-force-refresh` / `/dle-rebuild` references replaced with real commands. (Issue #39)
- **Graph** — the two legends merged into one docked panel that survives node hover; the whole view localized.
- **Setup wizard** — welcome page is a three-card decision fork (demo vault / connect Obsidian / import lorebook); skip/resume without auto-relaunch nagging; keyboard focus + screen-reader announcements on step change; vault scanner wired in.
- **Librarian** — contextual bulk-action bar for the Flags list; gap rows get an expand chevron and a one-line "Reason" teaser.
- **Import** — per-entry recovery table for failed/skipped entries with classified failure types and Retry / Retry-all.
- **Pipeline toast** — elapsed-time counter and a Cancel button during the AI phases.
- **Toasts** — unified `notify` facade (severity routing, dedup, click-to-copy errors) on the high-value error sites.
- **Onboarding** — decision-aware Browse/Injection empty states; expand/collapse-all for Browse folder grouping with count chips.

### Changed

- **Settings popup overhaul** — the old Connection/Features header rows and both subtab tiers are gone, replaced by a header strip (brand, master on/off switch, version chip, wiki help link) over a flat sidebar: a settings search box, a pinned **About** landing panel, and four accordion groups (Setup / Lore pipeline / Assistants / Tools). The former **Matching** and **AI Search** tabs are merged into one **Search** tab. Pre-overhaul tab tokens (persisted "last tab", deep links) resolve through a permanent alias so nothing breaks. Type sizing re-anchored to ST's font-scale slider. (See `docs/gotchas.md` #103.)
- Footer health icons became a clickable diagnostics dock; Browse per-row actions fold into a hover-reveal `⋮` kebab.
- Drawer overlay mode now also triggers on narrow viewports, so phones get the overlay drawer (the other half of Issue #39; the settings popup itself stays desktop-first for now).
- Localized: Cartographer "Why?" modal, Reference tab + `/dle` palette, `/dle-lint` popup and the index-build warning toast (which now links to `/dle-lint`).
- Interface, motion & accessibility: the whole UI moved onto DLE's motion/type tokens; reduced-motion honored properly (infinite animations disabled, spinner freezes); 44px touch targets and over-scroll containment; unified focus ring and contrast-safe colors; number inputs clamp on commit; iconography unified; pipeline toast and drawer status row rebalanced.
- De-slop pass: the Graph Health panel moved onto design tokens and its emoji severity dots replaced with the semantic `●`; ~30 stray inline px/opacity values folded into the `--dle-*` scale across the drawer, wizard, settings, and Rule Builder.

### Fixed

- All 25 confirmed regressions from the polish pass, caught by an adversarial bug-hunt before merge — highlights: undismissable/yanked pipeline toasts, the circuit-breaker "back online" toast lost on most recovery paths, graph-gravity values corrupted on edit, Rule Builder clobbering divergent context keys, the frozen drawer activity spinner, missing screen-reader phase announcements, and a multi-vault collision in Browse expand.
- From the release-readiness audit: the shareable diagnostics report no longer leaks private lore (titles, keywords, vault names, hosts — all pseudonymized) or fabricates "0 searches, 0 flags"; probability-skipped BM25 entries show up in `/dle-why`; corrupt-cache entries can no longer outrank fresh parses or silently disable cache hydration; drawer tabs no longer render blank after a teardown; the idle spinner fully stops; a literal `</entry>` in a summary can't break out of the AI selection manifest; same-vault duplicate titles survive multi-vault conflict resolution; and import failures carry their real failure type instead of a keyword-sniffed guess.

### i18n

- ~210 new UI strings (including the settings-overhaul nav/search/header labels), plus 80 more from localizing the whole setup wizard runtime, Rule Builder field labels, and the Browse quick-filter pills; all 7 locales at full key parity — **2,672 keys × 7 locales**.

---

## [2.5.1] - 2026-06-27

### Fixed

- **Librarian now works through NanoGPT, AI21, Pollinations, and Moonshot.** These four chat-completion sources were wrongly listed as not supporting tool/function calling, so the Librarian was silently disabled for any connection routed through them — no matter the model, preset, or connection profile, the source gate tripped before the model check ever ran. All four are tool-capable per SillyTavern's own tool-calling source list, so the entries were stale; only `perplexity` remains gated. Reasoning-only models (deepseek-reasoner, o1, `*-r1`, etc.) are still gated separately. Surfaced by a NanoGPT user whose function calling never fired regardless of what they changed.

---

## [2.5.0] - 2026-06-20

> Six-locale UI, single source of truth for pipeline verdicts, Custom Proxy retirement, editable AI prompts, new graph layouts + vault health, and a wide reliability sweep.

### Added

#### Internationalization (7 locales)

- **7 locales out of the box** — English (canonical) plus German, Spanish, French, Japanese, Simplified Chinese, Russian. UI strings (~2306 keys) and AI prompts (30 modules) both translated. Coverage: 95.8–97.3% UI per locale, 100% AI prompts. Hooks ST's built-in `addLocaleData()` + `data-i18n` MutationObserver — no custom layer.
- **AI prompt locale is a separate axis** — defaults to follow UI locale, can be pinned to English if you don't trust machine translations to preserve LLM behavior. Setting: `aiPromptLocale`.
- **Placeholder validator with unique-index semantics** — `${0}` and `${1}` indexed only; re-references like `${0} ... ${0}` count as one index so translators can match grammatical agreement (ES adjective/noun, etc.) without tripping validation.

#### Editable AI prompts

- **Prompts tab** — a new top-level settings tab (between Features and System) for viewing and overriding DLE's built-in AI prompts. Per-row revert / export / update, a status grid, plus tab-wide Export, Reload, and Reset-All actions. Prompt overrides live in your Obsidian vault under `promptsFolderPath`, resolved through a vault override layer with a multi-layer delete safety cage. Confirmation prompts guard export and language-change operations before clobbering existing vault overrides.

#### World Info import — full ST field parity

- **WI import: full ST World Info field parity** — every WI field now has a documented home (see `docs/gotchas.md` #69 for the contract). Companion-extension API additions: `convertWiEntry` return now carries `title` + `_emPosition`; `upsertConvertedEntry` returns a new `report` object + can return `action: 'em-skipped'` for Example Messages entries when `wiImportEmHandling === 'skip'`. Existing destructuring patterns (`{filename, content}` etc.) keep working — additive only.
  - **Native (DLE acts on):** `disable` → `enabled: false` (pre-fix disabled WI entries silently imported as active — the most damaging silent downgrade in the importer), `excludeRecursion`, `role` (Wave 1), plus `selective_logic` with all 4 modes enforced by new `applySelectiveLogic` gate (`and_any`, `and_all`, `not_all`, `not_any` — Wave 3), plus Example Messages positions 5/6 with `## Example Dialogue` subheader handling and configurable skip-on-import (Wave 4).
  - **Round-trip preserved** (snake_case frontmatter, surfaced by `/dle-lint` as new `W_WI_ROUND_TRIP` code): `vectorized`, `selective`, `use_probability`, `prevent_recursion`, `delay_until_recursion`, `group_override`, `use_group_scoring`, `case_sensitive`, `match_whole_words`, `automation_id`, `add_memo`, `display_index`, plus 6 `match_*` scan-source toggles (Wave 2).
  - **Structured import report popup** replaces the old success/warning toast — shows per-field counts, EM handling breakdown, friendly EM explainer with one-click "Skip on future imports" button that flips the `wiImportEmHandling` setting (Wave 5).

#### Graph view modes

- **Layout selector in the graph toolbar** — a new "Layout" dropdown beside "Color:". Force-directed stays the default; positions morph (no teleport) when you switch.
- **Layered DAG view** — a directed dependency layout over `requires` + `cascade` edges: cycle-break → longest-path layering → arrowheads, so you can read what pulls in what at a glance. Double-click-to-focus is gated off in DAG; Reset always returns to Force.
- **Vault Health / World Doctor** — a structural problem report surfaced as a side panel with graph highlighting: broken references (`requires`/`excludes`/`cascade` pointing at a title no entry has), contradictory gating (an entry that both requires and excludes the same target), circular `requires` (including via cascade), and orphans. Severity-ranked (breaks-silently / won't-fire / quality).
- **Force-directed layout unchanged** — default on open, with saved-layout restore and reveal animation exactly as before; the new modes are purely additive.

#### Other new features

- **VerdictStore** — single source of truth for "what DLE decided this turn." Replaces the racing globals `lastInjectionSources` / `lastPipelineTrace` / `previousSources` / `lastInjectionEpoch`. Ring buffer (50) + per-chat IndexedDB spill (~200) survives chat switches and page reloads. 14 call sites migrated. See `docs/gotchas.md` #46.
- **Drawer Browse: folder grouping + batch optimize** ([#13](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/13), [#26](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/26)) — collapsible folder headers, batch-select for `/dle-optimize-keys` runs.
- **Dedicated summarize feature** ([#15](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/15)) — `/dle-summarize-range` produces and inserts a summary message with one-step rollback.
- **DLE-side response prefill** — anthropic-only or all-providers, configurable. Lets you prime the writer's first tokens without leaning on profile-level prefill.
- **AI manifest field whitelist** — `aiManifestIncludeFields` prunes custom fields from the manifest sent to the selector, saving tokens on vaults with rich frontmatter.
- **Manual AI circuit-breaker reset** (PR [#28.1](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/pull/28)) — drawer button to clear the tripped breaker without waiting out the 30s cooldown.
- **Fuzzy entry-name matching** for `/dle-pin`, `/dle-block`, `/dle-unpin`, `/dle-unblock`, `/dle-optimize-keys` — typos and partial titles resolve to the nearest entry.
- **Single-entry convert-and-upsert** (PR [#28.2](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/pull/28)) — `upsertConvertedEntry` for companion-extension integrations. Rename / replace / skip collision policies.
- **Caveman compression at import** — `importCompressByDefault` setting + per-call override; body passed through `compressCaveman()` and frontmatter annotated `compress: caveman`. Unknown modes warn rather than lie about transform state.
- **Frontmatter surgery + priority reverse** for batch-edits across multiple entries.
- **AI Notepad polish** ([#25](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/25)) — entry-count FIFO cap, pinned entries survive the cap, manual fuzzy dedup, refuse threshold=0 / empty input (data-wipe guard).
- **Per-tool default write vault + Librarian per-write override** ([#29](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/29), [#32](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/32)) — auto-suggest, scribe, librarian can each target a different vault.
- **Librarian tool-call budgets** surfaced as user settings (previously hard-coded).
- **Per-connection Test button** — every AI feature's connection config gets a Test button that fires a real probe and reports back with an ST-style green/red toast, so you can verify a profile before relying on it.

#### Interface, accessibility & onboarding

- **Why? tab redesign** — a verdict funnel header with a KEY › AI breadcrumb and source-vault chip, pipeline-ordered rejection groups, hover/focus-reveal Fix-It pins (pin or block an entry right where it was dropped), and a **live budget pressure meter** showing pre-truncation context pressure before anything gets cut.
- **New goo-spinner everywhere** — replaces every old spinner (status dot, toasts, empty states, refresh buttons, setup wizard), accent-colored and dark/light aware. The pipeline status toast is larger and cross-fades between phases instead of restarting its spinner each time.
- **Accessibility hardening** — high-contrast (`forced-colors`) support across tabs, radios, toggles, and browse rows; arrow-key navigation on radio groups; press feedback on every control; `prefers-reduced-motion` honored throughout, with `role=status` / `aria-live` on the pipeline toast.
- **Onboarding remediation** — connection failures over plain HTTP now open the guided checklist instead of dead-ending; a no-Connection-Profiles state explains how to create one (with a Keywords-Only escape hatch) in both the setup wizard and settings.
- **Drawer clarity pass** — calmer header bars, a footer that only turns red on real problems, canonical pipeline phase labels, and clearer mode/outcome wording.
- **Actionable AI-error toasts** — parse / shape / empty-result failures now tell you the next step, translated 1:1 across all 7 locales.
- **ST-native theming** — DLE themes entirely through ST `--SmartTheme*` / `--dle-*` tokens (via `color-mix`), tracking your ST theme in dark and light.
- **Drawer render performance** — heavy drawer tabs no longer repaint while the drawer is closed; Browse repaint is hash-guarded against redundant work.

### Changed

- **`librarianPerMessageActivity` now defaults ON** — Librarian gaps clear at generation start and persist across swipes, and per-message dropdown data is kept. Existing users who had explicitly turned it off keep their setting.

### Removed

- **Custom Proxy AI connection mode** — dead-headed. Connection Profile supersedes. Existing users migrated automatically with a one-shot notice popup. Code preserved for rollback (`src/ai/proxy-api.js` still present, marked `@deprecated v2.5`). `enableCorsProxy: true` is no longer required for DLE AI features. See `docs/gotchas.md` #68.

### Fixed

- **Verdict refactor closes a class of pipeline-state races** — UI consumers (drawer, cartographer, `/dle-why`) now read by `(chatId, msgIdx)` instead of the most-recent global, so swipes/regens/chat-switch no longer surface stale data.
- **`trackerKey(entry)` unified across all sites** — drawer browse, librarian search, strip-dedup log, cascade titleMap, `applyPinBlock` matchedKeys, sort tiebreaks. Bare `entry.title` Map keys were colliding across vaults; reviewers should reject any new bare-title key in pipeline/drawer/librarian/ai-search. See `docs/gotchas.md` #50.
- **Bootstrap exemption now generation-scoped** — `lorebook-bootstrap` bypasses ALL gating only while `bootstrapActive === true`. Once bootstrap deactivates, bootstrap-tagged entries are gated like any other. See `docs/gotchas.md` #60.
- **Post-await epoch guards on every branch** in pipeline / stages / AI / librarian. Aborted generations no longer commit verdict, fire status, or push to chat.
- **Shared 401/429 breaker classifier** — AI and Librarian agree on which errors trip the circuit breaker.
- **Vault**: partial-fetch handling, file-overwrite guard, prototype pollution guard, rename safety, incremental reuse-sync correctness.
- **WI import dedup probe failures fail loud** (V-C2) — a network glitch during the existence check used to return "assume free" and overwrite real vault files. Now returns null and surfaces an error.
- **WI import: vault rename is destructive** (V-M5) — renaming a vault changes the `vaultSource` prefix and orphans every per-entry tracker (cooldowns, decay, pins, blocks, chat counts, analytics). Settings UI now confirms before applying. See `docs/gotchas.md` #62.
- **Strip-dedup hash always reflects pre-truncation canonical content** (M-8) — a budget cut that shrinks "Castle" still dedups against the prior full-content "Castle" log line. See `docs/gotchas.md` #65.
- **`applyStripDedup` lookbackDepth ≤ 0 is a no-op**, not "dedup against entire log" (M-4) — external callers (`/dle-why`, `matchTextForExternal`) used to silently get the whole log. Pass `Number.MAX_SAFE_INTEGER` for the old behavior. See `docs/gotchas.md` #65.
- **`hasWarmup(entry)` is the canonical warmup-gate predicate** (M-6) — all three match paths (primary keyword, recursion, BM25) now use the same helper. Diverged on NaN/0/negative/Infinity/non-number. See `docs/gotchas.md` #65.
- **Gemini token-usage aliases** ([4e94339](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/commit/4e94339)) — `usageMetadata.promptTokenCount` / `candidatesTokenCount` parsed alongside the legacy field names; defensive parser hardening across providers.
- **CMRS AbortError unwrap** (BUG-249) — ST's wrapper around aborted fetches was misclassified as a generic error and tripped the breaker. Now demoted.
- **Drawer dismiss safe inside spawned popups**, init promise latch, pipeline-status orphan guard, PM-mode registration latch, settings-popup safety.
- **Scribe**: `/dle-scribe-history` reads from the configured Scribe vault, not the primary.
- **Librarian**: resolves model from the configured profile rather than the active profile ([#27](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/27)); null/0 session-cap treated as unlimited (BUG-071).
- **Slash commands**: `unnamedArgumentList` + `enumProviders` backfilled across remaining commands (BUG-040); `/dle-librarian` autocomplete + popup-scoped pickers + prefill lifecycle fixed.
- **Summary rollback data corruption** + summarize/batch-optimize hardening.
- **Audit batch** (onboarding, persistence, breaker, security, perf, correctness) — first-run wizard now imports using the live tested connection and re-verifies on Finish; empty-title entries skipped at parse; notepad + injection-log persist immediately so a fast chat switch can't drop them; verdict IDB reads scoped to the chat; circuit breaker releases the half-open probe on excluded errors; network debug buffer scrubbed on read with JWT/short-token patterns; pseudonymization replaces longest names first; embedded URL secrets stripped from connection references; lazy titleMap + requires/excludes early-out perf.
- **Release-day audit sweeps** — two independent passes (a verification audit of a prior sweep + a fresh full-codebase audit) fixed **87 bugs: 6 high, 31 medium, 50 low** (91 findings triaged; 5 reports verified as non-issues). Highlights: a diagnostics-privacy cluster (the shareable export no longer leaks AI prose, prompt/preset settings, sub-32-char header secrets, or `user:pass@` URL credentials); Librarian provider-routing fixes that resolve the gate, provider format, and tool-choice from the configured Librarian profile instead of ST's global connection (mixed-provider multi-turn no longer breaks); a swipe-indexing fix (injected sources attach to the right message and per-swipe injection counts stop drifting); and a `priority: 0` falsy-coalesce class fix (highest-priority entries were silently demoted to the default at every sort/write site).
- **Install path resolved at runtime** — DLE now derives its own extension folder from the module URL instead of a hardcoded name, so locale, icon, and template loading keep working regardless of what the install folder is called (and stay correct through a future repo/folder rename).

### Tests

- **Queue-based async runner** for the integration suite — no more flaky ordering on slow CI.
- **VRD-1..VRD-12 regression guards** for the Verdict refactor, including Wave C P1 prune sampling and bounded-cursor invariants.
- **PERF-P2-1..PERF-P2-5** for the exemption-policy cache.
- **i18n parity tests** across all 6 translations: key-count match, key-set match, placeholder preservation, AI prompt-module export contract.
- **WI-import parity** — full-parity fixture + 84 `wi-import.test.mjs` assertions + 6 `WI-PARITY` regression guards (Tier A native, Tier C round-trip, EM subheader, no-silent-drop contract).
- **Coverage backfill** for `cmrsResultToText` edges, `comparePriority` ([#16](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/16)), `resetAiCircuitBreaker` (PR [#28.1](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/pull/28)), `summarize`, caveman extras, BUG-043 round-trip, pin invariants.

---

## [2.0.2] - 2026-04-27

> Hotfix for AI search regression on non-Claude models.

### Fixed

- **AI search no longer throws `slice is not a function` on non-Claude models** ([#24](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/24)) — ST's `custom-request.js` replaces `result.content` with a parsed object when `data.json_schema` is set on the chat-completions route. `callViaProfile` was assigning that object straight to `text`, breaking `extractAiResponseClient` and the debug-preview `.slice` for every non-Claude provider. Fix re-stringifies through a new `cmrsResultToText` helper so the string contract holds across all callers. Claude path was already skipping `json_schema` (forced tool_choice + extended thinking conflict) and is unaffected. Regression test added.

---

## [2.0.1] - 2026-04-26

> First post-release patch from open-issue triage on v2.0-beta.

### Fixed

- **Vault entry content no longer XML-escaped on injection** ([#16](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/16)) — vault content was passing through `escapeXml` in `formatAndGroup`, so any `<tag>`, `&`, or `"` reached the LLM as `&lt;tag&gt;` etc. Title escape stays (load-bearing for the `<{{title}}>` wrapper tag name). Content now passes through raw — vault authors intentionally embed XML, markdown, code samples, and ampersands. Reverts the content-side half of BUG-090. Adds gotcha #45 documenting title-only escape policy.

### Changed

- **Timeout caps raised to 999999ms (~16 min)** ([#19](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/19)) — six per-feature timeout settings (`aiSearchTimeout`, `scribeTimeout`, `autoSuggestTimeout`, `aiNotepadTimeout`, `optimizeKeysTimeout`, `librarianSessionTimeout`) had their max clamp bumped from 120000ms to 999999ms. Defaults unchanged. Slow local LLMs and reasoning models on backed-up providers can now configure higher per-feature timeouts. Wiki + Roadmap updated with footgun guidance.

---

## [2.0.0-beta] - 2026-04-26

> The Librarian update. Your lorebook grows with your story — the writing AI flags what's missing, Emma helps you write it.

### Added

#### The Librarian (Emma)

DeepLore now has Emma, your librarian. As you roleplay, the writing AI reaches for details it needs; when one isn't in your vault, it flags the gap. You open the flag, chat with Emma, and she helps you author a vault-accurate entry. Your lorebook grows alongside your story.

- **Automatic gap detection** -- As the writing AI reaches for lore that isn't in your vault, it flags the gap to a dedicated inbox. Two dismissal tiers: hide to suppress, dismiss to bury. Re-flagging a hidden gap resurfaces it.
- **Vault audits** -- `/dle-librarian audit` walks through your entire vault and flags gaps, inconsistencies, and entries that need updating.
- **Generation tools** -- Writing AI gets two tools it calls automatically mid-generation: `search` queries your vault for relevant entries, `flag` silently notes gaps and stale entries. Runs in the background when the Librarian is enabled.
- **Emma's toolset** -- In her chat session, Emma has a dozen tools: `search_vault`, `get_entry`, `get_full_content`, `find_similar`, `list_flags`, `get_links`, `get_backlinks`, `list_entries`, `get_recent_chat`, `flag_entry_update`, `compare_entry_to_chat`, and `get_writing_guide`.
- **Writing guides** -- Tag any vault entry with `lorebook-guide` to make it a Librarian-only style reference. Emma fetches these guides via `get_writing_guide` to inform her suggestions; they never reach the writing AI through any path.
- **Graph-aware search** -- Writing AI's `search` tool resolves linked entries from `resolvedLinks`, not just BM25 matches — results pull in directly-related lore automatically.
- **Behind-the-scenes UX** -- Tool calls are hidden during generation and consolidated into a single expandable dropdown on the final message. Real-time status ("Choosing Lore...", "Consulting vault...", "Generating...") shows pipeline and writing-AI tool progress, and cleans up when done.
- **Session continuity** -- Emma's chat session (messages, draft state, work queue) persists in `chat_metadata` across page reloads and chat switches. Gaps flagged by the writing AI persist separately. Pick up where you left off.
- **Librarian drawer tab** -- See your gap list, flagged entries, and session stats at a glance with quick-dismiss controls.
- **Customizable persona** -- Tweak Emma's personality and focus through an editable prompt. Make her chattier, more formal, or focused on specific aspects of your world.
- **Auto-enables function calling** -- Turning on the Librarian automatically enables function calling on your active API connection, so you don't have to hunt for the setting.

#### Drawer Polish

- **Toolbar buttons** -- Librarian and Graph buttons added to the drawer header toolbar for quick access.
- **Footer simplification** -- The footer now shows `totalUsed / maxContext` with a tooltip breakdown, replacing the verbose multi-line display.
- **Librarian popup** -- Unified textarea replaces the old form-field layout. Chat auto-expands as you type, and tool names are shown in plain English.

#### Performance & Indexing

- **BM25 inverted index** -- Fuzzy search now uses an inverted posting list, scoring only documents that contain query terms instead of scanning the full index.
- **Multi-vault duplicate detection** -- Vaults with overlapping entries now detect duplicates via content hashing, preventing double-injection.
- **Cache fingerprinting** -- Improved cache fingerprint logic for more reliable freshness detection across vault rebuilds.
- **HTTPS support** -- Obsidian connections now support HTTPS for remote or secured setups.

#### Settings Redesign

The settings popup has been reorganized for clarity and easier navigation.

- **About tab** -- Redesigned as the landing tab with the DLE logo, master enable toggle, social links, diagnostics panel (moved from System), and a danger zone for destructive actions.
- **Reference tab** -- The slash command quick-reference grid now lives in its own tab instead of being buried in another section.
- **Grey-out audit** -- 43 disable patterns now correctly dim dependent settings when their parent feature is off. No more editing settings for features you've disabled.

#### Diagnostics

A new diagnostics subsystem for debugging issues and filing bug reports.

- **Flight recorder** -- A ring buffer captures recent extension activity (pipeline runs, tool calls, errors) for export.
- **State snapshots** -- Capture the current extension state for debugging without restarting.
- **Diagnostics panel** -- View, export, and manage diagnostic data from the About tab in settings.
- **IP masking** -- Diagnostic exports automatically mask IP addresses, preserving the first two octets for network-level debugging while protecting your identity.

#### New Slash Command

| Command | Description |
|---------|-------------|
| `/dle-librarian` | Toggle the Librarian on/off. Use `/dle-librarian audit` to trigger a comprehensive vault review. |

#### New Frontmatter Field

| Field | Type | Description |
|-------|------|-------------|
| `guide` | boolean | Via `lorebook-guide` tag -- Librarian-only writing/style guide. Never reaches the writing AI. |

### Fixed

Fixed ~350 stability and correctness bugs across comprehensive code audits. Highlights include data integrity safeguards (multi-vault safety, cache consistency, vault sync reliability), AI selection robustness (timeout handling, search fallback logic, circuit breaker fixes), UI and state reliability (chat lifecycle resets, drawer rendering, gating field persistence, swipe/regen handling), and edge case hardening (special character support, abort/stop races, multi-vault path collisions, and more).

### Under the Hood

- 960 → 1,313 passing tests.
- New `librarian/` module directory (8 focused files).

---

> **Looking for older releases?** `1.0.0-beta` and all pre-1.0 `ALPHA` builds are
> archived in **[CHANGELOG-archive.md](CHANGELOG-archive.md)**.
