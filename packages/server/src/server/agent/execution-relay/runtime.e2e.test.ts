import { writeJsonFileAtomic } from "../../atomic-file.js";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../../test-utils/daemon-test-context.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import type { AgentPromptInput } from "../agent-sdk-types.js";
import { createPaseoApi } from "@getpaseo/client";

const contexts: DaemonTestContext[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const ctx of contexts.splice(0).toReversed()) await ctx.cleanup();
}, 60_000);

async function context() {
  const gate = Promise.withResolvers<void>();
  releases.push(() => gate.resolve());
  const ctx = await createDaemonTestContext({
    agentClients: createTestAgentClients({
      beforeTurnComplete: async (prompt: AgentPromptInput) => {
        if (prompt === "relay implementation") await gate.promise;
      },
    }),
  });
  contexts.push(ctx);
  return { ...ctx, release: () => gate.resolve() };
}

async function plan(ctx: DaemonTestContext, provider: "claude" | "codex", title: string) {
  const created = await ctx.client.createAgent({
    provider,
    cwd: ctx.daemon.paseoHome,
    title,
    modeId: "default",
  });
  const managed = ctx.daemon.daemon.agentManager.getAgent(created.id);
  if (!managed || !("session" in managed)) throw new Error("Expected a live provider session");
  const request = {
    id: `${created.id}-plan`,
    provider,
    kind: "plan" as const,
    name: "TestPlan",
    input: { plan: title },
  };
  // The provider test adapter supplies a deferred approval; the real daemon, SDK,
  // host routing, store, mode commands, subscriptions and execution pipeline remain in use.
  let pending = [request];
  managed.session.getPendingPermissions = () => pending;
  managed.session.respondToPermission = async () => {
    pending = [];
    return { followUpPrompt: "relay implementation" };
  };
  managed.pendingPermissions.set(request.id, request);
  ctx.daemon.daemon.agentManager.notifyAgentState(created.id);
  return { created, request, managed };
}

test.each(["routed", "direct"] as const)(
  "real WebSocket RPC joins two plans across daemons using %s and starts them one at a time with Full Access",
  async (transport) => {
    const local = await context();
    const remote = await context();
    const localId = (await local.client.listHosts()).self.serverId;
    const remoteId = (await remote.client.listHosts()).self.serverId;
    if (transport === "direct") {
      await writeJsonFileAtomic(join(local.daemon.paseoHome, "execution-relay-hosts.json"), [
        { serverId: remoteId, label: "Remote", connection: `127.0.0.1:${remote.daemon.port}` },
      ]);
    } else {
      await createPaseoApi(local.client).hosts.add({
        connection: `127.0.0.1:${remote.daemon.port}`,
      });
      await expect
        .poll(async () => (await local.client.listHosts()).hosts[0]?.status)
        .toBe("online");
    }
    const a = await plan(local, "claude", "Claude implementation");
    const b = await plan(remote, "codex", "Codex implementation");
    const state = await local.client.joinExecutionRelay(
      { serverId: localId, agentId: a.created.id },
      a.request.id,
      { serverId: remoteId, agentId: b.created.id },
    );
    expect(state.groups[0].members.map((entry) => entry.status)).toEqual(["running", "queued"]);
    expect(await a.managed.session.getCurrentMode()).toBe("bypassPermissions");
    expect(await b.managed.session.getCurrentMode()).toBe("default");
    local.release();
    await expect
      .poll(async () => {
        const group = (await local.client.getExecutionRelayState()).groups[0];
        return { statuses: group?.members.map((entry) => entry.status), reason: group?.reason };
      })
      .toEqual({ statuses: ["completed", "running"], reason: null });
    expect(await b.managed.session.getCurrentMode()).toBe("full-access");
    remote.release();
    await expect.poll(async () => (await local.client.getExecutionRelayState()).groups).toEqual([]);
  },
  60_000,
);

test("relay RPC rejects an obsolete plan without approving either conversation", async () => {
  const ctx = await context();
  const serverId = (await ctx.client.listHosts()).self.serverId;
  const a = await plan(ctx, "claude", "Current plan");
  const b = await plan(ctx, "codex", "Other plan");
  await expect(
    ctx.client.joinExecutionRelay({ serverId, agentId: a.created.id }, "obsolete-plan", {
      serverId,
      agentId: b.created.id,
    }),
  ).rejects.toThrow("no longer available");
  expect((await ctx.client.getExecutionRelayState()).groups).toEqual([]);
  expect(await a.managed.session.getCurrentMode()).toBe("default");
  expect(await b.managed.session.getCurrentMode()).toBe("default");
}, 30_000);

test("local relay uses workspace names when agent titles are absent and refreshes existing members", async () => {
  const ctx = await context();
  const serverId = (await ctx.client.listHosts()).self.serverId;
  const a = await plan(ctx, "claude", "Initial title");
  const b = await plan(ctx, "codex", "Other plan");
  const record = await ctx.daemon.daemon.agentStorage.get(a.created.id);
  if (!record || !record.workspaceId) throw new Error("Expected a persisted workspace");
  await ctx.daemon.daemon.agentStorage.upsert({ ...record, title: null });
  await ctx.client.setWorkspaceTitle(record.workspaceId, "Ready workspace");
  const candidates = (await ctx.client.getExecutionRelayState()).candidates;
  expect(candidates.find((entry) => entry.address.agentId === a.created.id)?.title).toBe(
    "Ready workspace",
  );
  const state = await ctx.client.joinExecutionRelay(
    { serverId, agentId: a.created.id },
    a.request.id,
    { serverId, agentId: b.created.id },
  );
  expect(state.groups[0].members[0].title).toBe("Ready workspace");
  await ctx.client.setWorkspaceTitle(record.workspaceId, "Renamed workspace");
  const refreshed = (await ctx.client.getExecutionRelayState()).groups[0];
  expect(refreshed.members[0].title).toBe("Renamed workspace");
  expect(refreshed.members.map((entry) => entry.status)).toEqual(["running", "queued"]);
  expect(refreshed.members[0].host).not.toBe(serverId);
}, 30_000);
