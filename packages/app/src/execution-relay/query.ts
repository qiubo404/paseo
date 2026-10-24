import { useFetchQuery } from "@/data/query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RelayAddress, RelayState } from "@getpaseo/protocol/execution-relay";
import { useSessionStore } from "@/stores/session-store";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { relayAddressKey, selectRelayGroup } from "./model";

export function useExecutionRelayQuery(enabled = true) {
  const panelActive = useRetainedPanelActive();
  const coordinatorId = useSessionStore((state) => {
    const candidates = Object.entries(state.sessions).filter(
      ([, session]) => session.client && session.serverInfo?.features?.executionRelay,
    );
    return (
      (candidates.find(([, session]) => session.serverInfo?.desktopManaged) ??
        candidates[0])?.[0] ?? ""
    );
  });
  const client = useSessionStore((state) => state.sessions[coordinatorId]?.client ?? null);
  const queryKey = ["execution-relay", coordinatorId];
  const query = useFetchQuery({
    queryKey,
    enabled: Boolean(client) && panelActive && enabled,
    queryFn: () => {
      if (!client) throw new Error("Execution relay host is unavailable");
      return client.getExecutionRelayState();
    },
    refetchInterval: 5000,
    staleTimeMs: 1000,
    dataShape: "value",
  });
  return { client, query, queryKey };
}

export function useRelay(address: RelayAddress) {
  const { client, query, queryKey } = useExecutionRelayQuery();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (
      input:
        | { kind: "join"; target: RelayAddress; requestId: string }
        | { kind: "pause" | "resume" | "leave" },
    ) => {
      if (!client) throw new Error("Execution relay host is unavailable");
      return input.kind === "join"
        ? client.joinExecutionRelay(address, input.requestId, input.target)
        : client.updateExecutionRelay(address, input.kind);
    },
    onSuccess: (state: RelayState) => queryClient.setQueryData(queryKey, state),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });
  const group = selectRelayGroup(query.data, address);
  const member = group?.members.find(
    (entry) => relayAddressKey(entry.address) === relayAddressKey(address),
  );
  return { client, query, mutation, group, member };
}

export function useHasExecutionRelay(address: RelayAddress): boolean {
  return Boolean(selectRelayGroup(useExecutionRelayQuery().query.data, address));
}

export function useIsRelayPlanManaged(address: RelayAddress, requestId: string): boolean {
  const { query } = useExecutionRelayQuery();
  const member = selectRelayGroup(query.data, address)?.members.find(
    (entry) => relayAddressKey(entry.address) === relayAddressKey(address),
  );
  return Boolean(
    member &&
    member.planRequestId === requestId &&
    member.status !== "completed" &&
    member.status !== "canceled",
  );
}
