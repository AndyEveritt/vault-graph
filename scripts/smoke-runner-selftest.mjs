#!/usr/bin/env node
// github#146 -- the smoke runner's own scoring, with no Chrome

import { makeErrorLog, runChecks, summarise } from "./smoke-runner.mjs";

let failed = 0;
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail) {
  console.log("  " + (ok ? "ok  " : "FAIL") + " " + name + (detail ? "   (" + detail + ")" : ""));
  if (!ok) failed++;
}

// github#146 -- a page that answers only what the loop asks
function fakePage(opts = {}) {
  const busy = (opts.busy || []).slice();
  const p = {
    lost: opts.lost || null,
    sent: [],
    dead: opts.dead || false,
    captured: (opts.captured || []).slice(),
    get errors() { return p.captured.slice(); },
    async send(method, params) { p.sent.push(method); void params; },
    async eval(expr) {
      if (p.dead) throw new Error("Inspector.detached");
      // github#146 -- honour the grace, so a window can close too early
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
  };
  return p;
}

// github#146 -- the real settle() yields, so this one must too
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); return true; };
const quietLog = () => { const lines = []; const log = (m) => lines.push(String(m)); log.lines = lines; return log; };

async function run(checks, opts = {}) {
  const page = fakePage(opts);
  const errorLog = makeErrorLog(page);
  const ctx = { get errors() { return errorLog.errors; } };
  for (const e of opts.errors || []) ctx.errors.push(e);
  const log = quietLog();
  const r = await runChecks({
    checks, page, ctx, log, settle,
    chromeState: () => ({ gone: opts.gone || null, said: opts.said || [] }),
    fastClock: 0.1, nativeClock: 1.25,
    finalGraceMs: opts.finalGraceMs === undefined ? 0 : opts.finalGraceMs
  });
  return { ...r, lines: log.lines, text: log.lines.join("\n"), errors: ctx.errors, page };
}

const pass = (name) => ({ name, fn: async () => ({ ok: true, detail: "fine" }) });

console.log("the audit around every check");

// github#146 -- the defect, in the shape the review measured it
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

// github#146 -- an error that belongs to no check's window
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

// github#146
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

// github#146 -- a load-time error falls into the first window
{
  const r = await run([pass("whatever runs first here")], { errors: ["load-time boom"] });
  check("an error captured before the first check fails that check",
        r.failed === 1 && /threw during this check: load-time boom/.test(r.text),
        "failed " + r.failed);
}

// github#146 -- a check must see what the page threw while IT was running
{
  let sawDuringRun = null;
  const r = await run([
    { name: "reads the list while it runs",
      fn: async (p, ctx) => {
        const before = ctx.errors.length;
        p.captured.push({ kind: "console", text: "thrown mid-check" });
        sawDuringRun = ctx.errors.slice(before);
        ctx.errors.splice(before);
        return { ok: true, detail: "d" };
      } }
  ]);
  check("a check reading ctx.errors mid-run sees what arrived since it started",
        sawDuringRun && sawDuringRun.length === 1 && sawDuringRun[0] === "console: thrown mid-check",
        JSON.stringify(sawDuringRun));
  check("...and having handled them itself, it is not failed for them",
        r.failed === 0, "failed " + r.failed);
}

// github#146 -- the one allowlist: a check forgiving its own window
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

// github#146
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
  check("...and says why the round-trip failed", /-- Inspector.detached/.test(r.text));
  check("...and does not then wait out a settle it cannot finish",
        !/nothing accounted for/.test(r.text));
}

console.log("the error log");

{
  // github#146 -- what cdp.mjs hands over, in its shape
  const page = fakePage({ captured: [
    { kind: "exception", text: "Error: nope\n  at x", line: 11 },
    { kind: "exception", text: "Uncaught (in promise) Error: no" },
    { kind: "console", text: "bad Error: worse" }
  ] });
  const errorLog = makeErrorLog(page);
  check("an exception is read back with its line",
        errorLog.errors[0] === "exception: Error: nope (line 12)", errorLog.errors[0]);
  check("a stack is cut to its first line", !errorLog.errors[0].includes("at x"));
  check("console.error is read back, and labelled as one",
        errorLog.errors[2] === "console: bad Error: worse", errorLog.errors[2]);
  check("a second read adds nothing", errorLog.errors.length === 3, errorLog.errors.length + " held");
  page.captured.push({ kind: "console", text: "later" });
  check("...and a later capture is picked up on the next read",
        errorLog.errors[3] === "console: later", errorLog.errors.length + " held");
  errorLog.errors.splice(0);
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
