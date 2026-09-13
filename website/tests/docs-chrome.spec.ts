import { expect, test } from "@playwright/test";

test("narrow native brand stays whole and clear of menu/search", async ({ browser, baseURL }) => {
  for (const width of [320, 360, 390]) {
    const context = await browser.newContext({ baseURL, viewport: { width, height: 900 } });
    const page = await context.newPage();
    try {
      await page.route(/google-analytics|googletagmanager/, (route) => route.abort());
      await page.goto("/node-sdk/quick-start/");
      const brand = page.locator(".navbar__inner a.navbar__brand");
      await expect(brand).toHaveAttribute("href", "/node-sdk/");
      await expect(brand).toHaveAttribute("aria-label", "@agent-assembly/sdk");
      await expect(brand.locator("img:visible")).toBeVisible();
      const title = brand.locator(".navbar__title");
      await expect(title).toHaveText("@agent-assembly/sdk");
      const layout = await page.evaluate(() => {
        const brand = document.querySelector(".navbar__inner a.navbar__brand")?.getBoundingClientRect();
        const toggle = document.querySelector(".navbar__toggle")?.getBoundingClientRect();
        const search = document.querySelector(".navbar__search-input")?.getBoundingClientRect();
        const title = document.querySelector(".navbar__inner a.navbar__brand .navbar__title");
        if (!brand || !toggle || !search || !title) throw new Error("Native navbar region missing");
        return {
          brandLeft: brand.left,
          brandRight: brand.right,
          toggleRight: toggle.right,
          searchLeft: search.left,
          shortLabel: getComputedStyle(title, "::after").content,
          titleFontSize: getComputedStyle(title).fontSize,
        };
      });
      expect(layout.brandLeft).toBeGreaterThanOrEqual(layout.toggleRight);
      expect(layout.brandRight).toBeLessThanOrEqual(layout.searchLeft);
      if (width <= 360) {
        expect(layout.shortLabel).toContain("Node SDK");
        expect(layout.titleFontSize).toBe("0px");
      } else {
        expect(layout.shortLabel).not.toContain("Node SDK");
        expect(layout.titleFontSize).not.toBe("0px");
      }
    } finally {
      await context.close();
    }
  }
});

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
