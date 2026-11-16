"""
Test for Calendar controls' Just me / All practitioners buttons on narrower screens: on a stand-in for Halaxy's calendar
toolbar (date and Day / Week / Month on the left, Location and Practitioner on the right, which grows to the left), the
buttons keep their full labels when there is room, switch to "Me" / "All" when that is enough, and otherwise move to a
line of their own under the toolbar; back in the toolbar when the window is wide again.

Run:  python3 tests/calendar-controls/test_toolbar_fit.py
"""
import asyncio, re, sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
SRC = (ROOT / 'beta' / 'calendar-controls.user.js').read_text()
FIT = re.search(r'\n  function fitButtons\(\) \{.*?\n  \}\n', SRC, re.S).group(0)
FAILS = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)))
    if not ok:
        FAILS.append(name)


PAGE = """<!doctype html><html><head><style>
  body { margin: 0; font: 14px sans-serif; }
  .row { display: flex; } .col { flex: 1 1 0; min-width: 0; } .col-7 { flex: 0 0 58%; max-width: 58%; } .col-5 { flex: 0 0 42%; max-width: 42%; }
  .DayMenu .row { justify-content: center; } .right { display: flex; justify-content: flex-end; white-space: nowrap; }
  .btn { display: inline-block; padding: 4px 10px; border: 1px solid #63c; white-space: nowrap; }
  .btn-group { display: inline-flex; } .ml-2 { margin-left: 8px; }
</style></head><body><div id="calToolbar">
  <div class="row TopMenu">
    <div class="col-7 DayMenu"><div class="row"><span class="DateLabel">Practitioner / Thu 12-Nov-2026</span>
      <span class="btn">Day</span><span class="btn-group"><span class="btn">Week</span><span class="btn">Month</span></span></div></div>
    <div class="col-5"><div class="row"><div class="col" style="flex:0 0 20px"><span class="loading"></span></div>
      <div class="col right"><span class="btn" id="activeLocation">Multilocation</span><span class="btn" id="btn-swap-prac">Practitioner</span></div></div></div>
  </div>
</div><div id="grid">grid</div></body></html>"""

ADD = """(() => {
  const col = document.querySelector('#calToolbar .loading').closest('.col').nextElementSibling;
  const group = document.createElement('div'); group.id = 'upc-prac-buttons'; group.className = 'btn-group ml-2';
  group.innerHTML = '<span class="btn" data-long="Just me" data-short="Me">Just me</span><span class="btn" data-long="All practitioners" data-short="All">All practitioners</span>';
  col.prepend(group);
  const st = document.createElement('style');
  st.textContent = '#upc-prac-buttons { white-space: nowrap; } #upc-prac-row { display: flex; justify-content: flex-end; width: 100%; flex: 0 0 100%; padding: 4px 15px 0; }';
  document.head.appendChild(st);
})()"""

STATE = """(() => { const g = document.getElementById('upc-prac-buttons');
  return { where: g.parentElement.id === 'upc-prac-row' ? 'below' : 'toolbar', labels: [...g.children].map((b) => b.textContent),
    belowToolbar: !!document.querySelector('.TopMenu + #upc-prac-row'),
    rects: [...document.querySelectorAll('#calToolbar .btn, #calToolbar .DateLabel')].map((e) => e.textContent.slice(0, 8) + ' ' + Math.round(e.getBoundingClientRect().left) + '-' + Math.round(e.getBoundingClientRect().right)) }; })()"""


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        pg = await browser.new_page(viewport={'width': 1800, 'height': 600})
        await pg.set_content(PAGE)
        await pg.evaluate(ADD)
        await pg.evaluate('window.fitButtons = (function () {' + FIT + ' return fitButtons; })()')

        await pg.evaluate('fitButtons()')
        s = await pg.evaluate(STATE)
        check('wide screen: full labels, in the toolbar', s['where'] == 'toolbar' and s['labels'] == ['Just me', 'All practitioners'], s)

        await pg.set_viewport_size({'width': 720, 'height': 600})
        await pg.evaluate('fitButtons()')
        s = await pg.evaluate(STATE)
        check('a little narrower: short labels, still in the toolbar', s['where'] == 'toolbar' and s['labels'] == ['Me', 'All'], s)

        await pg.set_viewport_size({'width': 560, 'height': 600})
        await pg.evaluate('fitButtons()')
        s = await pg.evaluate(STATE)
        check('narrow: full labels on a line of their own under the toolbar', s['where'] == 'below' and s['belowToolbar'] and s['labels'] == ['Just me', 'All practitioners'], s)

        await pg.set_viewport_size({'width': 1800, 'height': 600})
        await pg.evaluate('fitButtons()')
        s = await pg.evaluate(STATE)
        check('wide again: back in the toolbar, the extra line gone', s['where'] == 'toolbar' and not await pg.evaluate("!!document.getElementById('upc-prac-row')"), s)

        await pg.evaluate("document.documentElement.classList.add('hxl')")
        await pg.set_viewport_size({'width': 800, 'height': 600})
        await pg.evaluate('fitButtons()')
        s = await pg.evaluate(STATE)
        check('mobile layout on: left to the mobile layout', s['where'] == 'toolbar' and s['labels'] == ['Just me', 'All practitioners'], s)
        await browser.close()
    print('\n' + ('All passed' if not FAILS else '%d failed' % len(FAILS)))
    sys.exit(1 if FAILS else 0)


asyncio.run(main())
