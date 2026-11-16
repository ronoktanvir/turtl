#!/usr/bin/env node
// turtl's emailed codes on a local Convex backend, with accounts on, against the stand-in for Resend in
// tests/fixtures/auth-stand-in.mjs: a password sign-up is held at Check your email until it confirms; a stranger's
// wrong reset codes do not spoil the owner's; the limits on emails hold; Start over frees the address. Convex's own
// runtime runs the functions and the fetches. Nothing here talks to Resend.
//   CONVEX_AGENT_MODE=anonymous npx convex dev --local-cloud-port 3292 --local-site-port 3293   (keep it running)
//   node scripts/email-codes/prove-local.mjs           (--port <n> serves the stand-in there; default 8212)
//   node scripts/email-codes/prove-local.mjs --slow    also waits out the minute between emails five times, to show
//                                                      the fifth email of the day is the last (about five minutes)
// It refuses to run unless .env.local names a local backend, and removes every variable it set when it ends.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference as ref } from "convex/server";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { startAuthStandIn } from "../../tests/fixtures/auth-stand-in.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const local = Object.fromEntries(
  readFileSync(join(root, ".env.local"), "utf8")
    .split("\n")
    .map((line) => /^([A-Z_]+)=(\S+)/.exec(line))
    .filter(Boolean)
    .map((match) => [match[1], match[2]]),
);
const convexUrl = local.EXPO_PUBLIC_CONVEX_URL ?? "";
const isLocal = (url) => /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url);
if (!/^(anonymous|local):/.test(local.CONVEX_DEPLOYMENT ?? "") || !isLocal(convexUrl)) {
  console.error("Refusing to run: .env.local does not name a local Convex backend. Start one with CONVEX_AGENT_MODE=anonymous npx convex dev.");
  process.exit(1);
}
const slow = process.argv.includes("--slow");
const portIndex = process.argv.indexOf("--port");
const port = portIndex === -1 ? 8212 : Number(process.argv[portIndex + 1]);
const standIn = await startAuthStandIn({ port });

const scratch = mkdtempSync(join(tmpdir(), "turtl-email-codes-"));
const convex = async (...args) => (await promisify(execFile)("npx", ["convex", ...args], { cwd: root, env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" } })).stdout;
const signing = await generateKeyPair("RS256", { extractable: true });
const fromFile = {
  JWT_PRIVATE_KEY: (await exportPKCS8(signing.privateKey)).trimEnd().replace(/\n/g, " "),
  JWKS: JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(signing.publicKey)) }] }),
};
const plain = {
  AUTH_REQUIRED: "true",
  SITE_URL: "http://localhost:8129",
  AUTH_STAND_IN_URL: standIn.url,
  // Stand-in values: the stand-in takes any key, and nothing is sent to Resend.
  AUTH_RESEND_KEY: "stand-in-key",
  AUTH_EMAIL_FROM: "turtl <no-reply@example.com>",
};
const VARIABLES = [...Object.keys(fromFile), ...Object.keys(plain)];
const cleanUp = async () => {
  for (const name of VARIABLES) await convex("env", "remove", name).catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
  await standIn.close();
};

let passed = 0;
const step = async (name, body) => {
  await body();
  passed += 1;
  console.log("ok   " + name);
};
const message = (error) => error?.data ?? error?.message;
const refusedWith = (words) => (error) => message(error) === words || (words instanceof RegExp && words.test(message(error)));
const guess = () => Array.from(randomBytes(20), (byte) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[byte & 31]).join("");
const signIn = async (params) => {
  const client = new ConvexHttpClient(convexUrl);
  const { tokens } = await client.action(ref("auth:signIn"), { provider: "password", params });
  if (tokens) client.setAuth(tokens.token);
  return { client, tokens };
};
const subjects = (to) => standIn.emails.filter((email) => email.to?.includes(to)).map((email) => email.subject);

try {
  for (const [name, value] of Object.entries(fromFile)) {
    const file = join(scratch, name);
    writeFileSync(file, value, { mode: 0o600 });
    await convex("env", "set", name, "--from-file", file);
  }
  for (const [name, value] of Object.entries(plain)) await convex("env", "set", name, value);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const owner = `owner-${randomBytes(3).toString("hex")}@example.com`;
  const secret = "local proof " + randomBytes(8).toString("hex");
  let first;
  await step("a password sign-up is held at Check your email: no permission, no project, no account for actions", async () => {
    first = await signIn({ email: owner, password: secret, flow: "signUp" });
    const viewer = await first.client.query(ref("users:viewer"), {});
    assert.equal(viewer.confirmed, false);
    assert.deepEqual(subjects(owner), ["Confirm your email address for turtl"]);
    const { listVersion } = await first.client.query(ref("consent/permission:status"), {});
    await assert.rejects(first.client.mutation(ref("consent/permission:allow"), { listVersion }), refusedWith("Sign in to continue."));
    await assert.rejects(first.client.mutation(ref("onboarding/projects:add"), { repoUrl: "https://github.com/owner/shop" }), refusedWith("Sign in to continue."));
    await assert.rejects(first.client.action(ref("users:account"), {}), refusedWith("Sign in to continue."));
    const status = await first.client.query(ref("auth/confirmation:status"), {});
    assert.equal(status.email, owner);
    console.log(`     Check your email: sent to ${status.email}, works until ${new Date(status.worksUntil).toISOString()}, deleted if unconfirmed after ${new Date(status.removedAt).toISOString()}`);
  });

  await step("asking for the email again within a minute sends nothing, and says so", async () => {
    const answer = await first.client.action(ref("auth/confirmation:resend"), {});
    assert.equal(answer.sent, false);
    assert.match(answer.message, /less than a minute ago/);
    assert.equal(subjects(owner).length, 1);
  });

  await step("wrong confirmation codes change nothing; the code from the email's link confirms, and then the account acts", async () => {
    for (let n = 0; n < 50; n++) await assert.rejects(first.client.mutation(ref("auth/confirmation:confirm"), { code: guess() }), refusedWith(/That code didn't work/));
    const link = standIn.lastLink(owner);
    assert.match(link, /^turtl:\/\/confirm-email\?emailCode=/);
    await first.client.mutation(ref("auth/confirmation:confirm"), { code: new URL(link).searchParams.get("emailCode") });
    assert.equal((await first.client.query(ref("users:viewer"), {})).confirmed, true);
    const { listVersion } = await first.client.query(ref("consent/permission:status"), {});
    await first.client.mutation(ref("consent/permission:allow"), { listVersion });
    assert.equal(typeof (await first.client.action(ref("users:account"), {})), "string");
  });

  await step("a stranger's 300 wrong reset codes, and 20 more requests, leave the owner's reset code working", async () => {
    // Ten wrong passwords lock the owner's password, as Convex Auth does.
    const stranger = new ConvexHttpClient(convexUrl);
    for (let n = 0; n < 10; n++) await assert.rejects(stranger.action(ref("auth:signIn"), { provider: "password", params: { email: owner, password: `wrong ${n}`, flow: "signIn" } }));
    await assert.rejects(stranger.action(ref("auth:signIn"), { provider: "password", params: { email: owner, password: secret, flow: "signIn" } }), refusedWith(/Too many wrong passwords/));
    await stranger.action(ref("auth:signIn"), { provider: "password", params: { email: owner, flow: "reset" } });
    const code = standIn.lastCode(owner);
    for (let n = 0; n < 20; n++) await stranger.action(ref("auth:signIn"), { provider: "password", params: { email: owner, flow: "reset" } });
    for (let n = 0; n < 300; n++) {
      await assert.rejects(stranger.action(ref("auth:signIn"), { provider: "password", params: { email: owner, code: guess(), newPassword: "stranger's pick", flow: "reset-verification" } }), refusedWith(/doesn't work for this email address/));
    }
    assert.deepEqual(subjects(owner).filter((subject) => subject === "Reset your turtl password").length, 1, "21 requests in a minute, one email");
    const back = await signIn({ email: owner, code, newPassword: "the owner's new password", flow: "reset-verification" });
    assert.ok(back.tokens, "the owner is signed in");
    assert.equal(await first.client.query(ref("users:viewer"), {}), null, "the session from before the reset has ended");
    assert.ok((await signIn({ email: owner, password: "the owner's new password", flow: "signIn" })).tokens, "the lock is cleared: the new password works at once");
    await assert.rejects(signIn({ email: owner, code, newPassword: "a third password", flow: "reset-verification" }), refusedWith(/doesn't work for this email address/), "a code works once");
  });

  await step("Start over throws an unconfirmed account away and frees its address at once", async () => {
    const typo = `typo-${randomBytes(3).toString("hex")}@exmaple.com`;
    const held = await signIn({ email: typo, password: secret, flow: "signUp" });
    await held.client.mutation(ref("auth/confirmation:startOver"), {});
    assert.equal(await held.client.query(ref("users:viewer"), {}), null);
    assert.ok((await signIn({ email: typo, password: "another password here", flow: "signUp" })).tokens, "the same address signs up again");
  });

  if (slow) {
    await step("five reset emails to one address, a minute apart, and the sixth is refused; the newest still works", async () => {
      const target = `limits-${randomBytes(3).toString("hex")}@example.com`;
      await signIn({ email: target, password: secret, flow: "signUp" });
      const resets = () => subjects(target).filter((subject) => subject === "Reset your turtl password").length;
      for (let n = 0; n < 6; n++) {
        if (n > 0) await new Promise((resolve) => setTimeout(resolve, 61_000));
        await new ConvexHttpClient(convexUrl).action(ref("auth:signIn"), { provider: "password", params: { email: target, flow: "reset" } });
        console.log(`     request ${n + 1}: ${resets()} reset email${resets() === 1 ? "" : "s"} so far`);
      }
      assert.equal(resets(), 5);
      const back = await signIn({ email: target, code: standIn.lastCode(target), newPassword: "after the limit", flow: "reset-verification" });
      assert.ok(back.tokens, "the newest works while no other can be sent");
    });
  }

  console.log(`\n${passed} checks passed. Emails the stand-in received: ${standIn.emails.length}.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanUp();
}
