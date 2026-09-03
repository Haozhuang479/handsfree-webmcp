#!/usr/bin/env python3
"""handsfree injector — copy the runtime next to the site and add the one line.

    python3 inject.py --html public/index.html [--static public] [--url /handsfree.js]
                      [--lang en-US] [--wake "hey shop"] [--no-voice] [--no-gesture] [--no-speak]
                      [--text-tool ask] [--scroll-tool scroll_page] [--dry-run] [--remove]

Rules:
  * The script tag is inserted as the FIRST element inside <head> so it can
    wrap document.modelContext.registerTool before app scripts register tools.
    (If the page has its own WebMCP registry on window.WebMCP, order does not
    matter — the runtime discovers tools lazily either way.)
  * Idempotent: re-running updates the existing tag instead of adding another.
  * --remove strips the tag (leaves the copied runtime file in place).
Exit 0 on success, 1 on error.
"""
import argparse
import pathlib
import re
import shutil
import sys

HERE = pathlib.Path(__file__).resolve().parent
RUNTIME = HERE.parent / "assets" / "handsfree.js"
TAG_RE = re.compile(r"[ \t]*<script[^>]*\bdata-handsfree\b[^>]*></script>\n?", re.I)


def build_tag(a) -> str:
    attrs = [f'src="{a.url}"', "defer", 'data-handsfree="1"']
    if not a.voice: attrs.append('data-voice="false"')
    if not a.gesture: attrs.append('data-gesture="false"')
    if not a.speak: attrs.append('data-speak="false"')
    if a.lang: attrs.append(f'data-lang="{a.lang}"')
    if a.wake: attrs.append(f'data-wake="{a.wake}"')
    if a.text_tool: attrs.append(f'data-text-tool="{a.text_tool}"')
    if a.scroll_tool: attrs.append(f'data-scroll-tool="{a.scroll_tool}"')
    if a.autostart: attrs.append('data-autostart="true"')
    return f"<script {' '.join(attrs)}></script>"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--html", required=True, help="HTML entry / layout file to edit")
    ap.add_argument("--static", help="Directory to copy handsfree.js into (default: the HTML file's directory)")
    ap.add_argument("--url", default="/handsfree.js", help="URL the page will load the runtime from")
    ap.add_argument("--lang"); ap.add_argument("--wake"); ap.add_argument("--text-tool"); ap.add_argument("--scroll-tool")
    ap.add_argument("--no-voice", dest="voice", action="store_false"); ap.add_argument("--no-gesture", dest="gesture", action="store_false")
    ap.add_argument("--no-speak", dest="speak", action="store_false"); ap.add_argument("--autostart", action="store_true")
    ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--remove", action="store_true")
    a = ap.parse_args()

    html_path = pathlib.Path(a.html)
    if not html_path.is_file():
        print(f"error: {html_path} not found", file=sys.stderr); return 1
    src = html_path.read_text(encoding="utf-8")

    if a.remove:
        out = TAG_RE.sub("", src)
        if out == src: print("nothing to remove"); return 0
        if not a.dry_run: html_path.write_text(out, encoding="utf-8")
        print(f"removed handsfree tag from {html_path}"); return 0

    if not RUNTIME.is_file():
        print(f"error: runtime missing at {RUNTIME}", file=sys.stderr); return 1
    static_dir = pathlib.Path(a.static) if a.static else html_path.parent
    dest = static_dir / pathlib.Path(a.url).name
    tag = build_tag(a)

    if TAG_RE.search(src):
        out = TAG_RE.sub(lambda m: re.match(r"[ \t]*", m.group(0)).group(0) + tag + "\n", src, count=1)
        action = "updated"
    else:
        head = re.search(r"<head[^>]*>[ \t]*\n?", src, re.I)
        if not head:
            print("error: no <head> in file — for framework layouts add the tag by hand (see SKILL.md)", file=sys.stderr); return 1
        # keep <meta charset> first (HTML spec wants it in the first 1024 bytes); otherwise go right after <head>
        charset = re.compile(r"<meta[^>]*charset[^>]*>[ \t]*\n?", re.I).search(src, head.end())
        at = charset.end() if charset and charset.start() < head.end() + 400 else head.end()
        indent = re.match(r"[ \t]*", src[at:]).group(0)
        out = src[:at] + f"{indent}<!-- handsfree: voice + gesture layer over this page's WebMCP tools -->\n{indent}{tag}\n" + src[at:]
        action = "inserted"

    if a.dry_run:
        print(f"[dry-run] would copy {RUNTIME} → {dest}\n[dry-run] would have {action} in {html_path}:\n  {tag}"); return 0
    static_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(RUNTIME, dest)
    html_path.write_text(out, encoding="utf-8")
    print(f"copied runtime → {dest}\n{action} tag in {html_path}:\n  {tag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
