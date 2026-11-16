"""
Test for HTML source for emails: templates chosen in a send box. A stand-in for Halaxy's editor (it strips tables and
styles, as CKEditor does) in a stand-in Send Invoice Email pop-up; choosing a template fetches it from
/communication/template/render/... as Halaxy does (capture 16 Nov 2026).

Checks: a template with tables or styled paragraphs opens in HTML mode exactly as fetched, merge tags kept, and is sent
as written; a letter-style template (coloured spans only) stays in the editor; already in HTML mode, choosing another
styled template replaces the source; editing in the <> view still works as before.

Run:  python3 tests/email-html/test_email_html.py
"""
import asyncio, json, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = (ROOT / 'beta' / 'email-html.user.js').read_text()
FAILS = []

RICH = ('<table width="100%" bgcolor="#ece4f6" style="background-color:#ece4f6;"><tbody><tr><td style="padding:12px;">'
        '<p style="margin:0;">Hi <span class="dynamicterm">[Patient First Name]</span>,</p><p style="margin:0;">Pay: [Payment Link]</p></td></tr></tbody></table>')
RICH2 = '<table bgcolor="#ffffff"><tbody><tr><td style="padding:4px;"><p>Second template</p></td></tr></tbody></table>'
LETTER = '<div class="single-spacing"><span style="color:#7a33c7;"><strong>Hello</strong></span> [Payment Link]</div>'
TEMPLATES = {'1': RICH, '2': LETTER, '3': RICH2}
SENT = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:500]))
    if not ok:
        FAILS.append(name)


PAGE = """<!doctype html><html><head></head><body><div id="pageContent">
<form id="composeEmailForm"><textarea name="form[subject]">Subject</textarea>
<textarea name="form[body]" class="form-control d-none">&lt;p&gt;Hi Patient, here's your receipt&lt;/p&gt;</textarea></form></div></body></html>"""

FAKE_EDITOR = r"""
window.makeEditor = function () {
  const ta = document.querySelector('textarea[name="form[body]"]');
  const root = document.createElement('div');
  root.className = 'ck ck-editor';
  root.innerHTML = '<div class="ck-toolbar"><div class="ck-toolbar__items"></div></div><div class="ck-editor__main"><div class="ck-editor__editable"></div></div>';
  ta.after(root);
  // Like CKEditor: tables and styles on paragraphs and cells don't survive.
  const strip = (h) => h.replace(/<\/?(table|tbody|tr|td)\b[^>]*>/g, '').replace(/<p\b[^>]*>/g, '<p>');
  let data = strip(ta.value);
  const changes = [];
  const ed = { sourceElement: ta, ui: { view: { element: root, toolbar: { element: root.querySelector('.ck-toolbar') } } },
    data: { get: () => data }, model: { document: { on: (ev, f) => changes.push(f) } },
    setData(h) { data = strip(h); changes.forEach((f) => f()); }, on() {}, enableReadOnlyMode() {}, disableReadOnlyMode() {} };
  root.querySelector('.ck-editor__editable').ckeditorInstance = ed;
  window.ed = ed;
};
// Halaxy choosing a template: fetch it filled in, then put it into the editor in its own handler.
window.chooseTemplate = (id) => new Promise((done) => {
  const x = new XMLHttpRequest();
  x.open('GET', '/a/pr/555/communication/template/render/' + id + '/invoice/3001');
  x.onload = () => { const j = JSON.parse(x.responseText); window.ed.setData(j.message); done(); };
  x.send();
});
// Halaxy sending: the form serialised, the body read from the editor.
window.send = () => new Promise((done) => {
  const x = new XMLHttpRequest();
  x.open('POST', '/a/pr/555/email/document/invoice/3001');
  x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  x.onload = done;
  x.send('form%5Bsubject%5D=Subject&form%5Bbody%5D=' + encodeURIComponent(window.ed.data.get()) + '&form%5B_token%5D=t');
});
true;
"""

STATE = """(() => { const p = document.querySelector('.hx-raw-panel'); return { html: !!p && p.style.display !== 'none',
  source: p ? p.querySelector('textarea').value : '' }; })()"""


async def halaxy(route):
    req = route.request
    path = urllib.parse.urlparse(req.url).path
    if '/communication/template/render/' in path:
        tid = path.split('/render/')[1].split('/')[0]
        return await route.fulfill(body=json.dumps({'status': 'OK', 'title': 'Template', 'message': TEMPLATES[tid], 'payload': {'subject': '<p>Subject</p>'}}), content_type='application/json')
    if path.startswith('/a/pr/555/email/'):
        SENT.append(urllib.parse.parse_qs(req.post_data or ''))
        return await route.fulfill(body='{"status":"OK"}', content_type='application/json')
    await route.fulfill(body=PAGE, content_type='text/html')


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context()
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + SCRIPT + "\n});")
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/invoice/3001')
        await pg.evaluate(FAKE_EDITOR)
        await pg.evaluate('makeEditor()')
        await pg.wait_for_timeout(500)
        check('<> button added to the send box editor', await pg.evaluate("!!document.querySelector('.hx-raw-btn')"))

        await pg.evaluate('chooseTemplate(2)')
        await pg.wait_for_timeout(500)
        s = await pg.evaluate(STATE)
        check('letter-style template: stays in the editor', not s['html'], s)

        await pg.evaluate('chooseTemplate(1)')
        await pg.wait_for_timeout(500)
        s = await pg.evaluate(STATE)
        check('styled template: opens in HTML mode exactly as fetched, tags kept',
              s['html'] and 'bgcolor="#ece4f6"' in s['source'] and '<td style="padding:12px;">' in s['source'] and '<span class="dynamicterm">[Patient First Name]</span>' in s['source'] and '[Payment Link]' in s['source'], s)
        await pg.evaluate('send()')
        body = SENT[-1].get('form[body]', [''])[0] if SENT else ''
        check('sent as written, styles and tags kept', 'bgcolor="#ece4f6"' in body and '<p style="margin:0;">' in body and '[Payment Link]' in body, body[:300])

        await pg.evaluate('chooseTemplate(3)')
        await pg.wait_for_timeout(500)
        s = await pg.evaluate(STATE)
        check('another styled template while in HTML mode: replaces the source', s['html'] and 'Second template' in s['source'] and 'ece4f6' not in s['source'] and 'bgcolor="#ffffff"' in s['source'], s)

        await pg.fill('.hx-raw-panel textarea', '<table bgcolor="#000"><tbody><tr><td>Edited by hand</td></tr></tbody></table>')
        await pg.evaluate('send()')
        body = SENT[-1].get('form[body]', [''])[0]
        check('edited in HTML mode: sent as typed', body.startswith('<table bgcolor="#000">') and 'Edited by hand' in body, body)
        check('no page errors', not errors, errors)
        await browser.close()
    print('\n' + ('All passed' if not FAILS else '%d failed' % len(FAILS)))
    sys.exit(1 if FAILS else 0)


asyncio.run(main())
