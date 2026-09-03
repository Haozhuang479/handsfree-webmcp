# Handsfree plugin

One line for your Claude Code. After the skill runs on a codebase, the site is
voice + gesture controllable through its own WebMCP tools.

```
plugins/handsfree/
├── .claude-plugin/plugin.json
└── skills/handsfree/
    ├── SKILL.md                     # the workflow Claude Code follows
    ├── assets/handsfree.js          # the runtime (the one line loads this)
    ├── scripts/inject.py            # copies the runtime + inserts the tag, idempotent
    └── reference/tool-authoring.md  # how to write WebMCP tools the runtime can route to
```

## Install
```bash
claude plugin marketplace add ~/Downloads/handsfree-marketplace
claude plugin install handsfree@handsfree
```
Installed on this machine on 2026-09-02 (registered by hand in
`~/.claude/plugins/` because the `claude` CLI was not on the shell PATH; the
cache copy lives at `~/.claude/plugins/cache/handsfree/handsfree/0.1.0/` —
re-copy or `claude plugin update handsfree@handsfree` after editing this repo).
Then in any project: "handsfree — make this site voice and gesture controlled".

## Manual use without installing
```bash
python3 ~/Downloads/handsfree-marketplace/plugins/handsfree/skills/handsfree/scripts/inject.py \
  --html public/index.html --static public
```

## What the runtime does
- Discovers tools registered on `document.modelContext` (WebMCP draft API),
  through the page's `window.WebMCP` registry when present, otherwise by
  wrapping `registerTool`; polyfills the API in browsers without it.
- Voice: Web Speech API → rule router → tool. Built-ins: scroll, back, next /
  previous, open (number N), buy (confirm), load more, help, yes / no, stop.
  Free sentences go to the tool annotated `handsfree.role = "text-sink"`.
- Gesture: MediaPipe HandLandmarker (on-device, loaded from cdn.jsdelivr.net;
  model from storage.googleapis.com). Open-hand swipe down/up scrolls, swipe
  left/right moves focus, pinch opens the focused item.
- Speaks short confirmations (toggle with `data-speak="false"`).

Requires a secure context (localhost / https) and user permission for mic and
camera. Speech recognition availability depends on the browser (Chrome/Edge
yes; Firefox no; embedded/headless Chromium usually no).
