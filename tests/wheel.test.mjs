import assert from "node:assert/strict";
import { test } from "node:test";
import { sidewaysTravel, wheelSwipeUp } from "../components/project/wheel.ts";

// The Fix and Features lists on a desktop: a mouse wheel moves the strip of cards sideways, and a two-finger
// swipe up on a trackpad (which the browser reports as wheel events) opens the first card, as a finger does.

test("a plain mouse wheel moves the strip sideways by the distance it turned", () => {
  assert.equal(sidewaysTravel({ deltaX: 0, deltaY: 100, deltaMode: 0 }), 100);
  assert.equal(sidewaysTravel({ deltaX: 0, deltaY: -40, deltaMode: 0 }), -40);
});

test("a wheel that reports lines instead of pixels moves a line's worth for each", () => {
  assert.equal(sidewaysTravel({ deltaX: 0, deltaY: 3, deltaMode: 1 }), 48);
});

test("a gesture that is already sideways is left to the browser", () => {
  assert.equal(sidewaysTravel({ deltaX: 60, deltaY: 10, deltaMode: 0 }), 0);
  assert.equal(sidewaysTravel({ deltaX: 0, deltaY: 0, deltaMode: 0 }), 0);
});

test("a swipe up past 80 points opens once, and the rest of the same swipe does not open again", () => {
  const swipe = wheelSwipeUp();
  assert.equal(swipe(40, 0), false);
  assert.equal(swipe(40, 16), true);
  assert.equal(swipe(40, 32), false, "the same swipe is still coasting");
  assert.equal(swipe(40, 48), false);
  assert.equal(swipe(40, 300), false, "coasting counts as the same swipe until the wheel has rested");
});

test("after the wheel has rested, a new swipe can open again", () => {
  const swipe = wheelSwipeUp();
  swipe(50, 0);
  assert.equal(swipe(50, 16), true);
  assert.equal(swipe(50, 1000), false);
  assert.equal(swipe(50, 1016), true);
});

test("small nudges with a rest between them never add up to a swipe", () => {
  const swipe = wheelSwipeUp();
  assert.equal(swipe(50, 0), false);
  assert.equal(swipe(50, 1000), false);
  assert.equal(swipe(50, 2000), false);
});

test("scrolling the other way never opens, and takes back travel already made", () => {
  const swipe = wheelSwipeUp();
  assert.equal(swipe(-200, 0), false);
  assert.equal(swipe(60, 16), false);
  assert.equal(swipe(-60, 32), false);
  assert.equal(swipe(60, 48), false);
  assert.equal(swipe(30, 64), true);
});
