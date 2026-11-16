import assert from "node:assert/strict";
import { test } from "node:test";
import { created, SITE, world } from "./github-harness.mjs";

// Review finding 20, GitHub's part. With AUTH_REQUIRED unset on a deployment that holds accounts, the single-owner demo
// is closed (convex/access.ts): GitHub's pages and webhook record nothing, and no installation's token is handed out.
// These run the real convex/github against the stand-in GitHub (tests/github-harness.mjs). The monitor, customer
// reports, the consent gate, the runner and push delivery are in tests/access-rules.test.mjs.

const UNAVAILABLE = "turtl is unavailable right now. Please try again later.";

test("ATTACK (finding 20): with AUTH_REQUIRED unset and an account present, GitHub's pages and webhook record nothing, and no token is handed out", async (t) => {
  const w = await world(t, { connect: true });
  // An attempt started while the deployment served accounts, by someone who then lost the variable's protection.
  w.stub.signIn("octo");
  w.stub.willInstall({ id: 7001, repositories: ["octo/app"] });
  const { url } = await w.backend.call("github.connect.begin", { returnTo: "app" }, null);
  const state = new URL(url).searchParams.get("state");
  await w.backend.insert("authAccounts", { userId: "users:1", provider: "password", providerAccountId: "owner@example.com" });
  const before = w.backend.snapshot();
  const mints = w.mints().length;

  // The browser comes back through the setup page and the callback.
  const setup = await w.http.setup(w.backend.ctx, new Request(`${SITE}/github/setup?state=${state}&installation_id=7001`));
  assert.equal(setup.status, 503);
  assert.match(await setup.text(), /turtl is unavailable right now/);
  const callback = await w.http.callback(w.backend.ctx, new Request(`${SITE}/github/callback?state=${state}&code=whatever`));
  assert.equal(callback.status, 503);
  // A webhook GitHub signed.
  const delivered = await w.deliver("installation", created(7002, "octo", "octo/site"));
  assert.deepEqual(delivered, { status: 503, body: { ok: false, error: { code: "UNAVAILABLE", message: UNAVAILABLE } } });
  // A repository's token.
  assert.deepEqual(await w.access("octo/app"), { ok: false, reason: "github_error", message: UNAVAILABLE });

  assert.equal(w.backend.snapshot(), before, "nothing was recorded: no link, no installation, no claimed attempt");
  assert.equal(w.mints().length, mints, "no installation token was minted");
});
