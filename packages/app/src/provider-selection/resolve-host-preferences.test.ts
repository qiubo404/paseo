import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { resolveHostPreferences } from "./resolve-host-preferences";

const ready: ProviderSnapshotEntry = {
  provider: "claude",
  enabled: true,
  status: "ready",
  defaultModeId: "default",
  modes: [
    { id: "default", label: "Ask" },
    { id: "bypass", label: "Bypass" },
  ],
  models: [
    {
      provider: "claude",
      id: "opus",
      label: "Opus",
      isDefault: true,
      defaultThinkingOptionId: "medium",
      thinkingOptions: [{ id: "medium", label: "Medium" }],
    },
    { provider: "claude", id: "sonnet", label: "Sonnet" },
  ],
};
const codex = {
  provider: "codex",
  providerPreferences: {
    codex: { model: "gpt", mode: "bypass", featureValues: { fast: true } },
    claude: { model: "sonnet", mode: "bypass", featureValues: { fast: true } },
  },
};

describe("host model defaults", () => {
  it("keeps an available current model, mode and feature values", () => {
    const preferences = {
      provider: "claude",
      providerPreferences: {
        claude: { model: "sonnet", mode: "bypass", featureValues: { fast: true } },
      },
    };
    expect(
      resolveHostPreferences(preferences, [ready]).preferences.providerPreferences?.claude,
    ).toMatchObject(preferences.providerPreferences.claude);
  });
  it("selects the target host default and resets permission and features across providers", () => {
    const resolved = resolveHostPreferences(codex, [ready]);
    expect(resolved.loading).toBe(false);
    expect(resolved.preferences.provider).toBe("claude");
    expect(resolved.preferences.providerPreferences?.claude).toEqual({
      model: "opus",
      mode: "default",
      thinkingByModel: { opus: "medium" },
    });
  });
  it("waits for an in-flight preferred catalog before choosing a different provider", () => {
    expect(
      resolveHostPreferences(codex, [
        { provider: "codex", enabled: true, status: "loading", models: undefined },
        ready,
      ]).loading,
    ).toBe(true);
    expect(resolveHostPreferences(codex, undefined).loading).toBe(true);
  });
  it("does not wait for unrelated providers when the current model is available", () => {
    expect(
      resolveHostPreferences(
        { provider: "claude", providerPreferences: { claude: { model: "opus" } } },
        [ready, { provider: "codex", enabled: true, status: "loading", models: undefined }],
      ).loading,
    ).toBe(false);
  });
  it("falls back within the same provider and normalizes unavailable thinking and mode", () => {
    const result = resolveHostPreferences(
      {
        provider: "claude",
        providerPreferences: {
          claude: { model: "removed", mode: "removed", thinkingByModel: { opus: "removed" } },
        },
      },
      [ready],
    );
    expect(result.preferences.providerPreferences?.claude).toMatchObject({
      model: "opus",
      mode: "default",
      thinkingByModel: { opus: "medium" },
    });
  });
  it("does not select disabled providers or hidden models and reports an empty catalog", () => {
    const result = resolveHostPreferences(codex, [
      { ...ready, enabled: false },
      {
        ...ready,
        provider: "hidden",
        models: [{ provider: "hidden", id: "hidden", label: "Hidden", isSelectable: false }],
      },
    ]);
    expect(result.loading).toBe(false);
    expect(result.preferences.provider).toBeUndefined();
  });
  it("uses a host default on the first visit without rewriting the input", () => {
    const result = resolveHostPreferences({}, [ready]);
    expect(result.preferences.providerPreferences?.claude?.model).toBe("opus");
    expect(codex.providerPreferences.codex.mode).toBe("bypass");
  });
});
