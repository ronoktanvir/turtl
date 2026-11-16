import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";

// A check's `credentialRef` is data: it is stored on a row and can come from a project's turtl.json. These tests
// hold that it can never pick which of the deployment's secrets is sent to that project's server.

function load(path, imports = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const module = { exports: {} };
  runInThisContext(`(function(require, exports, module) { ${outputText}\n})`, { filename: path })(
    (name) => { assert.ok(name in imports, `Unexpected import: ${name}`); return imports[name]; },
    module.exports,
    module,
  );
  return module.exports;
}

const client = load("../convex/protectedApp/client.ts");
const detect = load("../convex/onboarding/detect.ts");

function withFetch(run) {
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), headers: { ...(init?.headers ?? {}) } });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return run(sent).finally(() => { globalThis.fetch = real; });
}

function withEnv(values, run) {
  const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  return run().finally(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

const secrets = { OPENAI_API_KEY: "stand-in-model-key", GITHUB_APP_PRIVATE_KEY: "stand-in-private-key", JWT_PRIVATE_KEY: "stand-in-signing-key", PROTECTED_APP_CONTROL_SECRET: "stand-in-control-token" };

test("a request never carries a deployment secret other than the watched app's own token", () =>
  withEnv(secrets, () => withFetch(async (sent) => {
    for (const name of ["OPENAI_API_KEY", "GITHUB_APP_PRIVATE_KEY", "JWT_PRIVATE_KEY", "PATH", "protected_app_control_secret"]) {
      const result = await client.call("https://owner.example/hook", { method: "POST", credentialRef: name });
      assert.equal(result.kind, "not_sent", name);
      assert.match(result.reason, /does not send the setting named/);
    }
    assert.deepEqual(sent, [], "nothing was requested for a refused name");
  })));

test("the watched app's own token is still sent, and a call with no credential sends none", () =>
  withEnv(secrets, () => withFetch(async (sent) => {
    const signed = await client.call("https://booking.example/flags", { credentialRef: client.CREDENTIAL_REF });
    assert.equal(signed.kind, "response");
    const open = await client.call("https://booking.example/health");
    assert.equal(open.kind, "response");
    assert.equal(sent[0].headers.Authorization, "Bearer stand-in-control-token");
    assert.equal(sent[1].headers.Authorization, undefined);
  })));

test("a journey check with a refused credential name reports why and requests nothing", () =>
  withEnv(secrets, () => withFetch(async (sent) => {
    const outcome = await client.runJourneyCheck({ url: "https://owner.example/journey-check", credentialRef: "OPENAI_API_KEY" });
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /does not send the setting named OPENAI_API_KEY/);
    assert.deepEqual(sent, []);
  })));

test("turtl.json may name only that one setting, and both files agree on its name", () => {
  assert.equal(detect.MANIFEST_CREDENTIAL_REF, client.CREDENTIAL_REF);
  assert.deepEqual([...client.SENDABLE_CREDENTIAL_REFS], [client.CREDENTIAL_REF]);
  const manifest = (credentialRef) => detect.parseManifest(JSON.stringify({ version: 1, credentialRef, journeys: [{ name: "Book", path: "/journey-check", authenticated: true }] }));
  assert.equal(manifest(client.CREDENTIAL_REF).ok, true);
  for (const name of ["OPENAI_API_KEY", "GITHUB_APP_PRIVATE_KEY", "JWT_PRIVATE_KEY", "SUPERMEMORY_API_KEY", "sk-live-abc", "", 7]) {
    const parsed = manifest(name);
    assert.equal(parsed.ok, false, String(name));
    assert.match(parsed.reason, /credentialRef must be PROTECTED_APP_CONTROL_SECRET/);
  }
  assert.equal(detect.parseManifest(JSON.stringify({ version: 1, journeys: [] })).ok, true, "a file with no credential is fine");
});
