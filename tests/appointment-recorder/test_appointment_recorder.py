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

Run:  python3 tests/appointment-recorder/test_appointment_recorder.py
"""
import asyncio, datetime, json, re, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests'))
from fakeclock import until, idle, run  # noqa: E402

CORE = (ROOT / 'beta' / 'core.user.js').read_text().replace('perMinute: 45,', 'perMinute: 100000,')
SCRIPT = (ROOT / 'beta' / 'appointment-recorder.user.js').read_text()
NOW = datetime.datetime(2026, 11, 25, 10, 0, tzinfo=datetime.timezone.utc)
FAILS = []
S = {'files': [], 'uploads': [], 'deleted': []}


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:700]))
    if not ok:
        FAILS.append(name)


# The fake microphone, in every page and in the recorder window.
FAKE_MIC = r"""
(() => {
  window.__mic = { level: 0.4, calls: [], recorders: [] };
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
    return new Stream(d);
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
    createMediaStreamSource() { return { connect() {} }; }
    resume() { this.state = 'running'; return Promise.resolve(); }
  };
})();
"""

MENU = ("<div id='mainMenu'><ul><li class='mainmenu-item'><a class='mainmenu-link'><span class='mainmenu-link-label'>Patients</span></a>"
        "<ul><li><a class='mainmenu-sublink' href='/a/pr/555/patient/'>Patient List</a></li></ul></li></ul></div>")
NOTE_PAGE = ("<!doctype html><html><head><title>Clinical note | Halaxy</title><style>.halaxy-own { color: red; }</style></head><body class='vs-theme-default'>" + MENU +
             "<div id='headerWrapper'></div><div id='content'><h2>Clinical Note</h2><div class='note-area'><div class='ck ck-editor'><div class='ck-editor__main'>"
             "<div class='ck-editor__editable' contenteditable='true'><p>Existing text</p></div></div></div></div></div>"
             "<script>window.HkUser = { pracName: 'Cara Hale', pracID: 11 }; window.Hk = { jwt: 'jwt-test' };"
             "document.querySelector('.ck-editor__editable').ckeditorInstance = { isReadOnly: false };</script></body></html>")
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
    if '/clinical/category/note/id/' in path:
        return await route.fulfill(body=NOTE_PAGE, content_type='text/html')
    await route.fulfill(body=LIST_PAGE, content_type='text/html')


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
        await ctx.add_init_script(FAKE_MIC)
        # Halaxy pages only (the recorder window is a blank page the scripts don't run in, as on the PCs).
        await ctx.add_init_script("if (location.href.indexOf('https://eu.halaxy.com/a/pr/') === 0) {\n" + CORE + "\n}")
        await ctx.add_init_script("if (location.href.indexOf('https://eu.halaxy.com/a/pr/') === 0) document.addEventListener('DOMContentLoaded', function () {\n" + SCRIPT + "\n});")
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/9001/clinical/category/note/id/7001')
        await until(pg, "!!document.querySelector('.upc-rec-strip [data-a=start]')")
        place = await pg.evaluate("(() => { const s = document.querySelector('.upc-rec-strip'); return [s.nextElementSibling.className, s.textContent.trim(), [...s.querySelectorAll('select option')].map((o) => o.textContent)]; })()")
        check('note page: a strip just above the editor with a microphone list and Start Appointment', place[0] == 'ck ck-editor' and 'Start Appointment' in place[1] and place[2] == ['Default microphone'], place)

        # ---- Start
        await pg.evaluate("localStorage.setItem('upc-rec:mic', JSON.stringify({ id: 'mic-a', label: 'Desk Microphone' }))")
        await pg.click('.upc-rec-strip [data-a=start]')
        await idle(pg, 1000)
        pop = [x for x in ctx.pages if x is not pg][0]
        pop_errors = []
        pop.on('pageerror', lambda e: pop_errors.append(str(e)))
        await until(pg, "!!document.querySelector('.upc-rec-strip [data-a=finish]')")
        win = await pop.evaluate("[document.querySelector('.upc-rec-window h1').textContent, __mic.calls[0], __mic.recorders[0].mimeType, __mic.recorders[0].bits, !!document.querySelector('style') && [...document.querySelectorAll('style')].some((s) => s.textContent.includes('halaxy-own')), document.body.className, location.pathname + location.hash]")
        check('Start opens the recorder window: Halaxy\'s styles copied in, title Appointment Recording', win[0] == 'Appointment Recording' and win[4] and 'vs-theme-default' in win[5], win)
        check('it asks for the saved microphone, in mono', win[1]['audio'].get('deviceId') == {'exact': 'mic-a'} and win[1]['audio'].get('channelCount') == 1, win[1])
        check('it records Opus in Ogg at about 24 kbit/s', win[2] == 'audio/ogg;codecs=opus' and win[3] == 24000, win[2:4])
        check('reloading the window would open the recordings organisation, not the note', win[6] == '/a/pr/555/organisation/78972#upc-recorder-reloaded', win[6])

        await idle(pg, 12000)
        saved = await pg.evaluate("upcAppointmentRecorder.db.recs().then((r) => r.map((x) => [x.noteId, x.patientId, x.who, x.status, x.parts.map((p) => [p.n, p.chunks, p.mic, p.ext])]))")
        check('chunks are saved on this PC every 5 seconds', saved and saved[0][:4] == ['7001', '9001', 'CH', 'recording'] and saved[0][4][0][1] >= 2 and saved[0][4][0][2] == 'Desk Microphone', saved)
        st = await pg.evaluate("(() => { const s = document.querySelector('.upc-rec-strip'); return [s.querySelector('[data-upc-rec-time]').textContent, [...s.querySelectorAll('.upc-rec-bars > span')].map((b) => [b.className, parseInt(b.style.height)]), [...s.querySelectorAll('select option')].map((o) => o.textContent), s.querySelector('select').value]; })()")
        check('the strip shows the time, the level as bars and the microphone', re.match(r'^00:1\d$', st[0]) and len(st[1]) == 7 and all(c == 'bg-success' and h > 4 for c, h in st[1]) and st[3] == 'mic-a', st)
        check('the microphone list leaves out "Monitor of" devices and speakers', st[2] == ['Desk Microphone', 'USB Microphone'], st[2])

        other = await ctx.new_page()
        await other.goto('https://eu.halaxy.com/a/pr/555/patient/9002/clinical/category/note/id/7002')
        await until(other, "!!document.querySelector('.upc-rec-strip') && /Another appointment/.test(document.querySelector('.upc-rec-strip').textContent)")
        check('another note\'s page: says another appointment is being recorded, with Show Recorder', await other.evaluate("!document.querySelector('.upc-rec-strip [data-a=start]') && !!document.querySelector('.upc-rec-strip [data-a=show]')"))
        await other.close()

        # ---- change the microphone
        await pg.select_option('.upc-rec-strip select', 'mic-b')
        await until(pg, "upcAppointmentRecorder.db.recs().then((r) => r[0].parts.length === 2 && !!r[0].parts[0].endedAt)")
        await idle(pg, 6000)
        sw = await pop.evaluate("[__mic.calls.length, __mic.calls[1].audio.deviceId, __mic.recorders[0].stream.t[0].stopped]")
        sel = await pg.evaluate("document.querySelector('.upc-rec-strip select').value")
        check('changing the microphone ends the part and starts a new one on that microphone', sw[0] == 2 and sw[1] == {'exact': 'mic-b'} and sw[2] is True and sel == 'mic-b', (sw, sel))

        # ---- silence
        await pop.evaluate("__mic.level = 0")
        await idle(pg, 31000)
        q = await pg.evaluate("[document.querySelector('.upc-rec-strip').textContent.includes('No sound'), [...document.querySelectorAll('.upc-rec-strip .upc-rec-bars > span')].every((b) => b.className === 'bg-warning')]")
        qw = await pop.evaluate("!!document.querySelector('.upc-rec-window .alert-warning')")
        check('30 seconds of silence: "No sound" and amber bars, on the note and in the window', q == [True, True] and qw, (q, qw))
        await pop.evaluate("__mic.level = 0.5")
        await idle(pg, 2000)
        check('sound again: the warning goes', not await pg.evaluate("document.querySelector('.upc-rec-strip').textContent.includes('No sound')"))

        # ---- Finish
        await pg.click('.upc-rec-strip [data-a=finish]')
        await until(pg, "upcAppointmentRecorder.db.recs().then((r) => r[0].status === 'finished')")
        await until(pg, "() => window.open('', 'upc-recorder') && !window.open('', 'upc-recorder').__upcRecorder")
        await files_until(pg, 2)
        files = [(f['title'], f['comments'][:46]) for f in S['files']]
        check('each part is attached to the recordings organisation, titled by time and initials, with the recorder\'s comment',
              files == [('Recording 2026-11-25 10:00 CH', 'Appointment recorder; note 7001; patient 9001;'), ('Recording 2026-11-25 10:00 CH part 2', 'Appointment recorder; note 7001; patient 9001;')], files)
        ups = S['uploads']
        check('the files are Ogg audio, uploaded with Halaxy\'s token, named without the patient', len(ups) == 2 and ups[0]['name'] == 'recording-2026-11-25-1000-CH.ogg' and ups[1]['name'] == 'recording-2026-11-25-1000-CH-part2.ogg'
              and all(u['type'] == 'audio/ogg' and u['auth'] == 'Bearer jwt-test' for u in ups), ups)
        await until(pg, "/In Halaxy/.test(document.querySelector('.upc-rec-strip').textContent)")
        done = await pg.evaluate("(() => { const s = document.querySelector('.upc-rec-strip'); return [s.querySelector('[data-a=start]').textContent.trim(), !!s.querySelector('[data-a=download]'), s.textContent]; })()")
        check('afterwards the strip offers Continue Recording and Download Recording, with the copy in Halaxy', done[0] == 'Continue Recording' and done[1] and 'Recorded 00:' in done[2], done)
        await idle(pg, 20000)
        check('nothing is attached twice', len(S['files']) == 2, S['files'])

        # ---- Patients > Recordings
        lst = await ctx.new_page()
        await lst.goto('https://eu.halaxy.com/a/pr/555/patient/#upc-recordings')
        await until(lst, "!!document.querySelector('[data-upc-page] table[data-upc-list=upc-recordings] tbody tr')")
        row = await lst.evaluate("(() => { const tr = document.querySelector('[data-upc-page] tbody tr'); return [[...tr.cells].map((c) => c.textContent.trim()), tr.querySelector('a').getAttribute('href'), document.querySelector('a.upc-rec-menu') && document.querySelector('a.upc-rec-menu').textContent]; })()")
        check('Patients > Recordings lists it, with the note\'s link and its copy in Halaxy', row[0][0] == '25-Nov-2026 10:00' and row[0][2] == 'CH' and row[0][4] == 'In Halaxy' and row[0][5] == '09-Dec-2026'
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
        await files_until(pg, 3)
        stopped = [f['title'] for f in S['files']]
        check('a window closed mid-recording: marked stopped, Continue Recording offered, and its part still goes to Halaxy', len(stopped) == 3, stopped)

        # ---- copies older than 2 days
        S['files'].insert(0, {'id': 701, 'title': 'Recording 2026-11-20 09:00 DL', 'comments': 'Appointment recorder; note 1; patient 2; 30:00, 09:00 to 09:30'})
        S['files'].insert(0, {'id': 702, 'title': 'Recording 2026-11-20 09:00 notes', 'comments': 'Something CH attached by hand'})
        S['files'].insert(0, {'id': 703, 'title': 'Insurer letter', 'comments': ''})
        await pg.mouse.move(10, 10)
        await pg.mouse.move(20, 20)
        await pg.evaluate("localStorage.removeItem('upc-rec:cleanAt')")
        await run(pg, "upcAppointmentRecorder.cleanHalaxy()")
        left = sorted(f['id'] for f in S['files'])
        check('copies older than 2 days are deleted through Halaxy\'s Delete pop-up, only the recorder\'s own', S['deleted'] == [701] and 702 in left and 703 in left and len(left) == 5, (S['deleted'], left))

        # ---- 14 days on this PC
        await pg.clock.fast_forward(15 * 86400 * 1000)
        await pg.evaluate("localStorage.removeItem('upc-rec:localCleanAt')")
        await run(pg, "upcAppointmentRecorder.cleanLocal()")
        n = await pg.evaluate("upcAppointmentRecorder.db.recs().then((r) => r.length)")
        check('recordings older than 14 days leave this PC', n == 0, n)

        check('no page errors', not errors and not pop_errors, errors + pop_errors)
        await browser.close()
    print('\n' + ('All passed' if not FAILS else '%d failed' % len(FAILS)))
    sys.exit(1 if FAILS else 0)


asyncio.run(main())
