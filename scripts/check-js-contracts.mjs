// github#145
//
// THE COMPILER'S CHECK ON THE JAVASCRIPT, AND A PROBE THAT PROVES IT STILL HAS TEETH.
//
// Two runs of tsc against tsconfig.contracts.json (checkJs on):
//
//   1. the real one -- src/page.js and plugin/main.js must report ZERO diagnostics;
//   2. the probe    -- a copy of src/page.js with `var DATA = data` replaced by
//                      `/** @type {VaultData} */ var DATA = 42` must report an error.
//
// The second run is the reason this file exists rather than one more line in lint.mjs. Before
// github#145 the whole gate was green on a tree where that exact mutation drew zero errors and
// zero warnings -- the annotations were comments nobody read. A gate that cannot demonstrate
// its own teeth is how that happens again: someone sets checkJs back to false, or narrows the
// include, or adds a skipLibCheck-shaped escape hatch, and every run stays green because
// there is nothing left to find. So the check asserts a known defect IS caught, every time,
// and fails if it is not.
//
// THE PROBE'S CONFIG EXTENDS tsconfig.contracts.json AND OVERRIDES ONLY `files`. Written the
// obvious way -- rebuilding the compiler options inline -- it tests a program of its own and
// is worth nothing: measured while writing this, a version that set `checkJs: true` itself
// still reported the mutation as caught with checkJs turned OFF in the real config, which is
// precisely the false green this ticket exists to remove. Every setting the probe runs under
// has to come from the file the real check runs under, or the two can disagree.
//
// `files` beats `include` but NOT an `exclude` over the real sources, so the probe alone
// cannot see someone dropping src/page.js out of the program. --listFiles answers that
// directly: the two files this gate is for must actually be in it.
//
// scripts/lint.mjs calls this after the engine's own tsc, which puts it inside `npm run lint`
// and therefore inside .githooks/pre-push and release.ps1 with nothing further to wire.
//
// ZERO, NOT A BASELINE. github#145 allows a baseline tracked BY IDENTITY -- never by total,
// since a count lets one new error silently replace one old one -- if the work is phased. It
// was not: all 138 are fixed, so the bar is zero, which cannot drift and needs no ledger to
// keep honest. Every diagnostic is still printed with its full identity (file, position, code
// and message) so a failure names itself rather than handing back a number.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");

// Both are gitignored and both are removed in a finally -- and deleted again on the way in, so
// a killed run cannot leave one behind for check-pii/check-scope to trip over.
const PROBE_JS = join(ROOT, "src", "vg-contract-probe.js");
const PROBE_CFG = join(ROOT, "tsconfig.probe.json");

const ANCHOR = "var DATA = data;";
const MUTANT = '/** @type {VaultData} */ var DATA = 42;';

/** One diagnostic line as tsc prints it: `path(line,col): error TSxxxx: message`. */
/** A newline and a Windows path separator, built rather than escaped. */
const NL = String.fromCharCode(10);
const SEP = String.fromCharCode(92);

const DIAG = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

function runTsc(project, listFiles) {
  const args = [TSC, "--noEmit", "-p", project];
  if (listFiles) args.push("--listFiles");
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const diags = [];
  const files = [];
  for (const line of out.split(NL)) {
    // trim() takes the CR off a CRLF line as well as the indent tsc uses for a continuation.
    const t = line.trim();
    const m = DIAG.exec(t);
    // A continuation line (tsc indents the "Type 'X' is not assignable" detail under its
    // parent) is part of the diagnostic above it, not a new one.
    if (m) diags.push({ file: m[1], line: +m[2], col: +m[3], code: m[4], message: m[5] });
    else if (listFiles && t) files.push(t.split(SEP).join("/"));
  }
  return { diags, files, raw: out, status: r.status };
}

function cleanup() {
  for (const f of [PROBE_JS, PROBE_CFG]) rmSync(f, { force: true });
}

let failed = false;
cleanup();
try {
  if (!existsSync(TSC)) {
    console.log("js-contracts: FAIL -- node_modules/typescript is missing; run npm ci");
    process.exit(1);
  }

  /* ---------------------------------------------------------- the real check */

  const real = runTsc(join(ROOT, "tsconfig.contracts.json"), true);

  // The include, checked rather than assumed: a program that no longer holds these two files
  // reports zero diagnostics about them for the most boring reason there is. (src/page.js
  // would survive being dropped from the include -- plugin/main.js imports it, and it was
  // measured still checked that way -- but tsconfig.json names it anyway so the program is
  // stated rather than inherited, and this asserts the same thing at run time.)
  const covers = [];
  for (const want of ["src/page.js", "plugin/main.js"]) {
    if (real.files.some((f) => f.endsWith("/" + want))) covers.push(want);
    else {
      failed = true;
      console.log(`js-contracts: FAIL -- ${want} is not in the program tsconfig.contracts.json`);
      console.log("  builds. Its diagnostics are zero because nothing is reading it.");
    }
  }

  if (real.diags.length) {
    failed = true;
    console.log(`js-contracts: FAIL -- ${real.diags.length} diagnostic(s) with checkJs on\n`);
    // By identity, never by total: each one names its file, position, code and message, so a
    // new error that arrives while an old one is fixed is visible rather than netted out.
    for (const d of real.diags) {
      console.log(`  ${d.file}(${d.line},${d.col})  ${d.code}  ${d.message}`);
    }
    console.log("\n  Fix them at their source. A broad cast, an `any` or an exclusion puts the");
    console.log("  gate back where github#145 found it: green, and worth nothing.");
  } else {
    // Name what was actually read, so a passing line can never claim coverage the check
    // above it just denied.
    console.log(`js-contracts: ok -- 0 diagnostics with checkJs on (${covers.join(", ") || "nothing in scope"})`);
  }

  /* ------------------------------------------------------------- the probe */

  const page = readFileSync(join(ROOT, "src", "page.js"), "utf8");
  const hits = page.split(ANCHOR).length - 1;
  if (hits !== 1) {
    // The probe silently testing nothing is the failure this whole check exists to prevent,
    // so an anchor that no longer matches is a hard failure, not a skip.
    failed = true;
    console.log(`js-contracts: FAIL -- the probe's anchor \`${ANCHOR}\` matched ${hits} times in`);
    console.log("  src/page.js, not once. Re-point it at whatever now binds the VaultData");
    console.log("  argument, or the acceptance test for github#145 is measuring nothing.");
  } else {
    writeFileSync(PROBE_JS, page.replace(ANCHOR, MUTANT), "utf8");
    // The probe program is the mutated file alone: page.js imports its types from
    // ./engine/types, which tsc resolves on demand, so one file is the whole program and the
    // run costs a fraction of the real one. Everything else is inherited -- see the header.
    writeFileSync(PROBE_CFG, JSON.stringify({
      extends: "./tsconfig.contracts.json",
      files: ["src/vg-contract-probe.js", "src/globals.d.ts"],
    }, null, 2) + "\n", "utf8");

    const probe = runTsc(PROBE_CFG);
    const caught = probe.diags.filter((d) => /VaultData/.test(d.message));
    if (caught.length) {
      console.log(`js-contracts: ok -- the probe is rejected (${caught[0].code}: ${caught[0].message})`);
    } else {
      failed = true;
      console.log("js-contracts: FAIL -- the probe was NOT rejected.");
      console.log(`  A copy of src/page.js with \`${MUTANT}\` drew no VaultData diagnostic,`);
      console.log("  which is what the whole gate did before github#145. Something has turned");
      console.log("  the check off: checkJs, the include, or an exclusion over src/page.js.");
      if (probe.raw.trim()) console.log("\n" + probe.raw.trim());
    }
  }
} finally {
  cleanup();
}

process.exit(failed ? 1 : 0);
