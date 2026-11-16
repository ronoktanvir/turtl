// The web demo is uploaded to its host from an exported folder, and the upload leaves out every folder named
// node_modules. A font loaded straight from its package is exported under assets/node_modules/, so it never
// arrived, and every screen fell back to the browser's serif. The two fonts are therefore loaded from copies in
// assets/fonts/, and these tests keep the copies in step with the packages they come from.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url));
const layout = read("app/_layout.tsx").toString("utf8");
const fonts = [
  { family: "Capriola_400Regular", from: "node_modules/@expo-google-fonts/capriola" },
  { family: "Righteous_400Regular", from: "node_modules/@expo-google-fonts/righteous" },
];

test("the app loads each font from assets/fonts, under the family name T asks for", () => {
  for (const { family } of fonts) {
    assert.ok(layout.includes(`${family}: require("../assets/fonts/${family}.ttf")`), family + " is not loaded from assets/fonts");
  }
});

test("no font file is loaded from a package, where the web export would put it under node_modules", () => {
  assert.doesNotMatch(layout, /from "@expo-google-fonts\//);
  assert.doesNotMatch(layout, /require\("[^"]*node_modules/);
});

test("each copy is the package's own file, and its licence travels with it", () => {
  for (const { family, from } of fonts) {
    assert.ok(read(`assets/fonts/${family}.ttf`).equals(read(`${from}/400Regular/${family}.ttf`)), family + " differs from its package");
    assert.ok(read(`assets/fonts/${family}.LICENSE.txt`).equals(read(`${from}/LICENSE_FONT`)), family + " has no licence beside it");
  }
});
