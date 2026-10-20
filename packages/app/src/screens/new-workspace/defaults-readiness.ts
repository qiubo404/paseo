import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { filterSelectableModels, findModelByReference } from "@/provider-selection/model-catalog";

export function resolveWorkspaceDefaultsIssue(input: {
  hostKnown: boolean;
  connected: boolean;
  hostLoading?: boolean;
  serverId: string;
  sourceDirectory: string | null;
  isolationSupported: boolean;
  needsAgent: boolean;
  isLoading: boolean;
  preferencesLoading?: boolean;
  hasConfiguredProvider?: boolean;
  provider: string | null;
  model: string;
  mode: string;
  thinking: string;
  entries: readonly ProviderSnapshotEntry[];
}): {
  key:
    | "loading"
    | "noModels"
    | "hostUnavailable"
    | "projectUnavailable"
    | "isolationUnavailable"
    | "providerUnavailable"
    | "modelUnavailable"
    | "modeUnavailable"
    | "thinkingUnavailable";
  value?: string;
} | null {
  if (!input.hostKnown) return { key: "hostUnavailable", value: input.serverId };
  if (input.hostLoading) return { key: "loading" };
  if (!input.connected) return { key: "hostUnavailable", value: input.serverId };
  if (!input.sourceDirectory) return { key: "projectUnavailable" };
  if (!input.isolationSupported) return { key: "isolationUnavailable" };
  if (!input.needsAgent) return null;
  if (input.preferencesLoading) return { key: "loading" };
  if (input.hasConfiguredProvider === false) return { key: "noModels" };
  if (input.isLoading) return { key: "loading" };
  if (!input.provider) {
    const hasModels = input.entries.some(
      (entry) =>
        entry.enabled &&
        entry.status === "ready" &&
        (filterSelectableModels(entry.models ?? [])?.length ?? 0) > 0,
    );
    if (hasModels) return null;
    if (input.entries.some((entry) => entry.enabled && entry.status === "loading"))
      return { key: "loading" };
    return { key: "noModels" };
  }
  const provider = input.entries.find((entry) => entry.provider === input.provider);
  if (provider?.status === "loading") return { key: "loading" };
  if (!provider?.enabled || provider.status !== "ready")
    return { key: "providerUnavailable", value: input.provider };
  const model = findModelByReference(provider.models ?? [], input.model);
  return resolveAgentOptionsIssue(input, provider, model);
}

function resolveAgentOptionsIssue(
  input: Parameters<typeof resolveWorkspaceDefaultsIssue>[0],
  provider: ProviderSnapshotEntry,
  model: ReturnType<typeof findModelByReference>,
): ReturnType<typeof resolveWorkspaceDefaultsIssue> {
  if (input.model && !model) return { key: "modelUnavailable", value: input.model };
  if (input.mode && provider.modes && !provider.modes.some((mode) => mode.id === input.mode))
    return { key: "modeUnavailable", value: input.mode };
  if (
    input.thinking &&
    model &&
    !model.thinkingOptions?.some((thinking) => thinking.id === input.thinking)
  )
    return { key: "thinkingUnavailable", value: input.thinking };
  return null;
}
