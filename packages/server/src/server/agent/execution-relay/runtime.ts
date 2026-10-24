import { createRelayHosts } from "./hosts.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import { RelayGroupSchema, type RelayAddress } from "@getpaseo/protocol/execution-relay";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../../atomic-file.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import { buildStoredAgentPayload, toAgentPayload } from "../agent-projections.js";
import { respondToAgentPermission } from "../permission-response.js";
import { createHostObservationResolver, type ToolHosts } from "../host-operations/index.js";
import { ExecutionRelayService, type RelayAgent, type RelayPort } from "./service.js";
import { resolveWorkspaceDisplayName, type WorkspaceRegistry } from "../../workspace-registry.js";

function project(
  snapshot: AgentSnapshotPayload,
  serverId: string,
  host: string,
  workspaceName?: string | null,
): RelayAgent {
  const plan = snapshot.pendingPermissions.find((request) => request.kind === "plan");
  return {
    address: { serverId, agentId: snapshot.id },
    title: snapshot.title?.trim() || workspaceName?.trim() || "",
    host,
    provider:
      snapshot.provider === "claude" || snapshot.provider === "codex" ? snapshot.provider : null,
    status: snapshot.status,
    turnId: snapshot.activeTurn?.turnId ?? null,
    archived: Boolean(snapshot.archivedAt),
    planning:
      snapshot.currentModeId === "plan" ||
      snapshot.features?.some((feature) => feature.id === "plan_mode" && feature.value === true) ===
        true,
    blocked: snapshot.pendingPermissions.some((request) => request.kind !== "plan"),
    plan: plan
      ? {
          id: plan.id,
          hash: createHash("sha256")
            .update(JSON.stringify([plan.metadata?.planText, plan.input]))
            .digest("hex"),
        }
      : null,
  };
}

export function createExecutionRelayRuntime(input: {
  serverId: string;
  paseoHome: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  workspaceRegistry: WorkspaceRegistry;
  hosts(): ToolHosts;
  logger: Logger;
}): ExecutionRelayService {
  const { serverId, agentManager, agentStorage, logger } = input;
  const hosts = createRelayHosts(input.paseoHome, input.hosts);
  async function projectLocal(snapshot: AgentSnapshotPayload, host: string): Promise<RelayAgent> {
    const workspace = snapshot.workspaceId
      ? await input.workspaceRegistry.get(snapshot.workspaceId)
      : null;
    return project(
      snapshot,
      serverId,
      host,
      workspace ? resolveWorkspaceDisplayName(workspace) : null,
    );
  }
  async function localSnapshot(agentId: string): Promise<AgentSnapshotPayload | null> {
    const record = await agentStorage.get(agentId);
    const agent = agentManager.getAgent(agentId);
    if (agent)
      return toAgentPayload(agent, { title: record?.title, archivedAt: record?.archivedAt });
    return record ? buildStoredAgentPayload(record, [record.provider]) : null;
  }
  const observation = createHostObservationResolver({
    serverId,
    hosts: () => hosts,
    local: {
      async wait() {
        throw new Error("Relay observation does not use idle waits");
      },
      async observe(agentId, handler, signal, onError) {
        const unsubscribe = agentManager.subscribe(
          (event) => {
            if (event.type !== "agent_state" && event.type !== "agent_stream") return;
            void localSnapshot(agentId)
              .then((snapshot) =>
                handler(snapshot, event.type === "agent_stream" ? event.event : undefined),
              )
              .catch(onError);
          },
          { agentId, replayState: false },
        );
        signal.addEventListener("abort", unsubscribe, { once: true });
        return async () => {
          signal.removeEventListener("abort", unsubscribe);
          unsubscribe();
        };
      },
    },
  });
  const port: RelayPort = {
    async list() {
      const directory = await hosts.directory();
      const agents: RelayAgent[] = [];
      const unavailableHosts: string[] = [];
      for (const agent of agentManager.listAgents()) {
        const snapshot = await localSnapshot(agent.id);
        if (snapshot) agents.push(await projectLocal(snapshot, directory.self.label));
      }
      await Promise.all(
        directory.hosts
          .filter((host) => host.enabled && host.serverId)
          .map(async (host) => {
            if (host.status !== "online") {
              unavailableHosts.push(host.label ?? host.serverId!);
              return;
            }
            try {
              await hosts.use(host.serverId!, async (client) => {
                let cursor: string | undefined;
                do {
                  const page = await client.fetchAgents({
                    filter: { includeArchived: false },
                    page: { limit: 100, cursor },
                  });
                  for (const entry of page.entries)
                    agents.push(
                      project(
                        entry.agent,
                        host.serverId!,
                        host.label ?? host.serverId!,
                        entry.project.workspaceName,
                      ),
                    );
                  cursor = page.pageInfo.hasMore
                    ? (page.pageInfo.nextCursor ?? undefined)
                    : undefined;
                } while (cursor);
              });
            } catch {
              unavailableHosts.push(host.label ?? host.serverId!);
            }
          }),
      );
      return { agents, unavailableHosts };
    },
    async inspect(address) {
      const directory = await hosts.directory();
      if (address.serverId === serverId) {
        const snapshot = await localSnapshot(address.agentId);
        return snapshot ? projectLocal(snapshot, directory.self.label) : null;
      }
      return hosts.use(address.serverId, async (client) => {
        const result = await client.fetchAgent(address.agentId);
        return result
          ? project(
              result.agent,
              address.serverId,
              directory.hosts.find((host) => host.serverId === address.serverId)?.label ?? "",
              result.project?.workspaceName,
            )
          : null;
      });
    },
    async observe(address, update, onError) {
      const controller = new AbortController();
      let ready!: () => void;
      let fail!: (error: unknown) => void;
      const opened = new Promise<void>((resolve, reject) => {
        ready = resolve;
        fail = reject;
      });
      void observation
        .use(
          address.serverId,
          async (host) => {
            const stop = await host.observe(
              address.agentId,
              (snapshot, event) =>
                update(snapshot ? project(snapshot, address.serverId, address.serverId) : null, {
                  type: event?.type ?? "snapshot",
                  turnId: event && "turnId" in event ? event.turnId : undefined,
                }),
              controller.signal,
              onError,
            );
            ready();
            try {
              await new Promise<void>((resolve) => {
                if (controller.signal.aborted) resolve();
                else controller.signal.addEventListener("abort", () => resolve(), { once: true });
              });
            } finally {
              await stop();
            }
          },
          controller.signal,
        )
        .catch((error) => {
          fail(error);
          if (!controller.signal.aborted) onError(error);
        });
      try {
        await opened;
      } catch (error) {
        controller.abort();
        throw error;
      }
      return () => controller.abort();
    },
    async start(address: RelayAddress, requestId: string) {
      const snapshot = await port.inspect(address);
      if (!snapshot?.plan || snapshot.plan.id !== requestId || !snapshot.provider)
        throw new Error("Plan is no longer available");
      const mode = snapshot.provider === "claude" ? "bypassPermissions" : "full-access";
      // Claude's plan approval normally enters acceptEdits. Setting the resume mode first
      // makes implement_resume explicitly preserve Bypass, including plans created in Always Ask.
      const response = {
        behavior: "allow" as const,
        selectedActionId: snapshot.provider === "claude" ? "implement_resume" : "implement",
      };
      if (address.serverId === serverId) {
        await agentManager.setAgentMode(address.agentId, mode);
        await respondToAgentPermission({
          agentManager,
          agentId: address.agentId,
          requestId,
          response,
          logger,
        });
      } else {
        await hosts.use(address.serverId, async (client) => {
          await client.setAgentMode(address.agentId, mode);
          await client.respondToPermissionAndWait(address.agentId, requestId, response);
        });
      }
    },
  };
  const file = join(input.paseoHome, "execution-relay.json");
  return new ExecutionRelayService({
    port,
    store: {
      async load() {
        try {
          return z.array(RelayGroupSchema).parse(JSON.parse(await readFile(file, "utf8")));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
      },
      save: (groups) => writeJsonFileAtomic(file, groups),
    },
    onError: (err) => logger.error({ err }, "Execution relay update failed"),
  });
}
