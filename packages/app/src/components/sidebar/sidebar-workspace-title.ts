import type { TFunction } from "i18next";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { WorkspaceTitleSource } from "@/hooks/use-settings";
import { getStatusBucketLabel } from "@/hooks/sidebar-status-view-model";

export function resolveSidebarWorkspacePrimaryLabel(input: {
  workspace: Pick<SidebarWorkspaceEntry, "name" | "currentBranch">;
  workspaceTitleSource: WorkspaceTitleSource;
}): string {
  if (input.workspaceTitleSource === "branch") {
    return input.workspace.currentBranch ?? input.workspace.name;
  }
  return input.workspace.name;
}

export function resolveSidebarWorkspaceAccessibilityLabel(input: {
  workspace: Pick<
    SidebarWorkspaceEntry,
    "name" | "currentBranch" | "statusBucket" | "relayIndicator"
  >;
  workspaceTitleSource: WorkspaceTitleSource;
  leadingProjectName?: string | null;
  hostBadgeLabel?: string | null;
  pullRequestLabel?: string | null;
  serviceLabel?: string | null;
  t: TFunction;
}): string {
  let statusLabel: string | null = null;
  if (input.workspace.relayIndicator)
    statusLabel = input.t(`executionRelay.${input.workspace.relayIndicator}`);
  else if (input.workspace.statusBucket !== "done")
    statusLabel = getStatusBucketLabel(input.workspace.statusBucket, input.t);
  return [
    input.leadingProjectName,
    resolveSidebarWorkspacePrimaryLabel(input),
    input.hostBadgeLabel,
    input.pullRequestLabel,
    input.serviceLabel,
    statusLabel,
  ]
    .filter((label): label is string => Boolean(label))
    .join(", ");
}
