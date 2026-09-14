// github#145 -- the compiler's check on the JavaScript, and its probe
// github#145 -- 1. tsconfig.contracts.json must report ZERO diagnostics
// github#145 -- 2. a copy of src/page.js with `var DATA = 42` must NOT
// github#145 -- the probe's config extends the real one; rebuilding its
// github#145 -- options inline passed with checkJs OFF -- measured
// github#145 -- `files` beats `include`, not `exclude`, so --listFiles
// github#145 -- asserts the two files are really in the program
// github#145 -- zero, not a baseline; diagnostics print by identity
// github#145 -- .ai-context/invariants.md has why

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");

// github#145 -- gitignored; removed in a finally and on the way in
const PROBE_JS = join(ROOT, "src", "vg-contract-probe.js");
const PROBE_CFG = join(ROOT, "tsconfig.probe.json");

const ANCHOR = "var DATA = data;";
const MUTANT = '/** @type {VaultData} */ var DATA = 42;';

/** github#145 -- `path(line,col): error TSxxxx: message` */
const DIAG = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

function runTsc(project, listFiles) {
  const args = [TSC, "--noEmit", "-p", project];
  if (listFiles) args.push("--listFiles");
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const diags = [];
  const files = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    const m = DIAG.exec(t);
    // github#145 -- a continuation line belongs to the one above
    if (m) diags.push({ file: m[1], line: +m[2], col: +m[3], code: m[4], message: m[5] });
    // github#145 -- --listFiles prints platform separators
    else if (listFiles && t) files.push(t.replace(/\\/g, "/"));
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

  // github#145 -- a file out of the program reports zero for a dull reason
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
    // github#145 -- by identity, never by total
    for (const d of real.diags) {
      console.log(`  ${d.file}(${d.line},${d.col})  ${d.code}  ${d.message}`);
    }
    console.log("\n  Fix them at their source. A broad cast, an `any` or an exclusion puts the");
    console.log("  gate back where github#145 found it: green, and worth nothing.");
  } else {
    // github#145 -- name what was read; claim no denied coverage
    console.log(`js-contracts: ok -- 0 diagnostics with checkJs on (${covers.join(", ") || "nothing in scope"})`);
  }

  /* ------------------------------------------------------------- the probe */

  const page = readFileSync(join(ROOT, "src", "page.js"), "utf8");
  const hits = page.split(ANCHOR).length - 1;
  if (hits !== 1) {
    // github#145 -- a probe testing nothing is the failure this prevents
    failed = true;
    console.log(`js-contracts: FAIL -- the probe's anchor \`${ANCHOR}\` matched ${hits} times in`);
    console.log("  src/page.js, not once. Re-point it at whatever now binds the VaultData");
    console.log("  argument, or the acceptance test for github#145 is measuring nothing.");
  } else {
    writeFileSync(PROBE_JS, page.replace(ANCHOR, MUTANT), "utf8");
    // github#145 -- the mutated file alone is the whole program
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
