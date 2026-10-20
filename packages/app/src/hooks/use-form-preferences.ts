import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { resolveHostPreferences } from "@/provider-selection/resolve-host-preferences";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_FORM_PREFERENCES,
  mergeProviderPreferences,
  type FormPreferences,
  type ProviderPreferences,
} from "@/create-agent-preferences/preferences";
import {
  createAgentPreferencesService,
  type FormPreferenceUpdate,
} from "@/create-agent-preferences/service";

const FORM_PREFERENCES_QUERY_KEY = ["form-preferences"];

export type { FormPreferences, ProviderPreferences };

export { mergeProviderPreferences };

async function loadFormPreferences(): Promise<FormPreferences> {
  return createAgentPreferencesService.load();
}

export interface UseFormPreferencesReturn {
  preferences: FormPreferences;
  isLoading: boolean;
  updatePreferences: (updates: FormPreferenceUpdate) => Promise<FormPreferences>;
  scopeKey?: string;
  projectKey?: string;
  modelsError?: string | null;
}

const ScopedPreferences = createContext<UseFormPreferencesReturn | null>(null);

/** New-workspace choices remain draft-local until creation succeeds. */
export function ScopedFormPreferencesProvider(input: {
  scopeKey: string;
  projectKey: string;
  initialPreferences?: FormPreferences;
  fallbackPreferences?: FormPreferences;
  entries?: readonly ProviderSnapshotEntry[];
  modelsError?: string | null;
  children: ReactNode;
}) {
  interface Draft {
    preferences: FormPreferences;
    resolved: boolean;
  }
  const [state, setState] = useState<{
    scopeKey: string;
    projectKey: string;
    drafts: Record<string, Draft>;
  }>(() => ({ scopeKey: input.scopeKey, projectKey: input.projectKey, drafts: {} }));
  const previousDraft = state.drafts[state.scopeKey];
  const fallbackPreferences =
    (input.projectKey && state.projectKey === input.projectKey
      ? previousDraft?.preferences
      : undefined) ??
    input.fallbackPreferences ??
    {};
  const initialPreferences = input.initialPreferences?.provider
    ? input.initialPreferences
    : { ...fallbackPreferences, ...input.initialPreferences };
  const drafts = state.projectKey === input.projectKey ? state.drafts : {};
  const draft = drafts[input.scopeKey] ?? {
    preferences: initialPreferences,
    resolved: false,
  };
  const resolution = draft.resolved
    ? null
    : resolveHostPreferences(draft.preferences, input.entries);
  const current =
    resolution && !resolution.loading
      ? { preferences: resolution.preferences, resolved: true }
      : draft;
  if (state.scopeKey !== input.scopeKey || state.drafts[input.scopeKey] !== current) {
    setState({
      scopeKey: input.scopeKey,
      projectKey: input.projectKey,
      drafts: { ...drafts, [input.scopeKey]: current },
    });
  }
  const draftsRef = useRef({ ...drafts, [input.scopeKey]: current });
  draftsRef.current = { ...drafts, [input.scopeKey]: current };
  // A callback keeps its originating draft scope even if an async operation completes later.
  const updatePreferences = useCallback(
    async (update: FormPreferenceUpdate) => {
      const latestDraft = draftsRef.current[input.scopeKey] ?? {
        preferences: current.preferences,
        resolved: current.resolved,
      };
      const latest = latestDraft.preferences;
      const preferences = typeof update === "function" ? update(latest) : { ...latest, ...update };
      const agentEdited =
        preferences.provider !== latest.provider ||
        preferences.providerPreferences !== latest.providerPreferences;
      const next = { preferences, resolved: latestDraft.resolved || agentEdited };
      draftsRef.current = { ...draftsRef.current, [input.scopeKey]: next };
      setState((previous) =>
        previous.projectKey !== input.projectKey
          ? previous
          : {
              ...previous,
              drafts: { ...previous.drafts, [input.scopeKey]: next },
            },
      );
      return preferences;
    },
    [current.preferences, current.resolved, input.scopeKey, input.projectKey],
  );
  return createElement(
    ScopedPreferences.Provider,
    {
      value: {
        preferences: current.preferences,
        isLoading: !current.resolved,
        updatePreferences,
        scopeKey: input.scopeKey,
        projectKey: input.projectKey,
        modelsError: input.entries === undefined ? input.modelsError : null,
      },
    },
    input.children,
  );
}

export function useFormPreferences(options: { global?: boolean } = {}): UseFormPreferencesReturn {
  const scoped = useContext(ScopedPreferences);
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery({
    queryKey: FORM_PREFERENCES_QUERY_KEY,
    queryFn: loadFormPreferences,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const preferences = data ?? DEFAULT_FORM_PREFERENCES;

  const updatePreferences = useCallback(
    async (updates: FormPreferenceUpdate) => {
      const next = await createAgentPreferencesService.update(updates);
      queryClient.setQueryData<FormPreferences>(FORM_PREFERENCES_QUERY_KEY, next);
      return next;
    },
    [queryClient],
  );

  const globalPreferences = {
    preferences,
    isLoading: isPending,
    updatePreferences,
  };
  return !options.global && scoped ? scoped : globalPreferences;
}
