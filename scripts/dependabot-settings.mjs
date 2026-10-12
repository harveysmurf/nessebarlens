/**
 * #359: Dependabot's *security* half is a repository setting, not a file. The
 * 2026-10-11 audit found `security_and_analysis.dependabot_security_updates`
 * `disabled` and Dependabot alerts off, while `.github/dependabot.yml` still
 * ended with "Security updates are on by default in v2 and are not turned off
 * anywhere here". That comment was false in practice: a disabled repo setting
 * overrides the file, and `tests/dependabot-config.test.mts` only reads the
 * YAML, so it cannot see a setting that lives in the GitHub API.
 *
 * This module is the bridge, and it follows scripts/required-checks.mjs for the
 * same platform reason: reading `security_and_analysis` needs read access to a
 * repository setting, which a job's `GITHUB_TOKEN` cannot be granted. So it is
 * run BY HAND, not as a ci.yml step:
 *
 *   GITHUB_TOKEN=$(gh auth token) node scripts/dependabot-settings.mjs
 *
 * Both halves are checked together because they fail together: alerts feed the
 * alert list, security updates open the PR that closes an advisory. A repo with
 * one on and one off is a repo that either sees an advisory it never fixes, or
 * fixes one it never shows.
 *
 * Red/green, not just green: `settingsProblems` is exported so
 * `tests/dependabot-settings.test.mts` can assert it flags a disabled repo and
 * clears an enabled one without a network call or a real repository.
 */

import { fileURLToPath } from "node:url";

const DEFAULT_REPO = "harveysmurf/nessebarlens";

/**
 * The findings for one snapshot of the live settings. Empty means green.
 *
 * `securityUpdates` is the raw `status` string from GitHub, or `undefined` when
 * the field is absent — an older token can omit `security_and_analysis`
 * entirely, and "unknown" must not read as "on".
 */
export function settingsProblems({ securityUpdates, alerts }) {
  const problems = [];
  if (securityUpdates !== "enabled") {
    problems.push(
      `Dependabot security updates are "${securityUpdates ?? "unknown"}", not "enabled" — no security PR can ever open`,
    );
  }
  if (!alerts) {
    problems.push("Dependabot alerts are disabled — the repository cannot show an advisory it needs to fix");
  }
  return problems;
}

/** The copy-pasteable fix; both writes need administration access, so by hand. */
export function remediationCommands(repo = DEFAULT_REPO) {
  const body = { security_and_analysis: { dependabot_security_updates: { status: "enabled" } } };
  return [
    `  gh api -X PATCH repos/${repo} --input - <<'JSON'`,
    JSON.stringify(body, null, 2),
    "JSON",
    `  gh api --method PUT repos/${repo}/vulnerability-alerts`,
  ].join("\n");
}

export async function readDependabotSettings({ repo, token, baseUrl = "https://api.github.com" }) {
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" };

  const repoResponse = await fetch(`${baseUrl}/repos/${repo}`, { headers });
  if (!repoResponse.ok) {
    throw new Error(`repository read failed: ${repoResponse.status} ${await repoResponse.text()}`);
  }
  const securityUpdates = (await repoResponse.json())?.security_and_analysis
    ?.dependabot_security_updates?.status;

  // 204 = alerts enabled, 404 = disabled. Neither carries a body, so the status
  // is the whole answer; anything else is an auth/transport failure and must
  // not be flattened into a boolean.
  const alertsResponse = await fetch(`${baseUrl}/repos/${repo}/vulnerability-alerts`, { headers });
  let alerts;
  if (alertsResponse.status === 204) alerts = true;
  else if (alertsResponse.status === 404) alerts = false;
  else {
    throw new Error(
      `vulnerability-alerts read failed: ${alertsResponse.status} ${await alertsResponse.text()}`,
    );
  }

  return { securityUpdates, alerts };
}

async function main() {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_API_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY ?? DEFAULT_REPO;
  if (!token) {
    console.error(
      "::error::no GITHUB_TOKEN/GH_TOKEN; cannot verify Dependabot settings. " +
        "Not reporting success on a check that did not run.",
    );
    return 4;
  }

  const problems = settingsProblems(await readDependabotSettings({ repo, token }));
  for (const problem of problems) console.error(`::error::${problem}`);

  if (problems.length === 0) {
    console.log("Dependabot alerts and security updates are both enabled");
    return 0;
  }
  console.error(`\nEnable both in Settings -> Code security and analysis, or run:\n${remediationCommands(repo)}`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await main();
  if (result !== 0) process.exitCode = result;
}
