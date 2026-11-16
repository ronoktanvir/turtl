import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";

// RC-03: losing the network in the middle of a decision shows a message, not a sheet stuck on "Approving…".
// A Sheet is a Modal and draws above the root layout's "Can't reach turtl" screen, so the layout hands that
// screen to open sheets through components/ui/sheetCover.ts.

function load(path, imports) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  runInThisContext(`(function(require, exports, module) { ${outputText}\n})`, { filename: path })(
    (name) => { assert.ok(name in imports, `Unexpected import: ${name}`); return imports[name]; },
    module.exports,
    module,
  );
  return module.exports;
}

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("every open sheet is told when the cover changes, and stops listening when it closes", () => {
  const subscriptions = [];
  const react = { useSyncExternalStore: (subscribe, read) => { subscriptions.push({ subscribe, read }); return read(); } };
  const { setSheetCover, useSheetCover } = load("../components/ui/sheetCover.ts", { react });

  assert.equal(useSheetCover(), null, "no cover until the layout sets one");
  const [{ subscribe, read }] = subscriptions;
  let told = 0;
  const stop = subscribe(() => { told += 1; });

  const screen = { is: "the unreachable screen" };
  setSheetCover(screen);
  assert.equal(told, 1);
  assert.equal(read(), screen);

  setSheetCover(null);
  assert.equal(told, 2);
  assert.equal(read(), null);

  stop();
  setSheetCover(screen);
  assert.equal(told, 2, "a closed sheet is no longer told");
  setSheetCover(null);
});

test("a sheet draws the cover inside its own Modal, above its content", () => {
  const ui = source("../components/ui/index.tsx");
  const sheet = ui.slice(ui.indexOf("export function Sheet("), ui.indexOf("export function ago("));
  assert.match(sheet, /const cover = useSheetCover\(\);/);
  const modal = sheet.slice(sheet.indexOf("<Modal"), sheet.indexOf("</Modal>"));
  assert.ok(modal.includes("{cover}"), "the cover is inside the Modal");
  assert.ok(modal.indexOf("{cover}") > modal.indexOf("{footer}"), "and after the sheet's own content, so it is on top");
});

test("the root layout hands sheets the unreachable screen while the backend is out of reach, and takes it back", () => {
  const layout = source("../app/_layout.tsx");
  const unreachable = layout.slice(layout.indexOf("function Unreachable()"), layout.indexOf("export default function RootLayout"));
  assert.match(unreachable, /setSheetCover\(reachable \? null : <BackendUnavailable reason="unreachable" \/>\)/);
  assert.match(unreachable, /return \(\) => setSheetCover\(null\)/);
  assert.match(layout, /\{isStoreBuild && <Unreachable \/>\}/, "store builds only, as before");
});
