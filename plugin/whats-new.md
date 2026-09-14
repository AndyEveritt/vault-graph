<!--
  The update note the plugin shows ONCE, on the first open after a MINOR or MAJOR update
  (github#83, design/0016). Three line kinds, in any order after the heading:

    # 2.6.0          the release this note is for -- one per file, and it must be the one
                     being cut, or the strip stays silent rather than showing a stale note
    - <text>         up to five bullets, plain text: what you can now do, not how it was
                     built. No markup, no images, no links -- the strip builds its own
    > vg-dim         up to four control ids from src/page.html: what this release ADDED.
                     They pulse while the note is up and stop when it is dismissed. Leave
                     the line out when a release adds no control of its own

  The strip links out on its own: one link per release between the version last seen and
  this one, oldest first, plus the feature gallery. The release branch rewrites this file
  beside the CHANGELOG entry; a PATCH leaves it as it is, and shows nothing.
  scripts/build-plugin.mjs refuses a file that breaks any of that.
-->
# 2.8.0
- Three chips under the calendar band halo what you touched today, in the last seven days, or since you last had the graph open.
- The band counts either date, Added or Touched, and every chip says which one it means.
- The band's controls sit in one row at one height, and the fewer-more key is gone.
- Two grey colour slots stay out of the automatic rotation, so a group is grey only on purpose.
- The inner ring gets room in proportion to what it carries, and the outer ring's first row sits on the ring instead of crossing it.
> vg-recent
> vg-heatsrc
