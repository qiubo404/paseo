import { describe, expect, it } from "vitest";
import { formatAmount, formatResetCountdown, formatResetLabel } from "./format";

describe("formatResetCountdown", () => {
  const now = Date.parse("2026-10-21T08:00:00.000Z");

  it.each([
    [3 * 24 * 60 + 8 * 60 + 15, "3d 8h"],
    [24 * 60, "1d 0h"],
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

describe("formatAmount", () => {
  it("groups thousands in the app's language", () => {
    expect(formatAmount(12345, "credits", "en")).toBe("12,345");
    expect(formatAmount(12345, "requests", "en")).toBe("12,345");
    expect(formatAmount(12345, "credits", "fr").replace(/\s/g, " ")).toBe("12 345");
  });

  it("formats dollars as the language writes currency", () => {
    expect(formatAmount(1234.5, "usd", "en")).toBe("$1,234.50");
    expect(formatAmount(1234.5, "usd", "fr").replace(/\s/g, " ")).toBe("1 234,50 $US");
  });
});

it("retained reset times that have passed do not claim the quota is resetting", () => {
  const past = "2000-01-01T00:00:00.000Z";
  expect(formatResetLabel(past, true)).toBe("Reset time passed");
  expect(formatResetLabel(past)).toBe("resetting now");
  expect(formatResetLabel(null, true)).toBeNull();
});
