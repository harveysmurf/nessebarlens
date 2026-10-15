/**
 * #205 item 1: the required status checks are a repository setting, so nothing
 * in the repo can force them to stay correct. This module is the bridge:
 *
 *   .github/required-checks.txt   what we intend to require, committed
 *   ci.yml                       trusted status producers and which can block
 *   the live branch protection     what GitHub actually requires
 *
 * Run it BY HAND, from a machine holding a token that can read branch
 * protection: `GITHUB_TOKEN=$(gh auth token) node scripts/required-checks.mjs`.
 *
 * #413: the declared side is read from the DEFAULT BRANCH over the API, not
 * from the working tree. The live rule is remote state and the file was local
 * state, so the two described different points in time and every verdict from a
 * non-default checkout was about a repository that does not exist. Worse, the
 * copy-pasteable remedy was built from the same local list, so running it from a
 * stale branch printed a PATCH that deleted the checks `main` had gained.
 * `--local` keeps the on-disk read available for inspecting uncommitted edits
 * and refuses to print a remedy, because a remedy is only true of the branch
 * that declares it.
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
 * That half reads the working tree on purpose — in CI the checkout IS the commit
 * under test, so the two sides are the same point in time, which is exactly the
 * property #413 removed from this half.
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
const listPath = ".github/required-checks.txt";
const ciFile = path.join(root, ".github", "workflows", "ci.yml");

/**
 * The `jobs:` block of a workflow, parsed by indentation. No YAML dependency
 * exists in this repo and adding one for four fields is not worth the install;
 * this reads `jobs:`, then each two-space-indented job id and its body up to
 * the next one.
 */
function parseJobs(text) {
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

/**
 * Contexts from a required-checks.txt body, comments and blanks dropped.
 *
 * Split out from `readRequiredContexts` so the declared list can come from the API as
 * well as from disk, with one parse in both cases (#413).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseRequiredContexts(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0);
}

/**
 * From a file on disk. Used by the per-run test half, where the checkout and
 * the list are the same commit by construction, and by `--local`.
 *
 * @param {string} [file]
 * @returns {string[]}
 */
export function readRequiredContexts(file = listFile) {
  return parseRequiredContexts(fs.readFileSync(file, "utf8"));
}

export function ciJobs() {
  return parseJobs(fs.readFileSync(ciFile, "utf8"));
}

/**
 * The API root. `GITHUB_API_URL` is the platform's own variable for this, so
 * honouring it costs one line and makes the script pointable at a stub (see
 * tests/required-checks-ref.test.mts) or a GitHub Enterprise instance instead of
 * only github.com.
 */
function apiBase() {
  let url = process.env.GITHUB_API_URL ?? "https://api.github.com";
  while (url.endsWith("/")) url = url.slice(0, -1);
  return url;
}

async function api(path_, { token }) {
  const response = await fetch(`${apiBase()}${path_}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GET ${path_} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

/**
 * The default branch's head sha — the commit the declared list is read at.
 *
 * Resolving this rather than assuming `main` is what makes the verdict say which
 * commit it is about; the sha is printed with the result. A failure here throws
 * rather than falling back to the working tree, because a silent fallback is
 * the #413 bug wearing a different hat.
 */
async function defaultBranchHead({ repo, token }) {
  const repo_ = await api(`/repos/${repo}`, { token });
  const branch = repo_.default_branch;
  if (typeof branch !== "string" || branch.length === 0) {
    throw new Error("the API did not report a default_branch");
  }
  const head = await api(`/repos/${repo}/branches/${encodeURIComponent(branch)}`, { token });
  if (typeof head?.commit?.sha !== "string") {
    throw new Error(`could not resolve the head of ${branch}`);
  }
  return { branch, sha: head.commit.sha };
}

/**
 * A file's text at a ref, via the contents API's raw media type.
 *
 * Its own fetch rather than `api()`: the raw media type returns the file body,
 * not JSON, so parsing it as JSON would throw on every non-JSON file. It is
 * fetched by sha rather than branch name so the content is exactly the commit
 * the rule is compared against, even if the branch moves mid-run.
 */
async function fileAtRef(filePath, ref, { repo, token }) {
  const response = await fetch(
    `${apiBase()}/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github.raw+json",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GET ${filePath} at ${ref} failed: ${response.status} ${await response.text()}`);
  }
  const text = await response.text();
  if (text.trim().length === 0) {
    throw new Error(`${filePath} at ${ref} came back empty; refusing to treat that as an empty list`);
  }
  return text;
}

async function protection({ repo, token, branch = "main" }) {
  return api(`/repos/${repo}/branches/${encodeURIComponent(branch)}/protection`, { token });
}

/** Both spellings: the `checks` array when app_id is set, else legacy contexts. */
function liveContexts(rule) {
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
 *
 * Only ever called with a list read from the default branch. #413 had it built
 * from the working tree, which meant a remedy printed on a feature branch
 * would write that branch's list over the live rule.
 */
export function remediationCommand(repo, declared, branch = "main") {
  const body = {
    strict: true,
    checks: declared.map((context) => ({ context, app_id: 15368 })),
  };
  return [
    `  gh api -X PATCH repos/${repo}/branches/${branch}/protection/required_status_checks --input - <<'JSON'`,
    JSON.stringify(body, null, 2),
    "JSON",
  ].join("\n");
}

function compare(declared, live) {
  return {
    missing: declared.filter((context) => !live.includes(context)),
    extra: live.filter((context) => !declared.includes(context)),
  };
}

async function main() {
  const local = process.argv.includes("--local");
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_API_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY ?? "harveysmurf/nessebarlens";
  if (!token) {
    console.error(
      "::error::no GITHUB_TOKEN/GH_TOKEN; cannot verify branch protection. " +
        "Not reporting success on a check that did not run.",
    );
    return 4;
  }

  // The live rule is remote state, so the branch it is read from is the one the
  // API says is the default — not a hardcoded "main". Resolved in both modes,
  // including --local: the point of --local is to compare an uncommitted list
  // against the rule that actually exists, and reading branches/main on a
  // repository whose default is something else would quietly compare against
  // nothing.
  const head = await defaultBranchHead({ repo, token });
  const { branch, sha } = head;

  // The declared side. Local means the working tree, which says nothing about
  // the default branch unless you are standing on it -- so the output below says
  // so out loud, and no remedy is printed, because a remedy is only true of the
  // branch that declares it.
  const declared = local
    ? readRequiredContexts()
    : parseRequiredContexts(await fileAtRef(listPath, sha, { repo, token }));
  const scope = local
    ? `local working tree (${listFile}) -- NOT the default branch`
    : `${branch}@${sha} (${listPath})`;

  const live = liveContexts(await protection({ repo, token, branch }));
  const { missing, extra } = compare(declared, live);

  for (const context of missing) {
    console.error(`::error::${context} is declared at ${scope} but branch protection does not require it`);
  }
  for (const context of extra) {
    console.error(`::error::${context} is required by branch protection but is not declared at ${scope}`);
  }

  // One scope line on every run, success or drift, so both outcomes are
  // attributable to a commit. Without it a reader cannot tell which file the
  // verdict was about, and an unfalsifiable verdict is not a check.
  console.error(`declared side: ${scope}`);

  if (missing.length === 0 && extra.length === 0) {
    console.log(
      `branch protection requires exactly the ${declared.length} declared check(s): ${declared.join(", ")}`,
    );
    if (local) {
      console.log(
        "scope is the local working tree, so this says nothing about the default branch. " +
          "Re-run without --local to check what GitHub actually requires.",
      );
    }
    return 0;
  }

  if (local) {
    console.error(
      "Not printing a fix: this list is the local working tree, and writing it to branch\n" +
        "protection would set the rule from a list nobody else has. Fix the divergence on\n" +
        `the default branch, or re-run without --local to get a remedy that is true of ${branch}.`,
    );
    return 1;
  }
  console.error(`\nSet the rule to exactly the list declared at ${branch}@${sha}:\n${remediationCommand(repo, declared, branch)}`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let result;
  try {
    result = await main();
  } catch (error) {
    // The API can fail in ways a local read cannot. Falling back to disk would
    // answer a different question than the one asked, so this reports and stops
    // rather than producing a verdict about the wrong thing.
    console.error(`::error::${error.message}`);
    console.error(
      `Not falling back to ${listFile}: a verdict about the local file is not a verdict about ${process.env.GITHUB_REPOSITORY ?? "harveysmurf/nessebarlens"}.`,
    );
    result = 2;
  }
  if (result !== 0) process.exitCode = result;
}
