import type { DraftAgentControlsProps } from "@/composer/agent-controls";
import type { AgentFeature, AgentMode } from "@getpaseo/protocol/agent-types";
import { PLAN_MODE_FEATURE_ID } from "@/agent-controls/policy";

export function resolveAgentModeShortcut(input: {
  provider: string;
  features: readonly AgentFeature[];
  modeOptions: readonly AgentMode[];
  selectedMode: string | null | undefined;
}):
  | { type: "feature"; featureId: string; value: boolean }
  | { type: "mode"; modeId: string }
  | null {
  if (input.provider === "codex") {
    const plan = input.features.find((feature) => feature.id === PLAN_MODE_FEATURE_ID);
    if (plan?.type !== "toggle") return null;
    return { type: "feature", featureId: plan.id, value: !plan.value };
  }
  const modeId = resolveNextAgentModeId(input);
  return modeId ? { type: "mode", modeId } : null;
}

export function resolveNextAgentModeId({
  modeOptions,
  selectedMode,
}: {
  modeOptions: readonly AgentMode[];
  selectedMode: string | null | undefined;
}): string | null {
  if (modeOptions.length < 2) return null;

  const selectedIndex = modeOptions.findIndex((mode) => mode.id === selectedMode);
  const currentIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const nextIndex = (currentIndex + 1) % modeOptions.length;
  return modeOptions[nextIndex]?.id ?? null;
}

export function resolveAgentControlsMode(agentControls?: DraftAgentControlsProps) {
  return agentControls ? "draft" : "ready";
}
