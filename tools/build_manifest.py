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


def manifest(channel):
    scripts = []
    for p in sorted((ROOT / channel).glob('*.user.js')):
        text = p.read_text()
        scripts.append({'file': p.name, 'name': header_value(text, 'name'), 'version': header_value(text, 'version')})
    return json.dumps({'scripts': scripts}, indent=2) + '\n'


if __name__ == '__main__':
    for ch in ('stable', 'beta'):
        (ROOT / ch / 'scripts.json').write_text(manifest(ch))
        print('wrote', ch + '/scripts.json')
