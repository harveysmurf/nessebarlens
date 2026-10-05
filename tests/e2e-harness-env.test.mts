/**
 * Issue #143 follow-up: the browser flow's dev server was started without the
 * environment its specs assert on, so two of the eight specs could not pass no
 * matter what the secrets were — and neither failure looked like a config
 * problem.
 *
 *   - Prodigi is explicit-host: readProdigiConfig reports unconfigured unless
 *     PRODIGI_API_BASE is an allowlisted host, so /api/quote answered 503 and
 *     the physical-print spec waited on a Checkout button that could never
 *     enable.
 *   - A physical order fails closed without PRINT_ASSET_HMAC_SECRET (503 "Print
 *     fulfillment is not configured"), so the same spec could not reach Stripe
 *     even once the quote worked.
 *
 * Both are asserted here against playwright.config.ts rather than trusted: a
 * harness that drops one passthrough takes a spec down to a green skip.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const config = fs.readFileSync(path.join(root, "playwright.config.ts"), "utf8");

// Indentation-tolerant because the block now sits inside the remote-mode
// ternary. What this guards is the env block's existence and contents — that
// every key a spec needs reaches the dev server — and the depth it is written
// at is not part of that. The ternary that gates it is asserted separately.
const webServerEnv = config.match(/webServer:[\s\S]*?env:\s*\{([\s\S]*?)\n\s{4,}\},/);
assert.ok(webServerEnv, "playwright.config.ts must declare a webServer env block");

test("the dev server gets the Prodigi sandbox host and key the quote route requires", () => {
  // The base is pinned, never inherited: an inherited PRODIGI_API_BASE could be
  // a live host, and the flow would then quote against a live account.
  assert.match(
    webServerEnv[1],
    /PRODIGI_API_BASE:\s*"https:\/\/api\.sandbox\.prodigi\.com"/,
    "the harness must pin the sandbox host explicitly",
  );
  assert.match(
    webServerEnv[1],
    /PRODIGI_SANDBOX_API_KEY:\s*process\.env\.PRODIGI_SANDBOX_API_KEY/,
    "the sandbox key must reach the dev server",
  );
});

test("the dev server gets PRINT_ASSET_HMAC_SECRET, or a physical order cannot be charged", () => {
  assert.match(
    webServerEnv[1],
    /PRINT_ASSET_HMAC_SECRET:\s*process\.env\.PRINT_ASSET_HMAC_SECRET/,
    "without it /api/checkout answers 503 and the physical spec cannot reach Stripe",
  );
});

test("the hosted checkout job passes the same three values to the harness", () => {
  const ci = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const job = ci.match(/^ {2}e2e-hosted-checkout:\n((?:(?: {4}|\t).*\n|\n)*)/m);
  assert.ok(job, "the hosted specs must run in their own job");
  for (const name of [
    "STRIPE_SECRET_KEY",
    "PRODIGI_SANDBOX_API_KEY",
    "PRINT_ASSET_HMAC_SECRET",
  ]) {
    assert.match(job[1], new RegExp(`${name}: \\$\\{\\{ secrets\\.\\w+ \\}\\}`), `the job must pass ${name}`);
  }
});

/**
 * The suite is split in two, and the split is a promise about what a green
 * check means. It is held together by a string in a describe title and two grep
 * flags, which is exactly the kind of arrangement that rots silently: retag a
 * spec, or a new spec lands in the wrong describe, and the required job keeps
 * reporting green while covering less than it claims. These assert the
 * arrangement rather than the outcome.
 */
test("the hosted specs are tagged @hosted, and only they", () => {
  const specs = ["smoke.spec.ts", "success-states.spec.ts"]
    .map((f) => fs.readFileSync(path.join(root, "e2e", f), "utf8"))
    .join("\n");
  const tagged = specs.match(/test\.describe\("@hosted[^\n]*/g) ?? [];
  assert.equal(
    tagged.length,
    1,
    "@hosted must live on exactly one describe: the two specs that leave for checkout.stripe.com",
  );
  assert.match(tagged[0], /checkout smoke flow/);
});

test("the live-key guard is not tagged @hosted, so it stays in the required job", () => {
  const spec = fs.readFileSync(path.join(root, "e2e", "smoke.spec.ts"), "utf8");
  const guardAt = spec.indexOf('test("the live-key guard refuses a non-test Stripe key"');
  assert.ok(guardAt !== -1, "the live-key guard must exist");
  const taggedAt = spec.indexOf('test.describe("@hosted');
  assert.ok(
    taggedAt !== -1 && guardAt > taggedAt,
    "the guard must be declared outside the @hosted describe",
  );
});

test("the required job runs everything except the hosted specs", () => {
  const ci = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const job = ci.match(/^ {2}e2e-smoke:\n((?:(?: {4}|\t).*\n|\n)*)/m);
  assert.ok(job);
  assert.match(job[1], /--grep-invert @hosted/, "the gate must exclude the hosted specs");
  // A required job that also ran the hosted specs would go red on a Stripe
  // gate, which is the whole thing this split exists to prevent.
  assert.doesNotMatch(job[1], /--grep @hosted\b(?!\w)/);
});

test("the hosted specs run soft-failed and still attempt, rather than skipping", () => {
  const ci = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const job = ci.match(/^ {2}e2e-hosted-checkout:\n((?:(?: {4}|\t).*\n|\n)*)/m);
  assert.ok(job);
  assert.match(job[1], /continue-on-error: true/, "the hosted job must be soft-failed, not required");
  assert.match(job[1], /--grep @hosted/, "the hosted job must run the hosted specs");
  // A skip reads green having tested nothing, which is the trap: nobody could
  // then tell a moved Stripe gate from a broken redirect.
  assert.doesNotMatch(job[1], /--grep-invert @hosted/);
  // The run step must have no `if:` of its own. `if: always()` on the run step
  // is how a suite gets turned into a green skip while still looking like it
  // ran; `if: always()` on the *upload* step is the opposite and required.
  const runStep = job[1].match(/\n {6}- name: E2E hosted checkout\n((?: {8}.*\n|\n)*)/);
  assert.ok(runStep, "the hosted specs need a run step");
  assert.doesNotMatch(runStep[1], /\n {8}if:/, "the run step must be unconditional");
  assert.match(job[1], /if: always\(\)[\s\S]*upload-artifact/, "the trace must upload on every run of this job");
});

test("the digital-licence spec selects digital before asserting the digital price", () => {
  // The configurator opens on a physical format, so the price label holds a
  // Prodigi quote (or "—") and the digital price never appears unselected. The
  // spec used to assert it there, which is why it failed on a server whose
  // Prodigi env was complete.
  const spec = fs.readFileSync(path.join(root, "e2e", "smoke.spec.ts"), "utf8");
  const select = spec.search(/getByText\(\/digital copy\/i\)\.click\(\)/);
  const price = spec.search(/getByText\(`€\$\{DIGITAL_PRICE_EUR/);
  assert.ok(select !== -1, "the spec must select the digital format");
  assert.ok(price !== -1 && price > select, "the price assertion must come after the selection");
});
/**
 * #169: the hosted job was red on every run because one of its two specs
 * submits a payment on Stripe's hosted page, behind an AI-attestation dialog
 * nobody should click on a runner. A guaranteed-red job is noise, and it hides
 * the regression the other spec exists to catch. The blocked spec now skips
 * itself with the reason, and the job's red means the physical flow broke.
 *
 * These assert the arrangement rather than the outcome, for the same reason as
 * the split above: a skip is invisible in CI unless something pins it.
 */
test("the digital-licence spec skips itself with a reason, before it takes any action", () => {
  const spec = fs.readFileSync(path.join(root, "e2e", "smoke.spec.ts"), "utf8");
  assert.match(spec, /process\.env\.HOSTED_DIGITAL_SKIP_REASON/);
  // The title has to name the digital flow, or a reader cannot tell which spec
  // the skip belongs to without reading the body — and neither can this test.
  assert.match(spec, /test\("home \u2192 photo \u2192 configurator \u2192 price \u2192 Stripe \u2192 success page \(digital licence\)"/);
  const testBody = spec.slice(spec.indexOf("home \u2192 photo \u2192 configurator"));
  const skipAt = testBody.search(/test\.skip\(Boolean\(digitalSkipReason\), digitalSkipReason/);
  const firstActionAt = testBody.search(/page\.goto|page\.locator|checkout\.click/);
  assert.ok(skipAt !== -1, "the digital spec must skip on the reason CI supplies");
  assert.ok(
    skipAt < firstActionAt,
    "the skip has to come first, or the report shows a half-run test under an explained skip",
  );
  // The physical spec is the job's signal now, so the skip must not be able to
  // reach it: it is a statement inside one test body, not a describe-wide one.
  assert.ok(
    !/test\.describe\("physical print",[\s\S]{0,400}test\.skip\(Boolean\(digitalSkipReason\)/.test(spec),
    "the skip belongs to the digital flow only",
  );
});

test("the hosted job sets the skip reason and names the gate that causes it", () => {
  const ci = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const job = ci.match(/^ {2}e2e-hosted-checkout:\n((?:(?: {4}|\t).*\n|\n)*)/m);
  assert.ok(job);
  const reason = job[1].match(/HOSTED_DIGITAL_SKIP_REASON:\s*"([^"]+)"/);
  assert.ok(reason, "the hosted job must tell the spec why it is skipping");
  assert.match(reason[1], /attestation/i, "the skip reason has to name the gate, not just say skipped");
  // Only the soft job. A required job that skipped the digital flow would be
  // reporting green while covering less than it claims.
  const required = ci.match(/^ {2}e2e-smoke:\n((?:(?: {4}|\t).*\n|\n)*)/m);
  assert.ok(required);
  assert.doesNotMatch(required[1], /HOSTED_DIGITAL_SKIP_REASON/);
});

/**
 * `E2E_BASE_URL` points the same specs at a deployed host instead of the dev
 * server. It exists because the dev server answers from `next dev`, so it can
 * never prove a Worker serves a route or a binding — and the suite had no way
 * to check a deployment at all.
 *
 * The risk it introduces is a job quietly moving onto a deployed host, so these
 * pin the boundaries: opt-in per invocation, no dev server in that mode, and
 * the specs that only make sense against local seeds kept out of it.
 */
test("no workflow points E2E_BASE_URL at a deployed host", () => {
  // #143 ruled out a CI job driving a *deployed* host: every red run would have
  // two possible causes, the PR and the deployment. #204's `e2e-worker` job
  // needs the one legitimate exception — the same harness pointed at a Worker
  // built and started in the job — so the invariant is now the origin, not the
  // variable. Localhost only, and an empty result is still valid.
  const workflows = fs
    .readdirSync(path.join(root, ".github", "workflows"))
    .filter((f) => f.endsWith(".yml"))
    .map((f) => fs.readFileSync(path.join(root, ".github", "workflows", f), "utf8"))
    .join("\n");
  const values = [...workflows.matchAll(/E2E_BASE_URL["']?\s*[:=]\s*["']?([^\s"']+)/g)].map(
    (match) => match[1],
  );
  for (const value of values) {
    assert.match(
      value,
      /^https?:\/\/localhost(:\d+)?$/,
      `a CI job may point the harness at the local Worker build, never a deployed host: ${value}`,
    );
  }
});

test("a remote run starts no dev server, and the seeded states stay off it", () => {
  assert.match(
    config,
    /webServer:\s*REMOTE_BASE_URL\s*\?\s*undefined\s*:/,
    "the dev server must be conditional, or a remote run also boots a local one and the two disagree",
  );
  assert.match(
    config,
    /REMOTE_BASE_URL\s*\?\s*\{\s*testIgnore:\s*"\*\*\/success-states\.spec\.ts"\s*\}/,
    "the success-page states assert ORDERS fixtures only the dev server is seeded with",
  );
});

test("E2E_BASE_URL is rejected unless it is an http(s) URL", () => {
  // A typo would otherwise become a baseURL that resolves nowhere, and the
  // symptom is a spec timeout on the first goto, which reads as a broken deploy.
  assert.match(config, /new URL\(raw\)/);
  assert.match(config, /E2E_BASE_URL is not a URL/);
  assert.match(config, /must be http\(s\)/);
  // Normalised to the origin so page.goto("/") and an absolute assertion agree.
  assert.match(config, /return parsed\.origin/);
});

test("the reason for the skip is written down where the next reader looks", () => {
  const docs = fs.readFileSync(path.join(root, "DEVELOPMENT.md"), "utf8");
  assert.match(docs, /HOSTED_DIGITAL_SKIP_REASON/);
  assert.match(docs, /attestation/i);
});
