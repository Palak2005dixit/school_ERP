import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test("login accessibility", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel(/email/i)).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});
for (const path of [
  "/staff-attendance",
  "/recruitment",
  "/procurement",
  "/transport",
  "/library",
  "/learning",
  "/concerns",
  "/notifications",
  "/fees/controls",
  "/data-tools",
]) {
  test(`authenticated page renders ${path}`, async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("admin@demo.test");
    await page.getByLabel(/^password/i).fill("Admin@12345");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).not.toHaveURL(/login/);
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(
      page.getByText("Something went wrong on our side. Please try again."),
    ).toHaveCount(0);
  });
}
