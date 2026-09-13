import { expect, test } from "@playwright/test";

test("native mobile drawer remains usable above the correction", async ({ browser, baseURL }) => {
  for (const width of [390, 320])
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({
        baseURL,
        viewport: { width, height: 900 },
        colorScheme,
        reducedMotion: width === 320 ? "reduce" : "no-preference"
      });
      const page = await context.newPage();
      try {
        await page.route(/google-analytics|googletagmanager/, (route) => route.abort());
        await page.goto("/node-sdk/quick-start/");
        await expect(
          page.getByText("Governance activation correction", { exact: true })
        ).toBeVisible();
        await page
          .getByRole("region", { name: "Cookie consent" })
          .getByRole("button", { name: "Reject", exact: true })
          .click();
        const toggle = page.locator(".navbar__toggle");
        const close = page.locator(".navbar-sidebar__close");
        await toggle.click();
        await expect(close).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.locator(".navbar-sidebar--show")).toHaveCount(0);
        await expect(toggle).toBeFocused();
        await toggle.press("Enter");
        await page.waitForTimeout(60);
        await close.click();
        await expect(toggle).toBeFocused();
        await toggle.press("Enter");
        await expect(close).toBeVisible();
        expect(await page.locator(".navbar-sidebar").evaluate((el) => el.scrollLeft)).toBe(0);
        await close.click();
        await expect(toggle).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width
        );
      } finally {
        await context.close();
      }
    }
});

test("package-manager tabs retain exact commands", async ({ page }) => {
  await page.route(/google-analytics|googletagmanager/, (route) => route.abort());
  await page.goto("/node-sdk/quick-start/");
  await page
    .getByRole("region", { name: "Cookie consent" })
    .getByRole("button", { name: "Reject", exact: true })
    .click();
  for (const [name, command] of [
    ["npm", "npm install"],
    ["yarn", "yarn add"],
    ["bun", "bun add"],
    ["pnpm", "pnpm add"]
  ]) {
    const tab = page.getByRole("tab", { name, exact: true }).first();
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel").filter({ visible: true }).first()).toHaveText(
      `${command} @agent-assembly/sdk`
    );
  }
});
