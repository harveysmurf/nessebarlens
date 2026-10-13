/**
 * #359: enabling Dependabot alerts and security updates is a repository setting,
 * invisible to every file-based test, and the audit found both off while the
 * YAML still claimed security updates were on. scripts/dependabot-settings.mjs
 * is the hand-run comparison; this file holds the two properties that make it
 * worth running at all:
 *
 *   - it is red against a disabled repository and green against an enabled one,
 *     asserted on the pure decision rather than a live call; and
 *   - it stays out of ci.yml, because reading `security_and_analysis` needs
 *     administration access a job's GITHUB_TOKEN cannot be granted.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { readDependabotSettings, remediationCommands, settingsProblems } from "../scripts/dependabot-settings.mjs";

/** Serve the two endpoints from a fixed snapshot; alerts 204=enabled, 404=off. */
async function snapshot(securityUpdates: string | null, alertsStatus: number) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/vulnerability-alerts")) return new Response(null, { status: alertsStatus });
    return new Response(
      JSON.stringify({
        security_and_analysis: securityUpdates === null ? null : { dependabot_security_updates: { status: securityUpdates } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    return await readDependabotSettings({ repo: "owner/repo", token: "t" });
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("a disabled repository is red", () => {
  const problems = settingsProblems({ securityUpdates: "disabled", alerts: false });
  assert.ok(
    problems.some((problem) => /security updates/i.test(problem)),
    "the disabled security-update setting must be reported",
  );
  assert.ok(
    problems.some((problem) => /alerts/i.test(problem)),
    "disabled alerts must be reported",
  );
});

test("an enabled repository is green", () => {
  assert.deepEqual(settingsProblems({ securityUpdates: "enabled", alerts: true }), []);
});

test("an absent setting is not read as enabled", () => {
  // security_and_analysis can be omitted entirely for a token that cannot read
  // it, which is a failure to verify, not a green light.
  assert.equal(settingsProblems({ securityUpdates: undefined, alerts: true }).length, 1);
});

test("alerts alone turned off is still red", () => {
  assert.equal(settingsProblems({ securityUpdates: "enabled", alerts: false }).length, 1);
});

test("the remediation enables both settings", () => {
  const commands = remediationCommands("owner/repo");
  assert.match(
    commands,
    /gh api -X PATCH repos\/owner\/repo --input -/,
    "security updates are turned on by PATCHing the repository's security_and_analysis",
  );
  const body = JSON.parse(/<<'JSON'\n([\s\S]*)\nJSON/.exec(commands)?.[1] ?? "null");
  assert.deepEqual(body, {
    security_and_analysis: { dependabot_security_updates: { status: "enabled" } },
  });
  assert.match(
    commands,
    /gh api --method PUT repos\/owner\/repo\/vulnerability-alerts/,
    "alerts are turned on by PUTting the vulnerability-alerts endpoint",
  );
});

test("the live read turns a disabled snapshot into a red result", async () => {
  // 404 on vulnerability-alerts is "alerts disabled", not a transport error, so
  // the endpoint semantics are part of what makes the script honest.
  const settings = await snapshot("disabled", 404);
  assert.deepEqual(settings, { securityUpdates: "disabled", alerts: false });
  assert.notEqual(settingsProblems(settings).length, 0);
});

test("the live read turns an enabled snapshot into a green result", async () => {
  const settings = await snapshot("enabled", 204);
  assert.deepEqual(settings, { securityUpdates: "enabled", alerts: true });
  assert.deepEqual(settingsProblems(settings), []);
});

test("an unreadable setting is a loud failure, not a green or a red result", async () => {
  // 403 is the token lacking access (e.g. a repo-scoped token asked about
  // another repo). Flattening it to `false` would report a finding the script
  // cannot actually see; it must throw instead.
  await assert.rejects(() => snapshot("enabled", 403), /vulnerability-alerts read failed: 403/);
});

test("ci.yml does not try to verify Dependabot settings", () => {
  // Reading the setting needs administration access, which a job's GITHUB_TOKEN
  // cannot be granted, so a workflow step could only ever exit 4 while
  // reporting nothing about real drift. Keep it a manual tool.
  const ci = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.ok(
    !/dependabot-settings\.mjs/.test(ci),
    "ci.yml invokes dependabot-settings.mjs; a job token cannot read the setting, so this can only ever fail",
  );
});
