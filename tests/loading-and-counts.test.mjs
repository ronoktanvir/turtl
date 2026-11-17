// A count that changes rolls to its new value, and a screen that is waiting for its data shows the shape of what
// is coming. The arithmetic and the rules are held here; how both look is checked in a browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rollOffsets, rollWay } from "../components/ui/roll.ts";
import { SKELETON_WAIT, lineWidths } from "../components/ui/skeletonRules.ts";

const source = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("a count that grows rolls up, one that shrinks rolls down, and one that stays does not move", () => {
  assert.equal(rollWay(3, 4), "up");
  assert.equal(rollWay(4, 3), "down");
  assert.equal(rollWay(9, 10), "up");
  assert.equal(rollWay(2, 2), "none");
});

test("the old number leaves the way the new one is going, and neither travels more than half a line", () => {
  const up = rollOffsets("up", 24);
  assert.ok(up.leave < 0 && up.enter > 0, "rolling up: the old leaves upward, the new comes from below");
  const down = rollOffsets("down", 24);
  assert.ok(down.leave > 0 && down.enter < 0, "rolling down: the reverse");
  assert.equal(up.leave, -up.enter);
  assert.ok(Math.abs(up.enter) <= 12 && Math.abs(up.enter) >= 6);
  assert.deepEqual(rollOffsets("none", 24), { leave: 0, enter: 0 });
  assert.ok(Math.abs(rollOffsets("up", 38).enter) > Math.abs(up.enter), "a bigger number travels further");
});

test("a count never counts up from nothing: it starts on its value and waits until its screen is in view", () => {
  const count = source("components/ui/Count.tsx");
  assert.match(count, /useState\(value\)/, "the first number shown is the real one");
  assert.match(count, /useIsFocused\(\)/, "a change made elsewhere is shown when the person comes back");
  assert.match(count, /useReducedMotion\(\)/);
  assert.match(count, /accessibilityLabel=\{String\(value\)\}/, "a screen reader hears the new number, not both");
});

test("the counts a person watches change are drawn by Count", () => {
  const projects = source("app/projects.tsx");
  assert.match(projects, /<Count [^>]*value=\{p\.bugCount\}/);
  assert.match(projects, /<Count [^>]*value=\{p\.featureCount\}/);
  const home = source("app/project/[projectId]/index.tsx");
  assert.equal(home.match(/<Count [^>]*value=\{project\.bugCount\}/g)?.length, 2, "both layouts of the Fix tile");
  assert.match(home, /<Count [^>]*value=\{project\.featureCount\}/);
});

test("a placeholder's lines look like text: none short of half the width, the last one shortest, the same every time", () => {
  for (const lines of [1, 2, 3, 5]) {
    const widths = lineWidths(lines);
    assert.equal(widths.length, lines);
    assert.ok(widths.every((width) => width >= 50 && width <= 100));
    if (lines > 1) assert.equal(Math.min(...widths), widths.at(-1), "a paragraph ends short");
    assert.deepEqual(lineWidths(lines), widths);
  }
  assert.ok(new Set(lineWidths(4)).size > 2, "not a stack of equal bars");
});

test("a placeholder stays out of the way of a quick answer, holds still when asked, and says it is loading", () => {
  assert.ok(SKELETON_WAIT >= 150 && SKELETON_WAIT <= 300, "long enough that data already on its way never flashes one");
  const skeleton = source("components/ui/Skeleton.tsx");
  assert.match(skeleton, /SKELETON_WAIT/);
  assert.match(skeleton, /useReducedMotion\(\)/);
  assert.match(skeleton, /accessibilityRole="progressbar"/);
  assert.match(skeleton, /accessibilityLabel=\{label\}/);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(skeleton), "colours come from the theme");
});

test("no screen waits behind a bare Loading…", () => {
  const waiting = [
    "app/projects.tsx",
    "app/ai-permission.tsx",
    "app/project/[projectId]/index.tsx",
    "app/project/[projectId]/prepare.tsx",
    "app/review/[caseId]/index.tsx",
    "app/review/[caseId]/enacting.tsx",
    "components/fix/CasePage.tsx",
    "components/project/BeginScreen.tsx",
    "components/project/PreferencesSettings.tsx",
  ];
  for (const path of waiting) {
    const text = source(path);
    assert.ok(!/>\s*Loading…\s*</.test(text), path + " still shows the bare word");
    assert.match(text, /<Skeleton[A-Z]?[A-Za-z]*\b/, path + " shows a placeholder while it waits");
  }
});
