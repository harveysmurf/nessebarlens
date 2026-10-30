/**
 * The coverage gate's decisions, without the runner.
 *
 * `scripts/coverage.mjs` runs the suite under V8 coverage and then has to
 * answer three questions:
 *
 *   1. is the measured coverage over the floors?
 *   2. is the set of files the gate claims to cover still the set the suite
 *      actually loads?
 *   3. is every script in `scripts/` either measured, or a declared exception
 *      with a reason?
 *
 * All three are pure functions of the report and the list of scripts on disk,
 * so they live here, in a module with no side effects, and the runner keeps
 * only what is not pure: spawning node, reading the report, printing, exiting.
 *
 * The split is the point. The gate's exit code cannot show that these
 * decisions work: "the suite is green" is not evidence about a *failing*
 * gate, because the suite is what the gate runs. A gate whose decisions have
 * never been run against a report that ought to fail is a gate nobody can
 * trust to fail.
 *
 * Two sets are measured, with two floors:
 *
 *   - `src/` — the bounded-context tree and the API route handlers. The floor
 *     is the one this repo has ratcheted since the gate was introduced.
 *   - `scripts/` — the ops scripts, which were outside the gate entirely until
 *     this module existed. They are a third of the repo's JavaScript: 29
 *     `.mjs` files, ~9,100 lines, including the uploader that writes
 *     customer-visible masters to R2 and the two scripts that delete orders.
 *
 * The sets are measured separately because they are different kinds of code
 * with very different floors, and pooling them would make one floor a
 * statement about the other: a 2,198-line uploader held to the same line
 * coverage as the app's domain code would move the mean of the app's own
 * files, and the app's floor is a ratchet with a history.
 *
 * Within a set the floor is the simple mean over the files, for the reason
 * `coverage-report.mjs` already gives: a mean is pessimistic for big files
 * and is therefore safe to ratchet upward.
 */

import { isGatedFile, mean } from "./coverage-report.mjs";

/**
 * The floors for the `src/` set. Ratchet: never lower these, raise them as tests land.
 * @type {{ lines: number; branches: number; functions: number }}
 */
export const SRC_FLOOR = { lines: 99.95, branches: 99.9, functions: 100 };

/**
 * The floors for the `scripts/` set. Ratchet: never lower these, raise them as tests land.
 * @type {{ lines: number; branches: number; functions: number }}
 */
export const SCRIPT_FLOOR = { lines: 83, branches: 84, functions: 78 };

/**
 * The scripts the gate does not measure, each with the reason why.
 *
 * Every other `scripts/*.mjs` is measured — that is the default, so a new
 * script is inside the gate the moment it lands, and the only way out is to
 * say here, in a reason, why it cannot be measured.
 *
 * A script that cannot be loaded by the suite is the case that matters: node's
 * report lists loaded modules only, so a script no test imports is silently
 * absent from the gate's denominator.
 *
 * @type {Record<string, string>}
 */
export const SCRIPT_ALLOW_LIST = {
  "scripts/coverage.mjs":
    "the gate runner itself: it spawns the suite, so the suite never loads it. " +
    "Its decisions live in scripts/coverage-gate.mjs, which the suite does load " +
    "and which the gate does measure; what is left here is the spawn and the " +
    "printing, which have nothing to assert.",
};

/** The metrics both floors are stated over. */
const METRICS = ["lines", "branches", "functions"];

/**
 * True when the path is one of the scripts the gate measures.
 *
 * The `src/` side of that question is `isGatedFile` in `coverage-report.mjs`,
 * which is a pattern over the source tree; this one is a pattern over the ops
 * scripts, which are named by the allow-list above rather than by their path.
 *
 * @param {string} file
 * @param {Record<string, string>} [allowList]
 */
export function isGatedScript(file, allowList = SCRIPT_ALLOW_LIST) {
  return file.endsWith(".mjs") && file.startsWith("scripts/") && !(file in allowList);
}

/**
 * The gate's verdict.
 *
 * `rows` are the parsed coverage rows (see `parseCoverage`), `scriptFiles` the
 * `scripts/*.mjs` paths found on disk. The result is the measured coverage
 * per set, the failures that make the gate red, and the files each set covers.
 *
 * Every failure is a sentence, because the runner prints them and the operator
 * reads them: a gate that exits 1 without saying which file and which metric
 * is a gate that gets disabled.
 *
 * @param {{
 *   rows: Array<{ file: string; lines: number; branches: number; functions: number; uncovered: string }>;
 *   scriptFiles: string[];
 *   allowList?: Record<string, string>;
 * }} input
 */
export function gate({ rows, scriptFiles, allowList = SCRIPT_ALLOW_LIST }) {
  /** @type {string[]} */
  const failures = [];

  const src = rows.filter((row) => isGatedFile(row.file));
  const measuredScripts = scriptFiles.filter((file) => isGatedScript(file, allowList));
  const measured = rows.filter((row) => measuredScripts.includes(row.file));

  if (src.length === 0) {
    failures.push(
      "no src/ file under the bounded-context tree or src/app/api is in the coverage report",
    );
  }
  if (measured.length === 0) {
    failures.push("no scripts/*.mjs file is in the coverage report");
  }

  // A gated script that is not in the report is a script no test loads. The
  // report lists loaded modules only, so without this the gate would simply
  // measure one file fewer and stay green — the coverage-gate blind spot.
  const reported = new Set(rows.map((row) => row.file));
  for (const file of measuredScripts) {
    if (!reported.has(file)) {
      failures.push(`${file} is not in the coverage report: no test loads it`);
    }
  }

  // An allow-list entry that names a script which is gone is a hole with a
  // name on it: the script was renamed or deleted and the exception stayed.
  for (const [file, reason] of Object.entries(allowList)) {
    if (!scriptFiles.includes(file)) {
      failures.push(`the allow-list names ${file}, which is not in scripts/ any more`);
    }
    if (reason.trim() === "") {
      failures.push(`the allow-list names ${file} without a reason`);
    }
  }

  const actual = {
    src: { lines: mean(src, "lines"), branches: mean(src, "branches"), functions: mean(src, "functions") },
    scripts: {
      lines: mean(measured, "lines"),
      branches: mean(measured, "branches"),
      functions: mean(measured, "functions"),
    },
  };

  const floors = { src: SRC_FLOOR, scripts: SCRIPT_FLOOR };
  for (const set of ["src", "scripts"]) {
    const floor = floors[set];
    for (const metric of METRICS) {
      if (actual[set][metric] < floor[metric]) {
        failures.push(
          `${set} ${metric} ${actual[set][metric].toFixed(2)}% < ${floor[metric]}%`,
        );
      }
    }
  }

  return {
    actual,
    failures,
    measured: { src, scripts: measured },
  };
}
