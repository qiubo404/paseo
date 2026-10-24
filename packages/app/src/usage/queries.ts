import { useTranslation } from "react-i18next";
import { supportsUsageReports } from "@getpaseo/client/internal/daemon-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  skipToken,
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useShallow } from "zustand/shallow";
import { useFetchQueries, useFetchQuery } from "@/data/query";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { getIsElectron } from "@/constants/platform";
import { readDesktopSystemIdleTimeMs } from "@/desktop/electron/idle";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useUsageInSidebar } from "./in-sidebar";
import {
  createUsageRefreshScheduler,
  usageRefreshTargetKey,
  type UsageRefreshTarget,
} from "./refresh-scheduler";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHostRuntimeIsConnected,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import { usageCopy } from "./copy";
import {
  replaceReport,
  enabledHostUsageReports,
  resolveAgentUsageView,
  resolveUsageRefresh,
  resolveUsageView,
  settleReports,
  type UsageHost,
  type UsageQueryState,
  type AgentUsageView,
  type UsageRefresh,
  upsertReport,
} from "./model";
import type { UsageReportEntry, UsageView } from "./types";

// The daemon caches each report for five minutes, so re-reading it is cheap. Only
// an explicit refresh passes `forceRefresh` and reaches the source's API.
const REPORTS_STALE_TIME_MS = 60_000;

/** Every report list of a host: its own and each agent's. */
function hostUsageQueryKey(serverId: string) {
  return ["usage", serverId] as const;
}

function usageReportsQueryKey(serverId: string) {
  return [...hostUsageQueryKey(serverId), "reports"] as const;
}

function agentUsageQueryKey(serverId: string, agentId: string) {
  return [...hostUsageQueryKey(serverId), "agent", agentId] as const;
}

function requireClient(serverId: string) {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) throw new Error(usageCopy.clientUnavailable);
  return client;
}

/**
 * Lists a host's reports, or one agent's, writing each into `queryKey` as it streams in so a slow
 * source never holds back the others. The finished list then replaces the streamed one, dropping
 * any report the host no longer has, but never a report refreshed while the list streamed.
 */
async function streamReports(input: {
  queryClient: QueryClient;
  queryKey: QueryKey;
  serverId: string;
  agentId?: string;
  forceRefresh?: boolean;
  /** Once aborted, reports still on their way are dropped instead of written. */
  signal?: AbortSignal;
}): Promise<UsageReportEntry[]> {
  const { queryClient, queryKey, serverId, agentId, forceRefresh = false, signal } = input;
  const { reports } = await requireClient(serverId).listUsageReports(
    { agentId, forceRefresh },
    (report) => {
      if (signal?.aborted) return;
      queryClient.setQueryData<UsageReportEntry[]>(queryKey, (current) =>
        upsertReport(current, report),
      );
    },
  );
  return settleReports(queryClient.getQueryData<UsageReportEntry[]>(queryKey), reports);
}

function listReports(
  queryClient: QueryClient,
  serverId: string,
  forceRefresh = false,
): Promise<UsageReportEntry[]> {
  return streamReports({
    queryClient,
    queryKey: usageReportsQueryKey(serverId),
    serverId,
    forceRefresh,
  });
}

async function getReport(
  serverId: string,
  reportId: string,
  forceRefresh = false,
  agentId?: string,
): Promise<UsageReportEntry | null> {
  return (
    (
      await requireClient(serverId).listUsageReports(
        agentId === undefined ? { reportIds: [reportId], forceRefresh } : { agentId, forceRefresh },
      )
    ).reports.find((report) => report.id === reportId) ?? null
  );
}

function supportsUsage(session: SessionState | undefined): boolean {
  return supportsUsageReports(session?.serverInfo?.features);
}

async function refreshReports(queryClient: QueryClient, serverId: string): Promise<void> {
  await queryClient.fetchQuery({
    queryKey: usageReportsQueryKey(serverId),
    queryFn: () => listReports(queryClient, serverId, true),
    staleTime: 0,
  });
}

function toQueryState(query: {
  data: UsageReportEntry[] | undefined;
  error: unknown;
  isFetching: boolean;
}): UsageQueryState {
  return { data: query.data, error: query.error, isFetching: query.isFetching };
}

/** Usage reports for one host, as shown on its settings page. */
export function useHostUsage(serverId: string): { view: UsageView; refresh: () => void } {
  const queryClient = useQueryClient();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useSessionStore((state) => supportsUsage(state.sessions[serverId]));
  const query = useFetchQuery({
    queryKey: usageReportsQueryKey(serverId),
    queryFn: () => listReports(queryClient, serverId),
    enabled: isConnected && isSupported,
    dataShape: "list",
    staleTimeMs: REPORTS_STALE_TIME_MS,
  });
  const refresh = useCallback(() => {
    void refreshReports(queryClient, serverId).catch(() => undefined);
  }, [queryClient, serverId]);
  const { t } = useTranslation();
  const hostLabel = useHosts().find((host) => host.serverId === serverId)?.label ?? serverId;
  const view = resolveUsageView(
    {
      hostLabel,
      isConnected,
      supportsUsage: isSupported,
      query: toQueryState(query),
    },
    t,
  );
  return { view, refresh };
}

/** All configured hosts, with independent requests and the same cache as their cards/sidebar. */
export function useAllHostsUsage() {
  const queryClient = useQueryClient();
  const hosts = useUsageHosts();
  const queries = useFetchQueries<UsageReportEntry[]>(
    hosts.map((host) => ({
      queryKey: usageReportsQueryKey(host.serverId),
      queryFn: () => listReports(queryClient, host.serverId),
      enabled: host.isConnected && host.supportsUsage,
      // A removed/reordered host must never inherit another host's placeholder reports.
      dataShape: "value",
      staleTimeMs: REPORTS_STALE_TIME_MS,
      retry: false,
    })),
  );
  const refreshHost = useCallback(
    (serverId: string) => {
      void refreshReports(queryClient, serverId).catch(() => undefined);
    },
    [queryClient],
  );
  const reportingHosts = hosts.filter((host) => host.isConnected && host.supportsUsage);
  const mutation = useMutation({
    mutationFn: () =>
      Promise.allSettled(reportingHosts.map((host) => refreshReports(queryClient, host.serverId))),
  });
  const groups = hosts.map((host, index) => {
    const query = queries[index]!;
    const view = resolveUsageView({
      hostLabel: host.label,
      isConnected: host.isConnected,
      supportsUsage: host.supportsUsage,
      query: toQueryState(query),
    });
    const errorMessage = query.error instanceof Error ? query.error.message : String(query.error);
    return {
      host,
      view,
      // Keep previous/streamed cards, but never present a failed refresh as fresh data.
      refreshError: view.kind === "ready" && query.error ? errorMessage : null,
    };
  });
  const { mutate } = mutation;
  const refreshAll = useCallback(() => mutate(), [mutate]);
  return {
    groups,
    refreshHost,
    refreshAll,
    isRefreshing: mutation.isPending || queries.some((query) => query.isFetching),
    canRefresh: reportingHosts.length > 0,
  };
}

const NO_REPORTS: UsageReportEntry[] = [];

function sidebarUsageQueryKey(scope: UsageRefreshTarget) {
  return scope.agentId
    ? agentUsageQueryKey(scope.serverId, scope.agentId)
    : usageReportsQueryKey(scope.serverId);
}

/** Mounted once by the sidebar root; its consumers share both the query and the timer. */
export function useSidebarUsageQuery(fallbackServerId: string | null) {
  const queryClient = useQueryClient();
  const workspace = useActiveWorkspaceSelection();
  const agentId = useSessionStore((state) => {
    if (!workspace) return null;
    const session = state.sessions[workspace.serverId];
    const focused = session?.focusedAgentId;
    return focused && session.agents.get(focused)?.workspaceId === workspace.workspaceId
      ? focused
      : null;
  });
  const serverId = workspace?.serverId;
  const hasWorkspace = Boolean(workspace);
  const focused = useMemo<UsageRefreshTarget | null>(
    () => (serverId && agentId ? { serverId, agentId } : null),
    [serverId, agentId],
  );
  const [lastChat, setLastChat] = useState<UsageRefreshTarget | null>(null);
  useEffect(() => {
    if (focused) setLastChat(focused);
  }, [focused]);
  const target = useMemo(
    () => focused ?? lastChat ?? (fallbackServerId ? { serverId: fallbackServerId } : null),
    [focused, lastChat, fallbackServerId],
  );
  const active = useAppActivelyVisible();
  const { inSidebar } = useUsageInSidebar();
  const canReport = useHostReportsUsage(target?.serverId ?? "");
  const { config, isLoading: configLoading } = useDaemonConfig(target?.serverId ?? null);
  const key = target ? usageRefreshTargetKey(target) : null;
  const query = useFetchQuery<UsageReportEntry[]>({
    queryKey: target ? sidebarUsageQueryKey(target) : ["usage", "sidebar", "none"],
    queryFn: skipToken,
    enabled: false,
    dataShape: "value",
    staleTimeMs: REPORTS_STALE_TIME_MS,
    gcTime: 0,
    retry: false,
  });
  const current = useRef({ key, active, inSidebar, canReport, focused, lastChat, hasWorkspace });
  current.current = { key, active, inSidebar, canReport, focused, lastChat, hasWorkspace };
  const requestedKey = useRef<string | null>(null);
  const scheduler = useMemo(
    () =>
      createUsageRefreshScheduler({
        now: Date.now,
        readIdleMs: () =>
          getIsElectron() ? readDesktopSystemIdleTimeMs(invokeDesktopCommand) : Promise.resolve(0),
        canRefresh: (scope) => {
          const state = current.current;
          return Boolean(
            state.key === usageRefreshTargetKey(scope) &&
            state.active &&
            state.inSidebar &&
            state.canReport &&
            (state.focused || (!state.lastChat && !state.hasWorkspace)),
          );
        },
        updatedAt: (scope) =>
          queryClient.getQueryState(sidebarUsageQueryKey(scope))?.dataUpdatedAt ?? 0,
        fetch: (scope, forceRefresh) => {
          requestedKey.current = usageRefreshTargetKey(scope);
          return queryClient.fetchQuery({
            queryKey: sidebarUsageQueryKey(scope),
            queryFn: ({ signal }) =>
              streamReports({
                queryClient,
                queryKey: sidebarUsageQueryKey(scope),
                serverId: scope.serverId,
                agentId: scope.agentId,
                forceRefresh,
                signal,
              }),
            staleTime: 0,
            retry: false,
          });
        },
      }),
    [queryClient],
  );
  useEffect(() => {
    if (!target || !active || !inSidebar || !canReport || (!focused && lastChat)) return;
    const check = () => {
      void scheduler
        .refresh(target, { verifyAccount: requestedKey.current !== key })
        .catch(() => undefined);
    };
    check();
    // Also checks for resumed desktop activity, using local idle time rather than vendor requests.
    if (!focused) return;
    const timer = setInterval(check, 60_000);
    return () => clearInterval(timer);
  }, [target, key, active, inSidebar, canReport, focused, lastChat, hasWorkspace, scheduler]);
  const refresh = useCallback(() => {
    if (target && focused) void scheduler.refresh(target, { force: true }).catch(() => undefined);
  }, [target, focused, scheduler]);
  const reports = useMemo(
    () =>
      config ? enabledHostUsageReports(query.data ?? NO_REPORTS, config.providers) : NO_REPORTS,
    [config, query.data],
  );
  const hostLabel = useHosts().find((host) => host.serverId === target?.serverId)?.label ?? "";
  let error: string | null = null;
  if (query.error) error = query.error instanceof Error ? query.error.message : String(query.error);
  else if (!canReport && target) error = usageCopy.hostUnavailable(hostLabel);
  else if (!config && !configLoading && target) error = usageCopy.settingsUnavailable;
  return {
    reports,
    refresh,
    busy: query.isFetching,
    disabled: !focused || !canReport,
    hasChat: Boolean(focused || lastChat),
    loading: query.isFetching || configLoading,
    label: hostLabel,
    error,
  };
}

/**
 * The reports of the sidebar's usage host, which is connected and reports usage; none until they
 * load, or without a host.
 */
export function useUsageHostReports(serverId: string | null): UsageReportEntry[] {
  const queryClient = useQueryClient();
  const { config } = useDaemonConfig(serverId);
  const query = useFetchQuery({
    queryKey: usageReportsQueryKey(serverId ?? ""),
    queryFn: serverId ? () => listReports(queryClient, serverId) : skipToken,
    dataShape: "list",
    staleTimeMs: REPORTS_STALE_TIME_MS,
  });
  return useMemo(
    () =>
      config ? enabledHostUsageReports(query.data ?? NO_REPORTS, config.providers) : NO_REPORTS,
    [config, query.data],
  );
}

/**
 * The reports of the account an agent runs under, as its meter's tooltip or sheet shows them.
 * Fetched while either is mounted, so only while it is open.
 */
export function useAgentUsage(serverId: string, agentId: string): AgentUsageView {
  const queryClient = useQueryClient();
  const canReport = useHostReportsUsage(serverId);
  const queryKey = agentUsageQueryKey(serverId, agentId);
  const query = useFetchQuery({
    queryKey,
    // Consuming the signal cancels the request when the details close, so a reopen sends a new
    // request instead of joining one scoped to the login the agent ran under before.
    queryFn: ({ signal }) => streamReports({ queryClient, queryKey, serverId, agentId, signal }),
    enabled: canReport,
    // Another agent's reports never stand in while this one's load.
    dataShape: "value",
    // Dropped as soon as the details close: an agent resumed under another login keeps its ID, so
    // reports kept from an earlier open could show the old login. The daemon's cache keeps each
    // open's request cheap.
    gcTime: 0,
    // The daemon's errors (an unknown agent) do not heal on retry, and reopening the details
    // fetches again; retrying would hold the loading sentence for seconds instead.
    retry: false,
    staleTimeMs: REPORTS_STALE_TIME_MS,
  });
  const { t } = useTranslation();
  return resolveAgentUsageView({ canReport, query: toQueryState(query) }, t);
}

/** Whether a host is connected and reports usage, read without fetching anything. */
export function useHostReportsUsage(serverId: string): boolean {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useSessionStore((state) => supportsUsage(state.sessions[serverId]));
  return isConnected && isSupported;
}

/** Every host with whether it is connected and reports usage, in host order. */
export function useUsageHosts(): UsageHost[] {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const supportedServerIds = useSessionStore(
    useShallow((state) => serverIds.filter((serverId) => supportsUsage(state.sessions[serverId]))),
  );
  return useMemo(
    () =>
      hosts.map((host) => ({
        serverId: host.serverId,
        label: host.label,
        isConnected: connectionStatuses.get(host.serverId) === "online",
        supportsUsage: supportedServerIds.includes(host.serverId),
      })),
    [connectionStatuses, hosts, supportedServerIds],
  );
}

/**
 * Refreshes a host report, or the agent's session reports. The result replaces the card
 * in the requesting view. Host and agent views can use different logins of the same account.
 */
export function useReportRefresh(
  serverId: string,
  reportId: string,
  agentId?: string,
): { refresh: () => void; refreshState: UsageRefresh } {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => getReport(serverId, reportId, true, agentId),
    onSuccess: (report) => {
      queryClient.setQueryData<UsageReportEntry[]>(
        agentId === undefined
          ? usageReportsQueryKey(serverId)
          : agentUsageQueryKey(serverId, agentId),
        (reports) => (reports ? replaceReport(reports, reportId, report) : reports),
      );
    },
  });
  const { mutate } = mutation;
  const refresh = useCallback(() => mutate(), [mutate]);
  return { refresh, refreshState: resolveUsageRefresh(mutation) };
}
