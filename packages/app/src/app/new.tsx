import { useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import {
  ComposerEditingScope,
  WorkspaceComposerEditingSessionsProvider,
} from "@/composer/editing-session";
import { NewWorkspaceScreen } from "@/screens/new-workspace-screen";
import { buildNewWorkspaceDraftKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { useLocalDaemonServerIdState } from "@/hooks/use-is-local-daemon";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";
import { CHAT_LAUNCH_TARGET } from "@/new-workspace-launch/target";
import { useHostProjects, getHostProjectId } from "@/projects/host-projects";
import { useHasHydratedWorkspaces } from "@/stores/session-store-hooks";

/** New workspace drafts share one editing-session home, keyed like a tab by draft. */
const NEW_WORKSPACE_SESSIONS_KEY = "new-workspace";

function routeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function usePrefillProject(serverId: string, sourceDirectory: string | undefined) {
  const serverIds = useMemo(() => [serverId], [serverId]);
  const projects = useHostProjects(serverIds);
  const hydrated = useHasHydratedWorkspaces(serverId);
  const project = projects.find((candidate) =>
    candidate.hosts.some(
      (host) => host.serverId === serverId && host.iconWorkingDir === sourceDirectory,
    ),
  );
  const projectId = project ? (getHostProjectId(project, serverId) ?? undefined) : undefined;
  return { projectId, hydrated };
}

export default function NewWorkspaceRoute() {
  const params = useLocalSearchParams<{
    serverId?: string;
    dir?: string;
    name?: string;
    projectId?: string;
    draftId?: string;
    prompt?: string;
    local?: string;
  }>();
  const { t } = useTranslation();
  const localDaemon = useLocalDaemonServerIdState();
  const localPrefill = params.local === "1";
  const localServerId = localDaemon.status === "resolved" ? localDaemon.serverId : null;
  const routeServerId = routeString(params.serverId) ?? "";
  const serverId = localPrefill ? (localServerId ?? "") : routeServerId;
  const sourceDirectory = routeString(params.dir);
  const displayName = routeString(params.name);
  const prefillProject = usePrefillProject(serverId, sourceDirectory);
  const projectId = routeString(params.projectId) ?? prefillProject.projectId;
  const draftId = routeString(params.draftId);
  const prompt = routeString(params.prompt);
  const screenKey = JSON.stringify([serverId, sourceDirectory, displayName, projectId, draftId]);

  // The shell remounts this route when the viewport crosses the compact breakpoint;
  // the draft's editing session (fullscreen, retained caret) lives above the shell.
  const draftKey = buildNewWorkspaceDraftKey(draftId);
  const sessionTabIds = useMemo(() => [draftKey], [draftKey]);
  const [preparedDraftKey, setPreparedDraftKey] = useState<string | null>(null);

  useEffect(() => {
    if (prompt === undefined || !draftId) return;
    const prepare = () => {
      // Restoring a route must preserve edits already made to this draft.
      const store = useDraftStore.getState();
      if (!store.drafts[draftKey]) store.editDraftText({ draftKey, text: prompt });
      setPreparedDraftKey(draftKey);
    };
    const unsubscribe = useDraftStore.persist.onFinishHydration(prepare);
    if (useDraftStore.persist.hasHydrated()) prepare();
    return unsubscribe;
  }, [draftId, draftKey, prompt]);

  if (localPrefill && localDaemon.status === "error") {
    return <Text accessibilityRole="alert">{t("workspace.terminal.hostDisconnected")}</Text>;
  }
  const missingPrefillProject = prompt !== undefined && !projectId;
  if (missingPrefillProject && prefillProject.hydrated) {
    return <Text accessibilityRole="alert">{t("newWorkspace.defaults.projectUnavailable")}</Text>;
  }
  const waitingForHost = localPrefill && !localServerId;
  const waitingForDraft = prompt !== undefined && !!draftId && preparedDraftKey !== draftKey;
  if (waitingForHost || waitingForDraft || missingPrefillProject) return <StartupSplashScreen />;

  return (
    <HostRouteBootstrapBoundary>
      <WorkspaceComposerEditingSessionsProvider
        workspaceKey={NEW_WORKSPACE_SESSIONS_KEY}
        tabIds={sessionTabIds}
      >
        <ComposerEditingScope tabId={draftKey} targetKey={draftKey}>
          <NewWorkspaceScreen
            key={screenKey}
            serverId={serverId}
            sourceDirectory={sourceDirectory}
            displayName={displayName}
            projectId={projectId}
            draftId={draftId}
            initialLaunchTarget={prompt !== undefined ? CHAT_LAUNCH_TARGET : undefined}
          />
        </ComposerEditingScope>
      </WorkspaceComposerEditingSessionsProvider>
    </HostRouteBootstrapBoundary>
  );
}
