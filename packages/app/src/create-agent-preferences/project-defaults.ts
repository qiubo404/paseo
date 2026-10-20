import { z } from "zod";
import { FormPreferencesSchema, type FormPreferences } from "./preferences";

export const ProjectWorkspaceDefaultsSchema = z.strictObject({
  serverId: z.string().min(1),
  preferences: FormPreferencesSchema,
  hostPreferences: z.record(z.string(), FormPreferencesSchema).optional(),
});
export const ProjectWorkspaceDefaultsMapSchema = z.record(
  z.string(),
  ProjectWorkspaceDefaultsSchema,
);
export type ProjectWorkspaceDefaults = z.infer<typeof ProjectWorkspaceDefaultsSchema>;
export type ProjectWorkspaceDefaultsMap = z.infer<typeof ProjectWorkspaceDefaultsMapSchema>;
export const PROJECT_WORKSPACE_DEFAULTS_KEY = "@paseo:project-workspace-defaults";

export function getProjectHostPreferences(
  record: ProjectWorkspaceDefaults | undefined,
  serverId: string,
): FormPreferences | undefined {
  return (
    record?.hostPreferences?.[serverId] ??
    (record?.serverId === serverId ? record.preferences : undefined)
  );
}

interface ProjectIdentity {
  viewKey: string;
  projectKey: string | null;
}

// Choosing an equivalent checkout on another host must not become a new form scope.
export function resolveProjectDefaultsScope(
  project: ProjectIdentity | null,
  originKey: string | undefined,
  projects: readonly ProjectIdentity[],
): string {
  if (!project) return originKey ?? "unselected";
  const origin = projects.find((item) => item.viewKey === originKey);
  return origin?.projectKey && origin.projectKey === project.projectKey
    ? origin.viewKey
    : project.viewKey;
}

export interface ProjectDefaultsStorage {
  read(): Promise<ProjectWorkspaceDefaultsMap>;
  write(value: ProjectWorkspaceDefaultsMap): Promise<void>;
}

export class ProjectWorkspaceDefaultsService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: ProjectDefaultsStorage) {}

  load() {
    return this.storage.read();
  }

  save(projectKey: string, record: ProjectWorkspaceDefaults, includeAgent: boolean) {
    const operation = this.applySave(this.queue, projectKey, record, includeAgent);
    this.queue = operation;
    return operation;
  }
  private async applySave(
    previous: Promise<unknown>,
    projectKey: string,
    record: ProjectWorkspaceDefaults,
    includeAgent: boolean,
  ) {
    await previous.catch(() => undefined);
    const current = await this.storage.read();
    const previousRecord = current[projectKey];
    const hostPreferences = {
      ...(previousRecord ? { [previousRecord.serverId]: previousRecord.preferences } : {}),
      ...previousRecord?.hostPreferences,
    };
    const preferences: FormPreferences = includeAgent
      ? record.preferences
      : {
          ...getProjectHostPreferences(previousRecord, record.serverId),
          isolation: record.preferences.isolation,
        };
    const next = {
      ...current,
      [projectKey]: ProjectWorkspaceDefaultsSchema.parse({
        ...record,
        preferences,
        hostPreferences: { ...hostPreferences, [record.serverId]: preferences },
      }),
    };
    await this.storage.write(next);
    return next;
  }
}
