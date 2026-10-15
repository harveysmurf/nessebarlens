/**
 * #413: the drift check must read the declared side from the DEFAULT BRANCH,
 * not from the working tree it happens to be run from.
 *
 * The old script compared the live branch protection rule against
 * `.github/required-checks.txt` on disk. Those two sides are different points in
 * time, so from any checkout that was not the tip of the default branch the
 * verdict described a repository that does not exist — and the remedy it printed
 * was built from the same local list, so pasting it wrote that branch's list over
 * the live rule. Reproduced both ways on 2026-10-15: a stale branch reported
 * "requires exactly the 4 declared check(s)" while main was short a check, and
 * after the rule was corrected the same stale branch printed a PATCH containing
 * only the old 4 contexts, which would have deleted the gate #406 had just added.
 *
 * These tests run the real script as a subprocess against a stub API. The stub
 * deliberately serves a list that differs from the file committed in this repo,
 * so the two sides can be told apart by their contents alone — no test has to
 * edit the repository's own .github/required-checks.txt to create the divergence
 * that caused the bug.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

const SCRIPT = new URL("../scripts/required-checks.mjs", import.meta.url);
const REPO = "stub-owner/stub-repo";

/** What the stub's default branch declares. Deliberately unlike the real file. */
const API_DECLARED = ["Alpha gate", "Beta gate"];
/** What the stub's live branch protection requires — one more than declared. */
const API_LIVE = [...API_DECLARED, "Gamma gate"];
const API_SHA = "0123456789abcdef0123456789abcdef01234567";

/** The list committed in this repo — the thing the bug used to read. */
const { readRequiredContexts } = await import("../scripts/required-checks.mjs");

type StubOptions = {
  declared?: string[];
  live?: string[];
  /** Reply 500 to everything, to exercise the no-fallback path. */
  broken?: boolean;
};

async function withStub(
  options: StubOptions,
  body: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const declared = options.declared ?? API_DECLARED;
  const live = options.live ?? API_LIVE;

  const server: Server = createServer((req, res) => {
    if (options.broken) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "stub is down" }));
      return;
    }
    const url = new URL(req.url ?? "/", "http://stub");
    const send = (status: number, payload: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    };

    if (url.pathname === `/repos/${REPO}`) return send(200, { default_branch: "trunk" });
    if (url.pathname === `/repos/${REPO}/branches/trunk`) {
      return send(200, { name: "trunk", commit: { sha: API_SHA } });
    }
    if (url.pathname === `/repos/${REPO}/contents/.github/required-checks.txt`) {
      // Fetched by sha, not branch name, so the content is exactly the commit
      // the verdict is about even if the branch moves mid-run.
      assert.equal(url.searchParams.get("ref"), API_SHA, "contents must be fetched by sha");
      // The raw media type returns the file body, not JSON.
      return send(200, `# stub\n${declared.join("\n")}\n`, "text/plain");
    }
    if (url.pathname === `/repos/${REPO}/branches/trunk/protection`) {
      return send(200, {
        required_status_checks: {
          strict: true,
          checks: live.map((context) => ({ context, app_id: 15368 })),
        },
      });
    }
    return send(404, { message: `stub has no route for ${url.pathname}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await body(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

/**
 * Run the script and wait for it.
 *
 * Deliberately async rather than `spawnSync`: the stub server lives in this
 * process, and a synchronous spawn blocks the event loop that has to answer the
 * child's requests. `spawnSync` here deadlocks until the child is killed, which
 * looks exactly like a hang rather than a mistake.
 */
function run(baseUrl: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT.pathname, ...args], {
      env: {
        ...process.env,
        GITHUB_API_URL: baseUrl,
        GITHUB_TOKEN: "stub-token",
        GITHUB_REPOSITORY: REPO,
      },
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data",  (chunk) => (out += chunk));
    // A deadlock in the harness must fail the test, not stall the suite.
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the script did not exit within 30s; output so far:\n${out}`));
    }, 30_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(guard);
      resolve({ code, out });
    });
  });
}

test("the verdict is about the default branch, not the file in the working tree", async () => {
  await withStub({}, async (baseUrl) => {
    const { code, out } = await run(baseUrl, []);

    // The stub's trunk declares 2 contexts; the file committed in this repo
    // declares a different number entirely. Reading disk would produce the
    // latter, so the count alone tells the two apart.
    assert.equal(code, 1, `expected drift to exit 1, got ${code}:\n${out}`);
    assert.match(out, /Gamma gate is required by branch protection/);
    assert.doesNotMatch(
      out,
      /Photo listing check/,
      "the file committed in this repo leaked into a verdict about the stub's trunk",
    );
    // And the file's own first entry is absent, so it is not a merge of the two.
    assert.doesNotMatch(out, new RegExp(readRequiredContexts()[0]));
  });
});

test("the verdict names the commit it was made against", async () => {
  // Without this, "no drift" and "drift" are both floating: a reader cannot tell
  // which commit the declared side came from, which is what made the old output
  // unfalsifiable from the outside.
  await withStub({}, async (baseUrl) => {
    const { out } = await run(baseUrl, []);
    assert.match(out, new RegExp(`declared side: trunk@${API_SHA}`));
    assert.match(
      out,
      new RegExp(`trunk@${API_SHA} \\(\\.github/required-checks\\.txt\\)`),
      "the reported scope should name both the ref and the path",
    );
  });
});

test("a clean default branch reports the ref it verified and exits 0", async () => {
  // The shape of the message read after a legitimate PATCH: the ref is printed
  // with the verdict, so "no drift" is attributable to a commit rather than to
  // whichever branch the shell happened to be on.
  await withStub({ live: API_DECLARED }, async (baseUrl) => {
    const { code, out } = await run(baseUrl, []);
    assert.equal(code, 0, out);
    assert.match(out, /requires exactly the 2 declared check\(s\): Alpha gate, Beta gate/);
    assert.match(out, new RegExp(`declared side: trunk@${API_SHA}`));
  });
});

test("--local reads the working tree and says so", async () => {
  // The escape hatch, for inspecting uncommitted edits. It is the only path that
  // reads disk, it says that out loud, and it does not claim the result
  // describes the default branch.
  await withStub({ live: API_DECLARED }, async (baseUrl) => {
    const { code, out } = await run(baseUrl, ["--local"]);
    // The repo's own file declares more contexts than the stub's live rule, so
    // this one drifts the other way — which is the point: the two sides swapped.
    assert.equal(code, 1, out);
    assert.match(out, /local working tree/);
    assert.match(out, /NOT the default branch/);
    assert.match(
      out,
      new RegExp(readRequiredContexts()[0]),
      "with --local the verdict should be about this repo's own file",
    );
  });
});

test("--local refuses to print a remedy, and says why", async () => {
  // The dangerous half of #413: a remedy built from a list nobody else has. This
  // is the only code path where that could still happen, so it is the one the
  // assertion is about.
  await withStub({}, async (baseUrl) => {
    const { out } = await run(baseUrl, ["--local"]);
    assert.doesNotMatch(
      out,
      /gh api -X PATCH/,
      "a remedy built from the working tree would write an unmerged branch's list over branch protection",
    );
    assert.match(out, /Not printing a fix/);
  });
});

test("an API failure reports and exits 2 rather than falling back to disk", async () => {
  // A silent fallback would be the same bug wearing a different hat: a verdict
  // about a local file presented as a verdict about the repository. Exit 2 is
  // distinct from 1 (drift) and 4 (no token), so a caller can tell "could not
  // check" from "checked and found drift".
  await withStub({ broken: true }, async (baseUrl) => {
    const { code, out } = await run(baseUrl, []);
    assert.equal(code, 2, out);
    assert.match(out, /::error::/);
    assert.match(out, /Not falling back to/);
    assert.doesNotMatch(out, /gh api -X PATCH/);
  });
});

test("the remedy targets the resolved branch and carries the API's list", async () => {
  await withStub({}, async (baseUrl) => {
    const { out } = await run(baseUrl, []);
    assert.match(
      out,
      /gh api -X PATCH repos\/stub-owner\/stub-repo\/branches\/trunk\/protection\/required_status_checks/,
      "the remedy must target the branch the verdict was made against, not a hardcoded main",
    );
    const body = /<<'JSON'\n([\s\S]*)\nJSON/.exec(out)?.[1];
    assert.ok(body, `no remedy body in:\n${out}`);
    assert.deepEqual(JSON.parse(body!), {
      strict: true,
      checks: API_DECLARED.map((context) => ({ context, app_id: 15368 })),
    });
    assert.doesNotMatch(
      body!,
      new RegExp(readRequiredContexts()[0]),
      "the remedy must not carry a context that only exists in this repo's working tree",
    );
  });
});