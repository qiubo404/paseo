import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createHostClient } from "@getpaseo/client/node";
import type { HostSummary } from "@getpaseo/protocol/hosts";
import type { ToolHosts } from "../host-operations/index.js";

const peersSchema = z.array(
  z.object({ serverId: z.string().min(1), label: z.string(), connection: z.string().min(1) }),
);
type Peer = z.infer<typeof peersSchema>[number];

/** Relay is coordinator-owned: direct peers use ordinary RPCs without requiring a remote routing upgrade. */
export function createRelayHosts(paseoHome: string, base: () => ToolHosts): ToolHosts {
  const health = new Map<string, { status: "online" | "offline"; checked: number }>();
  async function peers(): Promise<Peer[]> {
    try {
      return peersSchema.parse(
        JSON.parse(await readFile(join(paseoHome, "execution-relay-hosts.json"), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Could not read relay host configuration", { cause: error });
    }
  }
  async function withPeer<T>(
    peer: Peer,
    action: (client: DaemonClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const client = createHostClient(peer.connection, {
      clientId: `relay-${randomUUID()}`,
      connectTimeoutMs: 5000,
      reconnect: { enabled: false },
    });
    const close = () => {
      void client.close();
    };
    signal?.addEventListener("abort", close, { once: true });
    try {
      signal?.throwIfAborted();
      await client.connect();
      if (client.getLastServerInfoMessage()?.serverId !== peer.serverId)
        throw new Error("Relay host identity changed");
      health.set(peer.serverId, { status: "online", checked: Date.now() });
      return await action(client);
    } catch (error) {
      health.set(peer.serverId, { status: "offline", checked: Date.now() });
      throw new Error("Relay host is unavailable", { cause: error });
    } finally {
      signal?.removeEventListener("abort", close);
      await client.close();
    }
  }
  return {
    async use(serverId, action, signal) {
      const peer = (await peers()).find((entry) => entry.serverId === serverId);
      if (peer) return withPeer(peer, action, signal);
      return base().use(serverId, action, signal);
    },
    async directory() {
      const directory = await base().directory();
      const configured = (await peers()).filter(
        (peer) => peer.serverId !== directory.self.serverId,
      );
      const direct = await Promise.all(
        configured.map(async (peer): Promise<HostSummary> => {
          if (Date.now() - (health.get(peer.serverId)?.checked ?? 0) > 30000) {
            await withPeer(peer, async () => undefined).catch(() => undefined);
          }
          return {
            registrationId: `relay:${peer.serverId}`,
            serverId: peer.serverId,
            label: peer.label,
            source: { id: "execution-relay", key: peer.serverId },
            metadata: {},
            enabled: true,
            status: health.get(peer.serverId)?.status ?? "offline",
            targetDescription: "Relay direct connection",
            lastOnlineAt: null,
            nextRetryAt: null,
            error: null,
          };
        }),
      );
      const identities = new Set(direct.map((peer) => peer.serverId));
      return {
        ...directory,
        hosts: [...directory.hosts.filter((peer) => !identities.has(peer.serverId)), ...direct],
      };
    },
  };
}
