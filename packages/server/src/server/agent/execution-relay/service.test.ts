import { expect, test } from "vitest";
import { ExecutionRelayService, type RelayAgent, type RelayPort } from "./service.js";
import type { RelayAddress, RelayGroup } from "@getpaseo/protocol/execution-relay";

const address = (agentId: string, serverId = "local"): RelayAddress => ({ serverId, agentId });
function agent(
  agentId: string,
  provider: "claude" | "codex",
  plan = true,
  serverId = "local",
): RelayAgent {
  return {
    address: address(agentId, serverId),
    title: agentId,
    host: serverId,
    provider,
    status: "running",
    turnId: `${agentId}-turn`,
    plan: plan ? { id: `${agentId}-plan`, hash: agentId } : null,
    blocked: false,
    planning: plan,
    archived: false,
  };
}
function harness(agents: RelayAgent[], initial: RelayGroup[] = []) {
  let disk = structuredClone(initial);
  const entries = new Map(agents.map((entry) => [JSON.stringify(entry.address), entry]));
  const listeners = new Map<string, Parameters<RelayPort["observe"]>[1]>();
  const starts: RelayAddress[] = [];
  const port: RelayPort = {
    list: async () => ({ agents: [...entries.values()], unavailableHosts: [] }),
    inspect: async (key) => entries.get(JSON.stringify(key)) ?? null,
    observe: async (key, handler) => {
      listeners.set(JSON.stringify(key), handler);
      return () => {
        listeners.delete(JSON.stringify(key));
      };
    },
    start: async (key) => {
      starts.push(key);
      const item = entries.get(JSON.stringify(key))!;
      item.plan = null;
      item.planning = false;
      item.turnId = `${key.agentId}-implementation`;
      item.status = "running";
    },
  };
  const service = new ExecutionRelayService({
    port,
    store: {
      load: async () => structuredClone(disk),
      save: async (groups) => {
        disk = structuredClone(groups);
      },
    },
    onError: (error) => {
      throw error;
    },
  });
  return {
    service,
    port,
    starts,
    entries,
    listeners,
    disk: () => disk,
    async emit(item: RelayAgent, type: string) {
      listeners.get(JSON.stringify(item.address))?.(item, { type, turnId: item.turnId });
      return service.getState();
    },
  };
}

test("a running implementation holds the slot while two plans on different hosts wait", async () => {
  const a = agent("a", "claude", false);
  const b = agent("b", "codex", true, "remote");
  const c = agent("c", "claude");
  const h = harness([a, b, c]);
  await h.service.start();
  await h.service.join(b.address, "b-plan", a.address);
  await h.service.join(c.address, "c-plan", b.address);
  expect(h.starts).toEqual([]);
  a.status = "idle";
  await h.emit(a, "turn_completed");
  expect(h.starts).toEqual([b.address]);
  await h.emit(a, "turn_completed");
  expect(h.starts).toEqual([b.address]);
  b.status = "idle";
  await h.emit(b, "turn_completed");
  expect(h.starts).toEqual([b.address, c.address]);
  c.status = "idle";
  await h.emit(c, "turn_completed");
  expect((await h.service.getState()).groups).toEqual([]);
  await h.service.close();
});

test("existing members receive current display names without changing their execution state", async () => {
  const a = agent("a", "claude", false);
  const b = agent("b", "codex");
  const h = harness([a, b]);
  await h.service.join(b.address, "b-plan", a.address);
  a.title = "Renamed implementation";
  b.title = "Ready plan workspace";
  b.host = "Mac Studio";
  const state = await h.service.getState();
  expect(
    state.groups[0].members.map(({ title, host, status }) => ({ title, host, status })),
  ).toEqual([
    { title: "Ready plan workspace", host: "Mac Studio", status: "queued" },
    { title: "Renamed implementation", host: "local", status: "running" },
  ]);
  expect(h.starts).toEqual([]);
  h.entries.delete(JSON.stringify(b.address));
  expect((await h.service.getState()).groups[0].members[0].title).toBe("Ready plan workspace");
  await h.service.close();
});

test("selecting two ready plans approves both, including Claude's blocked planning turn", async () => {
  const a = agent("a", "claude");
  const b = agent("b", "codex");
  const h = harness([a, b]);
  await h.service.join(a.address, "a-plan", b.address);
  expect(h.starts).toEqual([a.address]);
  expect(h.disk()[0].members.map((member) => member.status)).toEqual(["running", "queued"]);
  a.status = "idle";
  await h.emit(a, "turn_completed");
  expect(h.starts).toEqual([a.address, b.address]);
  await h.service.close();
});

test("manual pause lets the current turn finish but prevents the next plan from starting", async () => {
  const a = agent("a", "claude", false);
  const b = agent("b", "codex");
  const h = harness([a, b]);
  await h.service.join(b.address, "b-plan", a.address);
  await h.service.update(b.address, "pause");
  a.status = "idle";
  await h.emit(a, "turn_completed");
  expect(h.starts).toEqual([]);
  await h.service.update(b.address, "resume");
  expect(h.starts).toEqual([b.address]);
  await h.service.close();
});

test("a delayed snapshot from the approved plan does not pause the implementation", async () => {
  const a = agent("a", "claude");
  const oldPlan = structuredClone(a);
  const b = agent("b", "codex");
  const h = harness([a, b]);
  await h.service.join(a.address, "a-plan", b.address);
  const state = await h.emit(oldPlan, "snapshot");
  expect(state.groups[0].paused).toBe(false);
  expect(h.starts).toEqual([a.address]);
  await h.service.close();
});

test("a replaced plan loses its execution eligibility", async () => {
  const a = agent("a", "claude", false);
  const b = agent("b", "codex");
  const h = harness([a, b]);
  await h.service.join(b.address, "b-plan", a.address);
  b.plan = { id: "new-plan", hash: "new" };
  await h.emit(b, "permission_requested");
  a.status = "idle";
  const state = await h.emit(a, "turn_completed");
  expect(h.starts).toEqual([]);
  expect(state.groups[0].reason).toBe("plan_changed");
  expect(state.groups[0].members[0].status).toBe("invalid");
  await expect(h.service.update(b.address, "resume")).rejects.toThrow("invalid plan");
  await h.service.update(b.address, "leave");
  expect((await h.service.getState()).groups).toEqual([]);
  await h.service.close();
});

test("a question in a queued conversation pauses relay until the user resolves it", async () => {
  const a = agent("a", "claude", false);
  const b = agent("b", "codex");
  const h = harness([a, b]);
  await h.service.join(b.address, "b-plan", a.address);
  b.blocked = true;
  await h.emit(b, "permission_requested");
  a.status = "idle";
  const state = await h.emit(a, "turn_completed");
  expect(state.groups[0].reason).toBe("needs_input");
  expect(h.starts).toEqual([]);
  b.blocked = false;
  await h.service.update(b.address, "resume");
  expect(h.starts).toEqual([b.address]);
  await h.service.close();
});

test("a failed implementation pauses the group and can be removed without executing its successor", async () => {
  const a = agent("a", "claude", false);
  const b = agent("b", "codex");
  const h = harness([a, b]);
  await h.service.join(b.address, "b-plan", a.address);
  a.status = "error";
  const state = await h.emit(a, "turn_failed");
  expect(state.groups[0].reason).toBe("turn_failed");
  expect(h.starts).toEqual([]);
  await h.service.update(a.address, "leave");
  await h.service.update(b.address, "resume");
  expect(h.starts).toEqual([b.address]);
  await h.service.close();
});

test("restart retains intent but never replays an execution with an unknown outcome", async () => {
  const a = agent("a", "claude");
  const b = agent("b", "codex");
  const h = harness([a, b]);
  await h.service.join(a.address, "a-plan", b.address);
  const restored = harness([a, b], h.disk());
  await restored.service.start();
  expect((await restored.service.getState()).groups[0].reason).toBe("restart");
  expect(restored.starts).toEqual([]);
  a.status = "idle";
  await expect(restored.service.update(b.address, "resume")).rejects.toThrow("outcome is unknown");
  expect(restored.starts).toEqual([]);
  await restored.service.close();
  await h.service.close();
});

test("cannot combine groups that both own an implementation slot", async () => {
  const a = agent("a", "claude", false);
  const b = agent("b", "codex");
  const c = agent("c", "codex", false);
  const d = agent("d", "claude");
  const h = harness([a, b, c, d]);
  await h.service.join(b.address, "b-plan", a.address);
  await h.service.join(d.address, "d-plan", c.address);
  await expect(h.service.join(b.address, "b-plan", d.address)).rejects.toThrow("Both groups");
  expect((await h.service.getState()).groups).toHaveLength(2);
  expect(h.starts).toEqual([]);
  await h.service.close();
});

test("after restart a confirmed live execution can be observed without sending its plan again", async () => {
  const a = agent("a", "claude");
  const b = agent("b", "codex");
  const h = harness([a, b]);
  await h.service.join(a.address, "a-plan", b.address);
  const restored = harness([a, b], h.disk());
  await restored.service.start();
  await restored.service.update(b.address, "resume");
  expect(restored.starts).toEqual([]);
  a.status = "idle";
  await restored.emit(a, "turn_completed");
  expect(restored.starts).toEqual([b.address]);
  await restored.service.close();
  await h.service.close();
});

test.each(["claude", "codex"] as const)(
  "a %s planning turn without a finished plan is not a relay target",
  async (provider) => {
    const a = agent("a", provider);
    a.plan = null;
    const b = agent("b", "codex");
    const h = harness([a, b]);
    expect((await h.service.getState()).candidates.map((entry) => entry.address)).toEqual([
      b.address,
    ]);
    await expect(h.service.join(b.address, "b-plan", a.address)).rejects.toThrow(
      "no longer running",
    );
    expect(h.starts).toEqual([]);
    await h.service.close();
  },
);

test("a lost approval acknowledgement retains the slot without retrying or starting a successor", async () => {
  const a = agent("a", "claude");
  const b = agent("b", "codex");
  const h = harness([a, b]);
  const dispatch = h.port.start;
  h.port.start = async (destination, requestId) => {
    await dispatch(destination, requestId);
    throw new Error("connection lost after acceptance");
  };
  await h.service.join(a.address, "a-plan", b.address);
  expect(h.starts).toEqual([a.address]);
  expect(h.disk()[0].reason).toBe("dispatch_unknown");
  expect(h.disk()[0].members[0].status).toBe("starting");
  await h.service.getState();
  expect(h.starts).toEqual([a.address]);
  await h.service.close();
});
