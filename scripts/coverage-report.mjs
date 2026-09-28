/**
 * Parses node's `--experimental-test-coverage` table.
 *
 * Kept separate from the runner so it can be tested against the report text of
 * more than one node version. The format is not frozen, and the two versions in
 * play disagree:
 *
 *   node 20 — one flat row per file, path in the first column:
 *              # src/lib/sku-map.ts | 78.13 | 100.00 | 100.00 | 74-80
 *
 *   node 22 — a directory tree, path split across indented rows:
 *              # src                       |      |      |      |
 *              #  lib                      |      |      |      |
 *              #   sku-map.ts              | 78.13 | 100.00 | 100.00 | 74-80
 *
 * CI runs node 22 and local runs are node 20. A parser that only understands
 * one of them fails CI with "no rows" on a perfectly green suite, which is
 * exactly the bug this split exists to prevent. The node 22 fixture below is
 * captured verbatim from a real run.
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
  // node 22's tree nests by indentation, one leading space per level after
  // the report's "# ": " src", "  lib", "   sku-map.ts". Keep one name per
  // level so the path can be rebuilt.
  const dirs = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^#\s?/, "").trimEnd();
    if (!line.includes("|")) continue;
    const columns = line.split("|");
    const indent = columns[0].length - columns[0].trimStart().length;
    const [name, lines, branches, functions] = columns.map((part) => part.trim());
    if (columns.length < 4) continue;

    if (!FILE_NAME.test(name)) {
      // A directory row carries no percentages. "all files" is a summary, not
      // a directory, and must never become a path prefix.
      const isSummary = name === "all files";
      if (!isSummary && lines === "" && branches === "" && functions === "") {
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
