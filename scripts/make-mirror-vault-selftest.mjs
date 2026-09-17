#!/usr/bin/env node
// github#176 -- the mirror translator agrees with the page's own sortTarget() (src/page.js) on
// two cases it did not: an empty target-folder, and an anchored one. No real vault needed.

import { translateSortSpec } from "./mirror-sortspec.mjs";

let failed = 0;
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail) {
  console.log("  " + (ok ? "ok  " : "FAIL") + " " + name + (detail ? "   (" + detail + ")" : ""));
  if (!ok) failed++;
}

// A small fake mirror: real path -> mirror path, one nested and one single-segment, like a
// real vault's dirMap would hold.
const FAKE_DIRS = new Map([
  ["Projects", "Foo"],
  ["Archive/Projects", "Old/Foo"],
  ["SomeFolder", "Mapped"],
]);
const mapPath = (p) => {
  const clean = String(p).split(/[\\/]/).filter(Boolean).join("/");
  if (!clean) return "";
  return FAKE_DIRS.has(clean) ? FAKE_DIRS.get(clean) : null;
};
const nameMap = new Map([["two", "Two"]]);

console.log("translateSortSpec");

// github#176 item 1 -- v="" ("target-folder:" with nothing after the colon) must drop the
// section exactly as sortTarget(raw) does on `!v`, never resolve to the mirror's root.
{
  const spec = ["target-folder:", "SomeFolder"].join("\n");
  const { text, dropped } = translateSortSpec(spec, "Home", mapPath, nameMap);
  check("an empty target-folder drops its section, never resolves to the mirror's root",
        text === "" && dropped === 2,
        `text ${JSON.stringify(text)}, dropped ${dropped} (want "", 2)`);
}

// github#176 item 2 -- an anchored, single-segment target ("/Projects") must keep its leading
// slash in the mirror's copy, or the page's rank drops from 3 (exact path) to 2 (name at any
// depth) and the translated section governs every folder sharing the mapped name.
{
  const spec = "target-folder: /Projects";
  const { text, dropped } = translateSortSpec(spec, "", mapPath, nameMap);
  check("a leading-slash target keeps its anchor once mapped",
        text === "target-folder: /Foo" && dropped === 0,
        `text ${JSON.stringify(text)}, dropped ${dropped} (want "target-folder: /Foo", 0)`);
}

// Same anchor, spelled relative from a top-level spec's own folder (github#176: "same for
// . / ./ in a top-level spec dir").
{
  const spec = "target-folder: ./Projects";
  const { text, dropped } = translateSortSpec(spec, "", mapPath, nameMap);
  check("./ from a top-level spec dir keeps its anchor once mapped",
        text === "target-folder: /Foo" && dropped === 0,
        `text ${JSON.stringify(text)}, dropped ${dropped} (want "target-folder: /Foo", 0)`);
}

// A nested anchored target already contains a slash post-mapping, so the bug never showed here
// -- confirm the fix does not add a redundant leading slash's worth of behaviour change.
{
  const spec = "target-folder: /Archive/Projects";
  const { text, dropped } = translateSortSpec(spec, "", mapPath, nameMap);
  check("a nested anchored target maps with its anchor, unaffected either way",
        text === "target-folder: /Old/Foo" && dropped === 0,
        `text ${JSON.stringify(text)}, dropped ${dropped} (want "target-folder: /Old/Foo", 0)`);
}

// A bare (unanchored) wildcard must never gain an anchor it never had -- wild always ranks 0
// in the page regardless of anchoring (github#172), so adding one here would be a no-op at
// best and a lie about the translation at worst.
{
  const spec = "target-folder: Projects/*";
  const { text, dropped } = translateSortSpec(spec, "", mapPath, nameMap);
  check("a bare wildcard target stays unanchored",
        text === "target-folder: Foo/*" && dropped === 0,
        `text ${JSON.stringify(text)}, dropped ${dropped} (want "target-folder: Foo/*", 0)`);
}

// An anchored wildcard must not gain a leading slash either -- wild overrides anchoring in the
// page's own rank rule, so the anchor carries no meaning here and must not be emitted.
{
  const spec = "target-folder: /Projects/*";
  const { text, dropped } = translateSortSpec(spec, "", mapPath, nameMap);
  check("an anchored wildcard target still stays unanchored",
        text === "target-folder: Foo/*" && dropped === 0,
        `text ${JSON.stringify(text)}, dropped ${dropped} (want "target-folder: Foo/*", 0)`);
}

// github#71 -- unrelated existing behaviour, kept honest by the same refactor: a target-folder
// that does not resolve at all still drops its section and everything under it.
{
  const spec = ["target-folder: Nowhere", "one", "target-folder: /", "two"].join("\n");
  const { text, dropped } = translateSortSpec(spec, "", mapPath, nameMap);
  check("an unmappable target-folder still drops its own section, not just the value",
        text === "target-folder: /\nTwo" && dropped === 2,
        `text ${JSON.stringify(text)}, dropped ${dropped} (want "target-folder: /\\nTwo", 2)`);
}

if (failed) { console.log("make-mirror-vault selftest: " + failed + " FAILED"); process.exit(1); }
console.log("make-mirror-vault selftest: all passed");
