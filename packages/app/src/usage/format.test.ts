import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  formatResetCountdown,
  formatDisplayPct,
  formatAgo,
  formatAmount,
  formatPct,
  formatProviderUsageLabel,
  formatResetLabel,
  formatRunsOutLabel,
} from "./format";

describe("formatResetCountdown", () => {
  const now = Date.parse("2026-10-21T08:00:00.000Z");

  it.each([
    [3 * 24 * 60 + 8 * 60 + 15, "3d 8h 15m"],
    [24 * 60, "1d 0h 0m"],
    [2 * 60 + 15, "2h 15m"],
    [60, "1h 0m"],
    [15, "15m"],
    [1, "1m"],
    [0.5, "<1m"],
    [0, "Pending reset"],
    [-1, "Pending reset"],
  ])("formats a reset %s minutes away as %s", (minutes, expected) => {
    expect(formatResetCountdown(new Date(now + minutes * 60_000).toISOString(), now)).toBe(
      expected,
    );
  });

  it.each([null, undefined, "", "invalid"])("ignores missing or invalid reset time %s", (iso) => {
    expect(formatResetCountdown(iso, now)).toBeNull();
  });
});
const NOW = Date.parse("2026-07-19T00:00:00.000Z");

describe("adaptive-precision reset labels", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it.each([
    [135, "resets 2h 15m"],
    [2 * 1440 + 3 * 60 + 7, "resets 2d 3h"],
    [60, "resets 1h 0m"],
    [15, "resets 15m"],
    [0.5, "resets <1m"],
    [0, "resetting now"],
  ])("shows a reset %s minutes away as %s", (minutes, expected) => {
    const resetsAt = new Date(NOW + minutes * 60_000).toISOString();
    expect(formatResetLabel(resetsAt, false, NOW)).toBe(expected);
  });

  it.each([
    [6 * 1440 + 16 * 60 + 20, "6天16小时", "6d 16h 20m"],
    [1440, "1天0小时", "1d 0h 0m"],
    [16 * 60 + 53, "16小时53分钟", "16h 53m"],
    [60, "1小时0分钟", "1h 0m"],
    [53, "53分钟", "53m"],
    [0.5, "<1分钟", "<1m"],
  ])(
    "shows %s remaining minutes as %s on cards while preserving sidebar abbreviations",
    async (minutes, expected, sidebar) => {
      await i18n.changeLanguage("zh-CN");
      const resetsAt = new Date(NOW + minutes * 60_000).toISOString();
      expect(formatResetCountdown(resetsAt, NOW)).toBe(sidebar);
      expect(formatResetLabel(resetsAt, false, NOW)).toBe(`将在 ${expected}后重置`);
    },
  );
});

describe("formatAmount", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(async () => {
    await i18n.changeLanguage("en");
  });
  it("groups thousands in the app's language", () => {
    expect(formatAmount(12345, "credits", "en")).toBe("12,345");
    expect(formatAmount(12345, "requests", "en")).toBe("12,345");
    expect(formatAmount(12345, "credits", "fr").replace(/\s/g, " ")).toBe("12 345");
  });

  it("formats dollars as the language writes currency", () => {
    expect(formatAmount(1234.5, "usd", "en")).toBe("$1,234.50");
    expect(formatAmount(1234.5, "usd", "fr").replace(/\s/g, " ")).toBe("1 234,50 $US");
  });

  it("localizes usage timing without patching the global clock", async () => {
    const twoHoursFromNow = new Date(NOW + 2 * 60 * 60 * 1000).toISOString();
    const threeDaysAgo = new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString();

    expect(formatPct(7, "en")).toBe("7%");
    expect(formatResetLabel(twoHoursFromNow, false, NOW)).toBe("resets 2h 0m");
    expect(formatRunsOutLabel(twoHoursFromNow, NOW)).toBe("runs out 2h");

    await i18n.changeLanguage("ja");
    expect(formatResetLabel(twoHoursFromNow, false, NOW)).toBe("2時間0分後にリセット");
    expect(formatRunsOutLabel(twoHoursFromNow, NOW)).toBe("2時間後に上限に到達");
    expect(formatAgo(threeDaysAgo, NOW)).toBe("3日前");
  });

  it("formats percentages with locale-specific spacing", () => {
    expect(formatPct(42, "fr")).toBe("42\u00a0%");
  });

  it("formats relative-time counts with the active locale", async () => {
    await i18n.changeLanguage("fr");
    const days = 1_234;
    const daysFromNow = new Date(NOW + days * 24 * 60 * 60 * 1000).toISOString();
    const daysAgo = new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

    expect(formatResetLabel(daysFromNow, false, NOW)).toBe("se réinitialise dans 1\u202f234 j 0 h");
    expect(formatRunsOutLabel(daysFromNow, NOW)).toBe("s’épuise dans 1\u202f234 j");
    expect(formatAgo(daysAgo, NOW)).toBe("il y a 1\u202f234 j");
  });

  it("selects Arabic plural forms for relative durations", async () => {
    await i18n.changeLanguage("ar");
    const twoHoursFromNow = new Date(NOW + 2 * 60 * 60 * 1000).toISOString();
    const threeHoursFromNow = new Date(NOW + 3 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();

    expect(formatResetLabel(twoHoursFromNow, false, NOW)).toBe(
      "تتم إعادة التعيين خلال ساعتين 0 دقيقة",
    );
    expect(formatRunsOutLabel(threeHoursFromNow, NOW)).toBe("ينفد خلال 3 ساعات");
    expect(formatAgo(twoDaysAgo, NOW)).toBe("قبل يومين");
  });

  it("uses locale-aware compact notation for token balances", () => {
    expect(formatAmount(1_234, "tokens", "en")).toBe("1.2K");
    expect(formatAmount(1_234, "tokens", "ar")).toBe("1.2\u00a0ألف");
  });

  it("localizes known provider-usage labels and preserves provider-specific labels", async () => {
    await i18n.changeLanguage("ko");

    expect(formatProviderUsageLabel("session", "Session")).toBe("세션");
    expect(formatProviderUsageLabel("five_hour", "Session")).toBe("세션");
    expect(formatProviderUsageLabel("five_hour", "5-hour limit")).toBe("5-hour limit");
    expect(formatProviderUsageLabel("monthly", "Monthly")).toBe("월간");
    expect(formatProviderUsageLabel("code_review:weekly", "Code review · Weekly")).toBe(
      "코드 검토 · 주간",
    );
    expect(formatProviderUsageLabel("code_review:five_hour", "Code review · 5-hour")).toBe(
      "코드 검토 · 5-hour",
    );
    expect(formatProviderUsageLabel("credits", "Credits")).toBe("크레딧");
    expect(formatProviderUsageLabel("custom_limit", "Custom limit")).toBe("Custom limit");
  });
});

it("retained reset times that have passed do not claim the quota is resetting", () => {
  const past = "2000-01-01T00:00:00.000Z";
  expect(formatResetLabel(past, true)).toBe("Reset time passed");
  expect(formatResetLabel(past)).toBe("resetting now");
  expect(formatResetLabel(null, true)).toBeNull();
});

it("says that a usage window percentage is consumed", () => {
  expect(formatDisplayPct(70, "used")).toBe("70% used");
  expect(formatDisplayPct(30, "remaining")).toBe("30% left");
});
it("translates the usage refresh control into Japanese", async () => {
  try {
    await i18n.changeLanguage("ja");
    expect(i18n.t("providerUsage.refresh")).toBe("更新");
  } finally {
    await i18n.changeLanguage("en");
  }
});

it("translates the neighboring usage percentage settings", async () => {
  try {
    await i18n.changeLanguage("ja");
    expect(i18n.t("providerUsage.displayUsed")).toBe("使用済み");
    expect(i18n.t("providerUsage.displayRemaining")).toBe("残り");
  } finally {
    await i18n.changeLanguage("en");
  }
});

it("preserves provider-defined labels even when their IDs match a standard period", () => {
  expect(formatProviderUsageLabel("monthly", "Extra allotment")).toBe("Extra allotment");
  expect(formatProviderUsageLabel("code_review:weekly", "Custom review allowance")).toBe(
    "Custom review allowance",
  );
});
