import { selectRelayWorkspaceIndicators, relayDisplayTitle } from "@/execution-relay/model";
import type { RelayState } from "@getpaseo/protocol/execution-relay";
import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceAgentActivity } from "@/utils/workspace-agent-activity";
import {
  areSidebarWorkspaceSessionsEqual,
  selectSidebarWorkspaceSessions,
  type SidebarWorkspaceSession,
} from "./sidebar-workspaces-view-model";

function workspaceMap(): Map<string, WorkspaceDescriptor> {
  return new Map();
}

function activityMap(): Map<string, WorkspaceAgentActivity> {
  return new Map();
}

function sidebarSession(input?: Partial<Omit<SidebarWorkspaceSession, "serverId">>) {
  return {
    workspaces: input?.workspaces ?? workspaceMap(),
    workspaceAgentActivity: input?.workspaceAgentActivity ?? activityMap(),
  };
}

describe("sidebar workspace session selection", () => {
  it("selects only sessions needed by sidebar placements", () => {
    const hostA = sidebarSession();
    const hostB = sidebarSession();
    const unusedHost = sidebarSession();

    expect(
      selectSidebarWorkspaceSessions(
        {
          "host-a": hostA,
          "host-b": hostB,
          unused: unusedHost,
        },
        ["host-b", "missing", "host-a"],
      ),
    ).toEqual([
      {
        serverId: "host-b",
        workspaces: hostB.workspaces,
        workspaceAgentActivity: hostB.workspaceAgentActivity,
      },
      {
        serverId: "host-a",
        workspaces: hostA.workspaces,
        workspaceAgentActivity: hostA.workspaceAgentActivity,
      },
    ]);
  });

  it("ignores high-frequency session changes outside the sidebar indexes", () => {
    const workspaces = workspaceMap();
    const workspaceAgentActivity = activityMap();

    const previous = selectSidebarWorkspaceSessions(
      { "host-a": sidebarSession({ workspaces, workspaceAgentActivity }) },
      ["host-a"],
    );
    const next = selectSidebarWorkspaceSessions(
      { "host-a": sidebarSession({ workspaces, workspaceAgentActivity }) },
      ["host-a"],
    );

    expect(previous).not.toBe(next);
    expect(areSidebarWorkspaceSessionsEqual(previous, next)).toBe(true);
  });

  it("detects changes to a selected workspace or activity index", () => {
    const workspaceAgentActivity = activityMap();
    const previous = selectSidebarWorkspaceSessions(
      { "host-a": sidebarSession({ workspaceAgentActivity, workspaces: workspaceMap() }) },
      ["host-a"],
    );
    const next = selectSidebarWorkspaceSessions(
      { "host-a": sidebarSession({ workspaceAgentActivity, workspaces: workspaceMap() }) },
      ["host-a"],
    );

    expect(areSidebarWorkspaceSessionsEqual(previous, next)).toBe(false);
  });
});

describe("relay workspace indicators", () => {
  const address = { serverId: "host-a", agentId: "queued" };
  function relay(paused = false): RelayState {
    return {
      candidates: [],
      unavailableHosts: [],
      groups: [
        {
          id: "relay",
          paused,
          reason: null,
          members: [
            {
              address,
              title: "Plan",
              provider: "claude",
              status: "queued",
              planRequestId: "approved-plan",
              planHash: "hash",
              turnId: null,
            },
          ],
        },
      ],
    };
  }
  function queuedAgent() {
    return {
      id: "queued",
      workspaceId: "workspace",
      status: "running",
      attentionReason: "permission",
      pendingPermissions: [{ id: "approved-plan", kind: "plan" }],
      turn: { phase: "open" },
    };
  }
  function sessions(agents = [queuedAgent()]) {
    return {
      "host-a": {
        agents: new Map(agents.map((agent) => [agent.id, agent])),
        agentDetails: new Map(),
      },
    };
  }
  it("distinguishes queued and paused plans without changing native status", () => {
    const input = sessions();
    expect(selectRelayWorkspaceIndicators(relay(), input)).toEqual({
      "host-a:workspace": "waiting",
    });
    expect(selectRelayWorkspaceIndicators(relay(true), input)).toEqual({
      "host-a:workspace": "paused",
    });
    expect(input["host-a"].agents.get("queued")?.status).toBe("running");
  });
  it("leaves a replaced approval, another question and a failed task visible", () => {
    const changed = queuedAgent();
    changed.pendingPermissions[0].id = "new-plan";
    expect(selectRelayWorkspaceIndicators(relay(), sessions([changed]))).toEqual({});
    const question = queuedAgent();
    question.pendingPermissions.push({ id: "question", kind: "question" });
    expect(selectRelayWorkspaceIndicators(relay(), sessions([question]))).toEqual({});
    const failed = queuedAgent();
    failed.status = "error";
    expect(selectRelayWorkspaceIndicators(relay(), sessions([failed]))).toEqual({});
  });
  it("does not hide another agent's active turn or permission in the same workspace", () => {
    const another = {
      ...queuedAgent(),
      id: "another",
      pendingPermissions: [] as Array<{ id: string; kind: string }>,
      attentionReason: "",
      turn: { phase: "open" },
    };
    expect(selectRelayWorkspaceIndicators(relay(), sessions([queuedAgent(), another]))).toEqual({});
    another.turn.phase = "idle";
    another.pendingPermissions = [{ id: "permission", kind: "tool" }];
    expect(selectRelayWorkspaceIndicators(relay(), sessions([queuedAgent(), another]))).toEqual({});
  });
  it("removes the indicator after cancellation or loss of the queued plan", () => {
    const state = relay();
    state.groups[0].members[0].status = "canceled";
    expect(selectRelayWorkspaceIndicators(state, sessions())).toEqual({});
    const started = queuedAgent();
    started.pendingPermissions = [];
    expect(selectRelayWorkspaceIndicators(relay(), sessions([started]))).toEqual({});
  });
});

describe("relay display names", () => {
  const entry = { address: { serverId: "local", agentId: "uuid" }, title: "uuid" };
  it("uses workspace names for legacy ID snapshots and live titles after a rename", () => {
    expect(relayDisplayTitle(entry, null, "Workspace name")).toBe("Workspace name");
    expect(relayDisplayTitle(entry, "Renamed conversation", "Workspace name")).toBe(
      "Renamed conversation",
    );
    expect(relayDisplayTitle(entry)).toBe("");
    expect(relayDisplayTitle({ ...entry, title: "Last known name" })).toBe("Last known name");
  });
});
