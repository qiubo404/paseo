import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import type { RelayState } from "@getpaseo/protocol/execution-relay";
import { useSessionStore } from "@/stores/session-store";
import { useHosts } from "@/runtime/host-runtime";
import { relayAddressKey, relayDisplayTitle, selectRelayWorkspaceIndicators } from "./model";
import { useExecutionRelayQuery } from "./query";

export function useRelayDisplay(state: RelayState | undefined) {
  const hosts = useHosts();
  const entries = useMemo(
    () => [
      ...(state?.candidates ?? []),
      ...(state?.groups.flatMap((group) => group.members) ?? []),
    ],
    [state],
  );
  const titles = useSessionStore(
    useShallow((store) => {
      const result: Record<string, string> = {};
      for (const entry of entries) {
        const session = store.sessions[entry.address.serverId];
        const agent =
          session?.agents.get(entry.address.agentId) ??
          session?.agentDetails.get(entry.address.agentId);
        const workspaceKey =
          agent?.workspaceId && session
            ? resolveWorkspaceMapKeyByIdentity({
                workspaces: session.workspaces,
                workspaceId: agent.workspaceId,
              })
            : null;
        const workspace = workspaceKey ? session?.workspaces.get(workspaceKey) : null;
        result[relayAddressKey(entry.address)] = relayDisplayTitle(
          entry,
          agent?.title,
          workspace?.name ?? agent?.projectPlacement?.workspaceName,
        );
      }
      return result;
    }),
  );
  return useMemo(
    () =>
      new Map(
        entries.map((entry) => [
          relayAddressKey(entry.address),
          {
            title: titles[relayAddressKey(entry.address)],
            host:
              hosts.find((host) => host.serverId === entry.address.serverId)?.label.trim() ||
              (entry.host !== entry.address.serverId ? entry.host : "") ||
              "",
          },
        ]),
      ),
    [entries, titles, hosts],
  );
}

export function useRelayWorkspaceIndicators(enabled: boolean) {
  const { query } = useExecutionRelayQuery(enabled);
  return useSessionStore(
    useShallow((store) =>
      enabled && !query.error ? selectRelayWorkspaceIndicators(query.data, store.sessions) : {},
    ),
  );
}
