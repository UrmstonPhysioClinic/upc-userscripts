"""
Checks every script in stable/ and beta/ against the repository rules.

- Header has @name, @namespace, @version, and update/download URLs pointing at its own file.
- Beta @name ends in " (beta)"; stable does not.
- A script in both channels at the same version differs only in @name, @updateURL and @downloadURL.
  Beta may be ahead of stable (newer version, new scripts, scripts removed) until Carl confirms it.
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
LOADER_GM = {'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_registerMenuCommand'}
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
if stable ^ beta:
    print('     note: only in stable: %s; only in beta: %s' % (sorted(stable - beta), sorted(beta - stable)))

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
        body = text[len(head):]
        used = set(re.findall(r'\b(GM_\w+|GM\.\w+|unsafeWindow)\b', body)) - LOADER_GM
        grants = set(meta(head, 'grant')) - LOADER_GM - {'none'}
        check(tag + ' uses only what the loader provides', not used and not grants, sorted(used | grants))
        hits = [label for rx, label in SUSPECT if rx.search(text)]
        check(tag + ' no secrets or identifiers', not hits, hits)
        if ch == 'beta':
            # Native look (CLAUDE.md): interfaces live in the page with Halaxy's classes, not in a
            # shadow root, and never use Halaxy's behaviour classes on our own elements.
            check(tag + ' native look: no shadow root', 'attachShadow' not in body)
            behaviour = re.findall(r'class="[^"]*\b(ajax|btn-submit|btn-cancel|bootbox|dialogBoxForm|datepicker|popoverTarget)\b', body)
            check(tag + ' native look: no Halaxy behaviour classes on our elements', not behaviour, behaviour)
    if len(texts) == 2:
        vs = meta(header(texts['stable']) or '', 'version')
        vb = meta(header(texts['beta']) or '', 'version')
        if vs != vb:
            key = lambda v: [int(x) if x.isdigit() else x for x in re.split(r'[.-]', v[0] if v else '0')]
            check(name + ' beta is not behind stable', key(vb) > key(vs), (vs, vb))
            continue
        a, b = texts['stable'].splitlines(), texts['beta'].splitlines()
        diff = [(x, y) for x, y in zip(a, b) if x != y]
        bad = [d for d in diff if not (ALLOWED_DIFF.match(d[0]) and ALLOWED_DIFF.match(d[1]))]
        check(name + ' same version: stable and beta differ only in name and URLs', len(a) == len(b) and not bad, bad[:3])

# The loader's script lists must match the files.
sys.path.insert(0, str(ROOT / 'tools'))
from build_manifest import manifest  # noqa: E402
for ch in ('stable', 'beta'):
    p = ROOT / ch / 'scripts.json'
    check(ch + '/scripts.json is up to date (run tools/build_manifest.py)', p.exists() and p.read_text() == manifest(ch))

# The loader itself.
loader = ROOT / 'loader' / 'upc-loader.user.js'
if loader.exists():
    text = loader.read_text()
    head = header(text) or ''
    url = RAW + 'loader/upc-loader.user.js'
    check('loader update URLs', meta(head, 'updateURL') == [url] and meta(head, 'downloadURL') == [url])
    ver = meta(head, 'version')
    const = re.search(r'\bconst VERSION\s*=\s*[\'"]([^\'"]+)', text)
    check('loader VERSION constant matches', bool(ver and const and const.group(1) == ver[0]))
    r = subprocess.run(['node', '--check', str(loader)], capture_output=True, text=True)
    check('loader syntax', r.returncode == 0, r.stderr.strip()[:300])
else:
    check('loader exists', False)

print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
sys.exit(1 if FAILS else 0)
