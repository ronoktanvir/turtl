import assert from "node:assert/strict";
import { test } from "node:test";
import { devToolsShown, usesLiveData } from "../data/source.ts";

test("live data needs a URL and the explicit example override always wins", () => {
  assert.equal(usesLiveData(undefined, undefined), false);
  assert.equal(usesLiveData("", "live"), false);
  assert.equal(usesLiveData("https://deployment.convex.cloud", undefined), true);
  assert.equal(usesLiveData("https://deployment.convex.cloud", "example"), false);
});

test("a development build hides the Dev pill and Live cases once the backend says accounts are on", async () => {
  assert.equal(devToolsShown(true, { accounts: true }), false);
  assert.equal(devToolsShown(true, { accounts: false }), true);
  assert.equal(devToolsShown(true, undefined), true); // still loading, or the example build
  assert.equal(devToolsShown(false, { accounts: false }), false);
  const { readFileSync } = await import("node:fs");
  for (const file of ["app/projects.tsx", "app/review/[caseId]/chat.tsx", "components/fix/CasePage.tsx", "components/dev/DevTools.tsx"]) {
    const source = readFileSync(new URL("../" + file, import.meta.url), "utf8");
    assert.match(source, /useDevToolsOn\(\)/, file);
    assert.doesNotMatch(source, /import \{[^}]*\bdevToolsOn\b[^}]*\} from "[./]*\/?(components\/)?ui"/, file);
  }
});
