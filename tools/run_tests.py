"""
Runs every test: tests/check_scripts.py, then each tests/<script>/test_*.py (beta copies), one at a time.

Run:  python3 tools/run_tests.py            # all
      python3 tools/run_tests.py remittances bank-statement   # only these folders
Prints one line per test and the failures; exits 1 if any failed.
On GitHub (CI set) it also holds the tests to time limits (tests/budgets.txt): a folder over its limit, or a group over
300 seconds, fails, and the slowest folders are listed in the job summary.
Needs Python 3 with Playwright (Chromium), reportlab, Pillow and astral, and Node.js with npm.
"""
import os, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FOLDER_LIMIT, GROUP_LIMIT = 90, 300


def limits():
    out = {}
    for line in (ROOT / 'tests' / 'budgets.txt').read_text().splitlines():
        parts = line.split()
        if parts and not line.startswith('#') and len(parts) >= 2 and parts[1].isdigit():
            out[parts[0]] = int(parts[1])
    return out


def main(only):
    tests = [ROOT / 'tests' / 'check_scripts.py']
    for d in sorted(p for p in (ROOT / 'tests').iterdir() if p.is_dir() and not p.name.startswith(('.', '_'))):
        if only and d.name not in only:
            continue
        tests += sorted(d.glob('test_*.py'))
    failed, took = [], {}
    for t in tests:
        t0 = time.time()
        r = subprocess.run([sys.executable, str(t)], cwd=ROOT, capture_output=True, text=True, timeout=1500)
        name = str(t.relative_to(ROOT))
        secs = time.time() - t0
        folder = t.parent.name if t.parent.name != 'tests' else t.name
        took[folder] = took.get(folder, 0) + secs
        print('%s %s (%ds)' % ('PASS' if r.returncode == 0 else 'FAIL', name, secs), flush=True)
        if r.returncode != 0:
            failed.append(name)
            lines = (r.stdout + r.stderr).splitlines()
            shown = [l for l in lines if l.startswith('FAIL') or 'Error' in l] or lines[-15:]
            print('\n'.join('    ' + l for l in shown[:20]), flush=True)
    if os.environ.get('CI'):
        lim = limits()
        over = ['%s took %ds (limit %ds)' % (f, s, lim.get(f, FOLDER_LIMIT)) for f, s in took.items() if s > lim.get(f, FOLDER_LIMIT)]
        total = sum(took.values())
        if total > GROUP_LIMIT:
            over.append('this group took %ds (limit %ds): move a folder to a quicker group' % (total, GROUP_LIMIT))
        for o in over:
            print('TOO SLOW ' + o, flush=True)
            failed.append('too slow: ' + o)
        summary = os.environ.get('GITHUB_STEP_SUMMARY')
        if summary:
            with open(summary, 'a') as fh:
                fh.write('Group total %ds of %ds. Slowest: %s\n' % (total, GROUP_LIMIT, ', '.join('%s %ds' % (f, s) for f, s in sorted(took.items(), key=lambda x: -x[1])[:5])))
    print('\n%d of %d failed: %s' % (len(failed), len(tests), ', '.join(failed)) if failed else '\nAll %d passed' % len(tests))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(set(sys.argv[1:])))
