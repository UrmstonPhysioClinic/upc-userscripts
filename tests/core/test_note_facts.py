"""
Test for the core library's note facts (UPC.notes.facts): what a note's wording says is worked out once per note and
reused by every script on the PC and by other PCs (through the shared Admin Note "UPC shared list: Note wording").

Checks: the first script to ask reads the note once and works out every known kind; another kind asked later is
served without reading the note again; a kind added later by a script (Review requests' "review") reads it once more;
the facts are saved to the shared note (no note text in it); a second PC gets them from there without reading the
note; a draft is read again after a day; a newer version of a kind reads the note again.

Run:  python3 tests/core/test_note_facts.py
"""
import asyncio, json, re, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text().replace('perMinute: 45,', 'perMinute: 100000,')
FAILS = []
S = {'reads': [], 'notes': {}}
TEXT = {'501': 'Subjective: knee better. Plan: Discharge from physiotherapy today. Return if symptoms recur.',
        '502': 'Subjective: ok. Plan: Follow-up as needed.'}


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:600]))
    if not ok:
        FAILS.append(name)


PAGE = "<!doctype html><html><body><div id='headerWrapper'></div><script>window.HkUser = { pracName: 'Carl Healy' }; window.Hk = { jwt: 'j' };</script></body></html>"


async def halaxy(route):
    req = route.request
    p = urllib.parse.urlparse(req.url).path
    js = lambda o: route.fulfill(body=json.dumps(o), content_type='application/json')
    form = dict(urllib.parse.parse_qsl(req.post_data or '', keep_blank_values=True)) if req.method == 'POST' else {}
    m = re.match(r'^/a/pr/555/note/(\d+)$', p)
    if m:
        S['reads'].append(m.group(1))
        return await js({'content': '<p>' + TEXT[m.group(1)] + '</p>', 'contentQuestions': ''})
    notes = S['notes']
    m = re.match(r'^/a/pr/555/communication-log/organisation/(\d+)/list-data$', p)
    if m:
        return await js({'data': [{'id': n['id'], 'date': '2026-11-22 10:00:00', 'privacy': 'All', 'creator': 'Carl Healy', 'isImportant': False,
                                   'content': '\n<p class="font-weight-bold">Log Notes</p>\n' + n['html'] + '\n<div class="form-row mt-4">\n    </div>\n'} for n in reversed(notes.get(int(m.group(1)), []))]})
    m = re.match(r'^/a/pr/555/communication-log/organisation/(\d+)/(new|(\d+)/edit)$', p)
    if m:
        org = int(m.group(1))
        if req.method == 'GET':
            old = next((n for n in notes.get(org, []) if str(n['id']) == m.group(3)), None)
            return await js({'status': 'FORM', 'message': "<form id='adminNoteForm'><input type='hidden' name='form[_token]' value='t'><select name='form[privacy]'><option value='3' selected>All</option></select><textarea name='form[logContent]'>%s</textarea></form>" % (old['html'] if old else '')})
        if m.group(3):
            next(n for n in notes[org] if str(n['id']) == m.group(3))['html'] = form['form[logContent]']
        else:
            notes.setdefault(org, []).append({'id': 34000 + sum(len(v) for v in notes.values()), 'html': form['form[logContent]']})
        return await js({'status': 'CLOSE', 'url': '/a/pr/555/communication-log'})
    await route.fulfill(body=PAGE, content_type='text/html')


async def pc(browser):
    ctx = await browser.new_context()
    await ctx.route('https://eu.halaxy.com/**', halaxy)
    await ctx.add_init_script(CORE)
    pg = await ctx.new_page()
    await pg.goto('https://eu.halaxy.com/a/pr/555/calendar')
    await pg.wait_for_function('!!(window.UPC && UPC.notes && UPC.notes.facts)')
    return ctx, pg


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx, pg = await pc(browser)
        f = await pg.evaluate("UPC.notes.facts('501', ['open', 'finished'])")
        check('first ask: the note read once; finished and open-ended worked out', S['reads'] == ['501'] and f['finished'] == ['discharged'] and f['open'] == ['come back if needed'], (S['reads'], f))
        f = await pg.evaluate("UPC.notes.facts('501', ['finished'])")
        check('another script asking: no second read', S['reads'] == ['501'] and f['finished'] == ['discharged'], S['reads'])
        f = await pg.evaluate("(UPC.notes.addFacts('review', 5, (t) => ({ good: /discharge/i.test(t) ? ['finished'] : [] })), UPC.notes.facts('501', ['review']))")
        check('a kind added later by a script: read once more, then kept', S['reads'] == ['501', '501'] and f['review'] == {'good': ['finished']}, (S['reads'], f))
        await pg.evaluate("UPC.notes.facts('502', ['open'], { draft: true })")
        await pg.evaluate("UPC.notes.saveFacts()")
        shared = ' '.join(n['html'] for v in S['notes'].values() for n in v)
        check('saved to the shared note, with no note text', 'UPC shared list: Note wording' in shared and '501' in shared and 'knee' not in shared and 'Subjective' not in shared, shared[:400])
        await ctx.close()

        S['reads'].clear()
        ctx, pg = await pc(browser)
        f = await pg.evaluate("(UPC.notes.addFacts('review', 5, (t) => ({ good: [] })), Promise.all([UPC.notes.facts('501', ['finished', 'open', 'review']), UPC.notes.facts('502', ['open'])]))")
        check('another PC: facts from the shared note, nothing read', S['reads'] == [] and f[0]['finished'] == ['discharged'] and f[0]['review'] == {'good': ['finished']} and f[1]['open'] == ['see as needed'], (S['reads'], f))
        await pg.evaluate("(() => { const m = JSON.parse(localStorage.getItem('upc-notefacts:map')); m['502'].at -= 2 * 864e5; m['501'].at -= 2 * 864e5; localStorage.setItem('upc-notefacts:map', JSON.stringify(m)); })()")
        await pg.evaluate("Promise.all([UPC.notes.facts('501', ['open']), UPC.notes.facts('502', ['open'])])")
        check('a draft is read again after a day; a published note isn\'t', S['reads'] == ['502'], S['reads'])
        await pg.evaluate("(UPC.notes.addFacts('review', 6, (t) => ({ good: [] })), UPC.notes.facts('501', ['review']))")
        check('a newer version of a kind: read again', S['reads'] == ['502', '501'], S['reads'])
        await ctx.close()
        await browser.close()
    print('\n' + ('All passed' if not FAILS else '%d failed' % len(FAILS)))
    sys.exit(1 if FAILS else 0)


asyncio.run(main())
