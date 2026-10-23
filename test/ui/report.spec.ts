import { expect, test } from "@playwright/test";
import { renderHtml } from "../../src/report/index.js";
import { first, reportFixture } from "../unit/report-fixture.js";

test("desktop report separates delivery results, assertions and boundaries", async ({ page }) => {
  await page.setContent(renderHtml(reportFixture()));
  await expect(page).toHaveTitle("Concurrent payment duplicates — Webhook Failure Lab");
  await expect(page.getByRole("heading", { name: "Business outcomes", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Delivery timeline", exact: true })).toBeVisible();
  await expect(page.getByText("2 HTTP successes", { exact: true })).toBeVisible();
  await expect(page.getByText("paid · 1 fulfilment(s)", { exact: true })).toHaveCount(2);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to report" })).toBeFocused();
  await page.getByRole("link", { name: "Run details", exact: true }).click();
  await page.getByText("Synthetic event identities (1)", { exact: true }).click();
  await expect(
    page.getByText("payment.succeeded · order order-1 · 1200 NGN (minor units)"),
  ).toBeVisible();
});

test("390px report has no horizontal overflow and retains all delivery evidence", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const report = reportFixture();
  report.name =
    "Concurrent duplicate notifications with a deliberately long descriptive scenario name";
  first(report.attempts).eventId =
    "an-event-identifier-with-a-long-unbroken-value-012345678901234567890123456789";
  await page.setContent(renderHtml(report));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(page.getByText("2 HTTP successes", { exact: true })).toBeVisible();
  await expect(page.getByText("Planned offset", { exact: true })).toHaveCount(3);
  await page.getByRole("link", { name: "Delivery timeline", exact: true }).click();
  await expect(page.getByText("Delivery 1 · attempt 1", { exact: true })).toBeVisible();
  await expect(page.getByText("200 · http-success", { exact: true })).toHaveCount(2);
});

test("untrusted evidence is text, not executable HTML", async ({ page }) => {
  const report = reportFixture();
  const injection =
    '<img src=x onerror="globalThis.reportXss=true"><script>globalThis.reportXss=true</script>';
  report.name = injection;
  first(report.assertions).message = injection;
  report.limitations.push(injection);
  await page.setContent(renderHtml(report));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(injection);
  await expect(page.locator("img")).toHaveCount(0);
  await expect(page.locator("script")).toHaveCount(0);
  expect(await page.evaluate(() => Object.hasOwn(globalThis, "reportXss"))).toBe(false);
});

test("empty and incomplete reports explain why they cannot pass", async ({ page }) => {
  const report = reportFixture();
  report.assertions = [];
  report.attempts = [];
  report.finishedAt = "";
  await page.setContent(renderHtml(report));
  await expect(page.getByText("Execution error", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText(
    "No assertions executed. This report cannot establish business correctness.",
  );
  await expect(page.getByText("No delivery attempts recorded.", { exact: false })).toBeVisible();
  await expect(page.getByText("Incomplete", { exact: true })).toHaveCount(2);
});
