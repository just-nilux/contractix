import { expect, type Page, test } from "@playwright/test";

/**
 * The one end-to-end path: land, acknowledge, adopt the demo corpus, watch it
 * analyze, read the report, click through to the highlighted clause, delete.
 *
 * Written to pass *keyless*, which is how CI runs it. That constrains what can
 * be asserted, and the constraint is worth stating: with no model key the
 * classifier returns `other` for every document, `other` maps to no extraction
 * family, and a keyless report therefore has no extracted terms and no fired
 * rules. So there is no flag citation to click, and citation click-through is
 * exercised through search instead - whose hits carry `charStart`/`charEnd`
 * from the same frozen offsets and drive the identical viewer path.
 *
 * Assertions are chosen to hold with or without a key, so the same spec is
 * meaningful in both worlds rather than passing vacuously in one.
 */

const ACK_KEY = "ctx.disclaimer.ack";

async function acknowledgeDisclaimer(page: Page) {
  await page.getByRole("button", { name: "I understand" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}

test("a visitor can analyze the demo corpus and click through to a cited clause", async ({
  page,
}) => {
  // --- the disclaimer actually blocks (FR-7.6) ---------------------------------
  await page.goto("/");

  const gate = page.getByRole("dialog");
  await expect(gate).toBeVisible();
  await expect(gate).toContainText("not legal or tax advice");

  await page.keyboard.press("Escape");
  // The real assertion the jsdom polyfill cannot make: a browser's own
  // Escape-to-close is overridden, not merely unstyled.
  await expect(gate).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), ACK_KEY)).toBeNull();

  await acknowledgeDisclaimer(page);
  expect(await page.evaluate((key) => localStorage.getItem(key), ACK_KEY)).not.toBeNull();

  // --- the demo corpus is listed without a session -----------------------------
  await expect(page.getByText("Try it on the demo corpus")).toBeVisible();
  await expect(page.getByText("offer_de_senior_eng.pdf")).toBeVisible();

  await page.getByRole("button", { name: "Try the demo corpus" }).click();

  // --- adoption mints a session and lands on the case --------------------------
  await page.waitForURL(/\/cases\/[0-9a-f-]{36}$/);
  const caseUrl = page.url();
  await expect(page.getByRole("heading", { name: "Demo Corpus" })).toBeVisible();

  // --- every document reaches a terminal phase over the stream -----------------
  // Auto-analyze fires on its own: the demo case arrives ingested-but-unanalyzed,
  // which is exactly the state for which the progress stream never emits `done`.
  await expect(page.getByText("Ready").first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("button", { name: "Re-run the analysis" })).toBeVisible({
    timeout: 90_000,
  });

  // --- the report renders ------------------------------------------------------
  await expect(page.getByRole("heading", { name: "Report", exact: true })).toBeVisible();
  // The API's own disclaimer string, rendered rather than reproduced.
  await expect(
    page.getByText("Informational analysis, not legal or tax advice").first(),
  ).toBeVisible();

  // Holds either way: keyless yields these empty states, a keyed run yields
  // rows. What must never happen is a blank section with neither.
  const reportSection = page.locator("section").filter({ hasText: "vsop_de.pdf" }).first();
  await expect(reportSection).toBeVisible();
  await expect(reportSection.getByText(/What to look at/i)).toBeVisible();
  await expect(reportSection.getByText(/^Terms$/i)).toBeVisible();

  // --- citation click-through, via search --------------------------------------
  await page.getByPlaceholder(/Kündigungsfrist/).fill("Probezeit");
  await page.getByRole("button", { name: "Search", exact: true }).click();

  const hits = page.locator("form ~ ul li button");
  await expect(hits.first()).toBeVisible({ timeout: 30_000 });

  // Try hits in order until one lands on a PDF: the corpus contains a DOCX,
  // which legitimately has no page geometry, and that path is asserted below.
  const hitCount = Math.min(await hits.count(), 3);
  let highlighted = false;

  for (let i = 0; i < hitCount && !highlighted; i += 1) {
    await hits.nth(i).click();

    const drawer = page.getByRole("complementary", { name: "Cited clause" });
    await expect(drawer).toBeVisible();
    // The exact rendering is always present: a slice of frozen clause text at
    // frozen offsets. This is the citation guarantee, geometry or not.
    await expect(drawer.locator("mark")).toBeVisible({ timeout: 30_000 });

    // `waitFor`, not `isVisible`: the latter answers immediately, and the PDF
    // worker plus the file fetch take a moment on a cold browser.
    const highlight = drawer.locator('[data-testid="citation-highlight"]').first();
    const drawn = await highlight
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);

    if (drawn) {
      const box = await highlight.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(0);
      expect(box?.height ?? 0).toBeGreaterThan(0);

      const canvasBox = await drawer.locator("canvas").first().boundingBox();
      expect(canvasBox).not.toBeNull();
      // The rectangle must land on the page, not merely exist.
      expect(box!.x).toBeGreaterThanOrEqual(canvasBox!.x - 1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(canvasBox!.x + canvasBox!.width + 1);
      highlighted = true;
    }

    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(drawer).toBeHidden();
  }

  expect(highlighted, "no search hit produced a highlight on a rendered page").toBe(true);

  // --- hard delete (PRD §9 flow 4) ---------------------------------------------
  await page.goto("/cases");
  await page.getByRole("button", { name: "Delete" }).first().click();

  const confirm = page.getByRole("dialog");
  // The confirmation names what goes, rather than asking "are you sure?".
  await expect(confirm).toContainText("permanently deletes");
  await confirm.getByRole("button", { name: "Delete permanently" }).click();

  await expect(page.getByText("No cases in this session yet.")).toBeVisible();

  // The case is genuinely gone, not merely hidden from the list.
  await page.goto(caseUrl);
  await expect(page.getByRole("heading", { name: "Case not found" })).toBeVisible();
});
