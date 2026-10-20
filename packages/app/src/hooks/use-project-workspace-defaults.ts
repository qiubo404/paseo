import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { readValidatedJson } from "@/storage/validated-storage";
import {
  PROJECT_WORKSPACE_DEFAULTS_KEY,
  ProjectWorkspaceDefaultsMapSchema,
  ProjectWorkspaceDefaultsService,
  type ProjectWorkspaceDefaults,
} from "@/create-agent-preferences/project-defaults";

const queryKey = ["project-workspace-defaults"];
const service = new ProjectWorkspaceDefaultsService({
  read: async () =>
    (await readValidatedJson(
      AsyncStorage,
      PROJECT_WORKSPACE_DEFAULTS_KEY,
      ProjectWorkspaceDefaultsMapSchema,
    )) ?? {},
  write: async (value) =>
    AsyncStorage.setItem(PROJECT_WORKSPACE_DEFAULTS_KEY, JSON.stringify(value)),
});

export function useProjectWorkspaceDefaults() {
  const queryClient = useQueryClient();
  const query = useFetchQuery({
    queryKey,
    queryFn: () => service.load(),
    dataShape: "value",
    immutableWhen: () => true,
  });
  const reload = useCallback(() => {
    void query.refetch();
  }, [query]);
  return {
    records: query.data,
    isLoading: query.isPending,
    error: query.error,
    reload,
    save: async (projectKey: string, record: ProjectWorkspaceDefaults, includeAgent: boolean) => {
      const next = await service.save(projectKey, record, includeAgent);
      queryClient.setQueryData(queryKey, next);
    },
  };
}
