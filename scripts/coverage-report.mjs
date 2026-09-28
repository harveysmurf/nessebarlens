/**
 * Parses node's `--experimental-test-coverage` table.
 *
 * Kept separate from the runner so it can be tested against the report text of
 * more than one node version. The format is not frozen, and the versions in play
 * disagree twice over — by layout, and by whether the reporter prefixes lines
 * when stdout is not a TTY:
 *
 *   node 20 — one flat row per file, path in the first column:
 *              # src/lib/sku-map.ts | 78.13 | 100.00 | 100.00 | 74-80
 *
 *   node 24 — a directory tree, path split across indented rows, and every
 *              line prefixed with a reporter marker when not a TTY:
 *              ℹ src                       |      |      |      |
 *              ℹ  lib                      |      |      |      |
 *              ℹ   sku-map.ts              | 78.13 | 100.00 | 100.00 | 74-80
 *
 * A parser that only understands the running node's output fails with "no rows"
 * on a perfectly green suite, which is exactly the bug this split exists to
 * prevent. The fixtures in the test are captured verbatim from real runs.
 */

const FILE_NAME = /\.[cm]?[jt]sx?$/;

/** "file:///a/b/src/lib/x.ts" and "/a/b/src/lib/x.ts" both become "src/lib/x.ts". */
function repoRelative(name) {
  return name
    .replace(/^file:\/\//, "")
    .replace(/^.*?(?=(?:^|\/)(?:src|tests|scripts)\/)/, "")
    .replace(/^\/+/, "");
}

/**
 * One file's coverage. `file` is always a path relative to the repo root,
 * whichever layout the report used.
 */
export function parseCoverage(text) {
  const rows = [];
  // The tree nests by indentation, one leading space per level after the
  // report's marker: " src", "  lib", "   sku-map.ts". Keep one name per
  // level so the path can be rebuilt.
  const dirs = [];
  for (const raw of text.split("\n")) {
    // The reporter prefixes each line when stdout is not a TTY — "ℹ src" in CI,
    // "# src" in a captured fixture. Strip whatever marker is there before
    // measuring indentation, or every directory level is off by the marker.
    const line = raw.replace(/^\s*(?:#|[ℹ✔✖✗›⚠])\s?/, "").trimEnd();
    if (!line.includes("|")) continue;
    const columns = line.split("|");
    const indent = columns[0].length - columns[0].trimStart().length;
    const [name, lines, branches, functions] = columns.map((part) => part.trim());
    if (columns.length < 4) continue;

    if (!FILE_NAME.test(name)) {
      // A directory row carries no percentages. "all files" is a summary, not
      // a directory, and must never become a path prefix — nor must the ".."
      // rows node emits when it collapses a deep absolute path.
      const isSummary = name === "all files";
      if (name !== ".." && !isSummary && lines === "" && branches === "" && functions === "") {
        dirs[indent] = name;
        dirs.length = indent + 1;
      }
      continue;
    }

    const pct = (value) => Number.parseFloat(value);
    if ([lines, branches, functions].some((value) => Number.isNaN(pct(value)))) continue;
    const parent = name.includes("/")
      ? ""
      : dirs.slice(0, indent).filter(Boolean).join("/");
    rows.push({
      // Tolerate file:// prefixes and absolute paths from newer reporters.
      file: (parent ? `${parent}/` : "") + repoRelative(name),
      lines: pct(lines),
      branches: pct(branches),
      functions: pct(functions),
      uncovered: columns.slice(4).join("|").trim(),
    });
  }
  return rows;
}

/**
 * True when the path is a source file under src/lib, whatever the report used
 * to make it absolute.
 */
export function isLibFile(file) {
  return /(^|\/)src\/lib\/[^/]+\.[cm]?[jt]sx?$/.test(file);
}

/** Mean of one metric over the given rows. */
export function mean(rows, key) {
  if (rows.length === 0) return 0;
  return rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
}
