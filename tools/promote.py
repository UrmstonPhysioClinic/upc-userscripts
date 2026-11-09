#!/usr/bin/env python3
"""Promote beta scripts to stable: python3 tools/promote.py core.user.js outstanding-actions.user.js ...

Copies each beta/<file> to stable/<file>, changing only what must differ between the channels:
the " (beta)" suffix on @name, and the beta/ path in @updateURL and @downloadURL.
Run tools/build_manifest.py and tests/check_scripts.py afterwards.
Only promote what Carl has confirmed working on live Halaxy (CLAUDE.md).
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def promote(name):
    src = ROOT / 'beta' / name
    if not src.exists():
        sys.exit('No such beta script: ' + name)
    text = src.read_text()
    end = text.index('// ==/UserScript==')
    head, body = text[:end], text[end:]
    head, n = re.subn(r'^(// @name\s+.*?) \(beta\)$', r'\1', head, count=1, flags=re.M)
    if n != 1:
        sys.exit(name + ': @name has no " (beta)" suffix')
    head, n = re.subn(r'^(// @(?:updateURL|downloadURL)\s+\S*/)beta/', r'\1stable/', head, flags=re.M)
    if n != 2:
        sys.exit(name + ': expected @updateURL and @downloadURL pointing at beta/')
    (ROOT / 'stable' / name).write_text(head + body)
    ver = re.search(r'^// @version\s+(\S+)', head, re.M).group(1)
    print('promoted', name, ver)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for n in sys.argv[1:]:
        promote(n)
