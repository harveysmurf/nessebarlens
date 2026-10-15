/**
 * Issue #405: the drift check verifies the catalog of the commit production is
 * *serving*, so the lookup that resolves that commit is the load-bearing part.
 *
 * It is also the part that reads two wrangler JSON documents whose shapes are
 * not this repo's to change, which is why the fixtures here are pinned to what
 * wrangler 4.149 actually emits: `deployments list --json` is an array sorted
 * ascending by `created_on` with `.versions[]` carrying `version_id` and
 * `percentage`, and `versions view <id> --json` is the raw version object whose
 * deploy tag lives at `annotations["workers/tag"]` (`release.yml` writes it with
 * `--tag="prod-$COMMIT_SHA"`).
 *
 * The behaviour that matters is the refusal. A fallback to `main` — or a regex
 * loose enough to accept a truncated tag — would produce a green run against a
 * commit nobody is served, which closes the incident this whole check exists to
 * open.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  deployedShaFromVersion,
  resolveDeployedSha,
  servingVersionId,
} from "../scripts/resolve-deployed-sha.mjs";

const SHA_NEW = "2".repeat(40);

type DeploymentEntry = {
  created_on: string;
  versions: { version_id: string; percentage: number }[];
};

/** A `deployments list --json` payload: oldest deployment first, as wrangler prints. */
const deployments = (...entries: DeploymentEntry[]) => entries;

const tagged = (sha: string, id: string) => ({
  id,
  annotations: {
    "workers/message": `deploy-${sha}`,
    "workers/tag": `prod-${sha}`,
  },
});

test("servingVersionId finds the version holding 100% of traffic", () => {
  assert.equal(
    servingVersionId(
      deployments(
        { created_on: "2026-10-01T00:00:00Z", versions: [{ version_id: "v1", percentage: 100 }] },
        {
          created_on: "2026-10-02T00:00:00Z",
          versions: [
            { version_id: "v2", percentage: 10 },
            { version_id: "v3", percentage: 90 },
          ],
        },
      ),
    ),
    "v1",
    "a partial rollout does not become the deployed version by being newest",
  );

  // Newest wins when the newest deployment holds all the traffic: that is the
  // ordinary case after a release.
  assert.equal(
    servingVersionId(
      deployments(
        { created_on: "2026-10-01T00:00:00Z", versions: [{ version_id: "v1", percentage: 100 }] },
        { created_on: "2026-10-02T00:00:00Z", versions: [{ version_id: "v2", percentage: 100 }] },
      ),
    ),
    "v2",
  );

  // Unsorted input must not change the answer: the function re-sorts by
  // created_on rather than trusting the array order the CLI happened to print.
  assert.equal(
    servingVersionId(
      deployments(
        { created_on: "2026-10-02T00:00:00Z", versions: [{ version_id: "v2", percentage: 100 }] },
        { created_on: "2026-10-01T00:00:00Z", versions: [{ version_id: "v1", percentage: 100 }] },
      ),
    ),
    "v2",
  );
});

test("servingVersionId reports nothing when no version holds all the traffic", () => {
  assert.equal(servingVersionId([]), undefined);
  assert.equal(
    servingVersionId(
      deployments({
        created_on: "2026-10-02T00:00:00Z",
        versions: [
          { version_id: "v2", percentage: 60 },
          { version_id: "v3", percentage: 40 },
        ],
      }),
    ),
    undefined,
    "a split rollout has no single answer, and guessing one is what this refuses to do",
  );
});

test("deployedShaFromVersion reads the commit out of the prod tag", () => {
  assert.equal(deployedShaFromVersion(tagged(SHA_NEW, "v2")), SHA_NEW);
});

test("deployedShaFromVersion refuses a version that is not a prod deploy", () => {
  // A staging deploy (`staging-<sha>`), a rollback, or a hand-made version all
  // reach the 100% slot. None of them answers "which commit is production?".
  assert.throws(() => deployedShaFromVersion({ id: "v9" }, "v9"), /no prod-<sha> tag/);
  assert.throws(
    () => deployedShaFromVersion({ id: "v9", annotations: { "workers/tag": "staging-abc" } }, "v9"),
    /no prod-<sha> tag/,
  );
  assert.throws(
    () => deployedShaFromVersion({ id: "v9", annotations: { "workers/tag": "prod-notasha" } }, "v9"),
    /no prod-<sha> tag/,
  );
  // Truncated but otherwise plausible: a 7-char sha is what `--tag` would carry
  // if someone abbreviated it, and checking out a ref derived from it is not a
  // thing this script should be able to do.
  assert.throws(
    () => deployedShaFromVersion({ id: "v9", annotations: { "workers/tag": `prod-${SHA_NEW.slice(0, 7)}` } }, "v9"),
    /no prod-<sha> tag/,
  );
});

test("resolveDeployedSha reads the version list, then that version's tag", async () => {
  const calls: string[][] = [];
  const sha = await resolveDeployedSha({
    run: async (_file, args) => {
      calls.push(args);
      if (args[0] === "deployments") {
        return {
          stdout: JSON.stringify(
            deployments({
              created_on: "2026-10-02T00:00:00Z",
              versions: [{ version_id: "v2", percentage: 100 }],
            }),
          ),
        };
      }
      return { stdout: JSON.stringify(tagged(SHA_NEW, "v2")) };
    },
  });

  assert.equal(sha, SHA_NEW);
  assert.deepEqual(calls, [
    ["deployments", "list", "--json"],
    ["versions", "view", "v2", "--json"],
  ]);
});

test("resolveDeployedSha fails, rather than guessing, when the served commit is unknowable", async () => {
  await assert.rejects(
    resolveDeployedSha({
      run: async (_file, args) =>
        args[0] === "deployments" ? { stdout: "[]" } : { stdout: "{}" },
    }),
    /no version holds 100% of production traffic/,
  );

  // A version that holds all the traffic but carries no prod tag — a staging
  // deploy promoted by hand, or a rollback. The sha is unknowable from here.
  await assert.rejects(
    resolveDeployedSha({
      run: async (_file, args) =>
        args[0] === "deployments"
          ? {
              stdout: JSON.stringify(
                deployments({
                  created_on: "2026-10-02T00:00:00Z",
                  versions: [{ version_id: "v2", percentage: 100 }],
                }),
              ),
            }
          : { stdout: JSON.stringify({ id: "v2", annotations: {} }) },
    }),
    /no prod-<sha> tag/,
  );
});

test("resolveDeployedSha names the CLI contract when wrangler's JSON moves", async () => {
  await assert.rejects(
    resolveDeployedSha({ run: async () => ({ stdout: "wrangler 4.149.0\n" }) }),
    /could not parse deployments list --json output/,
  );
  await assert.rejects(
    resolveDeployedSha({ run: async () => ({ stdout: "{}" }) }),
    /did not return an array/,
  );
});
