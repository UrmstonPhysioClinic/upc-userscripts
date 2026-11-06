"""
Checks every script in stable/ and beta/ against the repository rules.

- Each script exists in both channels.
- Header has @name, @namespace, @version, and update/download URLs pointing at its own file.
- Beta @name ends in " (beta)"; stable does not.
- Stable and beta differ only in @name, @updateURL and @downloadURL.
- If a VERSION constant exists, it matches @version.
- JavaScript syntax is valid (node --check).
- No obvious secrets or patient identifiers (invoice numbers, emails, dated names).

Run:  python3 tests/check_scripts.py
Needs: Python 3 and Node.js.
"""
import re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = 'https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/'
ALLOWED_DIFF = re.compile(r'//\s*@(name|updateURL|downloadURL)\b')
SUSPECT = [
    (re.compile(r'\bUPC\d{4,}\b'), 'invoice number'),
    (re.compile(r'[\w.+-]+@[\w-]+\.(?:com|co\.uk|org|net)\b'), 'email address'),
    (re.compile(r'(?i)(api[_-]?key|secret|password)\s*[:=]\s*[\'"][^\'"]{6,}'), 'secret'),
    (re.compile(r'(?i)bearer\s+[a-z0-9._-]{20,}'), 'token'),
]
FAILS = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)))
    if not ok:
        FAILS.append(name)


def header(text):
    end = text.find('// ==/UserScript==')
    return text[:end] if text.startswith('// ==UserScript==') and end > 0 else None


def meta(head, key):
    return [m.group(1).strip() for m in re.finditer(r'//\s*@' + key + r'\s+(.*)', head)]


stable = {p.name for p in (ROOT / 'stable').glob('*.user.js')}
beta = {p.name for p in (ROOT / 'beta').glob('*.user.js')}
check('every script is in both channels', stable == beta, sorted(stable ^ beta))

for name in sorted(stable | beta):
    texts = {}
    for ch in ('stable', 'beta'):
        p = ROOT / ch / name
        if not p.exists():
            continue
        text = p.read_text()
        texts[ch] = text
        head = header(text)
        tag = ch + '/' + name
        if head is None:
            check(tag + ' has a header', False)
            continue
        names = meta(head, 'name')
        check(tag + ' @name', len(names) == 1 and names[0].endswith(' (beta)') == (ch == 'beta'), names)
        check(tag + ' @namespace', bool(meta(head, 'namespace')))
        ver = meta(head, 'version')
        check(tag + ' @version', len(ver) == 1, ver)
        url = RAW + ch + '/' + name
        check(tag + ' update URLs', meta(head, 'updateURL') == [url] and meta(head, 'downloadURL') == [url],
              meta(head, 'updateURL') + meta(head, 'downloadURL'))
        const = re.search(r'\bconst VERSION\s*=\s*[\'"]([^\'"]+)', text)
        if const and ver:
            check(tag + ' VERSION constant matches', const.group(1) == ver[0], const.group(1))
        r = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
        check(tag + ' syntax', r.returncode == 0, r.stderr.strip()[:300])
        hits = [label for rx, label in SUSPECT if rx.search(text)]
        check(tag + ' no secrets or identifiers', not hits, hits)
    if len(texts) == 2:
        a, b = texts['stable'].splitlines(), texts['beta'].splitlines()
        diff = [(x, y) for x, y in zip(a, b) if x != y]
        bad = [d for d in diff if not (ALLOWED_DIFF.match(d[0]) and ALLOWED_DIFF.match(d[1]))]
        check(name + ' stable and beta differ only in name and URLs', len(a) == len(b) and not bad, bad[:3])

print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
sys.exit(1 if FAILS else 0)
