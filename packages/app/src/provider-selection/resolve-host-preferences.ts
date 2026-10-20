import type { AgentModelDefinition, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { FormPreferences, ProviderPreferences } from "@/create-agent-preferences/preferences";
import { filterSelectableModels, findModelByReference } from "./model-catalog";
import { resolveDefaultModel, resolveThinkingOptionId } from "./resolve-agent-form";

interface HostPreferencesResolution {
  preferences: FormPreferences;
  loading: boolean;
}

function selectableModels(entry: ProviderSnapshotEntry): AgentModelDefinition[] {
  return filterSelectableModels(entry.models ?? []) ?? [];
}

function resolveProviderOptions(input: {
  provider: ProviderSnapshotEntry;
  models: AgentModelDefinition[];
  model: AgentModelDefinition;
  saved: ProviderPreferences | undefined;
}): ProviderPreferences {
  const { provider, models, model, saved } = input;
  const modeAvailable = provider.modes?.some((item) => item.id === saved?.mode);
  const mode = modeAvailable ? saved?.mode : (provider.defaultModeId ?? provider.modes?.[0]?.id);
  const references = [model.id, ...(model.aliases ?? [])];
  const preferredThinking = references
    .map((reference) => saved?.thinkingByModel?.[reference])
    .find(Boolean);
  const thinking = resolveThinkingOptionId({
    availableModels: models,
    modelId: model.id,
    requestedThinkingOptionId: preferredThinking ?? "",
  });
  return {
    ...saved,
    model: model.id,
    mode: mode ?? undefined,
    thinkingByModel: thinking ? { [model.id]: thinking } : {},
  };
}

function resolveSelection(
  preferences: FormPreferences,
  provider: ProviderSnapshotEntry,
): HostPreferencesResolution {
  const models = selectableModels(provider);
  const sameProvider = provider.provider === preferences.provider;
  // Crossing providers must not carry another host's bypass mode or feature toggles.
  const saved = sameProvider ? preferences.providerPreferences?.[provider.provider] : undefined;
  const preferredModel = findModelByReference(models, saved?.model ?? "");
  const model = preferredModel ?? resolveDefaultModel(models);
  if (!model) return { preferences, loading: false };
  const result: HostPreferencesResolution = {
    loading: false,
    preferences: {
      ...preferences,
      provider: provider.provider,
      providerPreferences: {
        [provider.provider]: resolveProviderOptions({ provider, models, model, saved }),
      },
    },
  };
  return result;
}

/** Resolve once on entering a project/host draft; background refreshes never replace edits. */
export function resolveHostPreferences(
  preferences: FormPreferences,
  entries: readonly ProviderSnapshotEntry[] | undefined,
): HostPreferencesResolution {
  if (!entries) return { preferences, loading: true };
  const preferred = entries.find((entry) => entry.provider === preferences.provider);
  // Wait for the requested provider, without waiting for unrelated providers to finish.
  if (preferred?.enabled && preferred.status === "loading") return { preferences, loading: true };
  const available = entries.filter(
    (entry) => entry.enabled && entry.status === "ready" && selectableModels(entry).length > 0,
  );
  const provider =
    available.find((entry) => entry.provider === preferences.provider) ?? available[0];
  if (provider) return resolveSelection(preferences, provider);
  return {
    preferences: { ...preferences, provider: undefined, providerPreferences: {} },
    loading: entries.some((entry) => entry.enabled && entry.status === "loading"),
  };
}
