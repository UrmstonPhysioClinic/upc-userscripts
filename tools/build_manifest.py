"""
Writes stable/scripts.json and beta/scripts.json: the list of scripts the loader runs.

Run after adding, removing or changing any script:  python3 tools/build_manifest.py
tests/check_scripts.py fails if a list is out of date.
"""
import json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def header_value(text, key):
    m = re.search(r'//\s*@' + key + r'\s+(.*)', text.split('// ==/UserScript==')[0])
    return m.group(1).strip() if m else ''


# Scripts the loader starts before the rest, in this order. The health check goes first so it
# can catch errors from every other script, then the core library other scripts use.
# Everything else follows alphabetically.
FIRST = ['health-check.user.js', 'block-error-reporting.user.js', 'core.user.js']   # error reporting blocked before anything else can fail


def manifest(channel):
    scripts = []
    files = sorted((ROOT / channel).glob('*.user.js'), key=lambda p: (FIRST.index(p.name) if p.name in FIRST else len(FIRST), p.name))
    for p in files:
        text = p.read_text()
        entry = {'file': p.name, 'name': header_value(text, 'name'), 'version': header_value(text, 'version')}
        was = header_value(text, 'upc-was')   # renamed from: the loader moves this PC's switch and settings across
        if was:
            entry['was'] = was
        scripts.append(entry)
    return json.dumps({'scripts': scripts}, indent=2) + '\n'


if __name__ == '__main__':
    for ch in ('stable', 'beta'):
        (ROOT / ch / 'scripts.json').write_text(manifest(ch))
        print('wrote', ch + '/scripts.json')
