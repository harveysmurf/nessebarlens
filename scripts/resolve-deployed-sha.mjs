#!/usr/bin/env node
/**
 * Which commit production is actually serving (#405).
 *
 * The daily drift check reads the catalog of the **deployed** commit, not of
 * `main`. The two are different by design and after #404 they differ routinely:
 * a photo PR merged before `--promote` leaves `main` listing a photo whose
 * master was never written, which the release gate already refuses to deploy.
 * Checking `main` would re-report that known, already-failing release as fresh
 * drift every morning, and the incident it opens would be about a commit no
 * user can reach.
 *
 * So: resolve the version holding 100% of traffic, read that version's
 * `prod-<sha>` tag, and check out that sha. The tag is what makes this
 * trustworthy — a version id alone does not say which commit it was built from,
 * and `wrangler versions view --json` returns it as an annotation
 * (`workers/tag`), the same annotation `release.yml` writes with
 * `--tag="prod-$COMMIT_SHA"`.
 *
 * There is deliberately no fallback to `main`. A green run that checked the
 * wrong commit is worse than a red one: it closes the incident that says
 * production is serving a listing it cannot fill.
 *
 *   node scripts/resolve-deployed-sha.mjs
 *
 * Prints the sha on stdout, and writes `sha=<sha>` to `$GITHUB_OUTPUT` when
 * that variable is set. Needs `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
 * and a checkout with dependencies, because it shells out to wrangler.
 *
 * The two decisions are pure and exported: the wrangler JSON shapes are the
 * part that can change under us, and a fixture is the only way to test against
 * them without a Cloudflare account.
 */

import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

/**
 * The tag `release.yml` writes on every production deploy. Anchored and
 * full-length: a tag that merely starts with `prod-` is not a commit id, and
 * checking out something derived from it is not a thing this script should be
 * able to do.
 */
const PROD_TAG = /^prod-([0-9a-f]{40})$/;

/**
 * @typedef {{version_id?: string, percentage?: number}} DeploymentVersion
 * @typedef {{created_on?: string, versions?: DeploymentVersion[]}} Deployment
 * @typedef {{id?: string, annotations?: Record<string, string>}} Version
 */

/**
 * The version id serving 100% of traffic, or `undefined` when none does.
 *
 * Wrangler sorts `deployments list --json` ascending by `created_on`, so this
 * re-sorts rather than trusting the order it was handed: "the newest
 * deployment that holds all the traffic" is the answer, and taking the last
 * element of an array because the CLI happened to sort it is a different
 * answer that breaks silently if the CLI changes.
 *
 * Last-wins across the flattened stream, which is what the release's own jq
 * (`last(.[] | .versions[] | select(.percentage == 100) | .version_id)`)
 * computes.
 * @param {Deployment[]} deployments
 * @returns {string | undefined}
 */
export function servingVersionId(deployments) {
  const ordered = [...deployments].sort((a, b) =>
    String(a?.created_on ?? "").localeCompare(String(b?.created_on ?? "")),
  );
  let found;
  for (const deployment of ordered) {
    for (const version of deployment?.versions ?? []) {
      if (version?.percentage === 100 && version?.version_id) found = version.version_id;
    }
  }
  return found;
}

/**
 * The commit a deployed version was built from, read from its tag.
 *
 * Throws rather than returning `undefined`: every caller here has only one
 * correct answer, and a caller that continues without it checks the wrong
 * commit.
 * @param {Version} version
 * @param {string} [versionId] the id being read, for the message
 * @returns {string}
 */
export function deployedShaFromVersion(version, versionId = "") {
  const tag = version?.annotations?.["workers/tag"];
  const match = typeof tag === "string" ? PROD_TAG.exec(tag) : null;
  if (!match?.[1]) {
    const label = version?.id ?? versionId;
    throw new Error(
      label
        ? `the version serving production (${label}) has no prod-<sha> tag (tag: ${JSON.stringify(tag ?? null)}); refusing to guess which commit is deployed`
        : `no deployed version tag to read a prod-<sha> from; refusing to guess which commit is deployed`,
    );
  }
  return match[1];
}

/**
 * Resolve the deployed commit through wrangler: the 100% version, then its tag.
 * @param {{run?: (file: string, args: string[]) => Promise<{stdout: string}>}} [options]
 * @returns {Promise<string>}
 */
export async function resolveDeployedSha({ run = defaultRun } = {}) {
  const deployments = parseJson(
    (await run("wrangler", ["deployments", "list", "--json"])).stdout,
    "deployments list",
  );
  if (!Array.isArray(deployments)) {
    throw new Error("`wrangler deployments list --json` did not return an array");
  }
  const versionId = servingVersionId(deployments);
  if (!versionId) {
    throw new Error(
      "no version holds 100% of production traffic; production may be mid-deploy, or every deployment is a partial rollout",
    );
  }
  const version = parseJson(
    (await run("wrangler", ["versions", "view", versionId, "--json"])).stdout,
    "versions view",
  );
  return deployedShaFromVersion(version, versionId);
}

/**
 * wrangler prints progress and warnings on stderr and its JSON on stdout, so
 * only stdout is parsed. A parse failure here means the CLI's contract moved,
 * which is the one thing worth a loud message.
 * @param {string} stdout
 * @param {string} what
 */
function parseJson(stdout, what) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`could not parse ${what} --json output: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Run wrangler from the repository's own dependencies. `npx` resolves the
 * pinned version rather than downloading whatever is newest.
 * @param {string} file
 * @param {string[]} args
 */
async function defaultRun(file, args) {
  const { stdout } = await execFileAsync("npx", ["--no-install", file, ...args], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout };
}

async function main() {
  const sha = await resolveDeployedSha();
  console.log(`production is serving commit ${sha}`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
