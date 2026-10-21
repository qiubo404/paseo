import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { waitForTabBar } from "../support/helpers/launcher";
import { getServerId } from "../support/helpers/server-id";
import { openSettingsHostSection } from "../support/helpers/settings";
import {
  expectFooterItemSetting,
  expectFooterSeparator,
  leaveSettings,
  openSidebarNavSettings,
  setFooterItemVisible,
} from "../support/helpers/sidebar-nav-settings";
import { installUsageReportsFixture } from "../support/helpers/usage-reports";
import {
  claudeAndCodexReports,
  closeUsage,
  closeUsageFromBackdrop,
  closeUsageOptions,
  expectNoUsageItem,
  expectPinnedUsage,
  expectPinnedUsageFits,
  expectSummaryInSidebar,
  expectUnpinnableRows,
  openCompactSidebar,
  openUsageFromIcon,
  openUsageFromItem,
  pinRow,
  scrollUsageToWindow,
  setSummaryInSidebar,
  openUsageOptions,
  showUsageAs,
  togglePin,
  usageItem,
  usageModal,
  installTallUsageSource,
} from "../support/helpers/usage-sidebar-item";
import { seedSidebarFooterPreferences } from "../support/helpers/sidebar-nav-settings";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const USAGE_NOW = new Date("2026-10-21T08:00:00.000Z");

test.beforeEach(async ({ page }) => {
  await page.clock.setSystemTime(USAGE_NOW);
});

const WIDE = { width: 1440, height: 900 };
const COMPACT = { width: 390, height: 844 };

type ScreenshotArea = { kind: "page" } | { kind: "footer" } | { kind: "element"; locator: Locator };

/** Set PASEO_QA_SCREENSHOT_DIR to keep QA screenshots of each state. */
async function qaScreenshot(page: Page, name: string, area: ScreenshotArea = { kind: "page" }) {
  const directory = process.env.PASEO_QA_SCREENSHOT_DIR;
  if (!directory) return;
  // Let sheet and drawer animations settle so the image shows the final state.
  await page.waitForTimeout(600);
  // Expo's fast-refresh indicator sits over the footer's Hosts icon.
  await page.addStyleTag({ content: ".__expo_fast_refresh { display: none !important; }" });
  const file = path.join(directory, `${name}.png`);
  if (area.kind === "element") {
    await area.locator.screenshot({ path: file });
    return;
  }
  const clip = area.kind === "footer" ? await footerClip(page) : undefined;
  await page.screenshot({ path: file, clip });
}

/** Includes summary rows above the fixed icon row. */
async function footerClip(page: Page) {
  return (await page.locator('[data-testid="sidebar-footer"]:visible').boundingBox())!;
}

test.describe("Usage item", () => {
  test("reset countdowns stay visible, tick locally, resume and preserve refresh", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "usage-countdown",
      title: "Reset countdown",
    });
    try {
      await page.clock.install({ time: USAGE_NOW });
      await page.clock.setFixedTime(USAGE_NOW);
      const entry = claudeAndCodexReports(USAGE_NOW.getTime())[0]!;
      if (entry.report.status !== "available") throw new Error("Expected available fixture");
      entry.report.windows[0]!.usedPct = 67;
      entry.report.windows[0]!.resetsAt = new Date(
        USAGE_NOW.getTime() + 135 * 60_000,
      ).toISOString();
      entry.report.windows[1]!.usedPct = 21;
      entry.report.windows[1]!.resetsAt = new Date(
        USAGE_NOW.getTime() + 80 * 60 * 60_000,
      ).toISOString();
      const usage = await installUsageReportsFixture(page, { lists: [[entry]] });
      await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
      await page.setViewportSize(WIDE);
      await openAgentRoute(page, agent);
      await expectPinnedUsage(page, ["67% 2h 15m", "21% 3d 8h"]);
      await expect(usageItem(page)).toHaveAttribute(
        "aria-label",
        /Claude.*Session 67% used · resets in 2h 15m.*Weekly 21% used · resets in 3d 8h/,
      );
      await qaScreenshot(page, "reset-countdown-desktop", { kind: "footer" });
      await expect(usageItem(page).getByTestId("sidebar-usage-meter")).toHaveCount(2);

      const requests = usage.listRequests().length;
      await page.clock.setFixedTime(new Date(USAGE_NOW.getTime() + 60_000));
      await page.clock.fastForward(60_000);
      await expectPinnedUsage(page, ["67% 2h 14m", "21% 3d 7h"]);
      expect(usage.listRequests()).toHaveLength(requests);

      // A visibility transition uses the same signal on browser web and native AppState.
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.clock.setFixedTime(new Date(USAGE_NOW.getTime() + 120_000));
      await page.clock.fastForward(60_000);
      await expectPinnedUsage(page, ["67% 2h 14m", "21% 3d 7h"]);
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expectPinnedUsage(page, ["67% 2h 13m", "21% 3d 7h"]);
      expect(usage.listRequests()).toHaveLength(requests);

      await page.locator('[data-testid="sidebar-usage-refresh"]:visible').click();
      await expect.poll(() => usage.listRequests().at(-1)?.forceRefresh).toBe(true);
      await expectPinnedUsage(page, ["67% 2h 13m", "21% 3d 7h"]);

      const handle = page
        .getByTestId("left-sidebar-resize-handle")
        .filter({ visible: true })
        .first();
      const handleBounds = await handle.boundingBox();
      if (!handleBounds) throw new Error("Expected sidebar resize handle");
      await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + 150);
      await page.mouse.down();
      await page.mouse.move(200, handleBounds.y + 150, { steps: 12 });
      await page.mouse.up();
      await expect(usageItem(page).getByTestId("sidebar-usage-meter")).toHaveCount(0);
      await expectPinnedUsage(page, ["67% 2h 13m", "21% 3d 7h"]);
      await qaScreenshot(page, "reset-countdown-narrow", { kind: "footer" });

      await page.setViewportSize(COMPACT);
      await openCompactSidebar(page);
      await expectPinnedUsage(page, ["67% 2h 13m", "21% 3d 7h"]);
      await expectPinnedUsageFits(page);
      await qaScreenshot(page, "reset-countdown-compact", { kind: "footer" });
      await openUsageFromItem(page);
      await expect(usageModal(page).getByText("Claude", { exact: true })).toBeVisible();
    } finally {
      await agent.cleanup();
    }
  });

  test("both compact footer entry points open Usage as a sheet", async ({ page }) => {
    await page.setViewportSize(COMPACT);
    await installUsageReportsFixture(page, {
      lists: [() => claudeAndCodexReports(USAGE_NOW.getTime())],
    });
    await seedSidebarFooterPreferences(page, [{ key: "usage", visible: false }]);
    await gotoAppShell(page);
    await openCompactSidebar(page);
    const startingUrl = page.url();
    await expectNoUsageItem(page);

    await test.step("the icon opens a sheet without leaving the current screen", async () => {
      await openUsageFromIcon(page);
      await expect(usageModal(page).getByText("Claude", { exact: true })).toBeVisible();
      await expect(page).toHaveURL(startingUrl);
      await qaScreenshot(page, "compact-usage-icon-sheet");
      await setSummaryInSidebar(page, true);
      await expectPinnedUsage(page, ["31% 1d 0h", "54% 1d 0h", "7% 1d 0h", "12% 1d 0h"]);
      await closeUsageFromBackdrop(page);
    });

    await test.step("the summary opens the same sheet", async () => {
      await openUsageFromItem(page);
      await expect(usageModal(page).getByText("Codex", { exact: true })).toBeVisible();
      await expect(page).toHaveURL(startingUrl);
      await qaScreenshot(page, "compact-usage-summary-sheet");
      await closeUsageFromBackdrop(page);
    });
  });

  test("on desktop Usage opens as a dialog over the workspace and closes back to it", async ({
    page,
  }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "usage-modal-",
      title: "Usage dialog",
    });
    try {
      await page.setViewportSize(WIDE);
      await installUsageReportsFixture(page, {
        lists: [() => claudeAndCodexReports(USAGE_NOW.getTime())],
      });
      await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
      await openAgentRoute(page, agent);
      const workspaceUrl = page.url();

      await test.step("the summary opens a dialog over the workspace", async () => {
        await openUsageFromItem(page);
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByText("Claude", { exact: true })).toBeVisible();
        await expect(
          dialog.getByRole("button", { name: "Refresh all", exact: true }),
        ).toBeVisible();
        await expect(page).toHaveURL(workspaceUrl);
        await qaScreenshot(page, "desktop-usage-dialog");
      });

      await test.step("Close returns to the same workspace", async () => {
        await closeUsage(page);
        await expect(page).toHaveURL(workspaceUrl);
        await waitForTabBar(page);
      });

      await test.step("the icon opens it again, and Escape closes it", async () => {
        await openUsageFromIcon(page);
        await page.keyboard.press("Escape");
        await expect(usageModal(page)).toHaveCount(0);
        await expect(page).toHaveURL(workspaceUrl);
      });
    } finally {
      await agent.cleanup();
    }
  });

  const layouts = {
    desktop: { viewport: WIDE, showSidebar: async (_page: Page) => {} },
    compact: { viewport: COMPACT, showSidebar: openCompactSidebar },
  };
  for (const [size, { viewport, showSidebar }] of Object.entries(layouts)) {
    test(`long usage reports scroll between their first and last windows on ${size}`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const source = await installTallUsageSource();
      try {
        await page.setViewportSize(viewport);
        await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
        await gotoAppShell(page);
        await showSidebar(page);
        await expect(usageItem(page)).toBeInViewport();
        await openUsageFromItem(page);
        const content = usageModal(page);
        await expect(content.getByText("Window 20", { exact: true })).toHaveCount(1);
        await waitForSettledPosition(content);
        await expect(content.getByText("Window 20", { exact: true })).not.toBeInViewport();
        await qaScreenshot(page, `${size}-usage-scroll-top`);
        await scrollUsageToWindow(page, "Window 20");
        await expect(content.getByText("Window 20", { exact: true })).toBeInViewport();
        await qaScreenshot(page, `${size}-usage-scroll-bottom`);
        await scrollUsageToWindow(page, "Window 1");
        await expect(content.getByText("Window 20", { exact: true })).not.toBeInViewport();
      } finally {
        await source.cleanup();
      }
    });
  }
  test("pinned windows show in the sidebar, follow the used/remaining toggle and persist", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const serverId = getServerId();
    await installUsageReportsFixture(page, {
      lists: [() => claudeAndCodexReports(USAGE_NOW.getTime())],
    });
    await page.setViewportSize(WIDE);
    await gotoAppShell(page);
    const screen = page.getByTestId(`usage-host-${serverId}`);

    await test.step("a fresh device shows default windows once the Usage item is on", async () => {
      // The Usage item starts off on every layout; turning it on stores the choice.
      await expectNoUsageItem(page);
      await openSidebarNavSettings(page);
      await expectFooterItemSetting(page, "usage", false);
      await setFooterItemVisible(page, "usage", true);
      await qaScreenshot(page, "desktop-settings-sidebar-footer");
      await page.setViewportSize(COMPACT);
      await expectFooterItemSetting(page, "usage", true);
      await qaScreenshot(page, "compact-settings-sidebar-footer");
      await gotoAppShell(page);
      await openCompactSidebar(page);
      await expectPinnedUsage(page, ["31% 1d 0h", "54% 1d 0h", "7% 1d 0h", "12% 1d 0h"]);
      await qaScreenshot(page, "compact-footer-defaults");
      await page.setViewportSize(WIDE);
      await gotoAppShell(page);
      await expectPinnedUsage(page, ["31% 1d 0h", "54% 1d 0h", "7% 1d 0h", "12% 1d 0h"]);
      await qaScreenshot(page, "desktop-footer-defaults", { kind: "footer" });
      await openUsageFromItem(page);
      await qaScreenshot(page, "default-pins-card");
      await expect(pinRow(screen, "Claude", "Session")).toBeChecked();
      await expect(pinRow(screen, "Claude", "Weekly")).toBeChecked();
      await expect(pinRow(screen, "Codex", "Session")).toBeChecked();
      await expect(pinRow(screen, "Codex", "Weekly")).toBeChecked();
    });

    await test.step("pinning Claude 5-hour and Codex weekly shows both in the Usage item", async () => {
      await expect(screen.getByText("Claude", { exact: true })).toBeVisible({ timeout: 10_000 });
      // One host: no host filter, as on History.
      await expect(page.locator('[data-testid="usage-host-filter-trigger"]:visible')).toHaveCount(
        0,
      );
      await togglePin(screen, "Claude", "Weekly");
      await expectPinnedUsage(page, ["31% 1d 0h", "7% 1d 0h", "12% 1d 0h"]);
      await expect(pinRow(screen, "Claude", "Session")).toBeChecked();
      await expect(pinRow(screen, "Codex", "Session")).toBeChecked();
      await expect(pinRow(screen, "Codex", "Weekly")).toBeChecked();
      await qaScreenshot(page, "default-pins-after-one-toggle");
      await togglePin(screen, "Codex", "Session");
      await expectPinnedUsage(page, ["31% 1d 0h", "12% 1d 0h"]);
      await expect(usageItem(page)).not.toHaveText("Usage");
      await qaScreenshot(page, "desktop-footer-pins", { kind: "footer" });
      await expect(page.getByRole("button", { name: "Refresh all", exact: true })).toBeVisible();
      await qaScreenshot(page, "usage-card-refresh", {
        kind: "element",
        locator: screen.getByTestId("usage-report-claude:default"),
      });
    });

    await test.step("remaining flips the Usage item and the Usage modal", async () => {
      await showUsageAs(page, "remaining");
      await expectPinnedUsage(page, ["69% 1d 0h", "88% 1d 0h"]);
      await expect(usageItem(page)).toHaveAccessibleName(
        /Claude .*69% left · resets in 1d 0h, Codex .*88% left · resets in 1d 0h/,
      );
      await expect(
        screen.getByTestId("usage-report-claude:default").getByText("69% left"),
      ).toBeVisible();
      await expect(
        screen.getByTestId("usage-report-codex:default").getByText("88% left"),
      ).toBeVisible();
    });

    await test.step("on a phone the Usage item opens a bottom sheet", async () => {
      await closeUsage(page);
      await page.setViewportSize(COMPACT);
      await openCompactSidebar(page);
      await expect(usageItem(page)).toBeInViewport();
      await expectPinnedUsage(page, ["69% 1d 0h", "88% 1d 0h"]);
      await qaScreenshot(page, "compact-footer");
      await openUsageFromItem(page);
      const sheet = usageModal(page);
      await expect(sheet.getByText("Codex", { exact: true })).toBeInViewport();
      await expect(sheet.getByText("88% left")).toBeVisible();
      await expect(pinRow(sheet, "Claude", "Session")).toBeChecked();
      await expect(pinRow(sheet, "Claude", "Weekly")).not.toBeChecked();
      // The row reads its window, percent and reset; the checkbox state says it is pinned.
      await expect(pinRow(sheet, "Claude", "Session")).toHaveAccessibleName(
        /^Pin Claude Session, \d+% left( · .+)?$/,
      );
      // Settings opens a second sheet; closing it restores the Usage sheet underneath.
      await expect(page.locator('[data-testid="usage-options-menu"]:visible')).toBeVisible();
      await expect(page.locator('[data-testid="usage-refresh-all"]:visible')).toBeVisible();
      await openUsageOptions(page);
      await expect(page.getByTestId("usage-display-remaining")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await qaScreenshot(page, "compact-settings-expanded");
      await closeUsageOptions(page);
      await expect(sheet.getByTestId("usage-display-used")).toHaveCount(0);
      await expect(sheet).toBeVisible();
      await waitForSettledPosition(sheet);
      const sheetBox = (await sheet.boundingBox())!;
      // The sheet leaves the screen above it as its backdrop.
      expect(sheetBox.y).toBeGreaterThanOrEqual(COMPACT.height * 0.1);
      expect(sheetBox.width).toBeGreaterThan(COMPACT.width * 0.8);
      await qaScreenshot(page, "compact-sheet");
      await closeUsageFromBackdrop(page);
      await page.setViewportSize(WIDE);
    });

    await test.step("a reload keeps the pins and the toggle", async () => {
      await page.reload();
      await expectPinnedUsage(page, ["69% 1d 0h", "88% 1d 0h"]);
      await openUsageFromItem(page);
      await openUsageOptions(page);
      await expect(page.getByTestId("usage-display-remaining")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await qaScreenshot(page, "usage-settings-expanded");
      await closeUsageOptions(page);
    });

    await test.step("the Settings usage section shares the pins and the toggle", async () => {
      const workspaceUrl = page.url();
      await closeUsage(page);
      await openSettings(page);
      await openSettingsHostSection(page, serverId, "usage");
      const section = page.getByTestId("usage-card");
      await expect(section.getByText("69% left")).toBeVisible({ timeout: 10_000 });
      await expect(pinRow(section, "Codex", "Weekly")).toBeChecked();
      await page.goto(workspaceUrl);
      await openUsageFromItem(page);
      await expect(screen.getByText("Claude", { exact: true })).toBeVisible({ timeout: 10_000 });
    });

    await test.step("unpinning everything stays empty after a reload", async () => {
      await togglePin(screen, "Claude", "Session");
      await togglePin(screen, "Codex", "Weekly");
      await expectNoUsageItem(page);
      await page.reload();
      await openUsageFromIcon(page);
      await expect(screen.getByText("88% left")).toBeVisible({ timeout: 10_000 });
      await expectNoUsageItem(page);
      await expect(pinRow(screen, "Claude", "Session")).not.toBeChecked();
      await expect(pinRow(screen, "Claude", "Weekly")).not.toBeChecked();
      await expect(pinRow(screen, "Codex", "Session")).not.toBeChecked();
      await expect(pinRow(screen, "Codex", "Weekly")).not.toBeChecked();
      await qaScreenshot(page, "explicit-empty-pins-after-reload");
      await closeUsage(page);
    });

    await test.step("Settings > Sidebar lists the Usage item", async () => {
      await openSidebarNavSettings(page);
      const footer = page.getByTestId("sidebar-nav-section-footer");
      await expect(
        footer.getByTestId("sidebar-nav-item-usage").getByText("Usage", { exact: true }),
      ).toBeVisible();
      await qaScreenshot(page, "settings-sidebar-footer", { kind: "element", locator: footer });
      await leaveSettings(page);
    });
  });
});

test("without summary data the footer drops the Usage item and keeps the Usage icon", async ({
  page,
}) => {
  await installUsageReportsFixture(page, {
    lists: [
      [
        {
          id: "alpha:a",
          account: {},
          fetchedAt: new Date().toISOString(),
          sourceId: "alpha",
          sourceLabel: "Alpha plan",
          report: {
            status: "unavailable",
            problem: { kind: "no_quota", detail: "No active coding plan" },
          },
        },
      ],
    ],
  });
  await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
  await page.setViewportSize(WIDE);
  await gotoAppShell(page);
  await expect(page.locator('[data-testid="sidebar-usage-icon"]:visible')).toBeVisible({
    timeout: 30_000,
  });
  await expectNoUsageItem(page);
  await expectFooterSeparator(page, false);
  await qaScreenshot(page, "desktop-footer-no-summary", { kind: "footer" });
  await openUsageFromIcon(page);
});

test("the Usage Settings switch turns on the sidebar summary and the pins with it", async ({
  page,
}) => {
  const serverId = getServerId();
  await installUsageReportsFixture(page, {
    lists: [() => claudeAndCodexReports(USAGE_NOW.getTime())],
  });
  await page.setViewportSize(WIDE);
  await gotoAppShell(page);
  const screen = page.getByTestId(`usage-host-${serverId}`);
  const claude = screen.getByTestId("usage-report-claude:default");

  await test.step("off by default: no Usage item, and rows that do not pin", async () => {
    await openUsageFromIcon(page);
    await expectNoUsageItem(page);
    await expect(claude.getByText("Session", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expectUnpinnableRows(claude);
    await expectUnpinnableRows(screen.getByTestId("usage-report-codex:default"));
    await expectSummaryInSidebar(page, false);
    await qaScreenshot(page, "usage-summary-off");
  });

  await test.step("on: the Usage item and the pins appear", async () => {
    await setSummaryInSidebar(page, true);
    await expectPinnedUsage(page, ["31% 1d 0h", "54% 1d 0h", "7% 1d 0h", "12% 1d 0h"]);
    await expect(pinRow(screen, "Claude", "Weekly")).toBeChecked();
    await togglePin(screen, "Claude", "Weekly");
    await expectPinnedUsage(page, ["31% 1d 0h", "7% 1d 0h", "12% 1d 0h"]);
    await qaScreenshot(page, "usage-summary-on");
  });

  await test.step("off then on again, after a reload, brings back the saved pins", async () => {
    await setSummaryInSidebar(page, false);
    await expectNoUsageItem(page);
    await expectUnpinnableRows(claude);
    await page.reload();
    await openUsageFromIcon(page);
    await expectSummaryInSidebar(page, false);
    await expect(claude.getByText("Session", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expectUnpinnableRows(claude);
    await setSummaryInSidebar(page, true);
    await expectPinnedUsage(page, ["31% 1d 0h", "7% 1d 0h", "12% 1d 0h"]);
    await expect(pinRow(screen, "Claude", "Session")).toBeChecked();
    await expect(pinRow(screen, "Claude", "Weekly")).not.toBeChecked();
  });
});

test("released hosts supply source logos through the client conversion", async ({ page }) => {
  await installUsageReportsFixture(page, {
    lists: [() => claudeAndCodexReports(USAGE_NOW.getTime())],
    providerUsageListOnly: true,
  });
  await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
  await page.setViewportSize(WIDE);
  await gotoAppShell(page);
  await expectPinnedUsage(page, ["31% 1d 0h", "54% 1d 0h", "7% 1d 0h", "12% 1d 0h"]);
  // Source logos are decorative SVGs with no accessible role. Their path data distinguishes
  // the source artwork from the fallback gauge.
  const claudePath = /<path[^>]* d="([^"]+)"/.exec(
    claudeAndCodexReports(USAGE_NOW.getTime())[0]!.icon!,
  )![1]!;
  const codexPath = /<path[^>]* d="([^"]+)"/.exec(
    claudeAndCodexReports(USAGE_NOW.getTime())[1]!.icon!,
  )![1]!;
  const summary = usageItem(page).getByTestId("sidebar-usage-source");
  await expect(summary.nth(0).locator("svg path").first()).toHaveAttribute("d", claudePath);
  await expect(summary.nth(1).locator("svg path").first()).toHaveAttribute("d", codexPath);
  await qaScreenshot(page, "released-host-footer", { kind: "footer" });
  await openUsageFromItem(page);
  const screen = page.getByTestId(`usage-host-${getServerId()}`);
  await expect(
    screen.getByTestId("usage-report-claude").locator("svg path").first(),
  ).toHaveAttribute("d", claudePath);
  await expect(
    screen.getByTestId("usage-report-codex").locator("svg path").first(),
  ).toHaveAttribute("d", codexPath);
  await qaScreenshot(page, "released-host-usage-modal");
});
