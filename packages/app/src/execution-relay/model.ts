import type { RelayAddress, RelayState } from "@getpaseo/protocol/execution-relay";

export function relayAddressKey(address: RelayAddress): string {
  return JSON.stringify([address.serverId, address.agentId]);
}

export function selectRelayGroup(state: RelayState | undefined, address: RelayAddress) {
  return state?.groups.find((group) =>
    group.members.some(
      (member) =>
        member.status !== "canceled" &&
        relayAddressKey(member.address) === relayAddressKey(address),
    ),
  );
}

export function selectRelayTargets(state: RelayState | undefined, address: RelayAddress) {
  return (
    state?.candidates.filter(
      (candidate) => relayAddressKey(candidate.address) !== relayAddressKey(address),
    ) ?? []
  );
}

export type RelayWorkspaceIndicator = "waiting" | "paused";

interface RelayDisplayEntry {
  address: RelayAddress;
  title: string;
  host?: string;
}

export function relayDisplayTitle(
  entry: RelayDisplayEntry,
  title?: string | null,
  workspaceName?: string | null,
): string {
  return (
    title?.trim() ||
    workspaceName?.trim() ||
    (entry.title !== entry.address.agentId ? entry.title.trim() : "")
  );
}

interface RelaySidebarAgent {
  id: string;
  workspaceId?: string;
  archivedAt?: Date | null;
  status: string;
  attentionReason?: string | null;
  pendingPermissions: ReadonlyArray<{ id: string; kind?: string }>;
  turn: { phase: string };
}
interface RelaySidebarSession {
  agents: ReadonlyMap<string, RelaySidebarAgent>;
  agentDetails: ReadonlyMap<string, RelaySidebarAgent>;
}

/** Only the exact queued approval can replace an attention indicator. */
interface QueuedPlan {
  requestId: string;
  paused: boolean;
}
function ownsQueuedApproval(agent: RelaySidebarAgent, entry: QueuedPlan | undefined): boolean {
  return Boolean(
    entry &&
    agent.status !== "error" &&
    agent.attentionReason !== "error" &&
    agent.pendingPermissions.length === 1 &&
    agent.pendingPermissions[0].kind === "plan" &&
    agent.pendingPermissions[0].id === entry.requestId,
  );
}

export function selectRelayWorkspaceIndicators(
  state: RelayState | undefined,
  sessions: Record<string, RelaySidebarSession | undefined>,
): Record<string, RelayWorkspaceIndicator> {
  const result: Record<string, RelayWorkspaceIndicator> = {};
  const queued = new Map<string, QueuedPlan>();
  for (const group of state?.groups ?? [])
    for (const member of group.members) {
      if (member.status === "queued" && member.planRequestId)
        queued.set(relayAddressKey(member.address), {
          requestId: member.planRequestId,
          paused: group.paused,
        });
    }
  for (const [serverId, session] of Object.entries(sessions)) {
    if (!session) continue;
    const agents = new Map([...session.agentDetails, ...session.agents]);
    const blocked = new Set<string>();
    for (const agent of agents.values()) {
      if (!agent.workspaceId || agent.archivedAt) continue;
      const entry = queued.get(relayAddressKey({ serverId, agentId: agent.id }));
      if (entry && ownsQueuedApproval(agent, entry))
        result[`${serverId}:${agent.workspaceId}`] = entry.paused ? "paused" : "waiting";
      else if (
        agent.pendingPermissions.length ||
        agent.status === "error" ||
        agent.attentionReason === "error" ||
        agent.turn.phase === "open"
      )
        blocked.add(agent.workspaceId);
    }
    for (const workspaceId of blocked) delete result[`${serverId}:${workspaceId}`];
  }
  return result;
}
