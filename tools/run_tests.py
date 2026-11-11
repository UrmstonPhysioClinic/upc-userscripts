"""
Runs every test: tests/check_scripts.py, then each tests/<script>/test_*.py (beta copies), one at a time.

Run:  python3 tools/run_tests.py            # all
      python3 tools/run_tests.py remittances bank-statement   # only these folders
Prints one line per test and the failures; exits 1 if any failed.
Needs Python 3 with Playwright (Chromium), reportlab, Pillow and astral, and Node.js with npm.
"""
import subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main(only):
    tests = [ROOT / 'tests' / 'check_scripts.py']
    for d in sorted(p for p in (ROOT / 'tests').iterdir() if p.is_dir() and not p.name.startswith(('.', '_'))):
        if only and d.name not in only:
            continue
        tests += sorted(d.glob('test_*.py'))
    failed = []
    for t in tests:
        t0 = time.time()
        r = subprocess.run([sys.executable, str(t)], cwd=ROOT, capture_output=True, text=True, timeout=1500)
        name = str(t.relative_to(ROOT))
        print('%s %s (%ds)' % ('PASS' if r.returncode == 0 else 'FAIL', name, time.time() - t0), flush=True)
        if r.returncode != 0:
            failed.append(name)
            lines = (r.stdout + r.stderr).splitlines()
            shown = [l for l in lines if l.startswith('FAIL') or 'Error' in l] or lines[-15:]
            print('\n'.join('    ' + l for l in shown[:20]), flush=True)
    print('\n%d of %d failed: %s' % (len(failed), len(tests), ', '.join(failed)) if failed else '\nAll %d passed' % len(tests))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(set(sys.argv[1:])))
