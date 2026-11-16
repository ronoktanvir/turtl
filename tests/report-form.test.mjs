import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";
import { readSubmission } from "../convex/intake/rules.ts";

// The report form in protected-app/report/ is copied into other owners' apps, so it has to stand alone, say where a
// customer's words go, and send only what the README says.

const source = readFileSync(new URL("../protected-app/report/ReportForm.tsx", import.meta.url), "utf8");
const listing = JSON.parse(readFileSync(new URL("../store.config.json", import.meta.url), "utf8")).apple.info["en-US"];

function load() {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  const module = { exports: {} };
  const imports = { react: { useState: (value) => [value, () => {}] }, "react-native": { StyleSheet: { create: (s) => s }, Platform: { OS: "ios" }, Linking: {} }, "react/jsx-runtime": { jsx: () => null, jsxs: () => null, Fragment: "Fragment" } };
  runInThisContext(`(function(require, exports, module) { ${outputText}\n})`, { filename: "ReportForm.tsx" })(
    (name) => { assert.ok(name in imports, `The form imports ${name}; it may only need react and react-native`); return imports[name]; }, module.exports, module,
  );
  return module.exports;
}

test("the form needs only react and react-native, so it can be copied into any Expo app", () => {
  const form = load();
  assert.equal(typeof form.ReportForm, "function");
  assert.doesNotMatch(source, /from "\.\.?\//, "no import from the demo app");
});

test("the form tells the customer where their words go and links to the policy's report form section", () => {
  const { POLICY_URL } = load();
  assert.ok(POLICY_URL.startsWith(listing.privacyPolicyUrl), `${POLICY_URL} is not under ${listing.privacyPolicyUrl}`);
  assert.match(POLICY_URL, /#if-you-use-the-report-form$/);
  const policy = readFileSync(new URL("../site/privacy.md", import.meta.url), "utf8");
  assert.match(policy, /^## If you use the report form$/m, "the anchor names a heading that exists");
  assert.match(source, /goes to the team behind this app through turtl/);
  assert.match(source, /AI services/);
  assert.match(source, /accessibilityRole="link"[^>]*onPress=\{\(\) => \{ Linking\.openURL\(POLICY_URL\)/);
});

test("the form asks for no contact and sends only what the endpoint accepts", () => {
  assert.doesNotMatch(source, /contact|keyboardType="email-address"|textContentType/i);
  const body = source.match(/body: JSON\.stringify\(\{ ([^}]*) \}\)/)[1];
  assert.deepEqual(body.split(",").map((field) => field.trim().split(":")[0]), ["key", "text", "kind", "reporterId", "reportId"]);
  const sent = { key: "tik_x", text: "The booking button does nothing.", kind: "bug", reporterId: "abc123", reportId: "def456" };
  assert.equal(readSubmission(JSON.stringify(sent)).ok, true);
});

test("every control on the form has a test id, a role and a label", () => {
  for (const element of source.match(/<(Pressable|TextInput)\b[^>]*>/g)) {
    assert.match(element, /testID=/, element);
    assert.match(element, /accessibilityLabel=/, element);
    if (element.startsWith("<Pressable")) assert.match(element, /accessibilityRole=/, element);
  }
});
