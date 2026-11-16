import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { mapCaseSummary } from "../data/live/caseMapping.ts";
import { createLoader, memoryDb, root, withEnv } from "./fixtures/convex-memory.mjs";

// A case's star is the owner's "look at this later". It is stored on the case, only the case's owner can set it,
// and the live build shows it like the example build does.

const { setStarred } = createLoader()("convex/cases.ts");

const ADA = "acct-ada";
const world = () =>
  memoryDb(
    { apps: null, cases: null },
    {
      apps: [{ _id: "apps:1", name: "Booking", ownerId: ADA }, { _id: "apps:2", name: "Bob's", ownerId: "acct-bob" }],
      cases: [{ _id: "cases:1", appId: "apps:1", title: "Bookings fail" }, { _id: "cases:2", appId: "apps:2", title: "Bob's case" }],
    },
  );
const signedIn = (account) => ({ getUserIdentity: async () => (account ? { subject: `${account}|session-1` } : null) });
const star = (db, account, caseId, starred) => setStarred.handler({ db, auth: signedIn(account) }, { caseId, starred });

test("with accounts on, the owner stars and unstars their own case", async () => {
  await withEnv({ AUTH_REQUIRED: "true" }, async () => {
    const db = world();
    assert.equal(await star(db, ADA, "cases:1", true), null);
    assert.equal(db.rows("cases")[0].starred, true);
    await star(db, ADA, "cases:1", false);
    assert.equal(db.rows("cases")[0].starred, false);
  });
});

test("another account's case, or no sign-in, reads as not available and changes nothing", async () => {
  await withEnv({ AUTH_REQUIRED: "true" }, async () => {
    const db = world();
    await assert.rejects(star(db, ADA, "cases:2", true), (error) => error.data === "That project is not available on this account.");
    await assert.rejects(star(db, null, "cases:1", true), (error) => error.data === "Sign in to continue.");
    assert.deepEqual(db.rows("cases").map((row) => row.starred), [undefined, undefined]);
  });
});

test("the single-owner demo stars without a passcode", async () => {
  await withEnv({ AUTH_REQUIRED: undefined }, async () => {
    const db = world();
    await star(db, null, "cases:2", true);
    assert.equal(db.rows("cases")[1].starred, true);
  });
});

test("the live mapping carries the star, and an unstarred case has none", () => {
  const row = { _id: "cases:1", _creationTime: 1, appId: "apps:1", title: "Bookings fail", impact: "", kind: "outage", raisedBy: "monitor", status: "open" };
  assert.equal(mapCaseSummary({ ...row, starred: true }, 1).starred, true);
  assert.equal("starred" in mapCaseSummary({ ...row, starred: false }, 1), false);
  assert.equal("starred" in mapCaseSummary(row, 1), false);
});

test("the case screen no longer says stars are unavailable, and stars work in both builds", () => {
  const screen = readFileSync(join(root, "app/review/[caseId]/index.tsx"), "utf8");
  assert.doesNotMatch(screen, /Stars are not available/);
  assert.doesNotMatch(screen, /isLiveData/);
  const actions = readFileSync(join(root, "data/live/actions.ts"), "utf8");
  assert.match(actions, /api\.cases\.setStarred/);
});
