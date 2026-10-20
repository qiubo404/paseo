import { describe, expect, it } from "vitest";
import type { AgentMode } from "@getpaseo/protocol/agent-types";
import { resolveAgentControlsMode, resolveNextAgentModeId, resolveAgentModeShortcut } from "./mode";

const PLAN_MODE = { id: "plan", label: "Plan" } satisfies AgentMode;

const MODES = [
  PLAN_MODE,
  { id: "build", label: "Build" },
  { id: "full-access", label: "Full Access" },
] satisfies AgentMode[];

describe("resolveAgentModeShortcut", () => {
  it.each([false, true])("toggles Codex planning from %s without changing permissions", (value) => {
    expect(
      resolveAgentModeShortcut({
        provider: "codex",
        features: [{ id: "plan_mode", type: "toggle", label: "Plan", value }],
        modeOptions: MODES,
        selectedMode: "full-access",
      }),
    ).toEqual({ type: "feature", featureId: "plan_mode", value: !value });
  });

  it("does not change Codex permissions when planning is unavailable", () => {
    expect(
      resolveAgentModeShortcut({
        provider: "codex",
        features: [],
        modeOptions: MODES,
        selectedMode: "build",
      }),
    ).toBeNull();
  });

  it("keeps mode cycling for other providers", () => {
    expect(
      resolveAgentModeShortcut({
        provider: "claude",
        features: [],
        modeOptions: MODES,
        selectedMode: "build",
      }),
    ).toEqual({ type: "mode", modeId: "full-access" });
  });
});

describe("resolveAgentControlsMode", () => {
  it("uses ready mode when no controlled agent controls are provided", () => {
    expect(resolveAgentControlsMode(undefined)).toBe("ready");
  });

  it("uses draft mode when controlled agent controls are provided", () => {
    expect(
      resolveAgentControlsMode({
        providerDefinitions: [],
        selectedProvider: "codex",
        modeOptions: [],
        selectedMode: "",
        onSelectMode: () => undefined,
        models: [],
        selectedModel: "",
        onSelectModel: () => undefined,
        isModelLoading: false,
        modelSelectorProviders: [],
        isAllModelsLoading: false,
        onSelectProviderAndModel: () => undefined,
        thinkingOptions: [],
        selectedThinkingOptionId: "",
        onSelectThinkingOption: () => undefined,
        onApplyAgentProfile: () => undefined,
      }),
    ).toBe("draft");
  });
});

describe("resolveNextAgentModeId", () => {
  it("cycles from the selected mode to the next mode", () => {
    expect(resolveNextAgentModeId({ modeOptions: MODES, selectedMode: "build" })).toBe(
      "full-access",
    );
  });

  it("wraps from the last mode to the first mode", () => {
    expect(resolveNextAgentModeId({ modeOptions: MODES, selectedMode: "full-access" })).toBe(
      "plan",
    );
  });

  it("treats an empty selection as the visible first mode", () => {
    expect(resolveNextAgentModeId({ modeOptions: MODES, selectedMode: "" })).toBe("build");
  });

  it("treats a stale selection as the visible first mode", () => {
    expect(resolveNextAgentModeId({ modeOptions: MODES, selectedMode: "deleted-mode" })).toBe(
      "build",
    );
  });

  it("returns null when there are fewer than two modes", () => {
    expect(resolveNextAgentModeId({ modeOptions: [], selectedMode: "" })).toBeNull();
    expect(resolveNextAgentModeId({ modeOptions: [PLAN_MODE], selectedMode: "plan" })).toBeNull();
  });
});
