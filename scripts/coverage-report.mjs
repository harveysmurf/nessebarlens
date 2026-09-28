/**
 * Parses node's `--experimental-test-coverage` table.
 *
 * Kept separate from the runner so it can be tested against the report text of
 * more than one node version: the format is not frozen, and node 22 on CI
 * renders the file column differently from node 20 locally (absolute paths,
 * different padding). A parser that only understands the local shape fails CI
 * with "no rows", which is exactly the bug this split exists to prevent.
 */

/** One file's coverage: percentages plus the source text of the table row. */
export function parseCoverage(text) {
  const rows = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^#\s?/, "").trimEnd();
    if (!line.includes("|")) continue;
    const columns = line.split("|").map((part) => part.trim());
    if (columns.length < 4) continue;
    const [file, lines, branches, functions] = columns;
    // A file row ends in a real extension; the header row says "line %".
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const pct = (value) => Number.parseFloat(value);
    if ([lines, branches, functions].some((v) => Number.isNaN(pct(v)))) continue;
    rows.push({
      // Tolerate file:// prefixes and absolute paths from newer reporters.
      file: file.replace(/^file:\/\//, ""),
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
