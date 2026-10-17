<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Tailwind scans file text, not code

Tailwind v4 finds candidate class names by reading **file text** anywhere under
the project root. A utility named in an assertion, a comment, or an ordinary
sentence becomes a real rule in the shipped stylesheet. There is no "code only"
mode, and deleting a utility from `src/` does not delete its rule while something
else still mentions it.

So the paths that are not pages are excluded explicitly, with `@source not`
directly above the token block in `src/app/globals.css`: the test suite,
`scripts/`, `DEVELOPMENT.md`, and this file. That comment block is where the
long version lives; it is the thing to read before touching the theme.

**What that means for the next change here:**

- **Exclusion is explicit and named, never counted.** `border-palette.test.mts`
  lists each excluded path individually, because an unscanned path is the failure
  it exists for and "three are excluded" would not say which one went missing. A
  new doc or test directory goes in that list in the same commit it is created.
- **Do not name a utility in this file.** It is excluded, but the discipline is
  the point: describe a colour by its ramp and step ("the muted text step", "the
  retired border step"), not by the class name. A file that documents the hazard
  must not be an instance of it.
- **A test that asserts on compiled CSS narrows its own build** — `source(none)`
  plus an explicit `@source` — so the suite's own quoted class names cannot
  satisfy the assertion. `gallery-tiles.test.mts` established that pattern; its
  header explains why compiling beats reading source, since a plausible-looking
  string can emit nothing and still satisfy a source-text assertion.
- **A dead rule is worse than dead code**: it tells the production stylesheet a
  colour or a layout is available when the design says it is not. That is why the
  contrast and palette checks derive their values from `globals.css` instead of
  hard-coding literals — a literal keeps passing after the background moves.
- **Guards assert source text, not a default-detection build.** The scan cache is
  keyed on file content and returned stale candidates, so a measurement of a
  default build passed over a mutation that should have failed it. A guard that
  can pass when it should fail is worse than no guard; prefer a check you can
  demonstrate failing by mutation.
