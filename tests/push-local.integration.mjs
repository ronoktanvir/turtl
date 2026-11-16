import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference as ref } from "convex/server";
import { startExpoPushStub } from "./fixtures/expo-push-stub.mjs";

// Proves convex/push on a real local Convex backend (`npx convex dev --local-cloud-port 3250`), with Expo's push
// service replaced by tests/fixtures/expo-push-stub.mjs on port 8204. Convex's own runtime runs the functions,
// the scheduler and the fetch. It refuses to run against anything but a local anonymous deployment.
// Run: node --test tests/push-local.integration.mjs

const STUB_PORT = 8204;
const root = new URL("..", import.meta.url);
const envLocal = readFileSync(new URL(".env.local", root), "utf8");
assert.match(envLocal, /^CONVEX_DEPLOYMENT=anonymous:/m, "Push proofs run only against a local anonymous deployment.");
const config = JSON.parse(readFileSync(new URL(".convex/local/default/config.json", root), "utf8"));
const url = `http://127.0.0.1:${config.ports.cloud}`;

const convexEnv = (...args) => execFileSync("npx", ["convex", "env", ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString();
const client = (account) => {
  const c = new ConvexHttpClient(url);
  if (account) c.setAdminAuth(config.adminKey, { subject: `${account}|session`, issuer: "https://local.test", tokenIdentifier: `https://local.test|${account}` });
  else c.setAdminAuth(config.adminKey);
  return c;
};
const admin = client();
const anonymous = new ConvexHttpClient(url);
const TOKEN = (name) => `ExponentPushToken[${name}-${Date.now().toString(36)}]`;

async function until(read, ok, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (ok(value)) return value;
    await delay(150);
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}

test("push on a local Convex backend against a stand-in for Expo", { timeout: 120_000 }, async (t) => {
  const stub = await startExpoPushStub({ port: STUB_PORT });
  convexEnv("set", "EXPO_PUSH_API_URL", stub.url);
  convexEnv("set", "DEV_TOOLS_ENABLED", "true");
  t.after(async () => {
    await stub.close();
    convexEnv("remove", "EXPO_PUSH_API_URL");
    convexEnv("remove", "DEV_TOOLS_ENABLED");
    convexEnv("remove", "AUTH_REQUIRED");
  });

  await t.test("single-owner demo: one push per case event, the case's words never leave, Expo's refusals turn phones off", async () => {
    convexEnv("remove", "AUTH_REQUIRED");
    const live = TOKEN("demo"), gone = TOKEN("demo-Gone"), later = TOKEN("demo-later");
    for (const token of [live, gone, later]) await anonymous.mutation(ref("push/devices:register"), { token, platform: "ios" });
    assert.deepEqual(await anonymous.query(ref("push/devices:status"), { token: live }), { accountsMode: false, signedIn: true, registered: true });
    const { caseId } = await admin.mutation(ref("push/localProof:seed"), { name: "Local push proof", ownerId: "solo-owner" });

    for (const event of ["opened", "needs_decision", "needs_decision"]) {
      await admin.action(ref("notices:notifyOwner"), { caseId, event, text: "Customer wrote: my card 4242. TypeError at pay.ts:9" });
    }
    const snapshot = await until(() => admin.query(ref("push/localProof:snapshot"), { caseId }), (s) => s.sends[0]?.outcome && s.sends[0].outcome !== "pending", "no push outcome");
    assert.deepEqual(snapshot.notices.map((n) => [n.event, n.outcome]).sort(), [["needs_decision", "not_configured"], ["opened", "not_configured"]], "the text path records as before");
    assert.equal(snapshot.sends.length, 1, "one push for needs_decision, none for opened, none for the repeat");
    const send = snapshot.sends[0];
    assert.equal(send.outcome, "partly_sent");
    const requests = stub.sends().filter((r) => r.body.some((m) => m.data.caseId === caseId));
    assert.equal(requests.length, 1);
    const messages = requests[0].body;
    const mine = messages.filter((m) => [live, gone, later].includes(m.to));
    assert.equal(mine.length, 3);
    for (const message of mine) assert.deepEqual(message, { to: message.to, title: "Local push proof", body: "A case needs your decision. Open it to approve or decline a fix.", data: { caseId }, sound: "default", priority: "high" });
    assert.ok(!JSON.stringify(requests[0].body).match(/4242|TypeError|ECONNRESET/), "no customer words, errors or code");
    assert.equal((await admin.query(ref("push/localProof:token"), { token: gone })).disabledReason, "not_registered");

    // Receipts: Expo says one more phone was uninstalled. Read now rather than after the scheduled 15 minutes.
    const laterTicket = send.tickets[messages.findIndex((m) => m.to === later)];
    stub.settings.receiptErrors[laterTicket.receiptId] = "DeviceNotRegistered";
    await admin.action(ref("push/deliver:checkReceipts"), { sendId: send._id });
    assert.equal((await admin.query(ref("push/localProof:token"), { token: later })).disabledReason, "not_registered");
    assert.equal((await admin.query(ref("push/localProof:token"), { token: live })).disabledAt, undefined);
    const checked = (await admin.query(ref("push/localProof:snapshot"), { caseId })).sends[0];
    assert.ok(checked.receiptsCheckedAt);
    assert.ok(stub.requests.some((r) => r.path === "getReceipts" && r.body.ids.includes(laterTicket.receiptId)));
    for (const token of [live, gone, later]) await anonymous.mutation(ref("push/devices:remove"), { token });
  });

  await t.test("accounts mode: sign-in required, each owner's phones get only their projects' cases", async () => {
    convexEnv("set", "AUTH_REQUIRED", "true");
    await until(() => anonymous.query(ref("push/devices:status"), {}), (s) => s.accountsMode, "accounts mode did not turn on");
    assert.deepEqual(await anonymous.query(ref("push/devices:status"), {}), { accountsMode: true, signedIn: false, registered: false });
    await assert.rejects(anonymous.mutation(ref("push/devices:register"), { token: TOKEN("nobody"), platform: "ios" }), /Sign in to continue\./);
    const alice = client("alice"), bob = client("bob");
    const aliceToken = TOKEN("alice"), bobToken = TOKEN("bob");
    await alice.mutation(ref("push/devices:register"), { token: aliceToken, platform: "ios" });
    await bob.mutation(ref("push/devices:register"), { token: bobToken, platform: "android" });
    assert.equal((await bob.query(ref("push/devices:status"), { token: aliceToken })).registered, false);
    await bob.mutation(ref("push/devices:remove"), { token: aliceToken });
    assert.equal((await alice.query(ref("push/devices:status"), { token: aliceToken })).registered, true, "bob cannot remove alice's phone");

    const { caseId } = await admin.mutation(ref("push/localProof:seed"), { name: "Alice's shop", ownerId: "alice" });
    await admin.action(ref("notices:notifyOwner"), { caseId, event: "handled_under_permission", text: "text for Keiki" });
    await until(() => admin.query(ref("push/localProof:snapshot"), { caseId }), (s) => s.sends[0]?.outcome === "sent", "no push sent");
    const [request] = stub.sends().filter((r) => r.body.some((m) => m.data.caseId === caseId));
    assert.deepEqual(request.body.map((m) => m.to), [aliceToken], "only alice's phone");
    assert.equal(request.body[0].body, "A fix you allowed ran and the app passed its check. Open the case to see what changed.");

    // Sign-out: the phone removes its token while the session still exists.
    await alice.mutation(ref("push/devices:remove"), { token: aliceToken });
    assert.equal(await admin.query(ref("push/localProof:token"), { token: aliceToken }), null);
    await bob.mutation(ref("push/devices:remove"), { token: bobToken });
  });
});
