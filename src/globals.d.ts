// github#145 -- THE TWO DEBUG GLOBALS, DECLARED WHERE THEY ARE SET.
//
// src/page.js hangs its api on `window.__vg` (and the standalone build's debug region adds ~70
// more members to that same object through Object.defineProperties); plugin/main.js parks its
// spike report on `window.__vgSpikeReport` for the diagnostics command to read back. Both are
// real assignments to the real global, and with checkJs on the compiler said so 30 times:
// "Property '__vg' does not exist on type 'Window & typeof globalThis'".
//
// It is a declaration rather than 30 casts because a cast at each site states nothing -- it
// says "trust me" once per line and leaves the next reader no better off, and it would let the
// shape drift silently. Here the shape is written down once, and `window.__vg.applyData(...)`
// is checked against VgApi like any other call.
//
// OPTIONAL ON PURPOSE. Neither exists until a mount has run -- destroy() deletes __vg again
// (github#135) -- so `window.__vg` really is `VgApi | undefined` and the delete at the end of
// destroy() needs the property optional to be legal.
//
// Not linted, same as plugin/bundler-modules.d.ts: there is nothing in a declaration file for
// a rule to read.

export {};

declare global {
  interface Window {
    /** src/page.js -- the mount's api; absent before init and after destroy() (github#62, github#135) */
    __vg?: import("./page.js").VgApi;
    /** plugin/main.js -- the last spike report, for the diagnostics command (scripts/spike-check.mjs) */
    __vgSpikeReport?: unknown;
  }
}
