// The decisions behind turtl's motion that are plain arithmetic: which way a screen arrives, how long a list item
// waits its turn, and how a sheet answers a finger on its handle. The animations themselves are checked in a browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { STAGGER_CAP, arrival, arrivalOffset, depthOf, stagger } from "../components/ui/arrival.ts";
import { LIFT_LIMIT, sheetDrag, sheetLetsGo } from "../components/ui/sheetDrag.ts";

const source = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("going deeper arrives from the right, coming back from the left, and the first screen of a visit does not move", () => {
  assert.equal(arrival(null, "/projects"), "first");
  assert.equal(arrival("/projects", "/project/orca"), "forward");
  assert.equal(arrival("/project/orca", "/project/orca/fix"), "forward");
  assert.equal(arrival("/project/orca/fix", "/project/orca"), "back");
  assert.equal(arrival("/project/orca", "/projects"), "back");
  assert.equal(arrival("/projects", "/add-project"), "across");
  assert.ok(arrivalOffset("forward") > 0 && arrivalOffset("back") < 0);
  assert.equal(arrivalOffset("across"), 0);
  assert.equal(arrivalOffset("first"), 0);
});

test("an opened issue is deeper than any list it was opened from, and its own pages deeper still", () => {
  assert.equal(arrival("/project/orca/fix", "/review/orca-1"), "forward");
  assert.equal(arrival("/project/orca", "/review/orca-1"), "forward");
  assert.equal(arrival("/review/orca-1", "/review/orca-1/chat"), "forward");
  assert.equal(arrival("/review/orca-1/chat", "/review/orca-1"), "back");
  assert.equal(arrival("/review/orca-1", "/project/orca/fix"), "back");
  assert.equal(depthOf("/project/orca?tab=1#top"), 2);
});

test("a list's items arrive one after another with shrinking gaps, and none waits past the cap", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(stagger), [0, 50, 90, 120, 145]);
  const waits = Array.from({ length: 40 }, (_, index) => stagger(index));
  assert.ok(waits.every((wait, index) => index === 0 || wait >= waits[index - 1]), "never out of order");
  assert.equal(Math.max(...waits), STAGGER_CAP);
  assert.ok(STAGGER_CAP <= 300, "a long list is all on screen within a third of a second");
});

test("a sheet follows a finger pulling it down exactly, and only gives a little when pulled up", () => {
  assert.equal(sheetDrag(0), 0);
  assert.equal(sheetDrag(37), 37);
  assert.ok(sheetDrag(-30) < 0 && sheetDrag(-30) > -30 * 0.5, "resists from the start");
  assert.ok(sheetDrag(-200) < sheetDrag(-30), "still gives a little more");
  assert.ok(sheetDrag(-100000) > -LIFT_LIMIT - 0.001, "and never lifts past its limit");
});

test("letting go closes a sheet after a quarter of its height or a flick, and not otherwise", () => {
  assert.equal(sheetLetsGo(0, 0, 400), false, "a tap on the handle");
  assert.equal(sheetLetsGo(-40, -1, 400), false, "pulled up");
  assert.equal(sheetLetsGo(60, 0, 400), false, "a short pull, let go slowly");
  assert.equal(sheetLetsGo(101, 0, 400), true, "past a quarter of its height");
  assert.equal(sheetLetsGo(30, 0.5, 400), true, "a flick downward");
  assert.equal(sheetLetsGo(150, -0.5, 400), false, "pulled far, then pushed back up");
  assert.equal(sheetLetsGo(50, 0, 120), false, "a small sheet still needs a real pull");
});

test("every screen arrives through ScreenEnter, and no control waits on an animation before it acts", () => {
  const ui = source("components/ui/index.tsx");
  assert.match(ui, /<ScreenEnter>\{children\}<\/ScreenEnter>/);
  const motion = source("components/ui/motion.tsx");
  const zoom = motion.slice(motion.indexOf("export function ZoomPressable"));
  assert.ok(!/\.start\(\([^)]*\)\s*=>\s*\{[^}]*onPress/.test(zoom), "a card's press is not held until its animation ends");
  assert.ok(!/scale\(0\)|outputRange: \[0, 1\] \}\) \}\] *\/\/ scale/.test(motion), "nothing grows from nothing");
});

test("motion that is not asked for stays off: Reduce Motion is assumed until it is known", () => {
  const motion = source("components/ui/motion.tsx");
  assert.match(motion, /useState\(known \?\? true\)/);
  for (const name of ["Reveal", "Pop", "Breathe", "TypingDots", "usePressScale"]) {
    const body = motion.slice(motion.indexOf("export function " + name));
    assert.ok(body.slice(0, body.indexOf("\n}\n")).includes("useReducedMotion()"), name + " asks about Reduce Motion");
  }
});
