/**
 * #205 item 1: the required status checks are a repository setting, so nothing
 * in the repo can force them to stay correct. This module is the bridge:
 *
 *   .github/required-checks.txt   what we intend to require, committed
 *   ci.yml                        the jobs that exist and which of them can block
 *   the live branch protection     what GitHub actually requires
 *
 * Run it BY HAND, from a machine holding a token that can read branch
 * protection: `GITHUB_TOKEN=$(gh auth token) node scripts/required-checks.mjs`.
 *
 * It is deliberately NOT a step in ci.yml, and the reason is a platform limit
 * rather than a preference. Reading the protection rule needs the
 * `administration` permission; a job's GITHUB_TOKEN cannot be granted it (it is
 * not among the scopes `permissions:` accepts), and no other token Actions
 * supplies carries it. A workflow step physically cannot read the setting it
 * would have to compare. Wiring it in anyway only produces a step that exits 4
 * "no GITHUB_TOKEN/GH_TOKEN" forever while reporting nothing about real drift,
 * which is what it did while it was in ci.yml.
 *
 * Making it a real gate would mean an admin-scoped PAT in Actions secrets,
 * which parks a repo-admin credential exactly where the job-scoped-permissions
 * discipline in #209 keeps it out. Not worth it for drift that is rare,
 * deliberate, and cheap to catch by hand.
 *
 * The per-run half is automated and free: tests/branch-protection.test.mts
 * holds the committed list against ci.yml in both directions on every test run.
 *
 * Exported so tests/branch-protection.test.mts asserts against the same parse
 * the script uses, instead of a second implementation that can disagree. That
 * export is why the module still needs to exist even though nothing runs it
 * automatically.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(import.meta.dirname, "..");
const listFile = path.join(root, ".github", "required-checks.txt");
const ciFile = path.join(root, ".github", "workflows", "ci.yml");

/**
 * The `jobs:` block of a workflow, parsed by indentation. No YAML dependency
 * exists in this repo and adding one for four fields is not worth the install;
 * this reads `jobs:`, then each two-space-indented job id and its body up to
 * the next one.
 */
export function parseJobs(text) {
  const lines = text.split("\n");
  const jobsAt = lines.findIndex((line) => /^jobs:[ \t]*$/.test(line));
  if (jobsAt === -1) throw new Error("no jobs: block");

  const jobs = [];
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const head = /^ {2}([A-Za-z0-9_-]+):[ \t]*$/.exec(lines[i]);
    if (!head) {
      if (/^[^\s#]/.test(lines[i]) && lines[i].trim() !== "") break;
      continue;
    }
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^ {2}\S/.test(lines[j])) break;
      body.push(lines[j]);
    }
    const name = /^\s+name:\s*(.+)$/m.exec(body.join("\n"))?.[1]?.trim();
    if (name === undefined) throw new Error(`job ${head[1]} has no name:`);
    jobs.push({
      id: head[1],
      name: name.replace(/^["']|["']$/g, ""),
      // A soft-failed job cannot gate anything, so requiring its check name
      // would block merges on a result the workflow itself ignores.
      soft: /^\s+continue-on-error:\s*true\b/m.test(body.join("\n")),
    });
  }
  return jobs;
}

/** Contexts from .github/required-checks.txt, comments and blanks dropped. */
export function readRequiredContexts(file = listFile) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0);
}

export function ciJobs() {
  return parseJobs(fs.readFileSync(ciFile, "utf8"));
}

async function protection({ repo, token, baseUrl }) {
  const response = await fetch(
    `${baseUrl ?? "https://api.github.com"}/repos/${repo}/branches/main/protection`,
    { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } },
  );
  if (!response.ok) {
    throw new Error(`branch protection read failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

/** Both spellings: the `checks` array when app_id is set, else legacy contexts. */
export function liveContexts(rule) {
  const checks = rule.required_status_checks?.checks ?? [];
  return checks.length > 0
    ? checks.map((check) => check.context)
    : (rule.required_status_checks?.contexts ?? []);
}

/**
 * The copy-pasteable fix for drift. It targets `/required_status_checks`
 * because `branches/main/protection` itself accepts PUT only: a PATCH there
 * returns 404 whatever the token's scopes, which is how this hint once sent
 * the person fixing the drift down a dead end. The body uses `checks` rather
 * than the legacy `contexts`: when both are sent GitHub honours `checks` and
 * ignores `contexts`, so writing the legacy field would report success while
 * changing nothing. 15368 is GitHub Actions.
 */
export function remediationCommand(repo, declared) {
  const body = {
    strict: true,
    checks: declared.map((context) => ({ context, app_id: 15368 })),
  };
  return [
    `  gh api -X PATCH repos/${repo}/branches/main/protection/required_status_checks --input - <<'JSON'`,
    JSON.stringify(body, null, 2),
    "JSON",
  ].join("\n");
}

async function main() {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_API_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY ?? "harveysmurf/nessebarlens";
  if (!token) {
    console.error(
      "::error::no GITHUB_TOKEN/GH_TOKEN; cannot verify branch protection. " +
        "Not reporting success on a check that did not run.",
    );
    return 4;
  }

  const declared = readRequiredContexts();
  const live = liveContexts(await protection({ repo, token }));

  const missing = declared.filter((context) => !live.includes(context));
  const extra = live.filter((context) => !declared.includes(context));

  for (const context of missing) console.error(`::error::${context} is required in ${listFile} but not by branch protection`);
  for (const context of extra) console.error(`::error::${context} is required by branch protection but not in ${listFile}`);

  if (missing.length === 0 && extra.length === 0) {
    console.log(`branch protection requires exactly the ${declared.length} declared check(s): ${declared.join(", ")}`);
    return 0;
  }
  console.error(`\nSet the rule to exactly the committed list:\n${remediationCommand(repo, declared)}`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await main();
  if (result !== 0) process.exitCode = result;
}