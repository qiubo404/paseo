export const USAGE_REFRESH_INTERVAL_MS = 5 * 60_000;
export const USAGE_IDLE_TIMEOUT_MS = 10 * 60_000;

export interface UsageRefreshTarget {
  serverId: string;
  agentId?: string;
}

export function usageRefreshTargetKey(target: UsageRefreshTarget): string {
  return JSON.stringify([target.serverId, target.agentId ?? null]);
}

interface UsageRefreshSchedulerInput {
  now: () => number;
  readIdleMs: () => Promise<number | null>;
  canRefresh: (target: UsageRefreshTarget) => boolean;
  updatedAt: (target: UsageRefreshTarget) => number;
  fetch: (target: UsageRefreshTarget, force: boolean) => Promise<unknown>;
}

/** One owner for manual and automatic requests, including checks that finish after a tab switch. */
export function createUsageRefreshScheduler(input: UsageRefreshSchedulerInput) {
  const attempts = new Map<string, number>();
  const pending = new Map<string, Promise<void>>();

  function refresh(
    target: UsageRefreshTarget,
    options: { force?: boolean; verifyAccount?: boolean } = {},
  ): Promise<void> {
    const key = usageRefreshTargetKey(target);
    const existing = pending.get(key);
    if (existing) return existing;
    if (!input.canRefresh(target)) return Promise.resolve();
    const lastRead = Math.max(attempts.get(key) ?? 0, input.updatedAt(target));
    if (
      !options.force &&
      !options.verifyAccount &&
      input.now() - lastRead < USAGE_REFRESH_INTERVAL_MS
    )
      return Promise.resolve();

    async function run(): Promise<void> {
      if (!options.force) {
        const idleMs = await input.readIdleMs();
        if (idleMs !== null && idleMs >= USAGE_IDLE_TIMEOUT_MS) return undefined;
      }
      if (!input.canRefresh(target)) return undefined;
      attempts.set(key, input.now());
      try {
        await input.fetch(target, Boolean(options.force));
      } finally {
        // Failures also start a new interval: a failed request must not create a retry loop.
        attempts.set(key, input.now());
      }
      return undefined;
    }
    const request = run();
    pending.set(key, request);
    void request.finally(() => pending.delete(key)).catch(() => undefined);
    return request;
  }

  return { refresh };
}
