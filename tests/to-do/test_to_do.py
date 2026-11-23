"""
To do, against a mock Halaxy (invented tasks). Clock: 16:00 on Monday 23-Nov-2026 (UK).

Checks: Schedule > To do with a badge for overdue and today's tasks; the signed-in person's open tasks grouped Overdue,
Today, This week, Later, No date (completed ones and other people's left out); Done asks first, then uses Halaxy's
Mark as completed and its Complete link; Tomorrow saves the Edit task form with only the due date changed; ticking
rows and "Move to Monday"; New task linked to a patient (Halaxy's patient search), for the chosen person, with a
stamped comment, through Halaxy's add-task form; a card for each list page this person can open, with its count and
top rows, and none for lists they can't open; Halaxy look.

Run:  python3 tests/to-do/test_to_do.py
"""
import asyncio, datetime, json, re, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text().replace('perMinute: 45,', 'perMinute: 100000,')
SCRIPT = (ROOT / 'beta' / 'to-do.user.js').read_text()
NOW = datetime.datetime(2026, 11, 23, 16, 0, tzinfo=datetime.timezone.utc)
FAILS = []
S = {}


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:700]))
    if not ok:
        FAILS.append(name)


def task(i, title, due, status, who=('Carl Healy',), typ='', pri='Low'):
    return {'id': i, 'title': title, 'comment': '', 'priority': pri, 'due_date': due, 'status': status, 'assignees': list(who), 'type': typ, 'created_by': 'Roxanna Healy'}


TASKS = [task(1, 'Bank transfer', '2021-04-13T00:00:00+01:00', 'Overdue'), task(2, 'Call insurer', '2026-11-23T10:00:00+00:00', 'Pending', typ='Patient', pri='High'),
         task(3, 'Send report', '2026-11-26T00:00:00+00:00', 'Pending', typ='Invoice'), task(4, 'Renew licence', '2026-12-10T00:00:00+00:00', 'Pending', typ='Organisation'),
         task(5, 'Tidy files', '', 'Pending'), task(6, 'Old done', '2026-11-01T00:00:00+00:00', 'Completed'), task(7, 'Not mine', '2026-11-23T00:00:00+00:00', 'Pending', who=('Wendy Pritchard',))]


def edit_form(tid, title='Task'):
    return ("<form name='form' id='form_task_edit'><input name='form[title]' value='%s'><select name='form[taskTemplates]'><option value=''></option></select>"
            "<input type='radio' name='form[actionerType]' value='1' checked><select multiple name='form[linkPrGs][]'><option value='11' selected>Carl Healy</option><option value='12'>Wendy Pritchard</option></select>"
            "<input type='radio' name='form[priority]' value='1' checked><input type='radio' name='form[priority]' value='2'><input type='radio' name='form[priority]' value='3'>"
            "<input name='form[displayDueDate]' value='13-Apr-2021'><select name='form[displayDueTime][hour]'><option value='0' selected>00</option></select><select name='form[displayDueTime][minute]'><option value='0' selected>00</option></select>"
            "<input type='hidden' name='form[isTimeSet]' value='false'><textarea name='form[comment]'>2026-11-01 10:00 RH\n- note</textarea><input type='hidden' name='form[_token]' value='tt'>"
            "<a class='ajax btn' href='/a/pr/555/task/%s/complete'>Mark as completed</a></form>") % (title, tid)


def page_html():
    return ("<!doctype html><html><head><title>Tasks | Halaxy</title></head><body style='margin:0 0 0 230px'>"
            "<div style='position:fixed;left:0;top:0;bottom:0;width:218px'><nav><ul id='mainMenu'>"
            "<li class='mainmenu-item'><a class='mainmenu-link'><span class='mainmenu-link-label'>Schedule</span></a><ul><li><a class='mainmenu-sublink' href='/a/pr/555/calendar'>Calendar</a></li>"
            "<li><a class='mainmenu-sublink' href='/a/pr/555/task/'>Tasks &amp; Follow-Ups</a></li></ul></li>"
            "<li class='mainmenu-item'><a class='mainmenu-link'><span class='mainmenu-link-label'>Finances</span></a><ul><li><a class='mainmenu-sublink' href='/a/pr/555/invoice/'>Invoices</a></li>"
            "<li><a class='mainmenu-sublink upc-rtb-menu' href='/a/pr/555/invoice/#upc-ready-to-bill'>Ready to bill</a></li></ul></li></ul></nav></div>"
            "<div id='headerWrapper' style='height:50px'></div><div id='pageContent'><h1>Tasks</h1></div>"
            "<script>window.HkUser = { linkPrG: 11, pracID: 11, pracName: 'Carl Healy' }; window.Hk = { jwt: 'j' };</script></body></html>")


async def halaxy(route):
    req = route.request
    u = urllib.parse.urlparse(req.url)
    p = u.path
    js = lambda o: route.fulfill(body=json.dumps(o), content_type='application/json')
    form = urllib.parse.parse_qsl(req.post_data or '', keep_blank_values=True) if req.method == 'POST' else []
    if p == '/a/pr/555/task/data':
        S['reads'] += 1
        return await js(TASKS)
    m = re.match(r'^/a/pr/555/task/(\d+)/complete/(\w+)$', p)
    if m:
        S['completed'].append(int(m.group(1)))
        return await js({'status': 'REFRESH'})
    m = re.match(r'^/a/pr/555/task/(\d+)/complete$', p)
    if m:
        return await js({'status': 'FORM', 'title': 'Task Completion', 'message': "<div class='row'>Are you sure?</div><button class='btn btn-cancel'>Cancel</button><a class='btn btn-primary ajax' href='/a/pr/555/task/%s/complete/abc123'>Complete</a>" % m.group(1)})
    m = re.match(r'^/a/pr/555/task/(new(?:/linkPaG/\d+)?|\d+)$', p)
    if m:
        if req.method == 'GET':
            return await js({'status': 'FORM', 'title': 'Edit task', 'message': edit_form(m.group(1), 'New' if m.group(1).startswith('new') else 'Task %s' % m.group(1))})
        S['posts'].append((m.group(1), form))
        return await js({'status': 'REFRESH'})
    if p == '/a/magic/lookup/patient':
        return await js({'lookup': [{'id': 9001, 'title': 'John Doe (P-000721) / 21-Aug-1994', 'payload': {'pag': {'id': 663}}}]})
    await route.fulfill(body=page_html(), content_type='text/html')


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        S.update({'reads': 0, 'completed': [], 'posts': []})
        ctx = await browser.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/London')
        await ctx.clock.install(time=NOW.isoformat())
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.add_init_script("localStorage.setItem('upc-todo:ready-to-bill', JSON.stringify({ at: 1, o: { title: 'Ready to bill', cls: 'upc-rtb-menu', href: '/a/pr/555/invoice/#upc-ready-to-bill', count: 4, rows: ['Patient A, Bupa, £ 40.00', 'Patient B, AXA, £ 60.00', 'Patient C, Bupa, £ 1,200.00'] } }));"
                                  "localStorage.setItem('upc-todo:old-balances', JSON.stringify({ at: 1, o: { title: 'Old balances', cls: 'upc-ob-menu', href: '#', count: 9, rows: [] } }));")
        await ctx.add_init_script(CORE)
        await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + SCRIPT + "\n});")
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/task/')
        await pg.wait_for_selector('a.upc-todo-menu', timeout=20000)
        menu = await pg.evaluate("[...document.querySelectorAll('#mainMenu a.mainmenu-sublink')].map((a) => a.childNodes[0].textContent.trim())")
        check('Schedule > To do, after Halaxy\'s own items', menu[:3] == ['Calendar', 'Tasks & Follow-Ups', 'To do'], menu)
        await pg.click('a.upc-todo-menu')
        await pg.wait_for_selector('[data-upc-to-do] [data-upc-list=overdue]', timeout=20000)
        heads = await pg.evaluate("[...document.querySelectorAll('[data-upc-to-do] .card h2')].map((h) => h.textContent)")
        check('my open tasks grouped; completed and other people\'s left out', heads[:5] == ['Overdue (1)', 'Today (1)', 'This week (1)', 'Later (1)', 'No date (1)'], heads)
        badge = await pg.evaluate("(document.querySelector('a.upc-todo-menu .upc-todo-badge') || {}).textContent")
        check('badge: overdue and due today', badge == '2', badge)
        check('a card for each list I can open, with count and top rows; none for lists I can\'t', 'Ready to bill (4)' in heads and 'Old balances (9)' not in heads
              and 'Patient C, Bupa, £ 1,200.00' in await pg.evaluate("document.querySelector('.upc-todo-lists').innerText") and 'and 1 more' in await pg.evaluate("document.querySelector('.upc-todo-lists').innerText"), heads)

        await pg.click("[data-a=done][data-id='2']")
        await pg.wait_for_selector('[data-upc-todo-confirm]')
        conf = await pg.evaluate("document.querySelector('[data-upc-todo-confirm]').innerText")
        check('Done asks first', 'Mark "Call insurer" as completed?' in conf and not S['completed'], conf)
        await pg.click('[data-upc-todo-confirm] [data-c=yes]')
        await pg.click("[data-a=tomorrow][data-id='1']")
        await pg.click('[data-upc-todo-confirm] [data-c=yes]')
        await pg.wait_for_function("document.querySelectorAll('[data-upc-to-do] .upc-ok').length >= 2", timeout=20000)
        check("Done: Halaxy's Mark as completed, then its Complete link", S['completed'] == [2], S['completed'])
        post = dict(S['posts'][0][1]) if S['posts'] else {}
        check('Tomorrow: the Edit task form saved with only the due date changed',
              S['posts'][0][0] == '1' and post.get('form[displayDueDate]') == '24-Nov-2026' and post.get('form[title]') == 'Task 1' and post.get('form[_token]') == 'tt'
              and post.get('form[comment]') == '2026-11-01 10:00 RH\n- note' and ('form[linkPrGs][]', '11') in S['posts'][0][1], S['posts'])

        await pg.check("[data-upc-list=later] tr[data-upc-id='4'] input[data-upc-tick]")
        await pg.click('[data-a=bulk-monday][data-list=later]')
        conf = await pg.evaluate("document.querySelector('[data-upc-todo-confirm]').innerText")
        check('ticked rows: one question', 'Move "Renew licence" to 30-Nov-2026?' in conf, conf)
        await pg.click('[data-upc-todo-confirm] [data-c=yes]')
        await pg.wait_for_function("document.querySelectorAll('[data-upc-to-do] .upc-ok').length >= 3", timeout=20000)
        check('moved to Monday', [x[0] for x in S['posts']] == ['1', '4'] and dict(S['posts'][1][1]).get('form[displayDueDate]') == '30-Nov-2026', S['posts'])

        await pg.click('[data-a=new]')
        await pg.wait_for_selector('[data-upc-todo-new] #upc-tn-title')
        await pg.fill('#upc-tn-title', 'Chase referral letter')
        await pg.select_option('#upc-tn-link', 'patient')
        await pg.fill('#upc-tn-term', 'john')
        await ctx.clock.run_for(600)
        await pg.wait_for_selector('[data-upc-tn-found] [data-pick]')
        await pg.click('[data-upc-tn-found] [data-pick]')
        await pg.select_option('#upc-tn-who', '12')
        await pg.fill('#upc-tn-due', '2026-11-25')
        await pg.select_option('#upc-tn-pri', '3')
        await pg.fill('#upc-tn-comment', 'Ask the GP surgery')
        await pg.click('[data-upc-todo-new] [data-c=yes]')
        await pg.wait_for_function("!document.querySelector('[data-upc-todo-new]')", timeout=20000)
        last = S['posts'][-1]
        f = dict(last[1])
        check('New task: linked to the patient, for the chosen person, priority, due date, stamped comment, through Halaxy\'s form',
              last[0] == 'new/linkPaG/663' and f.get('form[title]') == 'Chase referral letter' and [v for k, v in last[1] if k == 'form[linkPrGs][]'] == ['12']
              and f.get('form[priority]') == '3' and f.get('form[displayDueDate]') == '25-Nov-2026' and re.fullmatch(r'2026-11-23 16:\d\d CH\n- Ask the GP surgery', f.get('form[comment]', '')) is not None, last)
        look = await pg.evaluate("(() => { const r = document.querySelector('[data-upc-to-do]'); return r.classList.contains('upc-native') && !!r.querySelector('.upc-page-bar h1') && r.querySelector('table').className.startsWith('table table-striped table-bordered'); })()")
        check('Halaxy look: title bar, cards, tables', look)
        check('no page errors', not errors, errors)
        await browser.close()
    print('\n' + ('All passed' if not FAILS else '%d failed' % len(FAILS)))
    sys.exit(1 if FAILS else 0)


asyncio.run(main())
