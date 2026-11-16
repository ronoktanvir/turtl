import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { legalLinks } from "../components/legal/links.ts";
import { checkListing, checkPages } from "../store/check.mjs";

const root = new URL("..", import.meta.url).pathname;
const listing = JSON.parse(readFileSync(new URL("../store.config.json", import.meta.url), "utf8")).apple.info["en-US"];
const compose = (env) => JSON.parse(execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(require('./store.config.js')))"], { cwd: root, env: { PATH: process.env.PATH, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const reviewer = { APP_REVIEW_FIRST_NAME: "Ada", APP_REVIEW_LAST_NAME: "Example", APP_REVIEW_EMAIL: "review@example.com", APP_REVIEW_PHONE: "+1 555 010 0000", APP_REVIEW_DEMO_USERNAME: "review@example.com", APP_REVIEW_DEMO_PASSWORD: "placeholder" };

test("the store listing fits Apple's limits and names no price", () => {
  assert.deepEqual(checkListing().problems, []);
});

test("the listing, the app's links, and the published pages name the same addresses", () => {
  assert.deepEqual(checkPages().problems, []);
  const byId = Object.fromEntries(legalLinks.map((link) => [link.id, link.url]));
  assert.equal(byId.privacy, listing.privacyPolicyUrl);
  assert.equal(byId.support, listing.supportUrl);
  assert.equal(byId.terms, listing.marketingUrl + "terms/");
});

test("App Review's contact and sign-in come only from the environment, all or nothing", () => {
  assert.equal(compose({}).apple.review, undefined);
  const full = compose(reviewer).apple.review;
  assert.equal(full.demoUsername, reviewer.APP_REVIEW_DEMO_USERNAME);
  assert.equal(full.demoRequired, true);
  assert.ok(full.notes.length > 100 && Buffer.byteLength(full.notes) <= 4000);
  assert.throws(() => compose({ ...reviewer, APP_REVIEW_PHONE: "" }));
  assert.doesNotMatch(readFileSync(new URL("../store.config.json", import.meta.url), "utf8"), /"review"|demoPassword/);
});
