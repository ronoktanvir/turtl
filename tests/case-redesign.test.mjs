import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";

// Ronok's second pass over the issues list and an opened issue: the issue's own name at the top, a compact list with
// a swipe that spreads turtl's green, the Overview, Logs and Code bar that regroups around the selected tab, and
// Fixes as its own page. These check the rules that decide those, without a renderer.

function load(path, imports = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: path,
  });
  const module = { exports: {} };
  runInThisContext("(function(require, exports, module) { " + outputText + "\n})", { filename: path })(
    (name) => { assert.ok(name in imports, "Unexpected import: " + name); return imports[name]; }, module.exports, module,
  );
  return module.exports;
}

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// --- The name at the top of an opened issue ---

const { caseTitle } = load("../components/ui/caseTitle.ts");

test("an opened issue is headed by its own title, with no project name and no number", () => {
  assert.equal(caseTitle({ title: "Answers time out before the next round", number: 1, type: "fix" }), "Answers time out before the next round");
  assert.equal(caseTitle({ title: "  Share a   finished streak \n", number: 2, type: "feature" }), "Share a finished streak");
  assert.equal(caseTitle({ title: "", number: 4, type: "fix" }), "Error #4");
  assert.equal(caseTitle({ title: "   ", number: 3, type: "feature" }), "Request #3");
  assert.equal(caseTitle({ title: null, number: 0, type: "fix" }), "Case");
  assert.equal(caseTitle({ title: undefined, number: 0, type: "feature" }), "Request");
});

test("the issue screen and the running fix use that title, on one line that scrolls, and never the project's name", () => {
  for (const path of ["../app/review/[caseId]/index.tsx", "../app/review/[caseId]/enacting.tsx"]) {
    const screen = source(path);
    assert.match(screen, /<Header\s+title=\{caseTitle\((current|c)\)\}\s+scrollTitle/, path + " heads the screen with the case's title");
    assert.doesNotMatch(screen, /project\??\.name/, path + " no longer puts the project's name in front of the case");
    assert.doesNotMatch(screen, /: (error|request) #|" (error|request)"/, path + " no longer builds a name like “Listener Ladder: error #1”");
  }
  const ui = source("../components/ui/index.tsx");
  assert.match(ui, /scrollTitle \? \(\s*<ScrollingTitle title=\{title\} testID=\{testID\} \/>/);
  assert.match(ui, /<ScrollView[\s\S]*?horizontal[\s\S]*?<T variant="heading" font="title" style=\{nowrap\} testID=\{testID\} accessibilityRole="header">/, "the title stays a heading for screen readers inside its sideways scroll");
});

// --- The Overview, Logs and Code bar ---

const { tabSides, tabPositions } = load("../components/fix/tabLayout.ts");

test("the selected tab stands apart and the others gather on the side they come from", () => {
  assert.deepEqual(tabSides(3, 0), ["start", "end", "end"]); // Overview: left; Logs and Code together at the right
  assert.deepEqual(tabSides(3, 1), ["start", "center", "end"]); // Logs: in the middle
  assert.deepEqual(tabSides(3, 2), ["start", "start", "end"]); // Code: at the right; Overview and Logs together at the left
});

test("the tabs' places at phone width, and at 320 wide where the middle tab keeps clear of its neighbours", () => {
  const widths = [100, 62, 66]; // Overview, Logs, Code, as measured
  assert.deepEqual(tabPositions(widths, 0, 390, 16, 18), [16, 228, 308]);
  assert.deepEqual(tabPositions(widths, 1, 390, 16, 18), [16, 164, 308]);
  assert.deepEqual(tabPositions(widths, 2, 390, 16, 18), [16, 134, 308]);
  const narrow = tabPositions(widths, 1, 320, 16, 18);
  assert.deepEqual(narrow, [16, 134, 238]);
  assert.ok(narrow[1] >= 16 + 100 + 18 && narrow[1] + 62 + 18 <= narrow[2], "Logs keeps a full gap from Overview and Code");
  const squeezed = tabPositions(widths, 1, 260, 16, 18);
  assert.ok(squeezed[1] > squeezed[0] && squeezed[1] < squeezed[2], "with no room for gaps, the middle tab sits halfway between");
  assert.equal(tabPositions([100, 0, 66], 0, 390, 16, 18), null, "nothing is placed until every tab is measured");
  assert.equal(tabPositions(widths, 0, 0, 16, 18), null);
});

test("each tab has its own colour, readable on both themes, and the bar keeps its test IDs", () => {
  const { dark, light } = load("../theme/tokens.ts");
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const [name, theme] of [["dark", dark], ["light", light]]) {
    for (const token of ["tabOverview", "tabLogs", "tabCode"]) {
      assert.match(theme[token], /^#[0-9a-f]{6}$/i, `${name}.${token}`);
      assert.ok(contrast(theme[token], theme.bg) >= 4.5, `${name}.${token} reads at 4.5:1 or more on the background (${contrast(theme[token], theme.bg).toFixed(2)})`);
    }
    assert.equal(new Set([theme.tabOverview, theme.tabLogs, theme.tabCode]).size, 3, name + " gives each tab its own colour");
  }
  const tabs = source("../components/fix/CaseTabs.tsx");
  assert.match(tabs, /const tints: Record<CaseTab, TokenName> = \{ Overview: "tabOverview", Logs: "tabLogs", Code: "tabCode" \};/);
  assert.match(tabs, /testID=\{id\("tab-" \+ name\.toLowerCase\(\)\)\}/);
  assert.match(tabs, /accessibilityRole="tab"/);
});

// --- Pulling: the list's green swipe and the move between an issue and its fixes ---

const swipe = load("../components/ui/swipe.ts");

test("a pull completes past half its travel, or on a quick flick, and otherwise falls back", () => {
  assert.equal(swipe.shouldComplete(0.49), false);
  assert.equal(swipe.shouldComplete(0.5), true);
  assert.equal(swipe.shouldComplete(0.15, 0.7), true, "a quick flick toward the target completes early");
  assert.equal(swipe.shouldComplete(0.1, 3), false, "a twitch is not a flick");
  assert.equal(swipe.shouldComplete(0.3, 0.2), false);
  assert.equal(swipe.swipeProgress(-40, 200), 0, "pulling the other way is no progress");
  assert.equal(swipe.swipeProgress(100, 200), 0.5);
  assert.equal(swipe.swipeProgress(900, 200), 1);
  assert.equal(swipe.swipeProgress(50, 0), 0);
  assert.equal(swipe.swipeTravel(844), 280);
  assert.equal(swipe.swipeTravel(560), 224);
  assert.equal(swipe.swipeTravel(300), 180);
  assert.equal(swipe.swipeTravel(0), 180);
});

test("only a clearly vertical drag in the pull's direction is a pull, so taps and sideways swipes pass", () => {
  assert.equal(swipe.isVerticalPull(0, -20, "up"), true);
  assert.equal(swipe.isVerticalPull(0, -6, "up"), false, "inside the dead zone it is still a tap");
  assert.equal(swipe.isVerticalPull(0, 20, "up"), false, "the wrong way");
  assert.equal(swipe.isVerticalPull(30, -25, "up"), false, "sideways belongs to the issue pager");
  assert.equal(swipe.isVerticalPull(4, 40, "down"), true);
});

test("a wheel pull begins only with a scroll that starts at the page's edge, so reading never spills into the next page", () => {
  const { wheelStep, wheelProgress, restingWheel, WHEEL_GAP, WHEEL_TRAVEL } = swipe;
  // One long scroll that reaches the end part way: it stops there, momentum and all.
  let s = restingWheel;
  for (let t = 0; t < 600; t += 16) s = wheelStep(s, t, 40, t > 300);
  assert.equal(s.distance, 0);
  // A fresh scroll at the end pulls, and completes past half.
  s = wheelStep(s, 600 + WHEEL_GAP + 1, 60, true);
  assert.equal(s.distance, 60);
  s = wheelStep(s, 600 + WHEEL_GAP + 20, 40, true);
  assert.equal(wheelProgress(s), 100 / WHEEL_TRAVEL);
  assert.ok(swipe.shouldComplete(wheelProgress(s)), "one ordinary notch of about 100 px completes");
  // Scrolling back undoes it, and once undone the rest of that scroll moves the page as usual.
  s = wheelStep(s, 840, -150, true);
  assert.equal(s.distance, 0);
  s = wheelStep(s, 856, 40, true);
  assert.equal(s.distance, 0, "the same scroll gesture does not pull again");
  // A scroll the wrong way at the edge is ordinary scrolling.
  assert.equal(wheelStep(restingWheel, 5000, -80, true).distance, 0);
  // Away from the edge nothing pulls.
  assert.equal(wheelStep(restingWheel, 5000, 80, false).distance, 0);
  // A pull still under way carries on across a short pause, as slow notches of a mouse wheel do.
  s = wheelStep(restingWheel, 9000, 50, true);
  s = wheelStep(s, 9000 + WHEEL_GAP + 50, 50, false);
  assert.equal(s.distance, 100);
});

test("wheel deltas in lines or pages count as pixels", () => {
  assert.equal(swipe.wheelPixels(3, 1, 800), 48);
  assert.equal(swipe.wheelPixels(1, 2, 700), 700);
  assert.equal(swipe.wheelPixels(-120, 0, 700), -120);
});

// --- The screens keep their ways in for keyboards, screen readers and tests ---

test("the list keeps its rows and adds the swipe, with a button doing everything the swipe does", () => {
  const begin = source("../components/project/BeginScreen.tsx");
  for (const id of ["begin-${type}", "header-back", "begin-case-strip", "begin-case-${item.id}", "begin-date-${item.id}", "begin-status-${item.id}", "begin-review", "begin-not-found-back"]) {
    assert.ok(begin.includes(id), "BeginScreen keeps " + id);
  }
  assert.match(begin, /accessibilityLabel=\{item\.title \+ "\. " \+ state\.label \+ "\. " \+ date\}/, "each row says its state to a screen reader");
  assert.match(begin, /accessibilityLabel=\{state\.label\}/);
  assert.match(begin, /onPress=\{begin\}[\s\S]*?accessibilityRole="button"[\s\S]*?testID="begin-review"/, "tapping the arrow, or Enter on it, plays the same move");
  assert.match(begin, /if \(reduced\) return open\(\);/, "with reduced motion it just opens");
  assert.match(begin, /useFocusEffect\(/, "coming back finds the list reset");
  assert.doesNotMatch(begin, /\{state\.label\}<\/T>/, "no status sentence beside the turtle");
});

test("Fixes is its own page, reached by the same pinned button, with a way back and everything it had", () => {
  const page = source("../components/fix/CasePage.tsx");
  for (const id of ["look-at-fixes", "fixes-section", "fixes-back", "fixes-enacting", "fixes-open-enacting", "fixes-declined", "fixes-decline", "investigate-further", "case-health", "case-summary", "overview-empty", "logs-empty", "code-empty", "screenshots-strip"]) {
    assert.ok(page.includes(`id("${id}")`), "CasePage keeps " + id);
  }
  assert.match(page, /label=\{feature \? "Look at options" : "Look at potential fixes"\}/);
  assert.match(page, /\{feature \? "Options" : "Fixes"\}/);
  assert.match(page, /onPress=\{\(\) => go\("fixes", true\)\}/);
  assert.match(page, /onPress=\{\(\) => go\("case", true\)\}/);
  assert.match(page, /if \(reduced\) return arrive\(target, refocus\);/, "with reduced motion the pages simply switch");
  assert.match(page, /<ApproveSheet caseId=\{c\.id\} fix=\{approving\}/);
  assert.match(page, /<DeclineSheet caseId=\{c\.id\} visible=\{declining\}/);
  assert.match(page, /display: part === "case" \? "flex" : "none"/, "the page not shown is out of the way of keyboards and screen readers");
  assert.match(page, /mouse: false/, "on the web a mouse drag on a page still selects text");
});
