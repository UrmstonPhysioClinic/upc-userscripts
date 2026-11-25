"""
Test for the Appointment recorder, against a mock Halaxy note page and recordings organisation, with a fake microphone
(invented devices, a recorder that makes small Ogg chunks, a level the test sets). Clock: 25-Nov-2026 10:00, fake.

Checks: the note page gets a strip above the editor (microphone list, Start Appointment); Start opens the recorder window,
which asks for the saved microphone in mono and records Ogg; chunks are saved on this PC every 5 seconds; the strip shows
the time, the level as bars and Finish Appointment; another note's page says another appointment is being recorded;
the microphone list leaves out "Monitor of" devices, and changing it starts a new part on that microphone; 30 seconds
of silence shows "No sound"; Finish stops it, the window closes, and each part is attached to the organisation, titled
"Recording 2026-11-25 10:00 CH" (" part 2"), never with a name, with the recorder's comment; the strip then offers
Continue Recording and Download Recording; Patients > Recordings lists it; a window closed mid-recording is marked
stopped and its part still goes to Halaxy; copies older than 2 days are deleted through Halaxy's Delete pop-up, only the
recorder's own; recordings older than 14 days leave the PC.

The Heidi step, against a mock Heidi (its test labels as on the real one, its answers from a mock API): after Finish the
recorder window goes to Heidi, which gets the recording as one Ogg file, starts a new session, uploads it and waits for
Heidi's completed note; the note goes into the empty note (the editor covered meanwhile), the window closes, and Undo
takes it out again. Heidi refusing the file is said on the note with Send to Heidi; sending again into a note with text
asks, and Add Below puts it after the text. A note left before Heidi finishes (the clinician moved on in Halaxy) is
opened in a new tab and the note put in there.

Run:  python3 tests/appointment-recorder/test_appointment_recorder.py
"""
import asyncio, datetime, json, re, subprocess, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests'))
from fakeclock import until, idle, run  # noqa: E402

HERE = Path(__file__).resolve().parent
if not (HERE / 'node_modules' / 'opus-recorder').exists():
    subprocess.run(['npm', 'install', '--no-audit', '--no-fund', '--no-package-lock', '--silent'], cwd=HERE, check=True)
ENCODER = (HERE / 'node_modules' / 'opus-recorder' / 'dist' / 'encoderWorker.min.js').read_bytes()
CORE = (ROOT / 'beta' / 'core.user.js').read_text().replace('perMinute: 45,', 'perMinute: 100000,')
# A session's hour warning and two-hour stop, shortened to 2 and 3 minutes so the test can reach them.
SCRIPT = (ROOT / 'beta' / 'appointment-recorder.user.js').read_text()
assert 'warnMs: 75 * 60e3, maxMs: 2 * 3600e3' in SCRIPT
SCRIPT = SCRIPT.replace('warnMs: 75 * 60e3, maxMs: 2 * 3600e3', 'warnMs: 120e3, maxMs: 180e3')
NOW = datetime.datetime(2026, 11, 25, 10, 0, tzinfo=datetime.timezone.utc)
FAILS = []
S = {'files': [], 'uploads': [], 'deleted': [], 'heidi': [], 'refuse': False, 'slow': False, 'landing': 'fresh'}


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:700]))
    if not ok:
        FAILS.append(name)


# The fake microphone, in every page and in the recorder window.
FAKE_MIC = r"""
(() => {
  window.__mic = { level: 0.4, calls: [], recorders: [], streams: [] };
  const DEVS = [
    { deviceId: 'mic-a', groupId: 'g1', kind: 'audioinput', label: 'Desk Microphone' },
    { deviceId: 'mic-b', groupId: 'g2', kind: 'audioinput', label: 'USB Microphone' },
    { deviceId: 'mon', groupId: 'g3', kind: 'audioinput', label: 'Monitor of Built-in Audio' },
    { deviceId: 'spk', groupId: 'g4', kind: 'audiooutput', label: 'Speakers' },
  ];
  class Track { constructor(d) { this.d = d; this.label = d.label; this.kind = 'audio'; } getSettings() { return { deviceId: this.d.deviceId, channelCount: 1 }; } stop() { this.stopped = true; } }
  class Stream { constructor(d) { this.t = [new Track(d)]; } getAudioTracks() { return this.t; } getTracks() { return this.t; } }
  const md = navigator.mediaDevices || {};
  md.getUserMedia = async (c) => {
    window.__mic.calls.push(JSON.parse(JSON.stringify(c)));
    const want = c.audio && c.audio.deviceId && c.audio.deviceId.exact;
    const d = want ? DEVS.find((x) => x.deviceId === want) : DEVS[0];
    if (!d) { const e = new Error('not found'); e.name = 'OverconstrainedError'; throw e; }
    const s = new Stream(d);
    window.__mic.streams.push(s);
    return s;
  };
  md.enumerateDevices = async () => DEVS.map((d) => Object.assign({}, d));
  class Recorder extends EventTarget {
    static isTypeSupported(t) { return /ogg/.test(t); }
    constructor(s, o) { super(); this.stream = s; this.mimeType = o.mimeType; this.bits = o.audioBitsPerSecond; this.state = 'inactive'; window.__mic.recorders.push(this); }
    emit() { const b = new Blob(['OggS' + 'x'.repeat(2000)], { type: 'audio/ogg' }); if (this.ondataavailable) this.ondataavailable({ data: b }); }
    start(ms) { this.state = 'recording'; this.timer = setInterval(() => this.emit(), ms); }
    requestData() { this.emit(); }
    stop() { clearInterval(this.timer); this.emit(); this.state = 'inactive'; setTimeout(() => this.dispatchEvent(new Event('stop')), 10); }
  }
  window.MediaRecorder = Recorder;
  window.AudioContext = class {
    constructor() { this.state = 'running'; this.sampleRate = 48000; }
    createAnalyser() {
      return { fftSize: 1024, smoothingTimeConstant: 0, get frequencyBinCount() { return this.fftSize / 2; },
        getFloatFrequencyData(a) { const l = window.__mic.level; for (let i = 0; i < a.length; i++) a[i] = l > 0 ? -90 + 55 * l * (0.6 + 0.4 * Math.sin(i)) : -140; },
        getFloatTimeDomainData(a) { const l = window.__mic.level; for (let i = 0; i < a.length; i++) a[i] = (i % 2 ? 1 : -1) * l * 0.5; } };
    }
    createMediaStreamSource(s) { return { s, connect() {}, disconnect() { this.gone = true; } }; }
    createMediaStreamDestination() { return { stream: new Stream({ deviceId: 'mix', label: 'mix' }) }; }
    close() { this.state = 'closed'; }
    resume() { this.state = 'running'; return Promise.resolve(); }
  };
})();
"""

MENU = ("<div id='mainMenu'><ul><li class='mainmenu-item'><a class='mainmenu-link'><span class='mainmenu-link-label'>Patients</span></a>"
        "<ul><li><a class='mainmenu-sublink' href='/a/pr/555/patient/'>Patient List</a></li></ul></li></ul></div>")
# A stand-in for Halaxy's CKEditor: the parts the recorder uses (getData, data.processor.toView, data.toModel,
# model.change with setSelection, insertContent, execute('undo')), keeping the note as HTML.
FAKE_EDITOR = r"""
window.fakeEditor = function (html) {
  const ed = { content: html, isReadOnly: false, undos: [], ui: { view: {} },
    getData() { return ed.content; },
    data: { get: () => ed.content, processor: { toView: (h) => ({ view: h }) }, toModel: (v) => ({ model: v.view }) },
    model: { document: { getRoot: () => ({ root: true }) },
      change(fn) { const w = { sel: 'end', createRangeIn: () => ({ all: true }), setSelection(a, b) { w.sel = a && a.all ? 'all' : b === 'end' ? 'end' : 'other'; } }; ed.w = w; fn(w); },
      insertContent(frag) { ed.undos.push(ed.content); ed.content = ed.w.sel === 'all' ? frag.model : ed.content + frag.model; } },
    execute(cmd) { if (cmd === 'undo' && ed.undos.length) ed.content = ed.undos.pop(); } };
  return ed;
};
"""
NOTES = {7003: '<p>Existing text</p>'}


def note_page(n):
    return ("<!doctype html><html><head><title>Clinical note | Halaxy</title><style>.halaxy-own { color: red; }</style></head><body class='vs-theme-default'>" + MENU +
            "<div id='headerWrapper'></div><div id='content'><h2>Clinical Note</h2><div class='note-area'><div class='ck ck-editor'><div class='ck-editor__main'>"
            "<div class='ck-editor__editable' contenteditable='true'></div></div></div></div></div>"
            "<script>window.HkUser = { pracName: 'Cara Hale', pracID: 11 }; window.Hk = { jwt: 'jwt-test' };" + FAKE_EDITOR +
            "document.querySelector('.ck-editor__editable').ckeditorInstance = fakeEditor(%s);</script></body></html>") % json.dumps(NOTES.get(n, ''))


# A mock Heidi: the elements the step uses, with Heidi's test labels; its upload and consult-note requests go to the
# mock API below. Its note is drawn as Heidi draws it (bold, underlined heading this time).
HEIDI_PAGE = r"""<!doctype html><html><head><title>Heidi</title></head><body><div id='app'></div><script>
const app = document.getElementById('app');
let n = 0;
function topBar() { return "<button data-testid='session-toolbar-cta-main'>New session</button>"; }
let empty = false;
let plain = false;   // the menu without its test label (found by its name)   // as on Heidi: New session does nothing on a session with nothing recorded
function bindNew() { app.querySelector('[data-testid=session-toolbar-cta-main]').onclick = () => { if (empty) return; n++; history.pushState(null, '', '/en/scribe/sessions/1234567890123456789012345' + n); session(); }; }
function today() { const d = new Date(); const h = d.getHours(); return 'Today ' + String(h % 12 || 12).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + (h < 12 ? ' AM' : ' PM'); }
function home() { app.innerHTML = topBar() + "<button data-testid='resume-recording-button'>Resume</button><button data-testid='start-recording-dropdown'>v</button><div class='tiptap ProseMirror'><p>Someone else's old session</p></div>"; bindNew(); }
function session() {
  empty = true;
  app.innerHTML = topBar() + "<button type='button'>" + today() + "</button><button data-testid='start-recording-button'>Transcribe</button><button " + (plain ? "" : "data-testid='start-recording-dropdown' ") + "aria-label='Open transcription mode menu'>v</button><div id='menu'></div><div id='dlg'></div><div class='tiptap ProseMirror' id='ed'></div>";
  bindNew();
  app.querySelector('[aria-label="Open transcription mode menu"]').addEventListener('pointerdown', () => {
    const m = document.getElementById('menu');
    m.innerHTML = "<div role='menuitem' data-testid='start-recording-dropdown-upload'>Upload session audio</div>";
    m.firstChild.addEventListener('click', () => { m.innerHTML = ''; const d = document.getElementById('dlg'); d.innerHTML = "<input type='file' data-testid='upload-audio-file-input-input' accept='.ogg,audio/ogg'>"; d.firstChild.addEventListener('change', upload); });
  });
}
function upload(e) {
  empty = false;
  const f = e.target.files[0];
  const sid = location.pathname.split('/').pop();
  const x = new XMLHttpRequest();
  x.open('GET', 'https://uk.api.heidihealth.com/api/test/refuse');
  x.onload = () => {
    if (x.responseText === 'yes') { document.getElementById('dlg').innerHTML = '<p>Unsupported file type</p>'; return; }
    const fd = new FormData(); fd.append('upload_file', f); fd.append('starttime', 'now');
    const u = new XMLHttpRequest(); u.open('POST', 'https://uk.api.heidihealth.com/api/v1/ml-scribe/sessions/' + sid + '/upload-audio'); u.onload = () => poll(sid); u.send(fd);
  };
  x.send();
}
function poll(sid) {
  const x = new XMLHttpRequest();
  x.open('GET', 'https://uk.api.heidihealth.com/api/v2/ml-scribe/sessions/' + sid + '/consult-note');
  x.onload = () => { const c = JSON.parse(x.responseText).consult_notes[0]; if (c.status === 'COMPLETED') document.getElementById('ed').innerHTML = "<p data-x='1'><strong><u>Subjective:</u></strong></p><p class='y'>- Knee pain</p>"; else setTimeout(() => poll(sid), 1000); };
  x.send();
}
// Heidi often opens on a new, empty session of its own (after a moment); the test says which.
const lx = new XMLHttpRequest();
lx.open('GET', 'https://uk.api.heidihealth.com/api/test/landing');
lx.onload = () => { plain = /plain/.test(lx.responseText); if (/fresh/.test(lx.responseText)) setTimeout(() => { n++; history.replaceState(null, '', '/en/scribe/sessions/1234567890123456789012345' + n); session(); }, 700); };
lx.send();
home();
</script></body></html>"""
NOTE_IN = '<p><strong><u>Subjective:</u></strong></p><p>- Knee pain</p>'
LIST_PAGE = ("<!doctype html><html><head><title>Patients | Halaxy</title></head><body>" + MENU +
             "<div id='headerWrapper'></div><div id='content'>Patient list</div><script>window.HkUser = { pracName: 'Cara Hale' }; window.Hk = { jwt: 'jwt-test' };</script></body></html>")
ATTACH_POPUP = ("<form name='form' method='post' id='fileupload' class='js-file-edit-form' data-upload-url='/api/v2/practitioner/file/upload/files?_locale=1'>"
                "<input type='hidden' name='form[_token]' value='tok-up'></form>")


async def halaxy(route):
    req = route.request
    u = urllib.parse.urlparse(req.url)
    path = u.path
    form = dict(urllib.parse.parse_qsl(req.post_data or '')) if req.method == 'POST' and 'urlencoded' in (req.headers.get('content-type') or '') else {}

    async def js(o):
        await route.fulfill(body=json.dumps(o), content_type='application/json')

    if re.search(r'^/a/pr/555/organisation/78972/?$', path):
        cards = ''.join("<div class='card attachment-file-card' data-href='/a/file/get/f%d.ogg'>%s</div><div class='dropdown-menu'><a data-modal-href='/a/pr/555/file/edit/%d'>Edit</a>"
                        "<a class='dropdown-item ajax text-danger' href='/a/pr/555/file/delete/%d' title='Delete this file'>Delete</a></div>" % (f['id'], f['title'], f['id'], f['id']) for f in reversed(S['files']))
        return await route.fulfill(body="<html><body><div class='card'><div class='card-header'><h2>Attachments</h2></div>%s</div></body></html>" % cards, content_type='text/html')
    if path.endswith('/file/upload/organisation/78972'):
        if req.method == 'GET':
            return await js({'status': 'FORM', 'message': ATTACH_POPUP})
        fid = 800 + len(S['files']) + len(S['deleted'])
        S['files'].append({'id': fid, 'title': form['form[files][1][title]'], 'comments': form['form[files][1][comments]']})
        return await js({'status': 'REFRESH'})
    if path.endswith('/practitioner/file/upload/files'):
        body = (req.post_data_buffer or b'').decode('latin-1')
        m = re.search(r'filename="([^"]+)"\r\nContent-Type: ([^\r]+)', body)
        S['uploads'].append({'name': m.group(1) if m else None, 'type': m.group(2) if m else None, 'auth': req.headers.get('authorization'), 'size': len(body)})
        return await js({'files': [{'id': '9%03d' % len(S['uploads'])}]})
    m = re.search(r'/file/edit/(\d+)$', path)
    if m:
        f = next(f for f in S['files'] if f['id'] == int(m.group(1)))
        return await js({'status': 'FORM', 'message': "<form id='fileupload'><div data-href='/a/file/get/f%d.ogg'></div><input name='form[title]' value='%s'><textarea name='form[comments]'>%s</textarea>"
                         "<input type='hidden' name='form[_token]' value='tf'></form>" % (f['id'], f['title'], f['comments'])})
    m = re.search(r'/file/delete/(\d+)(/([a-z0-9]+))?$', path)
    if m:
        fid = int(m.group(1))
        if not m.group(2):
            return await js({'status': 'FORM', 'message': "<p>Delete this file?</p><a class='btn btn-outline-primary btn-cancel' href='/a/pr/555/patient/1'>Cancel</a>"
                             "<a class='btn btn-outline-danger ajax' href='/a/pr/555/file/delete/%d/abc123'>Delete</a>" % fid})
        S['deleted'].append(fid)
        S['files'] = [f for f in S['files'] if f['id'] != fid]
        return await js({'status': 'REFRESH'})
    m = re.search(r'^/a/pr/555/note/(\d+)$', path)
    if m:
        n = int(m.group(1))
        return await js({'id': n, 'content': '<p>Not read</p>', 'patient': {'name': 'Patient %d' % (n + 2000), 'linkPaGId': n + 2000},
                         'notePractitionerName': 'Practitioner One', 'assignedPractitionerName': 'Practitioner Two', 'date': {'date': '25-Nov-2026', 'time': '09:55'}})
    m = re.search(r'/clinical/category/note/id/(\d+)', path)
    if m:
        return await route.fulfill(body=note_page(int(m.group(1))), content_type='text/html')
    await route.fulfill(body=LIST_PAGE, content_type='text/html')


async def heidi_api(route):
    req = route.request
    path = urllib.parse.urlparse(req.url).path
    cors = {'Access-Control-Allow-Origin': '*'}
    if path == '/api/test/landing':
        return await route.fulfill(body=S['landing'], headers=cors)
    if path == '/api/test/refuse':
        return await route.fulfill(body='yes' if S['refuse'] else 'no', headers=cors)
    if path.endswith('/upload-audio'):
        body = (req.post_data_buffer or b'').decode('latin-1')
        m = re.search(r'filename="([^"]+)"\r\nContent-Type: ([^\r]+)', body)
        S['heidi'].append({'name': m.group(1) if m else None, 'type': m.group(2) if m else None, 'size': len(body), 'sid': path.split('/')[-2]})
        return await route.fulfill(body='true', content_type='application/json', headers=cors)
    if path.endswith('/consult-note'):
        done = not S['slow']
        c = {'id': 'c1', 'status': 'COMPLETED' if done else 'CREATED', 'note': '**Subjective:**\n- Knee pain' if done else '', 'content_type': 'MARKDOWN'}
        return await route.fulfill(body=json.dumps({'consult_notes': [c]}), content_type='application/json', headers=cors)
    await route.fulfill(status=404, body='', headers=cors)


async def _true(v):
    return v


async def _state_is(pg, rid, state):
    h = await heidi_state(pg, rid)
    return bool(h) and h.get('state') == state


async def _text_has(pg, rid, text):
    h = await heidi_state(pg, rid)
    return bool(h) and text in (h.get('text') or '')


async def heidi_state(pg, rid):
    return await pg.evaluate("(id) => JSON.parse(localStorage.getItem('upc-rec:heidi:' + id) || 'null')", rid)


async def until_py(pg, fn, timeout=60, what=''):
    """Move the fake clock on until the Python check is true."""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while True:
        v = await fn()
        if v:
            return v
        if loop.time() > end:
            raise TimeoutError('not true: ' + what)
        try:
            await idle(pg, 500)
        except Exception as e:
            if 'closed' not in str(e).lower():
                raise
            await asyncio.sleep(0.1)


async def closed(pg, win, timeout=30):
    """Move the fake clock on until the recorder window has closed itself (moving the clock while it closes may fail)."""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not win.is_closed():
        if loop.time() > end:
            raise TimeoutError('the recorder window is still open')
        try:
            await idle(pg, 500)
        except Exception as e:
            if 'closed' not in str(e).lower():
                raise
            await asyncio.sleep(0.1)


async def files_until(pg, n, timeout=60):
    """Move the fake clock on until the organisation has n files."""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while len(S['files']) < n:
        if loop.time() > end:
            raise TimeoutError('only %d files' % len(S['files']))
        await idle(pg, 1000)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={'width': 1300, 'height': 900}, timezone_id='Europe/London')
        await ctx.clock.install(time=NOW.isoformat())
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.route('https://cdn.jsdelivr.net/npm/opus-recorder@8.0.5/dist/encoderWorker.min.js', lambda r: r.fulfill(body=ENCODER, content_type='application/javascript'))
        await ctx.route('https://scribe.heidihealth.com/**', lambda r: r.fulfill(body=HEIDI_PAGE, content_type='text/html'))
        await ctx.route('https://uk.api.heidihealth.com/**', heidi_api)
        await ctx.add_init_script(FAKE_MIC)
        # Halaxy pages only (the recorder window is a blank page the scripts don't run in, as on the PCs).
        await ctx.add_init_script("if (location.href.indexOf('https://eu.halaxy.com/a/pr/') === 0) {\n" + CORE + "\n}")
        await ctx.add_init_script("if (location.href.indexOf('https://eu.halaxy.com/a/pr/') === 0) document.addEventListener('DOMContentLoaded', function () {\n" + SCRIPT + "\n});")
        await ctx.add_init_script("if (location.hostname === 'scribe.heidihealth.com') {\n" + SCRIPT + "\n}")   # at the page's start, as the loader runs it
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/9001/clinical/category/note/id/7001')
        await until(pg, "!!document.querySelector('.upc-rec-strip [data-a=start]')")
        place = await pg.evaluate("(() => { const s = document.querySelector('.upc-rec-strip'); return [s.nextElementSibling.className, s.textContent.trim(), [...s.querySelectorAll('select option')].map((o) => o.textContent)]; })()")
        check('note page: a strip just above the editor with a microphone list and Start Appointment', place[0] == 'ck ck-editor' and 'Start Appointment' in place[1] and place[2] == ['Default microphone'], place)

        # ---- Start
        await pg.evaluate("localStorage.setItem('upc-rec:mic', JSON.stringify({ id: 'mic-a', label: 'Desk Microphone' }))")
        # A window of the recorder's name left on Heidi (up to 0.3.2 the recorder window went there; CH, 25 Nov 2026: Start then did nothing)
        await pg.evaluate("window.open('https://scribe.heidihealth.com/', 'upc-recorder', 'popup=yes,width=540,height=460'); 0")
        await until_py(pg, lambda: _true(any('heidihealth' in x.url for x in ctx.pages)), what='the old window on Heidi')
        await pg.click('.upc-rec-strip [data-a=start]')
        await idle(pg, 1000)
        pop = [x for x in ctx.pages if x is not pg][0]
        await until(pg, "!!document.querySelector('.upc-rec-strip [data-a=finish]')", timeout=30)
        check('Start works even with a window of the recorder\'s name left on Heidi: it is brought back and used', len(ctx.pages) == 2 and pop.url.startswith('https://eu.halaxy.com/'), [x.url for x in ctx.pages])
        pop_errors = []
        pop.on('pageerror', lambda e: pop_errors.append(str(e)))
        await until(pg, "!!document.querySelector('.upc-rec-strip [data-a=finish]')")
        win = await pop.evaluate("[document.querySelector('.upc-rec-window h1').textContent, __mic.calls[0], __mic.recorders[0].mimeType, __mic.recorders[0].bits, !!document.querySelector('style') && [...document.querySelectorAll('style')].some((s) => s.textContent.includes('halaxy-own')), document.body.className, location.pathname + location.hash, document.querySelector('.upc-rec-window .upc-page-sub').textContent]")
        check('Start opens the recorder window: Halaxy\'s styles copied in, title Appointment Recording, the note\'s patient and practitioner', win[0] == 'Appointment Recording' and win[4] and 'vs-theme-default' in win[5] and win[7] == 'Patient 9001, Practitioner One, started 10:00', win)
        check('it asks for the saved microphone, in mono', win[1]['audio'].get('deviceId') == {'exact': 'mic-a'} and win[1]['audio'].get('channelCount') == 1, win[1])
        check('it records Opus in Ogg at 16 kbit/s, from the AudioContext (so the microphone can change in the same file)', win[2] == 'audio/ogg;codecs=opus' and win[3] == 16000
              and await pop.evaluate("__mic.recorders[0].stream.t[0].d.deviceId === 'mix'"), win[2:4])
        check('reloading the window would open the recordings organisation, not the note', win[6] == '/a/pr/555/organisation/78972#upc-recorder-reloaded', win[6])

        await idle(pg, 12000)
        saved = await pg.evaluate("upcAppointmentRecorder.db.recs().then((r) => r.map((x) => [x.noteId, x.patientId, x.patient, x.practitioner, x.noteDate, x.by, x.status, x.parts.map((p) => [p.n, p.chunks, p.mic, p.ext])]))")
        check('chunks are saved on this PC every 5 seconds, with the note\'s patient, practitioner and date', saved and saved[0][:7] == ['7001', '9001', 'Patient 9001', 'Practitioner One', '25-Nov-2026 09:55', 'Cara Hale', 'recording']
              and saved[0][7][0][1] >= 2 and saved[0][7][0][2] == 'Desk Microphone', saved)
        st = await pg.evaluate("(() => { const s = document.querySelector('.upc-rec-strip'); return [s.querySelector('[data-upc-rec-time]').textContent, [...s.querySelectorAll('.upc-rec-bars > span')].map((b) => [b.className, parseInt(b.style.height)]), [...s.querySelectorAll('select option')].map((o) => o.textContent), s.querySelector('select').value]; })()")
        check('the strip shows the time, the level as bars and the microphone', re.match(r'^00:1\d$', st[0]) and len(st[1]) == 7 and all(c == 'bg-success' and h > 4 for c, h in st[1]) and st[3] == 'mic-a', st)
        check('the microphone list leaves out "Monitor of" devices and speakers', st[2] == ['Desk Microphone', 'USB Microphone'], st[2])

        other = await ctx.new_page()
        await other.goto('https://eu.halaxy.com/a/pr/555/patient/9002/clinical/category/note/id/7002')
        await until(other, "!!document.querySelector('.upc-rec-strip') && /Another appointment/.test(document.querySelector('.upc-rec-strip').textContent)")
        check('another note\'s page: says another appointment is being recorded, with Show Recorder', await other.evaluate("!document.querySelector('.upc-rec-strip [data-a=start]') && !!document.querySelector('.upc-rec-strip [data-a=show]')"))
        # Two more Halaxy tabs stay open, as on the PCs: every tab hears "finished" at once (CH, 25 Nov 2026: copies attached twice)
        await other.goto('https://eu.halaxy.com/a/pr/555/patient/')
        third = await ctx.new_page()
        await third.goto('https://eu.halaxy.com/a/pr/555/patient/9002/clinical/category/note/id/7002')
        await until(third, "!!document.querySelector('.upc-rec-strip')")
        await pg.bring_to_front()

        # ---- change the microphone
        await pg.select_option('.upc-rec-strip select', 'mic-b')
        await until(pg, "upcAppointmentRecorder.db.recs().then((r) => r[0].parts[0].mic === 'USB Microphone')")
        await idle(pg, 6000)
        sw = await pop.evaluate("[__mic.calls.length, __mic.calls[1].audio.deviceId, __mic.streams[0].t[0].stopped, __mic.recorders.length, __mic.recorders[0].state]")
        one = await pg.evaluate("upcAppointmentRecorder.db.recs().then((r) => [r[0].parts.length, r[0].parts[0].mics, r[0].parts[0].endedAt])")
        sel = await pg.evaluate("document.querySelector('.upc-rec-strip select').value")
        check('changing the microphone carries on in the same file on that microphone', sw == [2, {'exact': 'mic-b'}, True, 1, 'recording'] and one == [1, ['Desk Microphone', 'USB Microphone'], None] and sel == 'mic-b', (sw, one, sel))

        # ---- silence
        await pop.evaluate("__mic.level = 0")
        await idle(pg, 31000)
        q = await pg.evaluate("[document.querySelector('.upc-rec-strip').textContent.includes('No sound'), [...document.querySelectorAll('.upc-rec-strip .upc-rec-bars > span')].every((b) => b.className === 'bg-warning')]")
        qw = await pop.evaluate("!!document.querySelector('.upc-rec-window .alert-warning')")
        check('30 seconds of silence: "No sound" and amber bars, on the note and in the window', q == [True, True] and qw, (q, qw))
        await pop.evaluate("__mic.level = 0.5")
        await idle(pg, 2000)
        check('sound again: the warning goes', not await pg.evaluate("document.querySelector('.upc-rec-strip').textContent.includes('No sound')"))

        # ---- Finish, then the Heidi step
        rid = await pg.evaluate("upcAppointmentRecorder.db.recs().then((r) => r[0].id)")
        await pg.evaluate("window.coverSeen = []; new MutationObserver(() => { const c = document.querySelector('.ck-editor > .upc-rec-cover'); if (c) coverSeen.push(c.textContent); }).observe(document.body, { childList: true, subtree: true, characterData: true })")
        await pg.evaluate("window.__opens = []; const o = window.open; window.open = function (u, n, f) { __opens.push([u, n, f]); return o.apply(this, arguments); }; 0")
        await pg.click('.upc-rec-strip [data-a=finish]')
        opens = await pg.evaluate("__opens")
        check('Finish opens Heidi in a full-size window of its own, from the press itself (Firefox may not resize the small one)',
              opens[:1] == [['', 'upc-heidi', 'popup=yes,width=1100,height=820']], opens)
        await until(pg, "upcAppointmentRecorder.db.recs().then((r) => r[0].status === 'finished')")
        await closed(pg, pop)
        await until_py(pg, lambda: heidi_state(pg, rid), what='the Heidi step starts')
        await until_py(pg, lambda: _state_is(pg, rid, 'done'), what='Heidi\'s note in')
        await until_py(pg, lambda: _true(not any('heidihealth' in x.url for x in ctx.pages)), what='the Heidi window closes')
        content = await pg.evaluate("document.querySelector('.ck-editor__editable').ckeditorInstance.getData()")
        check('the recorder window closes; Heidi gets the recording as one Ogg file and uploads it in the new, empty session Heidi opens',
              len(S['heidi']) == 1 and S['heidi'][0]['sid'].endswith('51') and S['heidi'][0]['name'] == 'recording-25-Nov-2026-1000.ogg' and S['heidi'][0]['type'] == 'audio/ogg', S['heidi'])
        check('Heidi\'s completed note goes into the empty note as Heidi drew it (tidied), and the Heidi window closes', content == NOTE_IN, content)
        seen = await pg.evaluate("[...new Set(coverSeen)]")
        check('the note was covered meanwhile, with Cancel, saying what is happening', any('Waiting for Heidi' in x or 'Sending to Heidi' in x for x in seen) and all('Cancel' in x for x in seen), seen)
        st = await pg.evaluate("(() => { const s = document.querySelector('.upc-rec-strip'); return [s.textContent, !!document.querySelector('.ck-editor > .upc-rec-cover'), [...document.querySelectorAll('.upc-toast')].map((x) => x.textContent)]; })()")
        check('afterwards: no cover, "Heidi\'s note added" on the strip, and a toast with Undo', "Heidi's note added" in st[0] and not st[1] and any(x.startswith("Heidi's note added.") and 'Undo' in x for x in st[2]), st)
        kept = await pg.evaluate("upcAppointmentRecorder.db.recs().then((r) => r.find((x) => x.noteId === '7001').heidiNote === undefined)")
        check('Heidi\'s note is not kept on the PC once it is in', kept)
        await pg.click('.upc-toast .upc-toast-act')
        check('Undo takes it out again', await pg.evaluate("document.querySelector('.ck-editor__editable').ckeditorInstance.getData()") == '')
        await files_until(pg, 1)
        files = [(f['title'], f['comments'][:46]) for f in S['files']]
        check('the recording is attached to the recordings organisation as one file, titled by time, patient, practitioner and note, with the recorder\'s comment',
              files == [('Recording 25-Nov-2026 10:00, Patient 9001, Practitioner One, note 7001', 'Appointment recorder; note 7001; patient 9001;')], files)
        ups = S['uploads']
        check('the file is Ogg audio, uploaded with Halaxy\'s token, named without the patient', len(ups) == 1 and ups[0]['name'] == 'recording-25-Nov-2026-1000.ogg'
              and ups[0]['type'] == 'audio/ogg' and ups[0]['auth'] == 'Bearer jwt-test', ups)
        await until(pg, "/In Halaxy/.test(document.querySelector('.upc-rec-strip').textContent)")
        done = await pg.evaluate("(() => { const s = document.querySelector('.upc-rec-strip'); return [s.querySelector('[data-a=start]').textContent.trim(), !!s.querySelector('[data-a=download]'), s.textContent]; })()")
        check('afterwards the strip offers Continue Recording and Download Recording, with the copy in Halaxy', done[0] == 'Continue Recording' and done[1] and re.search(r'Recorded \d\d:\d\d', done[2]) is not None, done)
        await idle(pg, 20000)
        check('nothing is attached twice, with three Halaxy tabs open', len(S['files']) == 1 and len(S['uploads']) == 1, S['files'])
        check('nor sent to Heidi twice', len(S['heidi']) == 1, S['heidi'])
        await third.close()
        await other.close()

        # ---- Patients > Recordings
        lst = await ctx.new_page()
        await lst.goto('https://eu.halaxy.com/a/pr/555/patient/#upc-recordings')
        await until(lst, "!!document.querySelector('[data-upc-page] table[data-upc-list=upc-recordings] tbody tr')")
        row = await lst.evaluate("(() => { const tr = document.querySelector('[data-upc-page] tbody tr'); return [[...tr.cells].map((c) => c.textContent.trim()), tr.querySelector('a').getAttribute('href'), document.querySelector('a.upc-rec-menu') && document.querySelector('a.upc-rec-menu').textContent]; })()")
        check('Patients > Recordings lists it: patient, practitioner, the note\'s date as its link, its copy in Halaxy, Heidi', row[0][:8] == ['25-Nov-2026 10:00', row[0][1], 'Patient 9001', 'Practitioner One', '25-Nov-2026', 'In Halaxy', "Heidi's note added", '09-Dec-2026']
              and row[1] == '/a/pr/555/patient/9001/clinical/category/note/id/7001' and row[2] == 'Recordings', row)
        await lst.close()

        # ---- a window closed mid-recording
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/9003/clinical/category/note/id/7003')
        await until(pg, "!!document.querySelector('.upc-rec-strip [data-a=start]')")
        await pg.click('.upc-rec-strip [data-a=start]')
        await until(pg, "!!document.querySelector('.upc-rec-strip [data-a=finish]')")
        pop2 = [x for x in ctx.pages if x is not pg][0]
        await idle(pg, 11000)
        await pop2.close(run_before_unload=False)
        await idle(pg, 80000)
        await until(pg, "upcAppointmentRecorder.db.recs().then((r) => r.find((x) => x.noteId === '7003').status === 'stopped')")
        await until(pg, "/Window closed/.test(document.querySelector('.upc-rec-strip').textContent) && !!document.querySelector('.upc-rec-strip [data-a=start]')")
        await files_until(pg, 2)
        stopped = [f['title'] for f in S['files']]
        check('a window closed mid-recording: marked stopped, Continue Recording offered, and its part still goes to Halaxy', len(stopped) == 2 and stopped[1].endswith(', note 7003'), stopped)
        rid3 = await pg.evaluate("upcAppointmentRecorder.db.recs().then((r) => r.find((x) => x.noteId === '7003').id)")
        check('a stopped recording isn\'t sent to Heidi by itself: Send to Heidi on the strip', await heidi_state(pg, rid3) is None and await pg.evaluate("!!document.querySelector('.upc-rec-strip [data-a=heidi]')"))
        S['refuse'] = True
        S['landing'] = 'home'
        await pg.click('.upc-rec-strip [data-a=heidi]')
        await until_py(pg, lambda: _state_is(pg, rid3, 'failed'), what='Heidi refuses')
        hw = [x for x in ctx.pages if x is not pg][0]
        st = await pg.evaluate("document.querySelector('.upc-rec-strip').textContent")
        check('Heidi refusing the file: "Not sent to Heidi" on the note with why, and Send to Heidi again', 'Not sent to Heidi' in st and 'Unsupported file type' in st and await pg.evaluate("!!document.querySelector('.upc-rec-strip [data-a=heidi]')"), st)
        S['refuse'] = False
        S['landing'] = 'fresh'
        await pg.click('.upc-rec-strip [data-a=heidi]')
        await until(pg, "!!document.querySelector('.upc-dialog[data-upc-dialog=upc-rec-heidi-how]')", timeout=60)
        ask = await pg.evaluate("[...document.querySelectorAll('.upc-dialog [data-how]')].map((b) => b.textContent)")
        check('sending again into a note with text asks: Cancel, Add Below, Replace', ask == ['Cancel', 'Add Below', 'Replace'], ask)
        await pg.click('.upc-dialog [data-how=end]')
        await until_py(pg, lambda: _state_is(pg, rid3, 'done'), what='added below')
        content = await pg.evaluate("document.querySelector('.ck-editor__editable').ckeditorInstance.getData()")
        check('Add Below puts Heidi\'s note after the text already there', content == '<p>Existing text</p>' + NOTE_IN, content)
        await closed(pg, hw)

        # ---- a session left running: a warning after 75 minutes, finished after two hours (2 and 3 minutes here)
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/9004/clinical/category/note/id/7004')
        await until(pg, "!!document.querySelector('.upc-rec-strip [data-a=start]')")
        await pg.click('.upc-rec-strip [data-a=start]')
        await until(pg, "!!document.querySelector('.upc-rec-strip [data-a=finish]')")
        pop3 = [x for x in ctx.pages if x is not pg][0]
        await idle(pg, 122000)
        check('a session left running: "Still recording after 2 minutes" (75 on the PCs) on the note', await pg.evaluate("/Still recording after 2 minutes/.test(document.querySelector('.upc-rec-strip').textContent)"))
        S['slow'] = True   # Heidi takes its time, and the clinician moves on in Halaxy meanwhile
        S['landing'] = 'fresh-plain'   # and its menu has no test label this time
        await idle(pg, 60000)
        rid4 = await pg.evaluate("upcAppointmentRecorder.db.recs().then((r) => r.find((x) => x.noteId === '7004').id)")
        await until_py(pg, lambda: _text_has(pg, rid4, 'Waiting for Heidi'), what='Heidi working')
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/')
        await idle(pg, 20000)
        S['slow'] = False
        await until_py(pg, lambda: _true(any('/note/id/7004' in x.url for x in ctx.pages if x is not pg)), what='the note opened in a new tab')
        nt = [x for x in ctx.pages if '/note/id/7004' in x.url and x is not pg][0]
        # Playwright doesn't run init scripts in a tab opened by window.open (Tampermonkey does), so load it again.
        await nt.wait_for_load_state()
        await nt.reload()
        await until_py(pg, lambda: _state_is(pg, rid4, 'done'), what='note 7004 done')
        content = await nt.evaluate("document.querySelector('.ck-editor__editable').ckeditorInstance.getData()")
        check('moved on before Heidi finished: the note opens in a new tab and Heidi\'s note goes in there', content == NOTE_IN, content)
        await closed(pg, pop3)
        await until_py(pg, lambda: _true(not any('heidihealth' in x.url for x in ctx.pages)), what='the Heidi window closes')
        await nt.close()
        auto = await pg.evaluate("upcAppointmentRecorder.db.recs().then((r) => { const x = r.find((y) => y.noteId === '7004'); return [x.status, x.stopped]; })")
        check('and finished by itself after two hours', auto[0] == 'finished' and str(auto[1]).startswith('Stopped after'), auto)
        await files_until(pg, 3)


        # ---- a recording in two parts: Download gives one file
        js_join = """async () => {
          const enc = await fetch('https://cdn.jsdelivr.net/npm/opus-recorder@8.0.5/dist/encoderWorker.min.js').then((r) => r.text());
          const make = (secs) => new Promise((ok) => {
            const w = new Worker(URL.createObjectURL(new Blob([enc], { type: 'text/javascript' })));
            const pages = [];
            w.onmessage = (e) => {
              const d = e.data || {};
              if (d.message === 'ready') {
                w.postMessage({ command: 'getHeaderPages' });
                const n = secs * 16000;
                for (let i = 0; i < n; i += 4096) { const c = new Float32Array(4096); for (let k = 0; k < 4096; k++) c[k] = 0.3 * Math.sin(2 * Math.PI * 440 * (i + k) / 16000); w.postMessage({ command: 'encode', buffers: [c] }); }
                w.postMessage({ command: 'done' });
              } else if (d.message === 'page') pages.push(d.page);
              else if (d.message === 'done') { w.terminate(); ok(new Blob(pages, { type: 'audio/ogg' })); }
            };
            w.postMessage({ command: 'init', encoderSampleRate: 16000, originalSampleRate: 16000, numberOfChannels: 1, encoderApplication: 2048, encoderBitRate: 16000 });
          });
          const A = upcAppointmentRecorder;
          const a = await make(2), b = await make(3);
          const t0 = Date.now();
          const rec = { id: 'rjoin', noteId: '7009', patientId: '9009', patient: 'Patient 9009', practitioner: 'Practitioner One', startedAt: t0, status: 'stopped', beat: t0, parts: [
            { n: 1, mime: 'audio/ogg', ext: 'ogg', startedAt: t0, endedAt: t0 + 2000, chunks: 1, bytes: a.size },
            { n: 2, mime: 'audio/ogg', ext: 'ogg', startedAt: t0 + 5000, endedAt: t0 + 8000, chunks: 1, bytes: b.size }] };
          await A.db.addChunk('rjoin', 1, 0, a);
          await A.db.addChunk('rjoin', 2, 0, b);
          await A.db.putRec(rec);
          const one = await A.joined(rec);
          const head = new Uint8Array(await one.slice(0, 4).arrayBuffer());
          const back = await new OfflineAudioContext(1, 16000, 16000).decodeAudioData(await one.arrayBuffer());
          return [String.fromCharCode(...head), Math.round(back.duration * 10) / 10, one.type, A.fileName(rec, null)];
        }"""
        jr = await pg.evaluate(js_join)
        check('a recording in two parts is joined into one Ogg file holding both (2 s and 3 s)', jr[0] == 'OggS' and 4.9 <= jr[1] <= 6.2 and jr[2] == 'audio/ogg' and jr[3].endswith('.ogg'), jr)

        # ---- copies older than 2 days
        S['files'].insert(0, {'id': 701, 'title': 'Recording 2026-11-20 09:00 DL', 'comments': 'Appointment recorder; note 1; patient 2; 30:00, 09:00 to 09:30'})
        S['files'].insert(0, {'id': 702, 'title': 'Recording 2026-11-20 09:00 notes', 'comments': 'Something CH attached by hand'})
        S['files'].insert(0, {'id': 703, 'title': 'Insurer letter', 'comments': ''})
        S['files'].insert(0, {'id': 704, 'title': 'Recording 21-Nov-2026 11:00, Patient 9010, Practitioner Two, note 7010', 'comments': 'Appointment recorder; note 7010; patient 9010; 45:00, 11:00 to 11:45'})
        await pg.mouse.move(10, 10)
        await pg.mouse.move(20, 20)
        await pg.evaluate("localStorage.removeItem('upc-rec:cleanAt')")
        await run(pg, "upcAppointmentRecorder.cleanHalaxy()")
        left = sorted(f['id'] for f in S['files'])
        check('copies older than 2 days are deleted through Halaxy\'s Delete pop-up, only the recorder\'s own (old and new titles)', sorted(S['deleted']) == [701, 704] and 702 in left and 703 in left and {800, 801, 802} <= set(left), (S['deleted'], left))

        # ---- 14 days on this PC
        await pg.clock.fast_forward(15 * 86400 * 1000)
        await pg.evaluate("localStorage.removeItem('upc-rec:localCleanAt')")
        await run(pg, "upcAppointmentRecorder.cleanLocal()")
        n = await pg.evaluate("upcAppointmentRecorder.db.recs().then((r) => r.length)")
        check('recordings older than 14 days leave this PC', n == 0, n)

        # A tab running an older version leaves the work to the newer one.
        await pg.evaluate("new BroadcastChannel('upc-recorder').postMessage({ t: 'ver', v: '9.9.9' })")
        await until(pg, "upcAppointmentRecorder.outdated()")
        n = len(S['uploads'])
        await pg.evaluate("upcAppointmentRecorder.uploads()")
        check('a tab that hears of a newer version leaves uploads and Heidi to it', await pg.evaluate("upcAppointmentRecorder.outdated()") and len(S['uploads']) == n)
        check('no page errors', not errors and not pop_errors, errors + pop_errors)
        await browser.close()
    print('\n' + ('All passed' if not FAILS else '%d failed' % len(FAILS)))
    sys.exit(1 if FAILS else 0)


asyncio.run(main())
