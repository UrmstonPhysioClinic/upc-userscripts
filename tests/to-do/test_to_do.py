"""
To do, against a mock Halaxy (invented tasks). Clock: 16:00 on Monday 23-Nov-2026 (UK).

Checks: Schedule > To do with a badge for overdue and today's tasks; my open tasks grouped Overdue, Today, This week,
Later, No date (completed ones and other people's left out); Done takes effect at once (Halaxy's Mark as completed and
its Complete link) with Undo (Halaxy's Revert); ticked rows moved to a date (the Edit task form saved with only the
due date changed); a task opens in Halaxy's own Edit task pop-up and the list is read again when it closes; New task
finds a patient with Halaxy's search, then opens Halaxy's add-task pop-up for them; filters (for everyone) remembered;
the week view, dragging a task onto a day; a card for each list page I can open, none for lists I can't; Halaxy's
page underneath doesn't scroll; Halaxy look.

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
         task(5, 'Tidy files', '', 'Pending'), task(6, 'Old done', '2026-11-01T00:00:00+00:00', 'Completed'), task(7, 'Not mine', '2026-11-23T00:00:00+00:00', 'Pending', who=('Wendy Pritchard',)),
         task(8, 'Old student task', '2019-01-01T00:00:00+00:00', 'Overdue', who=('Old Student',))]


def edit_form(tid, title='Task'):
    return ("<form name='form' id='form_task_edit'><input name='form[title]' value='%s'><select name='form[taskTemplates]'><option value=''></option></select>"
            "<input type='radio' name='form[actionerType]' value='1' checked><select multiple name='form[linkPrGs][]'><option value='11' selected>Carl Healy</option><option value='12'>Wendy Pritchard</option></select>"
            "<input type='radio' name='form[priority]' value='1' checked><input type='radio' name='form[priority]' value='2'><input type='radio' name='form[priority]' value='3'>"
            "<input name='form[displayDueDate]' value='13-Apr-2021'><select name='form[displayDueTime][hour]'><option value='0' selected>00</option></select><select name='form[displayDueTime][minute]'><option value='0' selected>00</option></select>"
            "<input type='hidden' name='form[isTimeSet]' value='false'><textarea name='form[comment]'>2026-11-01 10:00 RH\n- note</textarea><input type='hidden' name='form[_token]' value='tt'>"
            "<a class='ajax btn' href='/a/pr/555/task/%s/complete'>Mark as completed</a>%s</form>") % (title, tid, LINKS.get(str(tid), ''))


# What tasks are linked to, as their Edit pop-up shows it (capture 24 Nov 2026: a plain link to the record).
LINKS = {'2': "<div class='col'><a href='/a/pr/555/patient/602'>Patient Two</a></div>", '3': "<div class='col'><a href='/a/pr/555/invoice/703'>Invoice UPC-012235</a></div>"}


def page_html():
    return ("<!doctype html><html><head><title>Tasks | Halaxy</title></head><body style='margin:0 0 0 230px'>"
            "<div style='position:fixed;left:0;top:0;bottom:0;width:218px'><nav><ul id='mainMenu'>"
            "<li class='mainmenu-item'><a class='mainmenu-link'><span class='mainmenu-link-label'>Schedule</span></a><ul><li><a class='mainmenu-sublink' href='/a/pr/555/calendar'>Calendar</a></li>"
            "<li><a class='mainmenu-sublink' href='/a/pr/555/task/'>Tasks &amp; Follow-Ups</a></li></ul></li>"
            "<li class='mainmenu-item'><a class='mainmenu-link'><span class='mainmenu-link-label'>Finances</span></a><ul><li><a class='mainmenu-sublink' href='/a/pr/555/invoice/'>Invoices</a></li>"
            "<li><a class='mainmenu-sublink upc-rtb-menu' href='/a/pr/555/invoice/#upc-ready-to-bill'>Ready to Bill</a></li></ul></li></ul></nav></div>"
            "<div id='headerWrapper' style='height:50px'><div id='alertHeader' class='alertIconsContainer'><div id='alertIncomingMessages' class='headIcon'><style>a.alertIcon[data-count]::after{content:attr(data-count);position:absolute;top:-12px;right:0;height:20px;font-size:12px;background-color:rgb(150,150,150)}</style><a id='btn-alert-incoming-messages' class='fa-stack alertIcon' href='javascript:' title='Inbox' data-count='12'><i class='icon-inbox icon'></i></a></div>"
            "<div class='alertPopoverInner'><div class='teasers'><div id='alertTeaser_9' class='viewTeaser alertType-task-due'><p><a href='/a/pr/555/task/4'>Renew licence</a> for <a href='/a/pr/555/organisation/804'>Org Four</a></p></div></div></div><div id='alertNotifications' class='headIcon'><style>#btn-alert-notifications{position:relative;display:inline-block;width:30px;height:30px;line-height:30px;font-size:15px}#btn-alert-notifications i{display:inline-block;width:18px;height:18px}#btn-alert-notifications[data-count]::after{content:attr(data-count);position:absolute;top:-3px;right:-5px;min-width:14px;height:14px;font-size:9px;line-height:14px;border-radius:7px;background-color:rgb(10,20,30);color:rgb(250,250,250)}</style><a id='btn-alert-notifications' class='fa-stack alertIcon' href='javascript:' title='Notifications' data-count='9'><i class='icon-alarm icon'></i></a></div></div></div><div id='pageContent'><h1>Tasks</h1></div>"
            "<script>window.HkUser = { linkPrG: 11, pracID: 11, pracName: 'Carl Healy' }; window.Hk = { jwt: 'j' };"
            "window.popups = []; document.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a.ajax'); if (!a) return; e.preventDefault();"
            " window.popups.push(a.getAttribute('href')); const d = document.createElement('div'); d.className = 'bootbox modal'; d.textContent = 'Halaxy pop-up'; document.body.appendChild(d); });</script>"
            "<div style='height:3000px'></div></body></html>")


# The week's calendar (Monday 23 Nov 2026 onwards, Unix seconds): practitioner 11 is the signed-in user.
def calendar_events():
    mon = int(datetime.datetime(2026, 11, 23, 9, 0).timestamp())
    ev = lambda d, h, prac, st='': {'id': 800 + d * 10 + h, 'type': 'appointment', 'linkPaGId': 1, 'practitionerID': prac, 'appointmentStatus': st, 'start': mon + d * 86400 + h * 3600, 'end': mon + d * 86400 + h * 3600 + 1800}
    return [ev(0, 0, 11), ev(0, 1, 11), ev(0, 2, 11, 'cancelled'), ev(0, 3, 22), ev(1, 0, 11), ev(1, 1, 11, 'did-not-attend'), ev(3, 0, 11), ev(3, 1, 11), ev(3, 2, 11)]


async def halaxy(route):
    req = route.request
    u = urllib.parse.urlparse(req.url)
    p = u.path
    js = lambda o: route.fulfill(body=json.dumps(o), content_type='application/json')
    form = urllib.parse.parse_qsl(req.post_data or '', keep_blank_values=True) if req.method == 'POST' else []
    if p == '/a/pr/555/task/data':
        S['reads'] += 1
        return await js(TASKS)
    if p == '/a/pr/555/lookup/practitioner':
        return await js([{'id': 11, 'name': 'Carl Healy'}, {'id': 22, 'name': 'Prac Two'}])
    if p == '/a/pr/555/calendar/json':
        S['calendar'] = S.get('calendar', 0) + 1
        return await js({'payload': {'events': calendar_events()}})
    m = re.match(r'^/a/pr/555/task/(\d+)/revert/(\w+)$', p)
    if m:
        S['reverted'].append(int(m.group(1)))
        return await js({'status': 'REFRESH', 'message': '/a/pr/555/task/'})
    m = re.match(r'^/a/pr/555/task/(\d+)/revert$', p)
    if m:
        return await js({'status': 'FORM', 'title': 'Revert Task', 'message': "<button class='btn btn-cancel'>Cancel</button><a class='btn ajax' href='/a/pr/555/task/%s/revert/def456'>Revert</a>" % m.group(1)})
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
            S.setdefault('popups', []).append(m.group(1))
            return await js({'status': 'FORM', 'title': 'Edit task', 'message': edit_form(m.group(1), 'New' if m.group(1).startswith('new') else 'Task %s' % m.group(1))})
        S['posts'].append((m.group(1), form))
        return await js({'status': 'REFRESH'})
    if p == '/a/magic/lookup/patient':
        return await js({'lookup': [{'id': 9001, 'title': 'John Doe (P-000721) / 21-Aug-1994', 'payload': {'pag': {'id': 663}}}]})
    html = page_html()
    if S.get('admin'):
        html = html.replace('linkPrG: 11, pracID: 11', 'linkPrG: 99, pracID: 99')
    await route.fulfill(body=html, content_type='text/html')


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        S.update({'reads': 0, 'completed': [], 'reverted': [], 'posts': []})
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
        check('Schedule > To do, after Halaxy\'s own items', menu[:3] == ['Calendar', 'Tasks & Follow-Ups', 'To Do'], menu)
        await pg.click('a.upc-todo-menu')
        await pg.wait_for_selector('[data-upc-to-do] [data-upc-list=overdue]', timeout=20000)
        heads = await pg.evaluate("[...document.querySelectorAll('[data-upc-to-do] .card h2')].map((h) => h.textContent)")
        check('my open tasks grouped; completed and other people\'s left out', heads[:5] == ['Overdue (1)', 'Today (1)', 'This Week (1)', 'Later (1)', 'No Date (1)'], heads)
        badge = await pg.evaluate("(document.querySelector('a.upc-todo-menu .upc-todo-badge') || {}).textContent")
        check('badge: overdue and due today', badge == '2', badge)
        head = await pg.evaluate("""(() => { const a = document.querySelector('#alertHeader a.upc-todo-head'); const inbox = document.getElementById('alertIncomingMessages');
          return a && [a.getAttribute('href'), a.title, (a.querySelector('.upc-todo-headcount') || {}).textContent, getComputedStyle(inbox).display, a.parentElement.nextElementSibling.id, !!a.querySelector('svg')]; })()""")
        check('top bar: To do in place of the Inbox (hidden), opening To do, with the same count; drawn icon when Halaxy\'s font has none', head == ['/a/pr/555/task/#upc-to-do', 'To do', badge, 'none', 'alertIncomingMessages', True], (head, badge))
        look = await pg.evaluate("""(() => { const el = document.querySelector('#alertHeader a.upc-todo-head .upc-todo-headcount'), b = getComputedStyle(el);
          const bell = document.getElementById('btn-alert-notifications'), bi = bell.querySelector('i').getBoundingClientRect(), br = bell.getBoundingClientRect(), a = getComputedStyle(bell, '::after');
          const r = el.getBoundingClientRect(), oi = document.querySelector('#alertHeader a.upc-todo-head i, #alertHeader a.upc-todo-head svg').getBoundingClientRect();
          return [b.height, b.fontSize, b.backgroundColor, b.boxSizing, Math.round(r.top - oi.top) === Math.round(br.top + parseFloat(a.top) - bi.top), Math.round(r.left - oi.left) === Math.round(br.left + parseFloat(a.left) - bi.left)]; })()""")
        check("the top bar count looks like the bell's (not the Inbox's), at the same place on its icon", look == ['14px', '9px', 'rgb(10, 20, 30)', 'content-box', True, True], look)
        await pg.wait_for_function("[...document.querySelectorAll('[data-upc-link] a')].length === 3", timeout=20000)
        linked = await pg.evaluate("Object.fromEntries([...document.querySelectorAll('[data-upc-link]')].map((e) => [e.dataset.upcLink, [e.textContent, (e.querySelector('a') || {}).getAttribute && e.querySelector('a').getAttribute('href'), (e.querySelector('a') || {}).target]]))")
        check('Linked to: the record by name, opening in a new tab', linked == {'2': ['Patient Two', '/a/pr/555/patient/602', '_blank'], '3': ['Invoice UPC-012235', '/a/pr/555/invoice/703', '_blank'], '4': ['Org Four', '/a/pr/555/organisation/804', '_blank']}, linked)
        check("read from each linked task's Edit pop-up once, one in the bell's list taken from there; unlinked tasks not read", sorted(x for x in S.get('popups', []) if x != 'new') == ['2', '3'], S.get('popups'))
        check('a card for each list I can open, with count and top rows; none for lists I can\'t', 'Ready to Bill (4)' in heads and 'Old Balances (9)' not in heads
              and 'Patient C, Bupa, £ 1,200.00' in await pg.evaluate("document.querySelector('.upc-todo-side').innerText") and 'and 1 more' in await pg.evaluate("document.querySelector('.upc-todo-side').innerText"), heads)

        check("Halaxy's page underneath doesn't scroll", await pg.evaluate("document.documentElement.style.overflow") == 'hidden')
        await pg.click("[data-a=done][data-id='2']")
        await pg.wait_for_function("document.querySelector('.upc-toast .upc-toast-act')", timeout=10000)
        await pg.wait_for_function("[...document.querySelectorAll('[data-upc-to-do] .upc-pill')].some((x) => x.textContent === 'Completed')", timeout=20000)
        check('a completed row: a pill and its own Undo', await pg.evaluate("!!document.querySelector(\"[data-a=undo1][data-id='2']\")"))
        check("Done at once, no question: Halaxy's Mark as completed, then its Complete link", S['completed'] == [2] and not await pg.evaluate("!!document.querySelector('[data-upc-todo-confirm]')"), S['completed'])
        check('Undo offered in a toast, not a bar across the page', await pg.evaluate("document.querySelector('.upc-toast').textContent") == 'Marked as completed: "Call insurer". Undo' and not await pg.evaluate("!!document.querySelector('[data-upc-to-do] .alert-success')"), await pg.evaluate("document.querySelector('.upc-toast').textContent"))
        await pg.click('.upc-toast .upc-toast-act')
        await pg.wait_for_function("document.querySelector(\"[data-a=done][data-id='2']\")", timeout=20000)
        check("Undo: Halaxy's Revert", S['reverted'] == [2], S['reverted'])

        await pg.check("[data-upc-list=later] tr[data-upc-id='4'] input[data-upc-tick]")
        await pg.fill("input[data-upc-move=later]", '2026-11-27')
        await pg.wait_for_function("document.querySelector('.upc-toast')", timeout=10000)
        await pg.wait_for_function("[...document.querySelectorAll('[data-upc-to-do] .upc-pill')].some((x) => x.textContent === 'Moved to 27-Nov-2026')", timeout=20000)
        check('the toast stays once the batch is done (closes later)', await pg.evaluate("!!document.querySelector('.upc-toast')"))
        post = dict(S['posts'][0][1]) if S['posts'] else {}
        check('ticked rows moved to a date: the Edit task form saved with only the due date changed',
              S['posts'][0][0] == '4' and post.get('form[displayDueDate]') == '27-Nov-2026' and post.get('form[title]') == 'Task 4' and post.get('form[_token]') == 'tt'
              and post.get('form[comment]') == '2026-11-01 10:00 RH\n- note' and ('form[linkPrGs][]', '11') in S['posts'][0][1], S['posts'])
        check('a moved task stays where it was (Later, not This week), with its Undo beside Done',
              await pg.evaluate("(() => { const r = document.querySelector(\"[data-upc-list=later] tr[data-upc-id='4']\"); return !!r && !!r.querySelector('[data-a=undo1]') && !!r.querySelector('[data-a=done]'); })()"))
        await pg.click("[data-a=undo1][data-id='4']")
        await pg.wait_for_function("!document.querySelector(\"[data-a=undo1][data-id='4']\") && document.querySelector(\"[data-a=done][data-id='4']\")", timeout=20000)
        check("a moved row's own Undo puts its date back", len(S['posts']) == 2 and dict(S['posts'][1][1]).get('form[displayDueDate]') == '10-Dec-2026', S['posts'][1:])

        n = S['reads']
        await pg.click("[data-upc-list=overdue] a[data-a=edit][data-id='1']")
        await pg.wait_for_function("window.popups.length === 1")
        pop = await pg.evaluate("window.popups[0]")
        await pg.evaluate("document.querySelector('.bootbox').remove()")
        await pg.wait_for_function("!document.querySelector('[data-upc-halaxy-popup]')", timeout=10000)
        await pg.wait_for_timeout(1500)
        check("a task opens in Halaxy's own Edit task pop-up; read again when it closes", pop.endswith('/a/pr/555/task/1') and S['reads'] > n, (pop, S['reads'], n))

        await pg.click('[data-a=new]')
        await pg.wait_for_selector('[data-upc-todo-new] #upc-tn-link')
        await pg.select_option('#upc-tn-link', 'patient')
        await pg.fill('#upc-tn-term', 'john')
        await ctx.clock.run_for(600)
        await pg.wait_for_selector('[data-upc-tn-found] [data-i]')
        await pg.keyboard.press('Enter')
        picked = await pg.evaluate("document.querySelector('#upc-tn-term').value")
        await pg.click('[data-upc-todo-new] [data-c=yes]')
        await pg.wait_for_function("window.popups.length === 2")
        pop = await pg.evaluate("window.popups[1]")
        check("New task: the patient found with Halaxy's search (dropdown, Enter picks), then Halaxy's add-task pop-up for them", pop.endswith('/a/pr/555/task/new/linkPaG/663') and picked.startswith('John Doe'), (pop, picked))
        await pg.evaluate("document.querySelector('.bootbox').remove()")

        await pg.select_option('select[data-f=who]', 'all')
        heads = await pg.evaluate("[...document.querySelectorAll('[data-upc-to-do] .card h2')].map((h) => h.textContent)")
        has_for = await pg.evaluate("[...document.querySelectorAll('[data-upc-list=today] th')].map((t) => t.textContent.trim()).includes('For')")
        check("for everyone: other people's tasks and a For column", 'Today (2)' in heads and has_for, heads)
        await pg.reload()
        await pg.wait_for_selector('[data-upc-to-do] [data-upc-list=overdue]', timeout=20000)
        check('filters remembered', await pg.evaluate("document.querySelector('select[data-f=who]').value") == 'all')
        opts = await pg.evaluate("[...document.querySelectorAll('select[data-f=who] option')].map((o) => o.textContent)")
        check("'For' lists Halaxy's active users only, not people named on old tasks", opts == ['For me', 'For Wendy Pritchard', 'For everyone'], opts)

        await pg.click('[data-a=view][data-view=week]')
        await pg.wait_for_selector('.upc-todo-week')
        days = await pg.evaluate("[...document.querySelectorAll('.upc-todo-week .card h2')].map((h) => h.textContent)")
        check('week view: a tray, then Monday to Friday', len(days) == 6 and days[1].startswith('Monday 23-Nov') and days[5].startswith('Friday 27-Nov'), days)
        await pg.wait_for_selector('.upc-todo-week .upc-todo-appts', timeout=10000)
        appts = await pg.evaluate("[...document.querySelectorAll('.upc-todo-week .upc-todo-drop')].map((c) => ((c.querySelector('.card-body > .upc-todo-appts:first-child') || {}).textContent || '').trim())")
        check("each day: my appointments (not cancelled, not did-not-attend, not someone else's)", appts == ['2 appointments', '1 appointment', 'No appointments', '3 appointments', 'No appointments'], appts)
        edge = await pg.evaluate("getComputedStyle(document.querySelector('.upc-todo-week .upc-todo-chip')).boxShadow")
        check('week tasks have the card headers\' purple left edge (inset 4px #994DE6)', 'rgb(153, 77, 230)' in edge and 'inset' in edge and '4px 0px 0px' in edge, edge)
        nposts = len(S['posts'])
        await pg.drag_and_drop("[data-chip='3']", ".upc-todo-drop[data-day]:nth-child(3)")
        await pg.wait_for_function("document.querySelector('.upc-toast')", timeout=10000)
        await pg.wait_for_timeout(2500)
        check('a task dragged onto Tuesday is moved there', len(S['posts']) == nposts + 1 and dict(S['posts'][-1][1]).get('form[displayDueDate]') == '24-Nov-2026', S['posts'][nposts:])
        # A save in one of Halaxy's pop-ups reloads the page, keeping the address: Week view and the week stay, and the
        # tasks are read afresh (CH, 24 Nov 2026).
        await pg.click('[data-a=week][data-step="1"]')
        reads = S['reads']
        await pg.evaluate("sessionStorage.setItem('upc-halaxy-popup', JSON.stringify({ at: Date.now(), from: '#upc-to-do' }))")
        S['admin'] = True   # the next page is an administrator's: not one of the practitioners
        await pg.reload()
        await pg.wait_for_selector('.upc-todo-week', timeout=20000)
        await pg.wait_for_timeout(800)
        wk = await pg.evaluate("[document.querySelector('.nav-link.active').textContent, document.querySelector('.upc-todo-weeknav .text-muted').textContent]")
        check('after the reload: still Week view, the same week', wk == ['Week', '30-Nov-2026 to 04-Dec-2026'], wk)
        await pg.wait_for_timeout(1500)
        check('an administrator (not a practitioner) sees no appointment counts', not await pg.evaluate("!!document.querySelector('.upc-todo-appts')"))
        check('after the reload: the tasks read afresh', S['reads'] > reads, (reads, S['reads']))
        check('after the reload: links known already, not read again', [x for x in S.get('popups', []) if x in ('2', '3')].count('2') == 1, S.get('popups'))
        look = await pg.evaluate("(() => { const r = document.querySelector('[data-upc-to-do]'); return r.classList.contains('upc-native') && !!r.querySelector('.upc-page-bar h1') && !!r.querySelector('.card .card-header h2') && !r.shadowRoot; })()")
        check('Halaxy look: title bar, cards', look)
        check('no page errors', not errors, errors)
        await browser.close()
    print('\n' + ('All passed' if not FAILS else '%d failed' % len(FAILS)))
    sys.exit(1 if FAILS else 0)


asyncio.run(main())
