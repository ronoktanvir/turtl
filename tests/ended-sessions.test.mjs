import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { root, world } from "./github-harness.mjs";

// Review finding 17. A Convex Auth token stays valid for up to an hour after its session ends (signed out, password
// reset, account deleted). convex/access.ts checks the session against the database, and an action has none, so an
// action that asked requireAccount directly took a dead session's token at its word. Connect GitHub's begin, refresh
// and disconnect did: a thief holding the token could uninstall turtl from the owner's GitHub after the owner signed
// out. These run the real convex/github/connect.ts against the stand-in GitHub (tests/github-harness.mjs).

const message = (error) => error?.data ?? error?.message;
const SIGN_IN = "Sign in to continue.";

// The harness signs a caller in with the subject "<caller>|session-1", which names no session row and so is read as
// live. A caller written "alice|authSessions:404" has the subject "alice|authSessions:404|session-1": account alice,
// session authSessions:404, which is not in the database because it ended.
const ENDED = "alice|authSessions:404";

async function connectedAlice(t) {
  const w = await world(t, { connect: true, accounts: true });
  w.stub.signIn("alice");
  w.stub.willInstall({ id: 7101, repositories: ["alice/app"] });
  const { url } = await w.backend.call("github.connect.begin", { returnTo: "app" }, "alice");
  const ticket = new URL((await w.open(url)).url).searchParams.get("ticket");
  assert.equal((await w.backend.call("github.connect.finish", { ticket }, "alice")).connected, 1);
  return w;
}

test("ATTACK (finding 17): a token whose session has ended cannot disconnect, refresh or begin Connect GitHub", async (t) => {
  const w = await connectedAlice(t);
  const attempts = w.backend.rows("githubConnectAttempts").length;
  const requests = w.stub.requests.length;

  const uninstalls = () => w.stub.requests.filter((request) => request.method === "DELETE" && request.path.startsWith("/app/installations/"));
  await assert.rejects(w.backend.call("github.connect.disconnect", {}, ENDED), (error) => message(error) === SIGN_IN);
  assert.deepEqual(uninstalls(), [], "turtl was not uninstalled from alice's GitHub");
  assert.equal(w.backend.rows("githubInstallationLinks").filter((link) => link.account === "alice" && link.active).length, 1, "alice's link is untouched");

  await assert.rejects(w.backend.call("github.connect.refresh", {}, ENDED), (error) => message(error) === SIGN_IN);
  await assert.rejects(w.backend.call("github.connect.begin", { returnTo: "app" }, ENDED), (error) => message(error) === SIGN_IN);
  assert.equal(w.backend.rows("githubConnectAttempts").length, attempts, "no attempt was written for the ended session");
  assert.equal(w.stub.requests.length, requests, "nothing was asked of GitHub");

  // A live session still works: alice herself disconnects, and turtl is uninstalled.
  const done = await w.backend.call("github.connect.disconnect", {}, "alice");
  assert.equal(done.disconnected, 1);
  assert.equal(uninstalls().length, 1);
});

test("a helper that checks the session refuses an action's context, which has no database, instead of skipping the check", async (t) => {
  const w = await world(t, { accounts: true });
  const access = w.load("convex/access.ts");
  const actionCtx = { auth: { getUserIdentity: async () => ({ subject: "alice|authSessions:404" }) }, runQuery: async () => null };
  for (const helper of ["requireAccount", "currentAccount", "signedInAccount"]) {
    await assert.rejects(access[helper](actionCtx), /needs the database to check the session/, helper);
  }
});

// Every action in convex/ that needs the caller asks through internal.access.*: none hands its own context to a helper
// that reads the session. TypeScript says so too (the helpers take a context with a database); this catches a cast.
test("no action passes its context to requireAccount, currentAccount or signedInAccount", () => {
  const files = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "_generated" ? [] : files(path);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
    });
  const offenders = [];
  for (const file of files(join(root, "convex"))) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node, inAction) => {
      let acting = inAction;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^(action|internalAction|httpAction)$/.test(node.expression.text)) acting = true;
      if (ts.isFunctionLike(node) && node.parameters?.some((parameter) => parameter.type && /\bActionCtx\b/.test(parameter.type.getText(source)))) acting = true;
      if (acting && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^(requireAccount|currentAccount|signedInAccount)$/.test(node.expression.text)) {
        offenders.push(`${relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${node.expression.text}`);
      }
      ts.forEachChild(node, (child) => visit(child, acting));
    };
    visit(source, false);
  }
  assert.deepEqual(offenders, [], "From an action, ask through ctx.runQuery(internal.access.account, {}).");
});
