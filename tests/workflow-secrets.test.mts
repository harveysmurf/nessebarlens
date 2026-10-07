/**
 * Issue #205 item 6: `gh secret list --env staging` showed seven credentials in
 * the staging Environment that no workflow reads — `CF_ACCOUNT_ID`,
 * `CF_API_TOKEN`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`,
 * `R2_S3_ENDPOINT`, `R2_ACCOUNT_ID`. Unused credentials are pure exposure: the
 * cost of one leaking is the same whether or not a job reads it, and the only
 * thing a stale secret buys is the belief that it is still needed.
 *
 * The half of item 6 that can live in a test is the inventory. Deleting the
 * secrets and revoking the R2 S3 key are account actions, done by hand; nothing
 * in a green suite can tell whether they happened. What a test *can* do is make
 * the expected set per environment the written-down truth, so the question
 * "which secrets should this environment have?" has an answer that is checked
 * rather than remembered.
 *
 * Two directions are asserted, because they fail for opposite reasons:
 *
 *   * every `secrets.X` a workflow reads must be in the expected set for that
 *     environment — a new secret without a documented home is how the next
 *     round of "which of these are actually used?" starts; and
 *   * every expected secret must still be read by some workflow — a secret left
 *     in the list after its last reader is gone is precisely the leftover this
 *     issue is about, so it fails here rather than waiting for a second audit.
 *
 * The second direction is why the seven leftovers had to be deleted before this
 * file could be written: they are in nobody's expected set, and a secret that
 * exists but is unread is indistinguishable, from inside the repo, from one
 * that was cleaned up.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const workflowDir = path.join(root, ".github", "workflows");

/**
 * The secret set each Environment is expected to hold, and who reads it.
 *
 * `staging` — sandbox Stripe, sandbox Prodigi, the staging SITE_URL, and the
 * `NEXT_PUBLIC_*` values baked into a staging build. The release build matrix
 * reads it through `environment: ${{ matrix.env }}` and the PR preview builds
 * with `environment: staging`, so these secrets are expected in both
 * environments; that is the one place the same name means a different value, and
 * it is the reason these are per-environment lists rather than one global set.
 *
 * `production` — the same names with live values.
 *
 * `NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED` is the ladder's on/off switch. It is in
 * both lists because the release build reads it for staging and production, and
 * the preview build now forwards it too (#257) so a reviewer sees the real
 * derivatives rather than the committed placeholder.
 *
 * `repository` — `PRINT_ASSET_HMAC_SECRET` is a repository secret, not an
 * Environment one: it signs print-asset URLs and has to be the *same* value in
 * every environment, since a signature made with one key and checked with
 * another is the failure this indirection exists to avoid. The hosted-checkout
 * job reads it from the repository while holding `environment: staging`, which
 * is the only workflow where the two scopes are read side by side.
 */
const EXPECTED: Record<string, ReadonlySet<string>> = {
  staging: new Set([
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "NEXT_PUBLIC_SITE_URL",
    "NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED",
    "NEXT_PUBLIC_WEB_IMAGES_BASE",
    "PRINT_ASSET_HMAC_SECRET",
    "PRODIGI_API_KEY",
    "PRODIGI_SANDBOX_API_KEY",
    "PRODIGI_WEBHOOK_TOKEN",
    "RECONCILE_SECRET",
    "RESEND_API_KEY",
    "SITE_URL",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
  ]),
  production: new Set([
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "NEXT_PUBLIC_SITE_URL",
    "NEXT_PUBLIC_WEB_DERIVATIVES_ENABLED",
    "NEXT_PUBLIC_WEB_IMAGES_BASE",
    "PRINT_ASSET_HMAC_SECRET",
    "PRODIGI_API_KEY",
    "PRODIGI_SANDBOX_API_KEY",
    "PRODIGI_WEBHOOK_TOKEN",
    "RECONCILE_SECRET",
    "RESEND_API_KEY",
    "SITE_URL",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
  ]),
  repository: new Set(["PRINT_ASSET_HMAC_SECRET"]),
};

const workflows = fs
  .readdirSync(workflowDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .map((name) => ({
    name,
    text: fs.readFileSync(path.join(workflowDir, name), "utf8"),
  }));

type Job = {
  workflow: string;
  job: string;
  /** The `environment:` value as written; a matrix expression counts as both. */
  environments: string[];
  secrets: string[];
};

const jobs: Job[] = workflows.flatMap(({ name, text }) => {
  const jobsText = text.slice(text.search(/^jobs:[ \t]*$/m));
  if (!jobsText) return [];
  return jobsText
    .split(/\n {2}(?=[a-z][\w-]*:\n)/)
    .slice(1)
    .flatMap((block): Job[] => {
      const job = block.match(/^([a-z][\w-]*):\n/)?.[1] ?? "?";
      const environment = block.match(/^[ \t]*environment:[ \t]*(.+)$/m)?.[1]?.trim();
      // `${{ matrix.env }}` is the build matrix, which runs once per
      // environment in EXPECTED — the same name with a different value in each,
      // which is exactly why the expectation is a set per environment and not a
      // flat list of secret names.
      const environments = !environment
        ? []
        : environment.includes("matrix.env")
          ? ["staging", "production"]
          : [environment];
      return [
        {
          workflow: name,
          job,
          environments,
          secrets: [...new Set([...block.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort(),
        },
      ];
    });
});

test("the scan can see the workflows at all", () => {
  // Every assertion below is a set comparison, and a set comparison against an
  // empty scan passes for the wrong reason: an empty expected set is trivially
  // a subset of nothing. Floors, not exact counts, because jobs come and go.
  const withSecrets = jobs.filter((job) => job.secrets.length > 0);
  assert.ok(
    withSecrets.length >= 5,
    `found ${withSecrets.length} jobs referencing secrets, expected at least 5:\n${jobs
      .map((j) => `${j.workflow}/${j.job}: ${j.environments.join("|") || "(none)"} ${j.secrets.join(",")}`)
      .join("\n")}`,
  );
  // Every secret-reading job must declare an `environment:`. A repository-level
  // secret is a legitimate fallback for one name (PRINT_ASSET_HMAC_SECRET, which
  // has to be identical in every environment), but a job reading anything else
  // from the repository scope is a secret that escaped the per-environment
  // separation — and if `environment:` ever stopped being parsed, this is the
  // assertion that notices.
  const unscoped = withSecrets.filter((job) => job.environments.length === 0);
  assert.deepEqual(
    unscoped.map((job) => `${job.workflow}/${job.job}`),
    [],
    "these jobs read secrets without declaring `environment:` — a secret outside an Environment cannot be rotated or reviewed per environment",
  );
  assert.ok(
    withSecrets.some((job) => job.environments.length === 2),
    "no job reads a secret from a matrix environment — release.yml's build job is the one that does, and losing it means the matrix expression stopped being recognised",
  );
});

test("every secret a workflow reads is in the expected set for its environment", () => {
  const undeclared: string[] = [];
  for (const job of jobs) {
    for (const environment of job.environments) {
      const expected = EXPECTED[environment];
      assert.ok(
        expected,
        `${job.workflow}/${job.job} declares \`environment: ${environment}\`, which is not a scope this test knows. Add it to EXPECTED in tests/workflow-secrets.test.mts and document the set in DEVELOPMENT.md.`,
      );
      for (const secret of job.secrets) {
        if (!expected.has(secret)) {
          undeclared.push(`${job.workflow}/${job.job} reads ${environment}.${secret}`);
        }
      }
    }
  }
  assert.deepEqual(
    undeclared,
    [],
    `these secrets are read but not documented:\n${undeclared.join("\n")}\nEvery Environment secret needs a row in DEVELOPMENT.md §Rotating a credential. An undocumented one is invisible to whoever next asks which credentials are actually in use.`,
  );
});

test("no expected secret has lost its last reader", () => {
  // The direction that catches the leftovers this issue is about. A secret in
  // EXPECTED with no reader left is dead exposure, and inside the repository it
  // looks identical to a live one until someone reads the account settings.
  const read = new Set(jobs.flatMap((job) => job.secrets));
  const unread = Object.entries(EXPECTED).flatMap(([scope, names]) =>
    [...names].filter((name) => !read.has(name)).map((name) => `${scope}.${name}`),
  );
  assert.deepEqual(
    unread,
    [],
    `these secrets are expected but no workflow reads them any more: ${unread.join(", ")}. Delete them from the ${unread.length > 0 ? "Environment" : "scope"} (and revoke the credential at the provider) rather than leaving them listed here.`,
  );
});

test("no workflow reads the retired Pages credentials or the unused R2 S3 keys", () => {
  // Named one at a time rather than as a pattern, because a pattern would also
  // have to be right about what a future legitimate name looks like, and a
  // false negative here is silent. These seven were in the staging Environment
  // with no reader:
  //
  //   CF_ACCOUNT_ID / CF_API_TOKEN          — the pre-Workers names for the
  //     Cloudflare token. scripts/sync-worker-secrets.sh still accepts them as a
  //     fallback for wrangler's own names, but the workflows have long passed
  //     CLOUDFLARE_* directly, so the Environment copies are unread.
  //   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ENDPOINT / R2_S3_ENDPOINT /
  //     R2_ACCOUNT_ID  — the S3-compatibility keys. The site reaches R2 through
  //     the Workers *binding*, not the S3 API, and wrangler.toml says so; these
  //     are a second credential for the same data with no code behind it.
  //
  // The R2 key is the one that matters most: an S3 access key is a long-lived
  // bearer credential for the masters bucket, so it must be revoked at
  // Cloudflare as well as deleted here. That step is an account action and is
  // tracked on the issue, not in this file.
  const retired = [
    "CF_ACCOUNT_ID",
    "CF_API_TOKEN",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ENDPOINT",
    "R2_S3_ENDPOINT",
    "R2_ACCOUNT_ID",
  ];
  const used = new Set(jobs.flatMap((job) => job.secrets));
  const stillUsed = retired.filter((name) => used.has(name));
  assert.deepEqual(
    stillUsed,
    [],
    `these retired credentials are read by a workflow again: ${stillUsed.join(", ")}. If that is deliberate, remove them from this list and document the reader; otherwise a workflow started depending on a credential that was supposed to be gone.`,
  );

  for (const name of retired) {
    for (const [scope, names] of Object.entries(EXPECTED)) {
      assert.ok(
        !names.has(name),
        `${scope}.${name} is back in the expected set — it was one of the seven unread credentials #205 removed.`,
      );
    }
  }
});

test("the documented environments are the ones the workflows use", () => {
  // A scope that exists in GitHub but in no workflow is exactly the shape of a
  // leftover environment: invisible in the repository, holding credentials that
  // nothing deploys with. Conversely a workflow pointing at a scope this test
  // has never heard of is caught above, by the assertion on `environment`.
  const used = new Set(jobs.flatMap((job) => job.environments));
  for (const scope of Object.keys(EXPECTED)) {
    if (scope === "repository") continue; // not an `environment:` value
    assert.ok(
      used.has(scope),
      `\`${scope}\` is documented as an Environment but no workflow declares \`environment: ${scope}\``,
    );
  }
  assert.deepEqual(
    [...used].filter((scope) => scope !== "repository" && !(scope in EXPECTED)).sort(),
    [],
    "these `environment:` values are not in EXPECTED",
  );
});
