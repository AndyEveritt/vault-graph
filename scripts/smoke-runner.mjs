// github#146
//
// The per-check loop of scripts/smoke.mjs, and the error audit around it.
//
// This lives in its own module for one reason: the loop is what github#146 is about, and a loop
// tangled into runOne() can only be exercised by launching Chrome. scripts/smoke-runner-selftest.mjs
// drives everything here with a fake page, which is how the two regressions the ticket asks for
// are written at all. Same arrangement as plugin/update-note.mjs + scripts/update-note-selftest.mjs.

import { errorText } from "./cdp.mjs";

/**
 * At most `n` error lines, with a count of what was left out.
 * @param {string[]} errs
 * @param {number} [n]
 */
export function summarise(errs, n = 3) {
  const shown = errs.slice(0, n).join(" | ");
  return errs.length > n ? `${shown} (+${errs.length - n} more)` : shown;
}

/**
 * The list of errors the checks see, kept in step with what the connection captured.
 *
 * cdp.mjs already collects both kinds a page can produce -- `Runtime.exceptionThrown`, which
 * covers thrown exceptions and unhandled promise rejections alike, and `Runtime.consoleAPICalled`
 * with type "error". Nothing here listens a second time; `sync()` copies whatever arrived since
 * it last looked into a list the checks own and may edit.
 *
 * `Log.entryAdded` is captured by neither, deliberately: it carries network 404s, CSP reports and
 * deprecation notices, which are Chrome's business and not this page's invariants. Auditing them
 * would be the broad filter github#146 warns against, pointing the other way.
 *
 * The two lists are separate on purpose. A check may splice its own window out of `errors` to
 * forgive errors it provoked, and `seen` counts into the connection's untouched list, so a splice
 * can never make the runner re-report what it already audited.
 */
export function makeErrorLog(page) {
  /** @type {string[]} */
  const errors = [];
  let seen = 0;
  return {
    errors,
    sync() {
      const all = page.errors;
      for (; seen < all.length; seen++) errors.push(errorText(all[seen]));
      return errors;
    }
  };
}

/**
 * Wait until the page has run what the check left behind, then flush what it reported.
 *
 * Two things have to happen before a window can close. The page has to get a turn -- an animation
 * frame and then a task, which is where a handler scheduled by a click or a drag actually runs --
 * and the connection has to deliver what that turn produced. CDP events and command responses
 * share one ordered connection, so an exception the renderer has already reported arrives before
 * the response to a round-trip issued after it.
 *
 * That is the whole guarantee, and its edge is worth being plain about: this sees what the page
 * has thrown by the time it returns. A timer a check leaves running further out than `graceMs`
 * throws into nobody's window, and no finite wait would change that.
 */
async function quiet(page, graceMs = 0) {
  try {
    await page.eval(
      "new Promise(function(r){ requestAnimationFrame(function(){ setTimeout(r, " +
      Math.max(0, graceMs | 0) + "); }); })"
    );
    return true;
  } catch { return false; }
}

/** One round-trip, to order the connection's events ahead of the reply. */
async function drain(page) {
  try { await page.eval("1"); return true; } catch { return false; }
}

/**
 * Run `checks` against an attached page, scoring each one, and fail any check that left a new
 * error behind.
 *
 * The runner keeps a high-water mark into `ctx.errors`: a check's window opens at the mark and
 * closes after its settle, an animation frame and a round-trip, so the window covers the
 * asynchronous tail of the interaction and not just the callback's own stack. Errors captured
 * before the first check -- page load -- fall into the FIRST check's window rather than a
 * synthetic line of their own: one mechanism, no double count against the "page loads with no
 * console errors" check, and still audited in the three jobs where that check does not run.
 *
 * A check may forgive its own window by truncating the list back to where it found it, which is
 * what the hostile-vault check does around navigations it deliberately provokes. That is the only
 * allowlist in the suite. A check that leaves the list SHORTER than the mark has removed
 * something the runner never audited, and which entries survived is unknowable from out here --
 * so the mark drops to zero and the whole list is audited rather than the remainder trusted.
 *
 * @returns {Promise<{ failed: number, ran: number, timings: {name: string, ms: number}[] }>}
 */
export async function runChecks(opts) {
  const { checks, page, ctx, log, settle, errorLog, chromeState, fastClock, nativeClock } = opts;
  const errors = ctx.errors;
  // github#146 -- the last window is the one with nothing after it to catch a straggler, so it is
  // the only one that pays for a grace period. Once per job, not once per check.
  const finalGraceMs = opts.finalGraceMs === undefined ? 500 : opts.finalGraceMs;

  const chromeTail = () => {
    const said = chromeState ? chromeState() : null;
    if (said && said.gone) log(`     chrome process: ${said.gone}`);
    if (said && said.said && said.said.length) {
      log("     chrome said:");
      for (const l of said.said.slice(-12)) log("       " + l);
    }
  };

  // github#113
  const stillBusy = async () => {
    const why = await page.j("__vg.demo.busyWhy()").catch(() => null);
    return why ? Object.keys(why).filter((k) => why[k]) : [];
  };

  const sync = () => { if (errorLog) errorLog.sync(); };

  let failed = 0;
  let mark = 0;
  let alive = true;
  const timings = [];
  for (const c of checks) {
    if (page.lost) {
      log(`\n  !! CDP connection lost (${page.lost}) -- ` +
          `${checks.length - timings.length} check(s) not run`);
      chromeTail();
      failed += checks.length - timings.length;
      alive = false;
      break;
    }
    if (!(await drain(page))) {
      const last = timings.length ? timings[timings.length - 1].name : "(before the first check)";
      log(`\n  !! the page stopped answering after "${last}"`);
      chromeTail();
      log(`     ${checks.length - timings.length} check(s) not run`);
      failed += checks.length - timings.length;
      alive = false;
      break;
    }
    let r;
    const t0 = Date.now();
    // github#113
    const fast = c.clock !== "real";
    if (fast) {
      await page.send("Emulation.setEmulatedMedia",
                      { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }).catch(() => {});
      await page.eval(`__vg.timeScale = ${fastClock}; void 0`).catch(() => {});
    }
    try { r = await c.fn(page, ctx); }
    catch (e) { r = { ok: false, detail: "threw: " + e.message }; }
    // github#113, github#112
    const left = await stillBusy();
    if (left.length) {
      const tb = Date.now();
      const done = await settle(page, 20000);
      r = { ok: false,
            detail: `${r.detail || ""} | left the page busy: ${left.join(", ")} -- ` +
                    (done ? `settled in ${((Date.now() - tb) / 1000).toFixed(1)}s`
                          : "STILL busy after 20s") };
    }
    if (fast) {
      await page.eval(`__vg.timeScale = ${nativeClock}; void 0`).catch(() => {});
      await page.send("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
    }
    // github#146 -- the window closes here: the page gets its turn, the connection is flushed,
    // and only then is the list read. What an interaction threw on its way out belongs to the
    // check that caused it, not to the innocent one after it.
    await quiet(page);
    sync();
    if (errors.length < mark) mark = 0;
    const fresh = errors.slice(mark);
    if (fresh.length) {
      r = { ok: false,
            detail: `${r.detail || ""} | threw during this check: ${summarise(fresh)}` };
    }
    mark = errors.length;
    const ms = Date.now() - t0;
    timings.push({ name: c.name, ms });
    if (!r.ok) failed++;
    const secs = ms >= 1000 ? ` ${(ms / 1000).toFixed(1)}s` : "";
    log(`${r.ok ? "  ok  " : " FAIL "} ${c.name}${secs}\n         ${r.detail}`);
  }

  // github#146 -- the final audit, before the browser closes. An error that arrives as the last
  // check returns belongs to nobody's window, and used to go out with the profile directory.
  if (alive && !page.lost) {
    await settle(page, 20000);
    await quiet(page, finalGraceMs);
  }
  sync();
  if (errors.length < mark) mark = 0;
  const late = errors.slice(mark);
  if (late.length) {
    failed++;
    log(" FAIL  the page threw after the last check finished\n" +
        `         ${late.length} error(s) nothing accounted for: ${summarise(late)}`);
  }

  return { failed, ran: checks.length + (late.length ? 1 : 0), timings };
}
