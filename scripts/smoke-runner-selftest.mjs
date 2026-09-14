#!/usr/bin/env node
// github#146
//
// The harness regressions for scripts/smoke-runner.mjs: the runner's own scoring, and the error
// audit around every check. No Chrome -- the page is a stand-in that answers the four calls the
// loop makes of it, so these run in milliseconds and the hook can afford them on every push.
//
// The two the ticket names are "a later check throws while its own assertion passes" and "an
// error arrives after the last check". Both fail without the audit in smoke-runner.mjs; the rest
// are here so the audit cannot be bought by breaking something the runner already did.

import { makeErrorLog, runChecks, summarise } from "./smoke-runner.mjs";

let failed = 0;
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail) {
  console.log("  " + (ok ? "ok  " : "FAIL") + " " + name + (detail ? "   (" + detail + ")" : ""));
  if (!ok) failed++;
}

/**
 * A page that answers what the loop asks of it and nothing else.
 * `busy` is the queue stillBusy() reads: each entry is one check's answer.
 */
function fakePage(opts = {}) {
  const busy = (opts.busy || []).slice();
  const p = {
    lost: opts.lost || null,
    sent: [],
    dead: opts.dead || false,
    // what cdp.mjs captures, in its own shape; makeErrorLog() reads this and nothing else
    captured: (opts.captured || []).slice(),
    get errors() { return p.captured.slice(); },
    async send(method, params) { p.sent.push(method); void params; },
    async eval(expr) {
      if (p.dead) throw new Error("Inspector.detached");
      // quiet() asks the page for a turn, and waits out the grace it was given. A stand-in that
      // resolved synchronously would let an error still in flight arrive after its own window
      // had closed, which is the thing these tests are about.
      const grace = /setTimeout\(r, (\d+)\)/.exec(String(expr));
      if (grace) { await new Promise((r) => setTimeout(r, Number(grace[1]))); return undefined; }
      return expr === "1" ? 1 : undefined;
    },
    async j(expr) {
      if (expr === "__vg.demo.busyWhy()") {
        const next = busy.shift();
        return next ? Object.fromEntries(next.map((k) => [k, true])) : null;
      }
      return null;
    },
    on() { /* the error log is wired separately in these tests */ }
  };
  return p;
}

// the real settle() polls the page, so it yields to the event loop; a stand-in that
// resolves synchronously would let a genuinely late error arrive after the audit.
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); return true; };
const quietLog = () => { const lines = []; const log = (m) => lines.push(String(m)); log.lines = lines; return log; };

/** Run the loop over `checks` with a fresh error array, and hand back everything observable. */
async function run(checks, opts = {}) {
  const page = fakePage(opts);
  const errorLog = makeErrorLog(page);
  const errors = errorLog.errors;
  for (const e of opts.errors || []) errors.push(e);
  const log = quietLog();
  const r = await runChecks({
    checks, page, ctx: { errors }, log, settle, errorLog,
    chromeState: () => ({ gone: opts.gone || null, said: opts.said || [] }),
    fastClock: 0.1, nativeClock: 1.25,
    finalGraceMs: opts.finalGraceMs === undefined ? 0 : opts.finalGraceMs
  });
  return { ...r, lines: log.lines, text: log.lines.join("\n"), errors, page };
}

const pass = (name) => ({ name, fn: async () => ({ ok: true, detail: "fine" }) });

console.log("the audit around every check");

// The defect github#146 reports, in the shape the review measured it: two checks, the second
// appends an error to the list and still returns a passing numeric result. Before the audit the
// runner printed 2/2 and returned failed: 0 while holding the error.
{
  const r = await run([
    pass("reads an empty error list"),
    { name: "passes its assertion and throws on the way out",
      fn: async (p, ctx) => { ctx.errors.push("exception: TypeError: x is not a function (line 42)"); return { ok: true, detail: "42 notes" }; } }
  ]);
  check("a later check that appends an error fails, though its assertion passed",
        r.failed === 1, "failed " + r.failed + " of " + r.ran);
  check("...and the failure line says what was thrown",
        /threw during this check: exception: TypeError: x is not a function \(line 42\)$/m.test(r.text),
        (r.lines[1] || "").trim());
  check("...while its own detail is kept",
        /42 notes \| threw during this check/.test(r.text));
  check("...and the check before it is untouched", r.text.includes("  ok   reads an empty error list"));
}

// The other regression the ticket names: an error that arrives as the last check returns belongs
// to no check's window at all, and used to leave with the profile directory.
{
  const r = await run([
    pass("one"),
    { name: "two",
      fn: async (p) => { setTimeout(() => p.captured.push({ kind: "console", text: "late boom" }), 30);
                         return { ok: true, detail: "ok" }; } }
  ], { finalGraceMs: 120 });
  check("an error arriving after the last check's own window fails the job",
        r.failed === 1, "failed " + r.failed);
  check("...as a line of its own, not attributed to a check",
        /the page threw after the last check finished/.test(r.text) &&
        /1 error\(s\) nothing accounted for: console: late boom/.test(r.text), r.lines.join(" / "));
  check("...and neither check is blamed for it",
        r.text.includes("  ok   one") && r.text.includes("  ok   two"));
  check("...and it is counted in the denominator", r.ran === 3, "ran " + r.ran);
}

// ...while an error the interaction throws on its own way out is the check's, not the job's.
{
  const r = await run([
    pass("one"),
    { name: "two",
      fn: async (p) => { setTimeout(() => p.captured.push({ kind: "console", text: "on the way out" }), 0);
                         return { ok: true, detail: "ok" }; } },
    pass("three")
  ]);
  check("an error thrown as a check returns is attributed to that check",
        r.failed === 1 && r.text.includes(" FAIL  two"), "failed " + r.failed);
  check("...and not to the innocent check after it", r.text.includes("  ok   three"));
}

// An error already in the list when the loop starts is the page load's. It falls into the first
// check's window rather than a line of its own -- so it is reported once in the job that runs
// "page loads with no console errors", and still reported in the three jobs that do not.
{
  const r = await run([pass("whatever runs first here")], { errors: ["load-time boom"] });
  check("an error captured before the first check fails that check",
        r.failed === 1 && /threw during this check: load-time boom/.test(r.text),
        "failed " + r.failed);
}

// The only allowlist in the suite: a check that provokes errors on purpose truncates its own
// window before returning. That is what "a folder named after an Object.prototype member still
// lays out" does around its hostile-vault navigations.
{
  const r = await run([
    pass("one"),
    { name: "forgives its own window",
      fn: async (p, ctx) => {
        const mark = ctx.errors.length;
        ctx.errors.push("expected: payload vault threw");
        ctx.errors.splice(mark);
        return { ok: true, detail: "4 pages" };
      } },
    pass("three")
  ]);
  check("a check that splices its own window back is not failed",
        r.failed === 0 && r.text.includes("  ok   forgives its own window"), "failed " + r.failed);
}

// ...but a splice may not carry the mark past something the runner has not audited. A check that
// leaves the list shorter than the mark has removed something unaudited, and which entries
// survived is unknowable from the outside -- so the runner audits the whole list instead.
{
  const r = await run([
    { name: "one", fn: async (p, ctx) => { ctx.errors.push("a"); ctx.errors.push("b"); return { ok: true, detail: "d" }; } },
    { name: "two", fn: async (p, ctx) => { ctx.errors.splice(0); ctx.errors.push("c"); return { ok: true, detail: "d" }; } },
    pass("three")
  ]);
  check("a splice below the runner's mark cannot hide a later error",
        r.failed === 2 && r.text.includes(" FAIL  two"), "failed " + r.failed);
}

console.log("what the runner already did, unchanged");

{
  const r = await run([pass("one"), pass("two"), pass("three")]);
  check("a clean run fails nothing", r.failed === 0, "failed " + r.failed);
  check("...counts every check", r.ran === 3 && r.timings.length === 3);
  check("...names each one in order",
        r.timings.map((t) => t.name).join(",") === "one,two,three");
  check("...and emulates reduced motion around a fast check",
        r.page.sent.filter((m) => m === "Emulation.setEmulatedMedia").length === 6,
        r.page.sent.filter((m) => m === "Emulation.setEmulatedMedia").length + " calls");
}

{
  const r = await run([{ name: "real", clock: "real", fn: async () => ({ ok: true, detail: "d" }) }]);
  check("a real-clock check is not put under reduced motion",
        !r.page.sent.includes("Emulation.setEmulatedMedia"));
}

{
  const r = await run([{ name: "throws", fn: async () => { throw new Error("boom"); } }]);
  check("a check whose callback throws fails with its message",
        r.failed === 1 && /threw: boom/.test(r.text));
}

{
  const r = await run([{ name: "leaks", fn: async () => ({ ok: true, detail: "d" }) }], { busy: [["cascade"]] });
  check("a check that leaves the page busy still fails",
        r.failed === 1 && /left the page busy: cascade/.test(r.text));
}

{
  const r = await run([pass("one"), pass("two"), pass("three")], { lost: "socket closed" });
  check("a lost connection fails every check that did not run",
        r.failed === 3 && /CDP connection lost \(socket closed\) -- 3 check\(s\) not run/.test(r.text),
        "failed " + r.failed);
  check("...and reports what chrome said", /chrome process: exit 1/.test(
    (await run([pass("one")], { lost: "x", gone: "exit 1" })).text));
}

{
  const r = await run([pass("one")], { dead: true });
  check("a page that stops answering fails the rest",
        r.failed === 1 && /stopped answering after "\(before the first check\)"/.test(r.text));
  check("...and does not then wait out a settle it cannot finish",
        !/nothing accounted for/.test(r.text));
}

console.log("the error log");

{
  // what cdp.mjs hands over, in its shape -- an exception, an unhandled rejection with no
  // exception object, and a console.error
  const page = fakePage({ captured: [
    { kind: "exception", text: "Error: nope\n  at x", line: 11 },
    { kind: "exception", text: "Uncaught (in promise) Error: no" },
    { kind: "console", text: "bad Error: worse" }
  ] });
  const errorLog = makeErrorLog(page);
  check("nothing is captured until it is synced", errorLog.errors.length === 0);
  errorLog.sync();
  check("an exception is read back with its line",
        errorLog.errors[0] === "exception: Error: nope (line 12)", errorLog.errors[0]);
  check("a stack is cut to its first line", !errorLog.errors[0].includes("at x"));
  check("console.error is read back, and labelled as one",
        errorLog.errors[2] === "console: bad Error: worse", errorLog.errors[2]);
  errorLog.sync();
  check("a second sync adds nothing", errorLog.errors.length === 3, errorLog.errors.length + " held");
  page.captured.push({ kind: "console", text: "later" });
  errorLog.sync();
  check("...and a later capture is picked up", errorLog.errors[3] === "console: later");
  errorLog.errors.splice(0);
  errorLog.sync();
  check("a check that splices the list does not make it re-report what it audited",
        errorLog.errors.length === 0, errorLog.errors.length + " held");
}

{
  check("a long list is summarised, with a count of the rest",
        summarise(["a", "b", "c", "d"]) === "a | b | c (+1 more)",
        summarise(["a", "b", "c", "d"]));
}

console.log("");
console.log(failed ? failed + " FAILED" : "all good");
process.exit(failed ? 1 : 0);
