import assert from "node:assert/strict";
import { test } from "node:test";
import { readSource } from "../convex/externalApp/source.ts";

const revision = "a".repeat(40);
const config = { repo: "owner/renamed-game", githubCredentialRef: "TURTL_TEST_GITHUB_TOKEN", sourcePaths: ["lib/game.ts"] };

test("source evidence is read at the observed full revision, not the base branch", async () => {
  const original = globalThis.fetch;
  try {
    const urls = [];
    globalThis.fetch = async (url) => { urls.push(url); return new Response("export const answer = true;"); };
    const result = await readSource(config, revision);
    assert.equal(result.files[0].revision, revision);
    assert.match(urls[0], new RegExp(`owner/renamed-game/contents/lib/game.ts\\?ref=${revision}$`));
    assert.equal(result.missing.length, 0);
    assert.equal((await readSource(config, "main")).files.length, 0);
    assert.equal(urls.length, 1);
  } finally { globalThis.fetch = original; }
});

test("invalid credentials can read public source anonymously without disclosing the token", async () => {
  const original = globalThis.fetch;
  process.env.TURTL_TEST_GITHUB_TOKEN = "test-only-invalid-token";
  try {
    const authorizations = [];
    globalThis.fetch = async (_url, init) => {
      authorizations.push(init.headers.Authorization ?? null);
      return authorizations.length === 1 ? new Response("", { status: 401 }) : new Response("source");
    };
    const result = await readSource(config, revision);
    assert.deepEqual(authorizations, ["Bearer test-only-invalid-token", null]);
    assert.equal(result.files[0].source, "source");
    assert.ok(!JSON.stringify(result).includes("test-only-invalid-token"));
  } finally { globalThis.fetch = original; delete process.env.TURTL_TEST_GITHUB_TOKEN; }
});

test("source failures stay unavailable and sensitive paths are not requested", async () => {
  const original = globalThis.fetch;
  try {
    const requested = [];
    globalThis.fetch = async (url) => { requested.push(url); return new Response("", { status: 404 }); };
    const result = await readSource({ ...config, sourcePaths: ["../private", ".env.local", "private.key", "lib/game.ts"] }, revision);
    assert.equal(result.files.length, 0);
    assert.equal(result.missing.length, 4);
    assert.equal(requested.length, 1);
  } finally { globalThis.fetch = original; }
});
