<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/icon-dark.svg">
    <img src="docs/icon-light.svg" alt="DeepLore" width="96">
  </picture>
</p>

<h1 align="center">DeepLore</h1>

**World Info keyword matching breaks at scale. DeepLore reads your Obsidian vault instead: keywords plus AI retrieval, so the right lore fires even when the word wasn't typed.**

![Version](https://img.shields.io/badge/version-2.6.2-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![SillyTavern](https://img.shields.io/badge/SillyTavern-1.12.14+-orange)
[![i18n](https://img.shields.io/badge/i18n-EN%20%7C%20ES%20%7C%20FR%20%7C%20DE%20%7C%20JA%20%7C%20ZH%20%7C%20RU-purple)](https://github.com/pixelnull/sillytavern-DeepLore/wiki/Contributing-Translations)

[**Live demo →**](https://pixelnull.github.io/sillytavern-DeepLore/) · [Wiki](https://github.com/pixelnull/sillytavern-DeepLore/wiki)

---

<p align="center">
  <img src="https://i.imgur.com/vx4EJeD.png" alt="DeepLore drawer with injection list and graph" width="800">
</p>

<p align="center"><em>What 200 lorebook entries looks like when retrieval actually works.</em></p>

---

## The problem

World Info's keyword matching breaks down around 80-100 entries. You write a scene about the consequences of breaking an oath. Your Bloodchain entry stays cold. The word was never typed.

Meanwhile the AI invents details you already wrote, and gets them wrong.

And your lore lives in two places: half in an Obsidian vault, half in ST's JSON. They drift.

## Two-stage retrieval

**Keywords cast a wide net. An AI narrows it down by reading entry summaries.** The AI reads your summaries and picks Bloodchain. No keyword needed.

```
Chat → matchEntries (keywords + BM25 fuzzy)
     → hierarchicalPreFilter (40+ entries cluster first)
     → aiSearch (reasoning model selects from summaries)
     → gating (era / location / scene / character)
     → cooldown / dedup / budget
     → inject → generate
```

<p align="center">
  <a href="https://youtu.be/tiq0dfD6-RU?si=pTBw4r-RNCkHsoYZ">
    <img src="https://img.youtube.com/vi/tiq0dfD6-RU/maxresdefault.jpg" alt="Watch: Drawer, Search, and Flagging" width="720">
  </a>
  <br>
  <a href="https://youtu.be/tiq0dfD6-RU?si=pTBw4r-RNCkHsoYZ">
    <img src="https://img.shields.io/badge/%E2%96%B6_Watch_on_YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="Watch on YouTube">
  </a>
</p>

## New in v2: Emma, your librarian

Emma is how your lorebook grows.

As you roleplay, the writing AI reaches for details: characters, places, rules, consequences. When it reaches for something that isn't in your vault, it flags the gap. You open the flag and chat with Emma, a separate librarian agent who helps you author a vault-accurate entry (or update one that drifted). She checks what already exists, pulls in style guides marked `lorebook-guide`, finds similar entries to dedupe against, and drafts the new file. Write-to-vault saves it back to Obsidian.

Your story fills in your world. Your world fires back into your story.

- Writing AI's tool activity collapses into one expandable dropdown on the final message
- Emma has her own connection channel; route her to something cheaper if you want
- `lorebook-guide` entries reach Emma only, never the writing AI
- Tool-calling provider required for both (Claude, Gemini, OpenAI-compat, Cohere)

<p align="center">
  <img src="https://i.imgur.com/V8RnLdy.png" alt="Librarian tab with a flagged worldbuilding gap opened" width="640">
</p>

<p align="center">
  <a href="https://youtu.be/jsPE9vkA8ck?si=6r-czyn5TvjdRf7M">
    <img src="https://img.youtube.com/vi/jsPE9vkA8ck/maxresdefault.jpg" alt="Watch: Librarian (Emma)" width="720">
  </a>
  <br>
  <a href="https://youtu.be/jsPE9vkA8ck?si=6r-czyn5TvjdRf7M">
    <img src="https://img.shields.io/badge/%E2%96%B6_Watch_on_YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="Watch on YouTube">
  </a>
</p>

## What an entry looks like

```yaml
---
tags: [lorebook]
keys: [Bloodchain, oath, vow]
priority: 100
summary: |
  When to select: scenes involving oaths, vows, sworn debts, or consequences
  of breaking trust. Select when loyalty, betrayal, or magical binding is at
  stake, even without the word "Bloodchain" appearing.
era: [post-Schism]
requires: []
---

A Bloodchain is a blood-magic oath. Breaking one doesn't kill you outright.
It hollows you. The chain pulls at everything you used to love until there's
nothing left to pull at.
```

<p align="center">
  <img src="https://i.imgur.com/QA75e7J.png" alt="Entry open in Obsidian" width="640">
</p>

Write it in Obsidian. DeepLore reads it. The AI writes as if it always knew how Bloodchains work, even if the word "Bloodchain" was never said.

## Obsidian connection: HTTPS or HTTP

The Local REST API plugin ships with a self-signed HTTPS cert. Browsers block it unless you install the cert to your OS trust store, and SillyTavern's cross-origin `fetch()` path ignores per-site browser exceptions. Previously: silent failure with no error telling you why.

**v2 handles both:**
- Auto-diagnoses connection failures: distinguishes cert error vs unreachable vs auth
- Falls back to HTTP (port 27123) with a one-click suggestion if HTTPS fails
- Full OS-level trust-store walkthrough for Windows / macOS / Linux if you want HTTPS
- Scans localhost for responding vault instances

<p align="center">
  <img src="https://i.imgur.com/x74FYZV.png" alt="HTTPS diagnostic panel" width="640">
</p>

## Relationship Graph

<p align="center">
  <a href="https://youtu.be/5oU1nFPh_m8?si=DcHkV0XeQJj3bk50">
    <img src="https://img.youtube.com/vi/5oU1nFPh_m8/maxresdefault.jpg" alt="Watch: Relationship Graph" width="720">
  </a>
  <br>
  <a href="https://youtu.be/5oU1nFPh_m8?si=DcHkV0XeQJj3bk50">
    <img src="https://img.shields.io/badge/%E2%96%B6_Watch_on_YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="Watch on YouTube">
  </a>
</p>

Force-directed layout, 200+ nodes, Louvain clustering, gap analysis, focus mode. See which entries cluster together, where orphans live, what chains hang off `requires` and `cascade_links`.

## Cost

Keyword-only mode: free. AI search adds ~1 extra provider call per turn. Emma adds 1-3 tool-call rounds when she's active. Fraction of a cent per message on Haiku-class models; more on Sonnet / Opus.

Each feature has an independent connection channel. Run free keyword retrieval and pay only for Emma, or vice versa. Works with local providers (Ooba, KoboldCpp, llama.cpp) for the AI search stage. Emma still needs a tool-calling provider.

## Privacy

Vault content goes to your configured LLM provider during retrieval and generation. Use a dedicated lorebook vault rather than your personal Obsidian vault.

Diagnostics exports for bug reports are pseudonymized before they leave your machine: IPs, hostnames, API keys, profile names, vault names, character names all masked. Readable format, auditable before you share:

<p align="center">
  <img src="https://i.imgur.com/OhOUjLw.png" alt="Diagnostics export with anonymization summary" width="640">
</p>

## What people are saying

> *"[I've] been using it all day and still amazed by it."*
> - /u/chaeriixo ([reddit](https://www.reddit.com/r/SillyTavernAI/comments/1s07i8f/deeplore_enhanced_v020_your_obsidian_vault_is_now/obxd24v/))

> *"I just installed this and this has all the features that I've been doing manually! This is freaking amazing and also dangerous, because I love world building as well."*
> - /u/realedazed ([reddit](https://www.reddit.com/r/SillyTavernAI/comments/1s07i8f/deeplore_enhanced_v020_your_obsidian_vault_is_now/obxwj40/))

> *"I figured [how to import SillyTavern lore] out! This seems really cool! I have imported my lorebooks into an Obsidian vault and my brain is exploding a bit because I have a HUGE chat with naturally HUGE lorebooks and there are so many things floating around my graphs. It was very easy to set up once I got past the newness of Obsidian. The wizard was easy to follow and clear. I can easily see myself spending hours curating my vaults this weekend."*
> - /u/morty_morty ([reddit](https://www.reddit.com/r/SillyTavernAI/comments/1sayvas/announcing_deeplore_enhanced_10beta_your_obsidian/oe4edb8/))

> *"While SillyTavern's built-in Lorebook system is fine at what it does, I found that sometimes... keywords weren't either enough or fired too often. After trying to wrap my slimy meat around the spider web of keywords, cases, whole-words, ect, I found that I work better within Obsidian and the [DLE] extension using Two-Stage retrieval."*
> - /u/SnowingDandruff ([reddit](https://www.reddit.com/r/SillyTavernAI/comments/1svwvd7/best_memory_management_extensions/oiciipy/))

## Prerequisites

- **SillyTavern 1.12.14+**
- **Obsidian** with the **Local REST API** plugin enabled
- A lore vault (your existing one works; `/dle-import` converts World Info JSON into vault entries)
- Optional: any LLM provider for AI search; keywords-only mode works without one

## Install

1. SillyTavern → Extensions → **Install Extension**
2. Paste: `https://github.com/pixelnull/sillytavern-DeepLore`
3. Run `/dle-setup`. It opens with a welcome screen that lets you pick a path — try the demo, connect a vault, or import existing World Info — then walks through vault connection (with a localhost vault scanner), tags, search mode, and provider. Skip steps and resume later if you want.

<p align="center">
  <img src="https://i.imgur.com/8Mktt2y.png" alt="Setup wizard first page" width="640">
</p>

## AI connections: profile or direct

Every AI feature (AI Search, Session Scribe, Auto Lorebook, AI Notepad, Librarian,
Optimize Keys) picks its own connection in **DLE Settings → Setup → AI Connections**:

- **Connection Profile** — reuse a SillyTavern Connection Manager profile. Nothing
  to configure beyond picking it from the dropdown.
- **Direct API (URL + key)** — point DeepLore straight at an endpoint. Use this when
  Connection Manager profiles don't work for you: a profile that was renamed or
  deleted, a completion preset SillyTavern rejects, or a provider you simply want
  DeepLore to talk to on its own.

  Paste an **API URL** (a base like `https://api.openai.com/v1`, or the full
  endpoint), an **API key**, and a **model** — the model is required here, since
  there's no profile to read one from. Format is auto-detected: OpenAI-compatible
  (`/chat/completions`) or Anthropic (`/v1/messages`); override it if the guess is
  wrong. That covers OpenAI, OpenRouter, Anthropic, Groq, DeepSeek, Mistral, xAI,
  Together, Gemini's OpenAI-compatible endpoint, and local runtimes like Ollama,
  LM Studio, llama.cpp and TabbyAPI (leave the key blank for those).

  Requests go straight from your browser, so the endpoint has to allow browser
  (CORS) requests. If it doesn't, tick **Route through SillyTavern's CORS proxy**
  (needs `enableCorsProxy: true` in ST's `config.yaml`). DeepLore says so
  explicitly when it thinks CORS is what blocked a call.

Other features can **Inherit** AI Search's connection, or override it with their own.
API keys are stored in SillyTavern's extension settings, the same as your Obsidian
key — they're never written to diagnostic exports.

## What's in the box

<p align="center">
  <img src="https://i.imgur.com/vzqxpr5.png" alt="Entry browser" width="640">
</p>

- **Librarian (Emma)** - your lorebook grows as you roleplay: writing AI flags gaps mid-generation, Emma helps you author the entries
- **Two-stage AI retrieval** - keywords + AI selection
- **Relationship Graph** - 200+ node vault view, clustering, gap analysis
- **Session Scribe** - auto-summaries written back to the vault
- **Context Cartographer** - per-message "why did this entry fire?" trace
- **Contextual Gating** - era / location / scene / character + user-defined fields
- **Diagnostics** - pipeline inspector, health check, activation simulation, status

<table>
  <tr>
    <td align="center" width="50%"><a href="https://i.imgur.com/rqEeOVX.png"><img src="https://i.imgur.com/rqEeOVX.png" height="180"></a><br><sub>Health Check - 30+ automated audits</sub></td>
    <td align="center" width="50%"><a href="https://i.imgur.com/MD6ILH8.png"><img src="https://i.imgur.com/MD6ILH8.png" height="180"></a><br><sub>Activation Simulation - replay chat, see entry timeline</sub></td>
  </tr>
  <tr>
    <td align="center" width="50%"><a href="https://i.imgur.com/0yX5UHC.png"><img src="https://i.imgur.com/0yX5UHC.png" height="180"></a><br><sub>Custom Gating - visual rule builder for user-defined fields</sub></td>
    <td align="center" width="50%"><a href="https://i.imgur.com/RwCNQca.png"><img src="https://i.imgur.com/RwCNQca.png" height="180"></a><br><sub>Status - connection & index info at a glance</sub></td>
  </tr>
</table>

Full feature docs: [**Wiki →**](https://github.com/pixelnull/sillytavern-DeepLore/wiki)

## Known rough edges

- **Still beta.** Hundreds of bugs fixed across the 2.x line, but the surface is big.
- **World Info parity gaps:** no regex keys, and `sticky`/`delay`/`group` scoring is preserved on import but not acted on (round-tripped, not enforced). Case-sensitivity, whole-word matching, and all four `selective_logic` modes (`and_any`/`and_all`/`not_all`/`not_any`) are supported. Import handles the rest; a few advanced WI behaviors downgrade and are flagged by `/dle-lint`.
- **Librarian needs a tool-calling provider.** Emma uses native tool calls; route her to Claude, Gemini, an OpenAI-compatible endpoint, or Cohere. Reasoner-only models can't drive the loop.
- **Obsidian API keys stored plaintext** in ST's extension settings JSON (platform limitation). Use a dedicated lorebook vault, not your personal one.

See [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) for the complete list.

## Upgrading

> **v2.6.3 note**: AI features can now connect via a **Direct API** URL + key, as an
> alternative to SillyTavern Connection Profiles — see [AI connections](#ai-connections-profile-or-direct)
> above. Existing profile-mode setups are untouched; nothing needs migrating.

> **v2.5 note**: Custom Proxy connection mode for AI features (claude-code-proxy direct routing via ST's CORS bridge) was removed in v2.5. All AI features now use SillyTavern Connection Profiles. If you were using Custom Proxy, DLE will show a migration popup on first boot of v2.5 and automatically switch each affected feature (AI Search, Scribe, Auto Lorebook, AI Notepad, Librarian, Optimize Keys) to its corresponding Connection Profile. `enableCorsProxy: true` in ST's `config.yaml` is no longer required for DLE AI features (it remains required only for ST's own raw-URL AI requests if you use those, and for Obsidian vault fetching when using HTTPS with a self-signed cert).

If you had **DeepLore Enhanced** (the previous name of this extension), update in place; same repo. No reindex needed; 1.0-beta vaults work as-is.

If you had the older standalone `sillytavern-DeepLore` extension, uninstall it first. Running both at once corrupts prompt injection.

## Star History

<a href="https://www.star-history.com/?type=date&repos=pixelnull%2Fsillytavern-deeplore">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=pixelnull/sillytavern-deeplore&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=pixelnull/sillytavern-deeplore&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=pixelnull/sillytavern-deeplore&type=date&legend=top-left" />
  </picture>
</a>

## License

MIT. Made by [pixelnull](https://infosec.exchange/@pixelnull).
