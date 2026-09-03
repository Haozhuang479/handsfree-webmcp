---
name: handsfree
description: >-
  Make a website voice + gesture controllable with one injected line, on top of
  WebMCP tools. Use when the user says "handsfree", "make this site voice
  controlled", "add gesture / hand control", "add WebMCP tools to this page",
  "agentify this site", "让网站支持语音/手势", or asks to instrument a page's
  capabilities as document.modelContext tools. Works on any codebase Claude
  Code can edit: static HTML, Vite/CRA, Next.js/Nuxt/SvelteKit layouts, Shopify
  themes. Not for building a voice assistant backend — the runtime routes
  speech/gestures to the page's own tools without an LLM.
---

# Handsfree — voice + gesture layer over WebMCP tools

Two layers, always in this order:

1. **Tool layer (WebMCP).** The page's capabilities become tools on
   `document.modelContext` (`registerTool({name, description, inputSchema,
   execute})`). This is the part that needs codebase access and judgement.
2. **Modality layer (runtime).** `assets/handsfree.js` — one `<script>` line —
   listens (Web Speech API), watches (MediaPipe hand tracking) and routes what
   it hears/sees to those tools with rules, no LLM.

The promise is honest only as "one command + one line": the runtime is one
line; the tools are generated code that the user must review.

## Workflow

### 0. Recon (2 minutes, read-only)
- Find the HTML entry or root layout: `index.html`, `app/layout.tsx`,
  `pages/_document.tsx`, `nuxt.config`, `src/app.html`, `layout/theme.liquid`.
- Find the static dir the entry is served from (`public/`, `static/`, `assets/`).
- Check for existing WebMCP tools:
  `grep -rn "modelContext\|WebMCP.registerTool\|registerTool(" --include=*.js --include=*.ts --include=*.tsx --include=*.html`
- Note the primary user actions: navigation, search/filter, pagination or
  infinite scroll, the main CTA(s) (add to cart, open item, buy), and any
  "focus/select item in a list" concept.

### 1. Tool layer
**If tools already exist** (e.g. a site built with the WebMCP shim pattern): keep
them. Only add missing `annotations.handsfree` roles (see below) if the site
has no text-sink or scroll tool.

**If none exist**: write `webmcp-tools.js` (or a module the framework loads
once on the client) following [reference/tool-authoring.md](reference/tool-authoring.md).
Minimum viable set — every one wired to a *real* function in the codebase, never
to synthetic DOM clicks when an API exists:

| tool | role | notes |
|---|---|---|
| `scroll_page` | `handsfree.role = "scroll"` | `{direction: down/up/top/bottom, amount}` — gestures land here |
| `ask` or `search` | `handsfree.role = "text-sink"` | free speech lands here; takes one string prop |
| `focus_item` | — | `{target: next/prev/first/last/N/text}` — highlights an item in the current list |
| `open_item` | — | opens the focused/targeted item (Learn more / details) |
| primary CTA(s) | `handsfree.confirm = true` when money/irreversible | e.g. `buy_now`, `add_to_cart`, `submit_form` — runtime asks "say yes" first |
| `go_home` / `go_back` | — | navigation |

Add `annotations.handsfree.phrases` (spoken aliases) to anything a person would
say differently from the tool name. Keep descriptions specific: they are what
a browser agent (and a future LLM router) reads.

Include the shim from the demo (`webmcp.js` pattern) when the site has no
registry of its own: it forwards to native `document.modelContext` when present
and keeps a page-side list otherwise. Native WebMCP is Chrome 146+ behind a
flag / 149+ origin trial (Sept 2026); everything must work without it.

### 2. Inject the runtime (the one line)
```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/inject.py" --html public/index.html --static public
```
Options: `--lang zh-CN`, `--wake "hey shop"`, `--no-gesture`, `--no-voice`,
`--no-speak`, `--text-tool NAME`, `--scroll-tool NAME`, `--autostart`,
`--dry-run`, `--remove`. The tag goes in as the **first** element of `<head>`
(it must wrap `registerTool` before app scripts run, unless the page exposes
`window.WebMCP`). For framework layouts without a literal `<head>`, copy
`assets/handsfree.js` into the static dir and add
`<script src="/handsfree.js" defer data-handsfree="1"></script>` (Next.js:
`<Script src="/handsfree.js" strategy="beforeInteractive" />`) by hand.

`${CLAUDE_SKILL_DIR}` is this skill's directory; if the variable is not set,
use the path where this SKILL.md lives.

### 3. Verify (never ask the user to check)
Start the dev server and, in the browser:
- The dock (hand / mic icons) renders bottom-right; console shows
  `[handsfree] ready · tools: …` listing the expected tools.
- `Handsfree.tools().map(t=>t.name)` — all tools present.
- `await Handsfree.route('scroll down')` → page scrolls (via the scroll tool).
- `await Handsfree.route('next')`, `await Handsfree.route('open it')`, and a
  free sentence → routed to `focus_item`, `open_item`, and the text-sink.
- A confirm-gated tool: `route('buy it')` returns `{pending}`; `route('yes')` executes.
Mic and camera need a secure context (localhost or https) and a real user
gesture; headless/embedded browsers often expose neither, so verify routing
with `Handsfree.route(...)` and report the modality checks as "needs a real
browser session" if the environment lacks them.

### 4. Report
List: tools registered (name → what it calls), the inserted line, config
flags, what was verified, and what needs a human (mic/camera permission,
reviewing the generated tools, sites where the primary actions had no API and
were skipped).

## Runtime behaviour reference
- **Voice grammar (built-in):** scroll down/up · top/bottom · back/forward · close ·
  next/previous · open (it / number N / the third one) · buy it (confirm) ·
  more / load more · cheaper / pricier (→ `refine_results` if the page has it) ·
  browse everything (→ a `browse*` tool) · what is this (→ `describe_focused`) ·
  help · stop · yes/no. Leading politeness ("hey", "please", "can you") is
  stripped; ASR quirks are undone ("page 4" → "page for", "fifty dollars" →
  $50, "dlp" → "landing page for"); price phrases become `max_price` /
  `min_price` and are removed from the query text. Anything else → text-sink.
  Spoken feedback is off by default (`speak: true` to enable).
- **Gestures:** the index fingertip is a cursor projected on the page (grey
  ring); whatever it points at gets `.hf-hover`. An **index-finger tap** (the
  finger, held out alone, bends and straightens within `tapMaxMs`) clicks it —
  a product card is focused through the page's focus tool and opened with its
  open tool, any other link/button gets a real `click()`. The outer left and
  right bands of the viewport (`zoneWidth`, 18 %) are **scroll zones**: the
  upper half scrolls up, the lower half scrolls down, and the speed grows
  from the band's vertical centre towards the edge (up to `maxScrollSpeed`
  px/s, with a `zoneDeadband` around the centre). No swipes. Everything is
  drawn on a full-screen dot field (fine grey grid that bulges under the
  cursor; the side bands are teal-tinted while a hand is tracked and glow when
  active) with a bold white/ink cursor ring and a thin ring on click (no trailing
  particles). Tuning: `tapBend`, `tapRelease`, `tapMaxMs`. Tuning: `zoneWidth`, `zoneDeadband`,
  `maxScrollSpeed`, `clickCooldownMs`, `cursorSmoothing`,
  `region` (the lower-left / lower-right part of the camera frame — picked by
  where the hand is, with hysteresis — maps to the whole viewport, so the arm
  can rest low), `accent`, `zoneColor` (teal by default, from `--mint-deep`). An open-hand **wave right = back** (dismiss /
  history / home tool), **wave left = forward** (`waveDistance`, `waveSpeed`,
  `waveWindowMs`, `waveCooldownMs`). The zones are drawn as a raised dot field:
  dot size grows towards the outer edge (faster scroll) and bulges under the cursor.
- **Popups:** a gesture or voice action carries no user activation, so
  `window.open` / `target=_blank` would be popup-blocked. The runtime navigates
  the current tab for synthetic clicks on `_blank` links; sites should offer an
  in-page panel for "open" (the demo's product sheet) and check
  `navigator.userActivation.isActive` before opening tabs. "back"/"close"
  first clicks a visible `[data-hf-dismiss]` control or a tool annotated
  `handsfree.role = "dismiss"`, then falls back to history / the home tool.
- **Tutorial:** `Handsfree.tutorial.start()` — a four-page walkthrough (point,
  scroll bands, fist click, ready). The first tap on the hand button opens it
  instead of the camera; the camera and the gesture engine start only from its
  final "Enable gestures" button (a real click, so the permission prompt is
  allowed). Completion is remembered in `localStorage` (`handsfree.tutorial`);
  `Handsfree.tutorial.reset()` shows it again.
- **Config:** `window.HANDSFREE_CONFIG` or `data-*` attrs — `voice`, `gesture`,
  `speak`, `lang`, `wake`, `textTool`, `scrollTool`, `autostart`, `position`,
  `swipeThreshold`, `cooldownMs`.
- **Scratch surfaces:** pages can consume `handsfree:cursor` to let the hand
  cursor act like a finger (the demo's scratch-to-win card is scratched by
  passing the cursor over it).
- **Events:** `handsfree:routed` `{text, result}`, `handsfree:gesture` `{gesture}`,
  `handsfree:cursor` `{x, y, mode}` (≈30 Hz while a hand is tracked), `handsfree:handlost`.
  Pages can drive hover behaviours from the cursor event (the demo scrolls its
  product rails: left half → left, right half → right). Mark horizontal
  scrollers with `data-hf-scroll="x"` and the vertical scroll zones pause
  while the cursor rests on them.
- **Discovery order:** `window.WebMCP.listTools()` if present → wrapped
  `document.modelContext.registerTool` → polyfill (flagged `polyfill: true`).

## Guardrails
- Never register a tool that moves money or deletes data without
  `handsfree.confirm = true`.
- Never wire tools to fabricated behaviour; if an action has no function or
  API, leave it out and say so.
- Do not commit; do not add the tag to more than one entry file; do not touch
  CSP unless the site already blocks `cdn.jsdelivr.net` / `storage.googleapis.com`
  (then report it — gestures need those hosts).
