import { randomUUID } from "node:crypto";
import type {
  RelayAddress,
  RelayGroup,
  RelayMember,
  RelayState,
} from "@getpaseo/protocol/execution-relay";

export interface RelayAgent {
  address: RelayAddress;
  title: string;
  host: string;
  provider: "claude" | "codex" | null;
  status: string;
  turnId: string | null;
  plan: { id: string; hash: string } | null;
  planning: boolean;
  blocked: boolean;
  archived: boolean;
}
export interface RelayEvent {
  type: string;
  turnId?: string | null;
}
export interface RelayPort {
  list(): Promise<{ agents: RelayAgent[]; unavailableHosts: string[] }>;
  inspect(address: RelayAddress): Promise<RelayAgent | null>;
  observe(
    address: RelayAddress,
    update: (agent: RelayAgent | null, event: RelayEvent) => void,
    error: (error: unknown) => void,
  ): Promise<() => void>;
  start(address: RelayAddress, requestId: string): Promise<void>;
}
export interface RelayStore {
  load(): Promise<RelayGroup[]>;
  save(groups: RelayGroup[]): Promise<void>;
}
export function relayKey(address: RelayAddress): string {
  return JSON.stringify([address.serverId, address.agentId]);
}
const active = (member: RelayMember) => member.status === "running" || member.status === "starting";
const terminal = (member: RelayMember) =>
  member.status === "completed" || member.status === "canceled";
const implementing = (agent: RelayAgent) =>
  agent.status === "running" && !agent.plan && !agent.planning && !agent.archived;
function candidate(agent: RelayAgent): boolean {
  return agent.provider !== null && !agent.archived && (agent.plan !== null || implementing(agent));
}
function addMember(members: RelayMember[], agent: RelayAgent): void {
  const found = members.find((member) => relayKey(member.address) === relayKey(agent.address));
  if (found && !terminal(found)) return;
  if (found) members.splice(members.indexOf(found), 1);
  members.push({
    address: agent.address,
    title: agent.title,
    host: agent.host,
    provider: agent.provider!,
    status: agent.plan ? "queued" : "running",
    planRequestId: agent.plan?.id ?? null,
    planHash: agent.plan?.hash ?? null,
    turnId: agent.plan ? null : agent.turnId,
  });
}

/** One durable execution slot per group. Provider approval is deferred until the slot is owned. */
export class ExecutionRelayService {
  private groups: RelayGroup[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private observers = new Map<string, () => void>();
  private lostObservers = new Set<string>();
  private closed = false;
  private initialized: Promise<void> | null = null;
  constructor(
    private readonly deps: { port: RelayPort; store: RelayStore; onError(error: unknown): void },
  ) {}

  start(): Promise<void> {
    return (this.initialized ??= (async () => {
      this.groups = await this.deps.store.load();
      // A lost dispatch acknowledgement is not permission to replay an implementation.
      for (const group of this.groups) {
        group.paused = true;
        group.reason = "restart";
      }
      await this.save();
      // Restored groups require an explicit resume. Opening remote observations
      // here would make an unreachable host block daemon startup.
    })());
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    await this.start();
    const result = this.tail.then(async () => {
      if (this.closed) throw new Error("Execution relay is shutting down");
      const value = await operation();
      await this.save();
      await this.watch();
      await this.advance();
      return value;
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  async getState(): Promise<RelayState> {
    await this.start();
    await this.tail;
    const { agents, unavailableHosts } = await this.deps.port.list();
    const displayAgents = new Map(agents.map((agent) => [relayKey(agent.address), agent]));
    const missing = new Map(
      this.groups
        .flatMap((group) => group.members)
        .filter((member) => !displayAgents.has(relayKey(member.address)))
        .map((member) => [relayKey(member.address), member.address]),
    );
    await Promise.all(
      [...missing.values()].map(async (address) => {
        // A disconnected member keeps its last known display information.
        const agent = await this.deps.port.inspect(address).catch(() => null);
        if (agent) displayAgents.set(relayKey(address), agent);
      }),
    );
    // Metadata refreshes share the mutation queue, but never advance the scheduler.
    const refreshed = this.tail.then(async () => {
      let changed = false;
      for (const group of this.groups)
        for (const member of group.members) {
          const agent = displayAgents.get(relayKey(member.address));
          if (!agent || (member.title === agent.title && member.host === agent.host)) continue;
          member.title = agent.title;
          member.host = agent.host;
          changed = true;
        }
      if (changed) await this.save();
      return structuredClone(this.groups);
    });
    this.tail = refreshed.catch(() => undefined);
    const eligible = new Map(
      agents.filter(candidate).map((agent) => [relayKey(agent.address), agent]),
    );
    return {
      groups: await refreshed,
      candidates: [...eligible.values()].map((agent) => ({
        address: agent.address,
        title: agent.title,
        host: agent.host,
        provider: agent.provider!,
        state: agent.plan ? "plan" : "running",
      })),
      unavailableHosts: [...new Set(unavailableHosts)],
    };
  }

  async join(source: RelayAddress, planRequestId: string, target: RelayAddress): Promise<void> {
    await this.mutate(async () => {
      if (relayKey(source) === relayKey(target)) throw new Error("Choose a different conversation");
      const [from, to] = await Promise.all([
        this.deps.port.inspect(source),
        this.deps.port.inspect(target),
      ]);
      if (!from || !candidate(from) || from.plan?.id !== planRequestId)
        throw new Error("The current plan is no longer available");
      if (!to || !candidate(to))
        throw new Error("The selected conversation is no longer running or awaiting plan approval");
      const existing = this.groups.filter((group) =>
        group.members.some(
          (member) =>
            member.status !== "canceled" &&
            [relayKey(source), relayKey(target)].includes(relayKey(member.address)),
        ),
      );
      const members = existing.flatMap((group) => structuredClone(group.members));
      for (const agent of [from, to]) addMember(members, agent);
      await this.assertSingleExecution(members);
      const paused = existing.some((group) => group.paused);
      this.groups = this.groups.filter((group) => !existing.includes(group));
      this.groups.push({
        id: existing[0]?.id ?? randomUUID(),
        members,
        paused: paused || from.blocked || to.blocked,
        reason:
          from.blocked || to.blocked
            ? "needs_input"
            : (existing.find((group) => group.reason)?.reason ?? null),
      });
    });
  }

  private async assertSingleExecution(members: RelayMember[]): Promise<void> {
    let running = 0;
    for (const member of members.filter((entry) => !terminal(entry))) {
      const snapshot = await this.deps.port.inspect(member.address);
      if (active(member) || (snapshot && implementing(snapshot))) running++;
    }
    if (running > 1)
      throw new Error("Both groups have an active implementation; wait before combining them");
  }

  async update(address: RelayAddress, action: "pause" | "resume" | "leave"): Promise<void> {
    await this.mutate(async () => {
      const group = this.findGroup(address);
      if (!group) throw new Error("The relay group has already finished");
      const member = group.members.find((entry) => relayKey(entry.address) === relayKey(address))!;
      if (action === "leave") {
        if (active(member))
          throw new Error("Wait for the current implementation to finish before leaving");
        member.status = "canceled";
      } else if (action === "pause") {
        this.pause(group, "manual");
      } else {
        for (const entry of group.members.filter((item) => !terminal(item))) {
          const snapshot = await this.deps.port.inspect(entry.address);
          if (!snapshot || snapshot.archived) throw new Error("A conversation is unavailable");
          if (entry.status === "invalid")
            throw new Error("Remove the invalid plan and select relay again");
          if (entry.status === "queued" && !this.matchesPlan(entry, snapshot))
            throw new Error("A queued plan has changed; select relay again");
          if (
            active(entry) &&
            (!implementing(snapshot) || (entry.turnId && entry.turnId !== snapshot.turnId))
          )
            throw new Error(
              "The previous execution outcome is unknown; it cannot be replayed automatically",
            );
          if (snapshot.blocked)
            throw new Error("Resolve the conversation's pending question or permission first");
          if (active(entry)) {
            entry.status = "running";
            entry.turnId = snapshot.turnId;
          }
        }
        group.paused = false;
        group.reason = null;
        for (const entry of group.members) this.lostObservers.delete(relayKey(entry.address));
      }
    });
  }

  private findGroup(address: RelayAddress): RelayGroup | undefined {
    return this.groups.find((group) =>
      group.members.some(
        (member) => member.status !== "canceled" && relayKey(member.address) === relayKey(address),
      ),
    );
  }
  private matchesPlan(member: RelayMember, agent: RelayAgent): boolean {
    return (
      agent.plan !== null &&
      member.planRequestId === agent.plan.id &&
      member.planHash === agent.plan.hash
    );
  }
  private pause(group: RelayGroup, reason: string): void {
    group.paused = true;
    group.reason = reason;
  }

  private async changed(
    address: RelayAddress,
    agent: RelayAgent | null,
    event: RelayEvent,
  ): Promise<void> {
    await this.mutate(async () => {
      const group = this.findGroup(address);
      const member = group?.members.find((entry) => relayKey(entry.address) === relayKey(address));
      if (!group || !member || terminal(member)) return;
      if (this.applyFailure(group, member, event)) return;
      if (!agent || agent.archived || agent.status === "closed" || agent.status === "error") {
        this.pause(group, "unavailable");
        return;
      }
      if (agent.blocked) {
        this.pause(group, "needs_input");
        return;
      }
      if (member.status === "queued") {
        if (!this.matchesPlan(member, agent)) {
          member.status = "invalid";
          this.pause(group, "plan_changed");
        }
        return;
      }
      if (active(member)) this.applyExecutionEvent(group, member, agent, event);
    });
  }

  private applyFailure(group: RelayGroup, member: RelayMember, event: RelayEvent): boolean {
    if (!active(member) || (event.type !== "turn_canceled" && event.type !== "turn_failed"))
      return false;
    if (member.turnId && event.turnId && member.turnId !== event.turnId) return true;
    member.status = "invalid";
    this.pause(group, event.type);
    return true;
  }

  private applyExecutionEvent(
    group: RelayGroup,
    member: RelayMember,
    agent: RelayAgent,
    event: RelayEvent,
  ): void {
    // Mode changes publish a snapshot before approval is released. That checkpoint
    // can arrive after dispatch acknowledgement; it is the plan we just approved.
    if (agent.plan?.id === member.planRequestId) return;
    if (agent.blocked || agent.plan) {
      this.pause(group, "needs_input");
      return;
    }
    if (event.type === "turn_started") {
      if (member.turnId && member.turnId !== agent.turnId) this.pause(group, "unexpected_turn");
      else member.turnId = agent.turnId;
    }
    if (event.type !== "turn_completed") return;
    if (member.turnId && event.turnId && member.turnId !== event.turnId) return;
    if (agent.status === "running") {
      this.pause(group, "unexpected_turn");
      return;
    }
    member.status = "completed";
  }

  private async watch(): Promise<void> {
    const wanted = new Set<string>();
    for (const group of this.groups)
      for (const member of group.members.filter((entry) => !terminal(entry))) {
        const key = relayKey(member.address);
        wanted.add(key);
        if (this.observers.has(key) || this.lostObservers.has(key)) continue;
        try {
          const stop = await this.deps.port.observe(
            member.address,
            (agent, event) => {
              if (!this.closed)
                void this.changed(member.address, agent, event).catch(this.deps.onError);
            },
            () => {
              if (!this.closed) void this.observationLost(member.address).catch(this.deps.onError);
            },
          );
          this.observers.set(key, stop);
        } catch {
          this.lostObservers.add(key);
          this.pause(group, "connection_lost");
          await this.save();
        }
      }
    for (const [key, stop] of this.observers)
      if (!wanted.has(key)) {
        stop();
        this.observers.delete(key);
      }
    for (const key of this.lostObservers) if (!wanted.has(key)) this.lostObservers.delete(key);
  }

  private async observationLost(address: RelayAddress): Promise<void> {
    await this.mutate(async () => {
      const key = relayKey(address);
      this.lostObservers.add(key);
      const stop = this.observers.get(key);
      this.observers.delete(key);
      stop?.();
      const group = this.findGroup(address);
      if (group) this.pause(group, "connection_lost");
    });
  }

  private async advance(): Promise<void> {
    if (this.closed) return;
    this.groups = this.groups.filter((group) => !group.members.every(terminal));
    for (const group of this.groups) {
      if (group.paused || group.members.some(active)) continue;
      const next = group.members.find((member) => member.status === "queued");
      if (!next) continue;
      try {
        // Check all members, including completed ones, before granting the slot.
        for (const member of group.members) {
          const snapshot = await this.deps.port.inspect(member.address);
          if (snapshot && implementing(snapshot))
            throw new Error("An implementation is already active");
        }
        const snapshot = await this.deps.port.inspect(next.address);
        if (!snapshot || !this.matchesPlan(next, snapshot)) {
          next.status = "invalid";
          this.pause(group, "plan_changed");
          continue;
        }
        if (snapshot.blocked) {
          this.pause(group, "needs_input");
          continue;
        }
        next.status = "starting";
        // Claude continues the blocked turn; Codex starts a new turn after approval.
        next.turnId = next.provider === "claude" ? snapshot.turnId : null;
        await this.save();
        await this.deps.port.start(next.address, next.planRequestId!);
        next.status = "running";
        const started = await this.deps.port.inspect(next.address);
        next.turnId = started?.turnId ?? next.turnId;
      } catch {
        // The destination may have accepted approval. Retain the slot until its outcome is known.
        this.pause(group, "dispatch_unknown");
      }
    }
    await this.save();
    await this.watch();
  }

  private async save(): Promise<void> {
    try {
      await this.deps.store.save(this.groups);
    } catch (error) {
      for (const group of this.groups) this.pause(group, "storage_error");
      throw error;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const stop of this.observers.values()) stop();
    this.observers.clear();
    await this.tail;
  }
}
