import assert from "node:assert/strict";
import { test } from "node:test";
import { usesLiveData } from "../data/source.ts";

test("live data needs a URL and the explicit example override always wins", () => {
  assert.equal(usesLiveData(undefined, undefined), false);
  assert.equal(usesLiveData("", "live"), false);
  assert.equal(usesLiveData("https://deployment.convex.cloud", undefined), true);
  assert.equal(usesLiveData("https://deployment.convex.cloud", "example"), false);
});
