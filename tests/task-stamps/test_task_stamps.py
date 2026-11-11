"""Task stamps: a mock Halaxy page with the add-task / edit-task pop-up (form#form_task_edit, a plain form[comment]
box, as captured live 11 Nov 2026). Invented content only."""
import asyncio, pathlib, re, sys
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = (ROOT / 'beta' / 'task-stamps.user.js').read_text()
FAILS = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)))
    if not ok:
        FAILS.append(name)

PAGE = """<!doctype html><html><head><meta charset='utf-8'></head><body><button id='activeUser'>Someone Else</button><div id='modals'></div>
<script>
window.HkUser = { pracName: 'Carl Healy' };
window.saved = [];
function popup(value) {
  document.getElementById('modals').innerHTML = "<div class='modal bootbox'><form id='form_task_edit'><input name='form[title]' value='Test task'>" +
    "<textarea class='form-control' name='form[comment]'></textarea><a class='ajax btn btn-outline-primary'>Cancel</a><button type='button' class='btn btn-primary btn-submit'>Save</button></form></div>";
  document.querySelector('textarea').value = value || '';
  document.querySelector('.btn-submit').addEventListener('click', () => { window.saved.push(document.querySelector('textarea').value); });
}
function appointment(value) {
  document.getElementById('modals').innerHTML = "<div class='upc-test-appt'><form id='pr-appointment' class='py-3 px-0'><select name='form[status]'><option>Booked</option></select>" +
    "<textarea class='form-control large' name='form[description]' placeholder='Comments' rows='3'></textarea></form>" +
    "<div class='footer'><button type='button' class='btn btn-primary' id='apptSave'>Save</button></div></div>";
  document.querySelector('textarea').value = value || '';
  document.getElementById('apptSave').addEventListener('click', () => { window.saved.push(document.querySelector('textarea').value); });
}
</script></body></html>"""

STAMP = r'\d{4}-\d{2}-\d{2} \d{2}:\d{2} CH'

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        pg = await browser.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.route('https://eu.halaxy.com/**', lambda r: r.fulfill(body=PAGE, content_type='text/html'))
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/9')
        await pg.add_script_tag(content=SCRIPT)
        val = lambda: pg.evaluate("document.querySelector('textarea').value")

        inits = await pg.evaluate("['Carl Healy', 'Dr Jane Mary Smith', 'Wendy', 'Roxanna (Rox) Healy', ''].map(upcTaskStamps.initials)")
        check('initials: first and last name', inits == ['CH', 'JS', 'W', 'RH', ''], inits)

        # New task: the stamp and a new line
        await pg.evaluate("popup('')")
        await pg.wait_for_timeout(200)
        await pg.click('textarea')
        v = await val()
        check('new task: comment starts with the date, time and initials, then a "- " line', re.fullmatch(STAMP + r'\n- ', v) is not None, repr(v))
        await pg.keyboard.type('Rang the patient')
        await pg.click('.btn-submit')
        s = (await pg.evaluate('saved'))[-1]
        check('typed after the stamp, at the end', re.fullmatch(STAMP + r'\n- Rang the patient', s) is not None, repr(s))

        # Bullets: Enter continues the list, Enter on an empty bullet ends it, Shift+Enter is a plain line, Backspace takes an empty bullet off
        await pg.evaluate("popup('')")
        await pg.wait_for_timeout(200)
        await pg.click('textarea')
        for k in ['First', 'Enter', 'Second', 'Enter', 'Enter', 'Plain line', 'Shift+Enter', 'Still plain']:
            if k in ('Enter', 'Shift+Enter'): await pg.keyboard.press(k)
            else: await pg.keyboard.type(k)
        v = await val()
        check('Enter gives a new "- "; Enter on an empty "- " ends the list; Shift+Enter is a plain new line', re.fullmatch(STAMP + r'\n- First\n- Second\nPlain line\nStill plain', v) is not None, repr(v))
        await pg.keyboard.press('Enter')
        await pg.keyboard.type('2026-11-11 16:30 CH')
        await pg.keyboard.press('Enter')
        await pg.keyboard.type('After my own stamp')
        await pg.keyboard.press('Enter')
        await pg.keyboard.press('Backspace')
        await pg.keyboard.type('x')
        v = await val()
        check('Enter after a typed stamp starts a "- " line; Backspace on an empty "- " takes it off', v.endswith('\n2026-11-11 16:30 CH\n- After my own stamp\nx'), repr(v))
        await pg.keyboard.press('Control+z')
        check('Undo still works', not (await val()).endswith('\nx'), repr(await val()))
        await pg.evaluate("popup('')")
        await pg.wait_for_timeout(200)
        await pg.click('textarea')
        await pg.keyboard.type('One')
        await pg.keyboard.press('Enter')
        await pg.click('.btn-submit')
        s = (await pg.evaluate('saved'))[-1]
        check('an empty "- " left at the end is taken off on Save', re.fullmatch(STAMP + r'\n- One', s) is not None, repr(s))
        # Splitting a bullet in the middle
        await pg.evaluate("popup('')")
        await pg.wait_for_timeout(200)
        await pg.click('textarea')
        await pg.keyboard.type('AlphaBeta')
        for _ in range(4): await pg.keyboard.press('ArrowLeft')
        await pg.keyboard.press('Enter')
        v = await val()
        check('Enter in the middle of a bullet splits it into two bullets', v.endswith('\n- Alpha\n- Beta'), repr(v))

        # Opened and saved without clicking into the box: left exactly as it was
        await pg.evaluate("popup('Some text   ')")
        await pg.wait_for_timeout(200)
        check('not clicked into: nothing added', await val() == 'Some text   ', repr(await val()))
        await pg.click('.btn-submit')
        check('not clicked into: saved exactly as it was', (await pg.evaluate('saved'))[-1] == 'Some text   ')

        # Saved with nothing typed: the empty stamp is taken off
        await pg.evaluate("popup('')")
        await pg.wait_for_timeout(200)
        await pg.click('textarea')
        await pg.click('.btn-submit')
        s = (await pg.evaluate('saved'))[-1]
        check('saved without typing: no empty stamp left', s == '', repr(s))

        # Adding to a task: a blank line and a new stamp under what's there
        await pg.evaluate("popup('2026-11-01 AB: Letter sent')")
        await pg.wait_for_timeout(200)
        await pg.click('textarea')
        v = await val()
        check('existing task: new stamp under the old comment', re.fullmatch(r'2026-11-01 AB: Letter sent\n\n' + STAMP + r'\n- ', v) is not None, repr(v))
        await pg.keyboard.type('Reply received')
        await pg.click('.btn-submit')
        s = (await pg.evaluate('saved'))[-1]
        check('existing task: the new entry saved under the old one', re.fullmatch(r'2026-11-01 AB: Letter sent\n\n' + STAMP + r'\n- Reply received', s) is not None, repr(s))

        # Status change only on an existing task: comment unchanged
        await pg.evaluate("popup('2026-11-01 AB: Letter sent')")
        await pg.wait_for_timeout(200)
        await pg.click('.btn-submit')
        s = (await pg.evaluate('saved'))[-1]
        check('existing task saved without typing: comment as it was', s == '2026-11-01 AB: Letter sent', repr(s))

        # Halaxy redraws the pop-up with what was typed (or a quick second edit): not stamped twice
        await pg.evaluate("popup(arguments[0])".replace('arguments[0]', repr(s + '\n\n' + await pg.evaluate("upcTaskStamps.stamp('CH')") + '\nJust now')))
        await pg.wait_for_timeout(200)
        await pg.click('textarea')
        v = await val()
        check('own stamp from the last few minutes: not stamped again', v.endswith('\nJust now') and len(re.findall(STAMP, v)) == 1, repr(v))

        # An old stamp of mine (an hour ago): stamped again
        await pg.evaluate("popup('2020-01-01 10:00 CH\\n- Old note')")
        await pg.wait_for_timeout(200)
        await pg.click('textarea')
        v = await val()
        check('older own stamp: a new stamp is added', len(re.findall(STAMP, v)) == 2, repr(v))

        # An appointment's Comments in the calendar (Save outside the form, as live)
        await pg.evaluate("appointment('Prefers mornings')")
        await pg.wait_for_timeout(200)
        await pg.click('#apptSave')
        check('appointment opened and saved without touching Comments: unchanged', (await pg.evaluate('saved'))[-1] == 'Prefers mornings')
        await pg.evaluate("appointment('Prefers mornings')")
        await pg.wait_for_timeout(200)
        await pg.click('textarea')
        await pg.keyboard.type('Running late')
        await pg.keyboard.press('Enter')
        await pg.keyboard.type('Rebooked for Friday')
        await pg.keyboard.press('Enter')
        await pg.click('#apptSave')
        s = (await pg.evaluate('saved'))[-1]
        check('appointment Comments: stamped under the old text, bullets, empty bullet taken off on Save', re.fullmatch(r'Prefers mornings\n\n' + STAMP + r'\n- Running late\n- Rebooked for Friday', s) is not None, repr(s))
        await pg.evaluate("appointment('')")
        await pg.wait_for_timeout(200)
        await pg.click('textarea')
        await pg.click('#apptSave')
        check('appointment Comments clicked into but nothing typed: left empty', (await pg.evaluate('saved'))[-1] == '')

        # No name known: left alone
        await pg.evaluate("window.HkUser = {}; document.getElementById('activeUser').textContent = ''; popup('')")
        await pg.wait_for_timeout(200)
        await pg.click('textarea')
        check('no signed-in name: nothing added', await val() == '')

        check('no page errors', not errors, errors)
        await browser.close()
    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
