import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("citations wrap as text, not atomic boxes, at 390px", async () => {
  const executablePath = process.env.CHROME_PATH ?? ["/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
  assert.ok(executablePath, "Set CHROME_PATH to a Chromium executable");
  const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto((process.env.UI_BASE_URL ?? "http://localhost:8081") + "/review/listener-ladder-1");
    await page.getByTestId("overview-2-paragraph").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    for (const id of ["overview-2-paragraph", "overview-3-paragraph", "fix-listener_database_ranking-paragraph"]) {
      const paragraph = page.getByTestId(id).first();
      await paragraph.scrollIntoViewIfNeeded();
      const result = await paragraph.evaluate((element) => {
        const links = [...element.querySelectorAll("[data-testid*='-cite-']")];
        const clone = element.cloneNode(true);
        clone.removeAttribute("data-testid");
        Object.assign(clone.style, { position: "fixed", left: "-2000px", top: "0", width: element.getBoundingClientRect().width + "px", display: "block", visibility: "hidden" });
        clone.textContent = element.textContent;
        element.parentElement.appendChild(clone);
        const result = { actualHeight: element.getBoundingClientRect().height, plainHeight: clone.getBoundingClientRect().height, links: links.map((link) => ({ tag: link.tagName, display: getComputedStyle(link).display, text: link.textContent })) };
        clone.remove();
        return result;
      });
      assert.ok(result.links.length > 0, id + " should contain citations");
      for (const link of result.links) {
        assert.equal(link.tag, "A", id + ": " + link.text);
        assert.equal(link.display, "inline");
      }
      assert.ok(Math.abs(result.actualHeight - result.plainHeight) <= 1, `${id}: linked paragraph ${result.actualHeight}px, natural text ${result.plainHeight}px`);
    }
    const link = page.getByTestId("overview-2-cite-cite-rank-wait").first();
    await link.scrollIntoViewIfNeeded();
    await link.focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("overview-2-cite-box-cite-rank-wait").first().waitFor();
    assert.equal(new URL(page.url()).hash, "");
  } finally {
    await browser.close();
  }
});
