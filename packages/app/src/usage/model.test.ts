import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  resolveUsageReport,
  enabledHostUsageReports,
  displayPercent,
  resolveAgentUsageView,
  replaceReport,
  resolveUsageRefresh,
  resolveUsageHostId,
  resolveUsageModalHostId,
  resolveUsageView,
  settleReports,
  upsertReport,
  usageWindowRowLabel,
  type UsageHost,
  type UsageQueryState,
} from "./model";
import type { UsageReportEntry, UsageWindow } from "./types";
import {
  createUsageRefreshScheduler,
  USAGE_IDLE_TIMEOUT_MS,
  USAGE_REFRESH_INTERVAL_MS,
  type UsageRefreshTarget,
} from "./refresh-scheduler";

describe("sidebar usage refresh scheduling", () => {
  const local = { serverId: "local", agentId: "a" };
  const other = { serverId: "remote", agentId: "a" };

  function setup() {
    const state = {
      now: 1_000_000,
      idleMs: 0 as number | null,
      eligible: true,
      updatedAt: 0,
      idleRead: () => Promise.resolve(state.idleMs),
      fetch: async (_target: UsageRefreshTarget, _force: boolean) => {},
    };
    const calls: Array<{ target: UsageRefreshTarget; force: boolean }> = [];
    const scheduler = createUsageRefreshScheduler({
      now: () => state.now,
      readIdleMs: () => state.idleRead(),
      canRefresh: () => state.eligible,
      updatedAt: () => state.updatedAt,
      fetch: async (target, force) => {
        calls.push({ target, force });
        await state.fetch(target, force);
      },
    });
    return { state, calls, ...scheduler };
  }

  it("shares one read for both windows and polls only after five minutes", async () => {
    const { state, calls, refresh } = setup();
    await refresh(local);
    state.now += USAGE_REFRESH_INTERVAL_MS - 1;
    await refresh(local);
    expect(calls).toHaveLength(1);
    state.now += 1;
    await refresh(local);
    expect(calls).toEqual([
      { target: local, force: false },
      { target: local, force: false },
    ]);
  });

  it("pauses while backgrounded, offline, unfocused, or idle, then resumes when due", async () => {
    const { state, calls, refresh } = setup();
    state.eligible = false;
    await refresh(local);
    state.eligible = true;
    state.idleMs = USAGE_IDLE_TIMEOUT_MS;
    await refresh(local);
    expect(calls).toHaveLength(0);
    state.idleMs = 0;
    await refresh(local);
    state.eligible = false;
    state.now += USAGE_REFRESH_INTERVAL_MS;
    await refresh(local);
    expect(calls).toHaveLength(1);
    state.eligible = true;
    await refresh(local);
    expect(calls).toHaveLength(2);
  });

  it("does not force-refresh on return to the foreground inside the interval", async () => {
    const { state, calls, refresh } = setup();
    await refresh(local);
    for (let i = 0; i < 4; i++) {
      state.eligible = false;
      await refresh(local);
      state.eligible = true;
      state.now += 10_000;
      await refresh(local);
    }
    expect(calls).toHaveLength(1);
  });

  it("joins manual and automatic reads in flight, and manual success resets the interval", async () => {
    const { state, calls, refresh } = setup();
    let finish!: () => void;
    state.fetch = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const pending = refresh(local);
    const manual = refresh(local, { force: true });
    expect(manual).toBe(pending);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    finish();
    await pending;
    state.fetch = async () => {};
    state.now += 60_000;
    await refresh(local, { force: true });
    expect(calls.at(-1)?.force).toBe(true);
    state.now += USAGE_REFRESH_INTERVAL_MS - 1;
    await refresh(local);
    expect(calls).toHaveLength(2);
  });

  it("backs off failures for a full interval while preserving a manual retry", async () => {
    const { state, calls, refresh } = setup();
    state.fetch = async () => {
      throw new Error("rate limited");
    };
    await expect(refresh(local)).rejects.toThrow("rate limited");
    for (let i = 0; i < 4; i++) {
      state.now += 60_000;
      await refresh(local);
    }
    expect(calls).toHaveLength(1);
    state.fetch = async () => {};
    await refresh(local, { force: true });
    expect(calls).toHaveLength(2);
  });

  it("isolates hosts and accounts, and verifies the account when switching chats", async () => {
    const { calls, refresh } = setup();
    await refresh(local);
    await refresh(other);
    await refresh({ serverId: "local", agentId: "b" });
    await refresh(local, { verifyAccount: true });
    expect(calls.map((call) => call.target)).toEqual([
      local,
      other,
      { serverId: "local", agentId: "b" },
      local,
    ]);
  });

  it("reuses a newer shared result and checks eligibility again after asynchronous idle detection", async () => {
    const { state, calls, refresh } = setup();
    state.updatedAt = state.now;
    await refresh(local);
    expect(calls).toHaveLength(0);
    state.now += USAGE_REFRESH_INTERVAL_MS;
    let finish!: (value: number) => void;
    state.idleRead = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = refresh(local);
    await Promise.resolve();
    state.eligible = false;
    finish(0);
    await pending;
    expect(calls).toHaveLength(0);
  });
});

describe("enabledHostUsageReports", () => {
  it("collapses identical Claude session and weekly quotas, preferring the labeled account", () => {
    const anonymous = claudeEntry("temporary");
    const labeled = { ...claudeEntry("account.org"), account: { label: "owner@example.test" } };
    const codex = entry({ sourceId: "codex" });
    expect(enabledHostUsageReports([anonymous, codex, labeled], {})).toEqual([labeled, codex]);
    expect(enabledHostUsageReports([labeled, anonymous], {})).toEqual([labeled]);
    expect(anonymous.account).toEqual({});
  });

  it.each(["five_hour", "weekly"])("keeps different %s percentages and reset timestamps", (id) => {
    const original = claudeEntry("one");
    for (const change of [{ usedPct: 50 }, { resetsAt: "2026-10-29T16:00:00Z" }]) {
      const different = claudeEntry("two");
      if (different.report.status !== "available") throw new Error("Expected available usage");
      different.report.windows = different.report.windows.map((window) =>
        window.id === id ? { ...window, ...change } : window,
      );
      expect(enabledHostUsageReports([original, different], {})).toEqual([original, different]);
    }
  });

  it("preserves conflicting account labels even when quotas match", () => {
    const first = { ...claudeEntry("one"), account: { label: "first@example.test" } };
    const second = { ...claudeEntry("two"), account: { label: "second@example.test" } };
    expect(enabledHostUsageReports([first, second], {})).toEqual([first, second]);
  });

  it("merges sub-second reset drift across a minute boundary but preserves different reset times", () => {
    const labeled = { ...claudeEntry("account.org"), account: { label: "owner@example.test" } };
    const anonymous = claudeEntry("temporary");
    if (labeled.report.status !== "available" || anonymous.report.status !== "available")
      throw new Error("Expected available usage");
    labeled.report.windows = labeled.report.windows.map((window) => ({
      ...window,
      resetsAt: "2026-10-26T14:49:59.947796+00:00",
    }));
    anonymous.report.windows = anonymous.report.windows.map((window) => ({
      ...window,
      resetsAt: "2026-10-26T14:50:00.297445+00:00",
    }));
    expect(enabledHostUsageReports([labeled, anonymous], {})).toEqual([labeled]);
    anonymous.report.windows[0]!.resetsAt = "2026-10-26T14:50:01.947796+00:00";
    expect(enabledHostUsageReports([labeled, anonymous], {})).toEqual([labeled, anonymous]);
  });

  it("keeps incomplete, failed, and differently scoped quotas visible", () => {
    const original = claudeEntry("one");
    const incomplete = claudeEntry("incomplete");
    if (incomplete.report.status !== "available") throw new Error("Expected available usage");
    incomplete.report.windows = [{ id: "weekly", label: "Weekly", usedPct: 27 }];
    const scoped = claudeEntry("scoped");
    if (scoped.report.status !== "available") throw new Error("Expected available usage");
    scoped.report.windows.push({ id: "weekly_model", label: "Weekly model", usedPct: 10 });
    const failed: UsageReportEntry = {
      ...claudeEntry("failed"),
      report: { status: "error", error: "Unavailable" },
    };
    const reports = [original, incomplete, scoped, failed];
    expect(enabledHostUsageReports(reports, {})).toEqual(reports);
  });

  it("retains the newer copy and keeps hosts and other sources independent", () => {
    const older = claudeEntry("old");
    const newer = { ...claudeEntry("new"), fetchedAt: "2026-10-26T12:00:00Z" };
    expect(enabledHostUsageReports([older, newer], {})).toEqual([newer]);
    expect(enabledHostUsageReports([older], {})).toEqual([older]);
    expect(enabledHostUsageReports([newer], {})).toEqual([newer]);
    const codex = [
      { ...older, sourceId: "codex", id: "codex:one" },
      { ...newer, sourceId: "codex", id: "codex:two" },
    ];
    expect(enabledHostUsageReports(codex, {})).toEqual(codex);
  });

  it("hides explicitly disabled providers while preserving enabled and standalone sources", () => {
    const cursor = entry({ sourceId: "cursor" });
    const codex = entry({ sourceId: "codex" });
    const standalone = entry({ sourceId: "subscription" });
    expect(
      enabledHostUsageReports([cursor, codex, standalone], { cursor: { enabled: false } }),
    ).toEqual([codex, standalone]);
    expect(enabledHostUsageReports([cursor, codex], { cursor: { enabled: true } })).toEqual([
      cursor,
      codex,
    ]);
    expect(enabledHostUsageReports([cursor], { cursor: {} })).toEqual([cursor]);
  });

  it("keeps each host's disabled-provider policy separate without deleting cached reports", () => {
    const reports = [entry({ sourceId: "cursor" })];
    expect(enabledHostUsageReports(reports, { cursor: { enabled: false } })).toEqual([]);
    expect(enabledHostUsageReports(reports, {})).toEqual(reports);
    expect(reports).toHaveLength(1);
  });
});

function claudeEntry(account: string): UsageReportEntry {
  return {
    ...entry({
      sourceId: "claude",
      planLabel: "Pro",
      windows: [
        { id: "five_hour", label: "Session", usedPct: 97, resetsAt: "2026-10-26T16:00:00Z" },
        { id: "weekly", label: "Weekly", usedPct: 27, resetsAt: "2026-10-28T16:00:00Z" },
      ],
    }),
    id: `claude:${account}`,
  };
}

function entry(input: {
  windows?: UsageWindow[];
  planLabel?: string;
  icon?: string;
  sourceId?: string;
}): UsageReportEntry {
  return {
    id: `${input.sourceId ?? "fixture"}:account-1`,
    account: {},
    fetchedAt: "2026-01-01T00:00:00.000Z",
    sourceId: input.sourceId ?? "fixture",
    sourceLabel: "Fixture source",
    ...(input.icon ? { icon: input.icon } : {}),
    report: {
      status: "available",
      ...(input.planLabel ? { planLabel: input.planLabel } : {}),
      windows: input.windows ?? [],
    },
  };
}

function ready(data: UsageReportEntry[]): UsageQueryState {
  return { data, error: null, isFetching: false };
}

describe("resolveUsageView", () => {
  it("asks for a host update when the host lacks usage sources", () => {
    expect(
      resolveUsageView({
        hostLabel: "Laptop",
        isConnected: true,
        supportsUsage: false,
        query: ready([entry({})]),
      }),
    ).toEqual({ kind: "unavailable", message: "Update Laptop to see usage" });
  });

  it("asks for a connection before anything else", () => {
    expect(
      resolveUsageView({
        hostLabel: "Laptop",
        isConnected: false,
        supportsUsage: false,
        query: undefined,
      }),
    ).toEqual({ kind: "unavailable", message: "Connect to Laptop to see usage" });
  });

  it("localizes unavailable host messages while retaining the host name", async () => {
    await i18n.changeLanguage("ko");
    expect(
      resolveUsageView({
        hostLabel: "Laptop",
        isConnected: false,
        supportsUsage: false,
        query: undefined,
      }),
    ).toEqual({ kind: "unavailable", message: "Laptop에 연결하여 제공업체 사용량을 확인하세요" });
  });

  it("moves from loading to ready to error", () => {
    const base = { hostLabel: "Laptop", isConnected: true, supportsUsage: true };
    expect(resolveUsageView({ ...base, query: undefined })).toEqual({ kind: "loading" });
    expect(
      resolveUsageView({ ...base, query: { data: [], error: null, isFetching: true } }),
    ).toEqual({ kind: "ready", reports: [], isRefreshing: true });
    expect(
      resolveUsageView({
        ...base,
        query: { data: undefined, error: new Error("boom"), isFetching: false },
      }),
    ).toEqual({ kind: "error", message: "boom" });
  });
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

const hosts: UsageHost[] = [
  { serverId: "offline", label: "Offline", isConnected: false, supportsUsage: true },
  { serverId: "old", label: "Old", isConnected: true, supportsUsage: false },
  { serverId: "a", label: "Alpha", isConnected: true, supportsUsage: true },
  { serverId: "b", label: "Beta", isConnected: true, supportsUsage: true },
];

describe("resolveUsageHostId", () => {
  const choose = (pickedServerId: string | null, activeServerId: string | null) =>
    resolveUsageHostId({ pickedServerId, activeServerId, hosts });

  it("reads the picked host over the active workspace's host", () => {
    expect(choose("a", "b")).toBe("a");
  });

  it("reads the active workspace's host when nothing usable is picked", () => {
    expect(choose(null, "b")).toBe("b");
    expect(choose("offline", "b")).toBe("b");
    expect(choose("old", "b")).toBe("b");
  });

  it("falls back to the first connected host that reports usage", () => {
    expect(choose(null, null)).toBe("a");
    expect(choose(null, "offline")).toBe("a");
    expect(choose(null, "old")).toBe("a");
  });

  it("has no host when none reports usage", () => {
    expect(
      resolveUsageHostId({
        pickedServerId: "old",
        activeServerId: "old",
        hosts: hosts.slice(0, 2),
      }),
    ).toBeNull();
  });
});

describe("resolveUsageModalHostId", () => {
  it("shows the picked host while it stays connected, even one that cannot report usage", () => {
    expect(resolveUsageModalHostId({ pickedServerId: "old", activeServerId: "b", hosts })).toBe(
      "old",
    );
    expect(resolveUsageModalHostId({ pickedServerId: "offline", activeServerId: "b", hosts })).toBe(
      "b",
    );
  });

  it("otherwise shows the host the sidebar row reads", () => {
    for (const pickedServerId of [null, "a", "offline"]) {
      for (const activeServerId of ["b", null, "old", "offline"]) {
        const choice = { pickedServerId, activeServerId, hosts };
        expect(resolveUsageModalHostId(choice)).toBe(resolveUsageHostId(choice));
      }
    }
  });

  it("shows the first connected host when none reports usage, so the modal says to update it", () => {
    expect(
      resolveUsageModalHostId({
        pickedServerId: null,
        activeServerId: null,
        hosts: hosts.slice(0, 2),
      }),
    ).toBe("old");
    expect(
      resolveUsageModalHostId({ pickedServerId: null, activeServerId: null, hosts: [] }),
    ).toBeNull();
  });
});

describe("usageWindowRowLabel", () => {
  it("names the window, its percent and its reset after what pinning it pins", () => {
    expect(
      usageWindowRowLabel({
        pinLabel: "Pin Claude Session",
        value: "31%",
        trailing: "resets in 2h",
      }),
    ).toBe("Pin Claude Session, 31% · resets in 2h");
    expect(usageWindowRowLabel({ pinLabel: "Pin Codex Weekly", value: "—", trailing: null })).toBe(
      "Pin Codex Weekly, —",
    );
  });
});

describe("displayPercent", () => {
  const window = (input: Partial<UsageWindow>): UsageWindow => ({
    id: "weekly",
    label: "Weekly",
    ...input,
  });

  it("reads the share used or the share left", () => {
    expect(displayPercent(window({ usedPct: 31 }), "used")).toBe(31);
    expect(displayPercent(window({ usedPct: 31 }), "remaining")).toBe(69);
    expect(displayPercent(window({ remainingPct: 40 }), "used")).toBe(60);
    expect(displayPercent(window({ usedPct: 50, remainingPct: 45 }), "remaining")).toBe(45);
  });

  it("has no percent when the window reports none", () => {
    expect(displayPercent(window({}), "remaining")).toBeNull();
  });
});

describe("resolveUsageRefresh", () => {
  it("is pending while a refresh runs, even after an earlier failure", () => {
    expect(resolveUsageRefresh({ isPending: true, error: new Error("boom") })).toBe("pending");
  });

  it("is failed after a refresh errors", () => {
    expect(resolveUsageRefresh({ isPending: false, error: new Error("boom") })).toBe("failed");
  });

  it("is idle before and after a successful refresh", () => {
    expect(resolveUsageRefresh({ isPending: false, error: null })).toBe("idle");
  });
});

describe("replaceReport", () => {
  const alpha = entry({ sourceId: "alpha", planLabel: "Old" });
  const beta = entry({ sourceId: "beta" });

  it("swaps only the refreshed report, in place", () => {
    const refreshed = entry({ sourceId: "alpha", planLabel: "New" });
    expect(replaceReport([alpha, beta], alpha.id, refreshed)).toEqual([refreshed, beta]);
  });

  it("drops a report the daemon no longer knows", () => {
    expect(replaceReport([alpha, beta], alpha.id, null)).toEqual([beta]);
  });
});

describe("upsertReport", () => {
  const alpha = entry({ sourceId: "alpha", planLabel: "Old" });
  const beta = entry({ sourceId: "beta" });

  it("starts a list from the first streamed report", () => {
    expect(upsertReport(undefined, alpha)).toEqual([alpha]);
  });

  it("appends a report the list does not have yet", () => {
    expect(upsertReport([alpha], beta)).toEqual([alpha, beta]);
  });

  it("replaces a report the list already has, in place", () => {
    const streamed = entry({ sourceId: "alpha", planLabel: "New" });
    expect(upsertReport([alpha, beta], streamed)).toEqual([streamed, beta]);
  });

  it("keeps a copy fetched after the streamed one, such as a Refresh that landed first", () => {
    const refreshed = { ...alpha, planLabel: "Refreshed", fetchedAt: "2026-01-01T00:05:00.000Z" };
    expect(upsertReport([refreshed, beta], alpha)).toEqual([refreshed, beta]);
  });
});

describe("settleReports", () => {
  const alpha = entry({ sourceId: "alpha", planLabel: "Old" });
  const beta = entry({ sourceId: "beta" });

  it("takes the finished list, dropping reports the host no longer has", () => {
    const streamed = entry({ sourceId: "alpha", planLabel: "New" });
    expect(settleReports([alpha, beta], [streamed])).toEqual([streamed]);
  });

  it("keeps a report refreshed while the list streamed over its older copy in the list", () => {
    const refreshed = { ...alpha, planLabel: "Refreshed", fetchedAt: "2026-01-01T00:05:00.000Z" };
    expect(settleReports([refreshed, beta], [alpha, beta])).toEqual([refreshed, beta]);
  });

  it("keeps the displayed order when providers finish a refresh in reverse order", () => {
    const refreshed = entry({ sourceId: "alpha", planLabel: "New" });
    const streamed = upsertReport(upsertReport([alpha, beta], beta), refreshed);
    expect(settleReports(streamed, [beta, refreshed])).toEqual([refreshed, beta]);
  });

  it("drops missing reports and appends new ones without moving surviving reports", () => {
    const gamma = entry({ sourceId: "gamma" });
    const delta = entry({ sourceId: "delta" });
    expect(settleReports([alpha, beta, gamma], [delta, gamma, alpha])).toEqual([
      alpha,
      gamma,
      delta,
    ]);
  });

  it("takes the finished list as is when nothing was shown yet", () => {
    expect(settleReports(undefined, [alpha, beta])).toEqual([alpha, beta]);
  });
});

describe("resolveAgentUsageView", () => {
  const report = entry({ sourceId: "claude" });
  const idle: UsageQueryState = { data: undefined, error: null, isFetching: false };

  it("shows nothing on a host that cannot report usage", () => {
    expect(resolveAgentUsageView({ canReport: false, query: idle })).toEqual({ kind: "none" });
  });

  it("loads until the first report streams in", () => {
    expect(
      resolveAgentUsageView({ canReport: true, query: { ...idle, isFetching: true } }),
    ).toEqual({ kind: "loading" });
  });

  it("shows each report as it streams in, before the request finishes", () => {
    expect(
      resolveAgentUsageView({
        canReport: true,
        query: { data: [report], error: null, isFetching: true },
      }),
    ).toEqual({ kind: "ready", reports: [report] });
  });

  it("shows nothing for an agent with no account to report", () => {
    expect(resolveAgentUsageView({ canReport: true, query: { ...idle, data: [] } })).toEqual({
      kind: "none",
    });
  });

  it("says why a failed request has nothing to show", () => {
    expect(
      resolveAgentUsageView({
        canReport: true,
        query: { ...idle, error: new Error("Unknown agent") },
      }),
    ).toEqual({ kind: "error", message: "Unable to load usage: Unknown agent" });
  });

  it("says the request failed instead of showing the reports from before it", () => {
    expect(
      resolveAgentUsageView({
        canReport: true,
        query: { data: [report], error: new Error("Unknown agent"), isFetching: false },
      }),
    ).toEqual({ kind: "error", message: "Unable to load usage: Unknown agent" });
  });
});

it("resolves retained usage and successful time without inventing old-daemon history", () => {
  const success = entry({ windows: [{ id: "weekly", label: "Weekly", usedPct: 42 }] });
  const failure: UsageReportEntry = {
    ...success,
    fetchedAt: "2026-01-01T00:06:00.000Z",
    report: { status: "error", error: "Rate limited" },
    lastSuccessful: {
      fetchedAt: success.fetchedAt,
      report: success.report as Extract<UsageReportEntry["report"], { status: "available" }>,
    },
  };
  expect(resolveUsageReport(failure, i18n.t)).toEqual({
    windows: success.report.status === "available" ? success.report.windows : [],
    balances: [],
    details: [],
    planLabel: null,
    successfulAt: success.fetchedAt,
    retained: true,
    messages: ["Rate limited"],
  });
  expect(resolveUsageReport({ ...failure, lastSuccessful: undefined }, i18n.t)).toEqual({
    windows: [],
    balances: [],
    details: [],
    planLabel: null,
    successfulAt: null,
    retained: false,
    messages: ["Rate limited"],
  });
  expect(resolveUsageReport(success, i18n.t)).toEqual({
    windows: success.report.status === "available" ? success.report.windows : [],
    balances: [],
    details: [],
    planLabel: null,
    successfulAt: success.fetchedAt,
    retained: false,
    messages: [],
  });
});

it("orders failed polls by attempt time even when successful data is older", () => {
  const success = entry({});
  if (success.report.status !== "available") throw new Error("fixture must be available");
  const failure: UsageReportEntry = {
    ...success,
    fetchedAt: "2026-01-01T00:06:00.000Z",
    report: { status: "error", error: "Rate limited" },
    lastSuccessful: { fetchedAt: success.fetchedAt, report: success.report },
  };
  expect(upsertReport([failure], success)).toEqual([failure]);
  expect(settleReports([failure], [success])).toEqual([failure]);
  expect(upsertReport([success], failure)).toEqual([failure]);
});

it("available and retained usage show the same successful completion time", () => {
  const success: UsageReportEntry = { ...entry({}), successfulAt: "2026-01-01T00:00:15.000Z" };
  if (success.report.status !== "available") throw new Error("fixture must be available");
  expect(resolveUsageReport(success, i18n.t).successfulAt).toBe("2026-01-01T00:00:15.000Z");
  const failure: UsageReportEntry = {
    ...success,
    successfulAt: undefined,
    fetchedAt: "2026-01-01T00:06:00.000Z",
    report: { status: "error", error: "Rate limited" },
    lastSuccessful: { fetchedAt: success.successfulAt!, report: success.report },
  };
  expect(resolveUsageReport(failure, i18n.t).successfulAt).toBe(
    resolveUsageReport(success, i18n.t).successfulAt,
  );
  expect(upsertReport([failure], success)).toEqual([failure]);
});
