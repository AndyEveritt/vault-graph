#!/usr/bin/env node
// github#141

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalDest, cleanTarget, ghostId, ghostLabel, isExternalTarget } from "../src/links.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BUILD = join(ROOT, "src", "build-graph.mjs");

let failures = 0;
/** @param {boolean} ok @param {string} name @param {string} [detail] */
function report(ok, name, detail) {
  if (!ok) failures++;
  console.log("  " + (ok ? "ok  " : "FAIL") + " " + name + (detail ? "   (" + detail + ")" : ""));
}
/** @param {unknown} a @param {unknown} b @param {string} name */
function eq(a, b, name) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  report(ok, name, ok ? "" : "got " + JSON.stringify(a) + ", want " + JSON.stringify(b));
}

/* ------------------------------------------------------------ the fixture -- */

/** @type {Record<string, string>} */
const NOTES = {
  "A/Target.md": "# A Target\n",
  "B/Target.md": "# B Target\n",
  "A/Unique.md": "---\naliases:\n  - Nickname\n---\n# Unique\n",
  "A/Has Space.md": "# spaced\n",
  "RootNote.md": "# root\n",
  "C/D/Deep.md": "# deep\n",
  "B/Source.md": [
    "md-relative-dot [x](./Target.md)",
    "md-relative-dotdot [x](../A/Target.md)",
    "md-bare [x](Target.md)",
    "md-qualified [x](A/Target.md)",
    "md-heading [x](A/Target.md#Heading)",
    "md-heading-bare [x](Target.md#Heading)",
    "md-encoded [x](../A/Has%20Space.md)",
    "md-external [x](https://example.com/thing.md)",
    "md-missing-relative [x](./Missing.md)",
    "wiki-bare [[Target]]",
    "wiki-qualified [[A/Target]]",
    "wiki-alias [[Nickname]]",
    "wiki-heading [[A/Target#Heading]]",
    "wiki-root [[RootNote]]",
    "wiki-deep [[C/D/Deep]]",
    "wiki-ghost-a [[FutureA/New]]",
    "wiki-ghost-b [[FutureB/New]]",
    "wiki-ghost-bare [[New]]",
    "code-fence-is-not-a-link",
    "```",
    "[[A/Target]]",
    "```",
    "inline-code `[[A/Target]]` is not a link either",
    "",
  ].join("\n"),
  "C/D/Other.md": [
    "from-deep-relative [x](./Deep.md)",
    "from-deep-updot [x](../../A/Target.md)",
    "from-deep-ghost [[FutureA/New]]",
    "",
  ].join("\n"),
};

/** @param {string} dir */
function makeVault(dir) {
  mkdirSync(join(dir, ".obsidian"), { recursive: true });
  writeFileSync(join(dir, ".obsidian", "app.json"), "{}", "utf8");
  for (const [rel, text] of Object.entries(NOTES)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, "utf8");
  }
}

/** @typedef {{ id: string, label: string, deg: number, ghost?: boolean }} Node */
/** @typedef {{ s: number, t: number, w: number }} Edge */
/** @typedef {{ nodes: Node[], edges: Edge[], stats: { unresolved: number } }} Data */

/**
 * @param {string} vault @param {string} out @param {string[]} extra
 * @returns {Data}
 */
function build(vault, out, extra) {
  const r = spawnSync(process.execPath, [BUILD, "--vault", vault, "--out", out, ...extra],
                      { stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) throw new Error("build-graph.mjs exited " + r.status);
  const m = /window\.VAULT_DATA=(\{[\s\S]*?\});<\/script>/.exec(readFileSync(out, "utf8"));
  if (!m) throw new Error("no window.VAULT_DATA in " + out);
  return JSON.parse(m[1]);
}

/** @param {Data} d */
function pairs(d) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const e of d.edges) {
    const a = d.nodes[e.s].id, b = d.nodes[e.t].id;
    out[(a < b ? a + " -- " + b : b + " -- " + a)] = e.w;
  }
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

/* --------------------------------------------------------- the pure rules -- */

console.log("check-link-resolution: the shared helper");
eq(cleanTarget("A/Target.md#Heading"), "A/Target", "a heading fragment comes off the destination");
eq(cleanTarget("A/Target.md#^blk"), "A/Target", "a block fragment comes off too");
eq(cleanTarget("../A/Has%20Space.md"), "../A/Has Space", "an encoded space decodes");
eq(cleanTarget("A/100%25.md"), "A/100%", "an encoded percent decodes without corrupting the name");
eq(cleanTarget("A/broken%zz.md"), "A/broken%zz", "an undecodable escape is left alone");
eq(canonicalDest("B/Source.md", "./Target"), "B/Target", "./ resolves against the source folder");
eq(canonicalDest("C/D/Other.md", "../../A/Target"), "A/Target", "../../ walks up from the source folder");
eq(canonicalDest("B/Source.md", "A/Target"), "A/Target", "a qualified destination is left vault-relative");
eq(canonicalDest("RootNote.md", "./Target"), "Target", "./ from a vault-root note is the vault root");
eq(ghostId(canonicalDest("B/Source.md", "FutureA/New")), "ghost:FutureA/New", "a ghost id is the full destination");
eq(ghostLabel("FutureA/New"), "New", "a ghost label is the basename only");
eq([isExternalTarget("https://example.com/a.md"), isExternalTarget("//cdn/a.md"),
    isExternalTarget("A/Target.md"), isExternalTarget("./A.md")],
   [true, true, false, false], "external destinations are told apart from vault ones");

/* --------------------------------------------------------- the whole build -- */

const work = mkdtempSync(join(tmpdir(), "vg-links-"));
try {
  const vault = join(work, "vault");
  makeVault(vault);

  console.log("check-link-resolution: resolution, ghosts off");
  const plain = build(vault, join(work, "plain.html"), []);
  const byId = Object.fromEntries(plain.nodes.map((n) => [n.id, n]));

  eq(plain.nodes.map((n) => n.id).sort(),
     ["A/Has Space.md", "A/Target.md", "A/Unique.md", "B/Source.md", "B/Target.md",
      "C/D/Deep.md", "C/D/Other.md", "RootNote.md"],
     "no ghost node is emitted with --ghosts off");

  eq(pairs(plain), {
    "A/Has Space.md -- B/Source.md": 1,
    "A/Target.md -- B/Source.md": 5,
    "A/Target.md -- C/D/Other.md": 1,
    "A/Unique.md -- B/Source.md": 1,
    "B/Source.md -- B/Target.md": 4,
    "B/Source.md -- C/D/Deep.md": 1,
    "B/Source.md -- RootNote.md": 1,
    "C/D/Deep.md -- C/D/Other.md": 1,
  }, "every endpoint and weight is exactly where Obsidian's own cache puts it");

  eq(byId["B/Target.md"].deg, 1, "the same-folder Target keeps its own degree");
  eq(byId["A/Target.md"].deg, 2, "the other-folder Target is reached from two sources");
  eq(plain.stats.unresolved, 5, "unresolved counts occurrences: ./Missing, New, FutureB/New and FutureA/New twice");

  console.log("check-link-resolution: ghost identity, ghosts on");
  const ghosted = build(vault, join(work, "ghosts.html"), ["--ghosts"]);
  eq(ghosted.nodes.filter((n) => n.ghost).map((n) => n.id).sort(),
     ["ghost:B/Missing", "ghost:FutureA/New", "ghost:FutureB/New", "ghost:New"],
     "two same-named ghosts stay two nodes, each under its full destination");
  eq(ghosted.nodes.filter((n) => n.ghost).map((n) => n.label).sort(),
     ["Missing", "New", "New", "New"],
     "a ghost label is still the basename");

  const gp = pairs(ghosted);
  eq(gp["B/Source.md -- ghost:FutureA/New"], 1, "FutureA/New is reached from B/Source only once");
  eq(gp["C/D/Other.md -- ghost:FutureA/New"], 1, "the same canonical destination aggregates across folders");
  eq(gp["B/Source.md -- ghost:FutureB/New"], 1, "FutureB/New is a separate neighbourhood");
  eq(gp["B/Source.md -- ghost:New"], 1, "a bare unresolved name stays one destination, as Obsidian keys it");
  eq(gp["B/Source.md -- ghost:B/Missing"], 1, "an unresolved relative path never falls back to a basename");
  eq(ghosted.nodes.find((n) => n.id === "ghost:FutureA/New").deg, 2,
     "the shared ghost carries both of its sources");

  const real = ghosted.nodes.filter((n) => !n.ghost).map((n) => n.id);
  eq(real, plain.nodes.map((n) => n.id), "--ghosts adds nodes and reorders nothing");
  eq(ghosted.stats.unresolved, plain.stats.unresolved, "--ghosts does not change the unresolved count");

  console.log("check-link-resolution: a same-named file elsewhere never rescues a qualified miss");
  const strict = join(work, "strict");
  mkdirSync(join(strict, ".obsidian"), { recursive: true });
  writeFileSync(join(strict, ".obsidian", "app.json"), "{}", "utf8");
  mkdirSync(join(strict, "X"), { recursive: true });
  mkdirSync(join(strict, "Y"), { recursive: true });
  writeFileSync(join(strict, "X", "Only.md"), "# only\n", "utf8");
  writeFileSync(join(strict, "Y", "Src.md"), "[[Z/Only]] and [x](./Only.md) and [[Only]]\n", "utf8");
  const s = build(strict, join(work, "strict.html"), ["--ghosts"]);
  eq(pairs(s), { "X/Only.md -- Y/Src.md": 1, "Y/Src.md -- ghost:Y/Only": 1, "Y/Src.md -- ghost:Z/Only": 1 },
     "only the bare name reaches X/Only.md; the qualified and relative misses stay ghosts");
  eq(s.stats.unresolved, 2, "both qualified/relative misses are counted unresolved");
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("check-link-resolution: " + (failures ? failures + " failure(s)" : "all checks passed"));
process.exit(failures ? 1 : 0);
