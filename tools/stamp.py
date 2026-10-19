#!/usr/bin/env python3
"""Stamp a build id into index.html and version.json so browsers never run a stale build.

Every local js/css reference in index.html gets ?v=<build>, the page carries
<meta name="pp-build">, and version.json holds the same id. js/update-check.js
compares the two and reloads a stale tab. Run by .git/hooks/pre-commit (tools/install-hooks.sh).
"""
import datetime
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"
VERSION = ROOT / "version.json"
ASSET_RE = re.compile(r'((?:src|href)=")((?:js|css)/[^"?]+)(?:\?v=[^"]*)?(")')
META_RE = re.compile(r'<meta name="pp-build" content="[^"]*">')


def stamp(build):
    html = INDEX.read_text(encoding="utf-8")
    html = ASSET_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={build}{m.group(3)}", html)
    meta = f'<meta name="pp-build" content="{build}">'
    if META_RE.search(html):
        html = META_RE.sub(meta, html)
    else:
        html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  ' + meta, 1)
        if meta not in html:
            sys.exit("stamp: could not find <meta charset> to anchor pp-build")
    INDEX.write_text(html, encoding="utf-8")
    VERSION.write_text(json.dumps({"build": build}) + "\n", encoding="utf-8")


if __name__ == "__main__":
    stamp(sys.argv[1] if len(sys.argv) > 1 else datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M%S"))
