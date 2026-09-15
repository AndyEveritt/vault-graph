# 0015 — Mirror the sortspec text, not the explorer

**Date** 2026-09-08 · **Status** accepted · **Relates to** github#71, `design/0001`, `design/0004`, `decisions/0009`

## Context

`design/0001` promised that wedges "go round the disc in the same sequence as the vault's own
folder list". That is true only while the file explorer is sorted by name. A vault running
[Custom File Explorer sorting](https://github.com/SebastianMC/obsidian-custom-sort) has an
explorer order the disc knew nothing about, and the DDR's sentence was false there.

## What was rejected

**Reading the explorer's resolved order.** The obvious move, and there is nothing to read. That
plugin exposes no public API for its order; it works by patching the explorer's own sort. The
only way to observe the result is the explorer's DOM, which would be a private-API dependency on
a *third-party plugin's* rendering — worse than the Obsidian-internal dependencies this repo has
so far stayed clear of, because it would break on that plugin's markup rather than on Obsidian's.
It also only works when the explorer pane happens to be open and the plugin happens to be on
(`sort-on` is not automatic at startup).

**Depending on the plugin being installed at all.** The exporter has no Obsidian to ask, and the
page must work standalone. A spec is a file; a file can be read by both hosts.

## The decision

**Parse the spec text, and only the subset that decides order.**

| read | ignored, with a notice naming the line |
|---|---|
| `target-folder:` — exact, `/`, `.`, `X/*`, `/regex/` | every other directive and punctuation-led marker |
| bare names, as ordered pins | `order-asc`/`order-desc` over `created` and `modified` |
| `order-asc` / `order-desc` over `a-z` | |
| the precedence: exact path > exact name > regexp > wildcard | |

Three things fall out of that table and each is load-bearing.

**`created` and `modified` are understood and deliberately not applied.** The plugin sorts
folders by their *filesystem* timestamps. The page has no folder timestamps — only the notes
inside a folder, whose dates would give a different answer under the same name. Agreeing loudly
and wrongly is worse than skipping and saying so.

**A parse failure falls back to name order, never to half a spec.** A partly-applied order is
indistinguishable from a bug at a glance, and a disc nobody can trust is worse than a disc in
the order it always had.

**A pin naming something that is not there is not an error.** Specs outlive the folders they
name, and a real root section usually pins *files*, which are not folders at all and can never
match. Both are normal wear: the pin does not appear, nothing is skipped, nothing is reported.

## Only two questions ever reach the parser

`paraDirs()` keeps `dirs[0]` and stops at the first `YYYY-MM` segment, so the disc has exactly
two levels. Of a deep spec's many sections only two kinds can reach it:

- the section targeting the **vault root** orders the wedges;
- the section targeting a **top-level folder** orders that folder's sub-wedges.

Sections aimed deeper are parsed, kept, and never asked about. They are not errors — they are
invisible here. The setting's own description says so, because a vault that wrote a
three-level spec and got two levels of effect deserves to be told rather than left to wonder.

## Where the code lives, and why there

The grammar is in `src/page.js`, at **module scope**. Two constraints pin it there:

- it is the one file both hosts share, so the parser exists once rather than twice;
- the exporter pastes that file in as **text** (`asScript()`), stripping only the trailing
  `export {}`, so the file can carry no `import` — a shared module is not available to it;
- module scope, outside the three `BEGIN/END` regions `scripts/build-plugin.mjs` strips, or the
  plugin would ship without it.

The hosts only *find* the text, and they differ because their sources differ: the exporter reads
the block scalar itself (its frontmatter parser flattens every value and has never needed YAML),
the plugin takes it from the metadata cache already parsed. Both look in the same three places —
a `sortspec.md` in any folder, a folder note's front matter, and the file named in the sort
plugin's own `data.json`.

The exporter additionally takes `--sortspec <file>` and `--folder-order <mode>`. The second is
not decoration: `decisions/0009` says the page stores nothing and the host persists settings, and
a standalone page's host is `localStorage` — which is empty on first open. Without a build flag a
page shipped with a spec would open in name order every time and the spec would be dead weight.
`--sortspec` only adds a source; it does not switch the mode by implication.

## What this must not break, and how it is held

**Colour.** The automatic palette slot is a group's index in the array `buildColors()` walks, so
following the draw order would repaint the whole disc whenever the order moved — and the golden
snapshots would not notice, because they hold positions and band, not colour. `computeOrder()`
emits a second, always-name-ordered array and the slot walk reads only that. Checked by *a folder
keeps its colour when the wedge order changes*.

**The rank.** `(vault root)`, the `_`-archives and `(unlinked)` keep the places `design/0001`
gave them in every mode. Only the real-folder bucket is re-sorted.

**Dots.** This moves wedges and rows. A note's radius is its link weight and nothing steps
between them; the serpentine inside a wedge is untouched.

**The other three fixtures.** None carries a spec and the default is still `Name`, so all three
goldens must be byte-identical — verified by regenerating all four and finding only the new one
changed. `spec-vault` is the fourth, and the only fixture laid out in anything but name order.

## D-12 — the spec orders FOLDER wedges only

`github#86` landed the grouping dimension while this work was parked: the disc can now be cut by
**tag** as well as by folder. A sortspec names *folders*, so the explorer order is a
folder-dimension answer, and both `drawOrder()` and `buildSubOrder()` gate it on
`state.dim === "folder"`. Left open, a root section's pins would reorder a **tag** that merely
shares a folder's name — a vault with an `03 - Resources` folder and an `#03 - Resources` tag would
see the tag disc quietly inherit the folder's pins.

`size` is deliberately **not** gated: biggest-tag-first means something, and it needs no spec.

## Absence means nobody has chosen, and then the vault decides

`folderOrder` is **absent** from the plugin's defaults rather than set to `"name"`. When the page
sees no value it decides from the vault: `explorer` if a sortspec was found, `name` otherwise. A
vault that ships a spec is one whose owner has already said what order they want things in, so
opening it in name order shows them an order they deliberately moved away from. Same idiom as
`sheetOpen`/`bandOpen`, where absent means "decide from the width" (`github#82`).

An explicit value always wins, which is what makes a choice stick: the host persists on every
change (`decisions/0009`), so a reader who picks Name keeps Name even in a spec-carrying vault.

**Both settings surfaces must therefore report the RESOLVED mode, not the stored one.** With
nothing stored, a control showing the stored value reads "Name" over a disc that is not in name
order, and picking Name — already the visible selection — looks like a no-op. `liveFolderOrder()`
peeks at a loaded view for what the page actually chose. It is safe to read `leaf.view` there
precisely because a deferred leaf hands back a stub that fails the `instanceof`: no mounted page
means nothing to report, which is the right answer rather than a reason to force a leaf open from
a settings render.

## The legend tail says "other", not "smaller", under a spec

`"N smaller subfolders"` is only true while the order *is* size. Under a spec the tail can hold
subfolders **bigger** than the named ones, so the row reads `"N other subfolders"` whenever the
order is not size.

## The mirror vault translates a spec; it never copies one

`scripts/make-mirror-vault.mjs` exists to check a real vault's **shape** without its content, and
since this issue a vault's shape includes the order its file explorer is in. A mirror with no
sortspec cannot exercise the one feature the source vault leans on hardest, which makes it the
wrong tool for exactly the check it exists for. So the mirror carries one — under four rules.

- **A spec is an ordinary note, so it is mirrored as one**, translated in place rather than
  written alongside. Bolting it on afterwards produced *both* a spec file and a random-titled note
  that had been the original: the folder carried one note more than the source, and the real spec
  note was a ghost nobody could find.
- **It is TRANSLATED, never copied.** Every `target-folder:` path and every pinned name goes
  through the same `dirMap` and `nameMap` the notes did, so the mirror carries the spec's
  *structure* — its pins, its `order-` lines, its precedence, its depth — and none of its real
  names. That is not tidiness. A person folder under a 1-on-1 tree **is a real person**, and
  copying a spec verbatim would put every one of them into a vault whose entire purpose is that it
  holds none. Comments go too, being prose someone wrote.
- **A line naming something not in the mirror is dropped, not passed through.** The page treats an
  unresolvable pin as ordinary wear and would carry on, but a mirror that kept real names for what
  it failed to map would be leaking the thing it cannot leak.
- **A spec is found BY ITS NAME**, so renaming it would hide it from the builder. A `sortspec`
  keeps that name; a folder note keeps its folder's mapped name, or it stops being a folder note.
  The sort plugin's own `data.json` is rewritten to point at the mirrored note, so a globally
  registered spec is found in the mirror exactly as in the source.

## Not built

Ordering taken from an Obsidian **bookmarks group**
(`bookmarksGroupToConsumeAsOrderingReference`), which that plugin also supports. It is a second
source with a second set of semantics, and the vault this feature was built for has it
configured but empty. If it is ever wanted, it belongs behind the same fallback rule as the
rest.
