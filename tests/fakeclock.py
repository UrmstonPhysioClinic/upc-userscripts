"""
Fake-clock waits for the tests (CH, 24 Nov 2026: slow tests waited in real time for Halaxy's pacing, retries and queues).

The test installs Playwright's clock on its context (ctx.clock.install). Instead of waiting in real time for a script's
timers (core's 300 ms gap between requests, a 20-second retry, a queue's turn), until() moves that fake clock on while it
waits, so a minute of the scripts' time passes in about a second. Mocked Halaxy answers still arrive in real time.

    import sys; sys.path.insert(0, str(ROOT / 'tests')); from fakeclock import until, idle
    await until(pg, "!!document.querySelector('[data-upc-x] table')")
    await idle(pg, 25000)          # let 25 seconds of the scripts' time pass (for "nothing happens" checks)
"""
import asyncio

STEP = 500        # ms of fake time per turn: above core's 300 ms gap, so a paced request needs one turn
PAUSE = 0.01      # s of real time per turn, for mocked answers to arrive


async def _true(pg, expr, arg):
    try:
        return await (pg.evaluate(expr) if arg is None else pg.evaluate(expr, arg))
    except Exception as e:   # the page is navigating: not yet
        if 'context was destroyed' in str(e) or 'navigat' in str(e).lower():
            return False
        raise


async def until(pg, expr, timeout=60, step=STEP, arg=None):
    """Wait (up to timeout real seconds) for the JS expression or function expr to be truthy, moving the fake clock on."""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while True:
        v = await _true(pg, expr, arg)
        if v:
            return v
        if loop.time() > end:
            raise TimeoutError('fakeclock.until: not true after %ds of real time: %s' % (timeout, expr[:200]))
        await pg.clock.run_for(step)
        await asyncio.sleep(PAUSE)


async def run(pg, expr, arg=None, step=STEP):
    """pg.evaluate(expr, arg) for a call that waits on the scripts' timers (paced requests), moving the fake clock on."""
    task = asyncio.ensure_future(pg.evaluate(expr) if arg is None else pg.evaluate(expr, arg))
    while not task.done():
        await pg.clock.run_for(step)
        await asyncio.sleep(PAUSE)
    return task.result()


async def idle(pg, ms, step=STEP):
    """Let ms of fake time pass in steps, giving mocked answers time to arrive between them."""
    left = ms
    while left > 0:
        await pg.clock.run_for(min(step, left))
        left -= step
        await asyncio.sleep(PAUSE)
