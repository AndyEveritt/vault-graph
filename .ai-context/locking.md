# Why the lock names stay separate

`scripts/lock.mjs` guards two different resources for this repo, and they are deliberately two
different lock names rather than one shared mutex. `CLAUDE.md`'s "How to work here" section has
the working commands and the two names; this is the archaeology behind why they are not aliased,
and where each one bit before it was fixed.

## The screen lock (`screen-left` / `screen-right` / `screen-primary`)

`record-demo.ps1` captures with `gdigrab -i desktop`, which copies a *region of the display* — so
anything else drawn there lands in the take and ruins it silently: the file exists and looks
plausible. A recording is not the only claimant: `smoke.mjs` parks every Chrome window it opens on
one fixed display, and `spike-check.mjs` puts Obsidian there. The lock is named after the
**screen**, not the job, so all three harnesses can share one claim without knowing about each
other. All three take their own screen lock now and release it on every way out (github#87), so a
caller never has to remember to.

The lock lives in the OS temp dir, not the worktree, so every worktree shares one — and the root
(`obsidian-vault-locks`) is shared with a sister Obsidian plugin, so working on both means their
jobs contend with each other, not just their own (github#92). A `mkdir` is the lock: atomic, and it
survives a killed session as a stale entry (20 min) rather than a permanent one.

## The fixture lock (`suite`)

Two full-suite runs do not fight over ports — each run gets its own free port and Chrome profile.
They fight over `.fixtures/`: a run that regenerates deletes every `<name>-*` directory there,
including the one a concurrent run is reading. That is the `suite` lock, and it is only about
`.fixtures/` — the display is a separate claim under its own name. It bites only when a fixture is
stale, which is why it is rare and reads as a regression in your branch.

## Why not one alias for both

This repo tried aliasing the two names first, and it deadlocks the exact pair that matters:
`.githooks/pre-push` holds `suite` around its own run while the `smoke.mjs` it spawns holds
`screen-left`. With the two names aliased, `aliasHold` blocks on whoever holds the alias — the
asker included — so the hook's own child process waits on a lock the hook itself is holding. Two
separate names is what lets that nesting work at all. A sister plugin (`vault-shelf`) hit the same
deadlock independently and reached the same design (`vault-shelf#37`).

## The pre-push nesting

`.githooks/pre-push` takes the `suite` lock itself, around its own run, and releases it on every
way out (github#92). Do not also wrap a `git push` in an outer acquire/release of either name: the
hook takes `suite` and the `smoke.mjs` it spawns takes `screen-left`, so an outer hold of either
one blocks the hook's own attempt and the push hangs until your stale window expires. A plain
`git push origin develop`/`main`, or a `smoke.mjs` run you drive directly, is correctly gated on
its own and needs no wrapping.
