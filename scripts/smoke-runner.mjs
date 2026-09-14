// github#146 -- the smoke loop, and the error audit around every check

import { errorText } from "./cdp.mjs";

/**
 * @param {string[]} errs
 * @param {number} [n]
 * @returns {string}
 */
export function summarise(errs, n = 3) {
  const shown = errs.slice(0, n).join(" | ");
  return errs.length > n ? `${shown} (+${errs.length - n} more)` : shown;
}

// github#146 -- the checks' own list, mirroring cdp.mjs's capture
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

// github#146 -- the page's turn, then the connection's
async function quiet(page, graceMs = 0) {
  try {
    await page.eval(
      "new Promise(function(r){ requestAnimationFrame(function(){ setTimeout(r, " +
      Math.max(0, graceMs | 0) + "); }); })"
    );
    return true;
  } catch { return false; }
}

// github#146 -- one round-trip, to order events ahead of the reply
async function drain(page) {
  try { await page.eval("1"); return true; } catch { return false; }
}

/**
 * github#146, github#112, github#113
 * @returns {Promise<{ failed: number, ran: number, timings: {name: string, ms: number}[] }>}
 */
export async function runChecks(opts) {
  const { checks, page, ctx, log, settle, errorLog, chromeState, fastClock, nativeClock } = opts;
  const errors = ctx.errors;
  // github#146 -- only the last window pays for a grace
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
    // github#146 -- the window closes after the interaction's tail
    await quiet(page);
    sync();
    // github#146 -- a splice below the mark hid something unaudited
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

  // github#146 -- the final audit, before the browser closes
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
