import type { TFunction } from "i18next";
import type { UsageProblem } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { formatAgo } from "./format";

// Messages for usage failures outside the UI. Rendered copy uses useTranslation.
export const usageCopy = {
  problem: (problem: UsageProblem, now: Date = new Date(), t: TFunction = i18n.t): string => {
    if (problem.kind === "no_quota") return problem.detail;
    const remedy = problem.refreshedBy
      ? t("providerUsage.runToRefresh", { command: problem.refreshedBy })
      : t("providerUsage.signInAgain");
    if (problem.kind === "rejected")
      return t("providerUsage.loginRejected", { status: problem.status, remedy });
    return t("providerUsage.loginExpired", {
      relativeTime: formatAgo(problem.expiresAt, now.getTime(), t),
      remedy,
    });
  },
  get clientUnavailable() {
    return i18n.t("providerUsage.clientUnavailable");
  },
  title: "Usage",
  planUsage: "Plan usage",
  options: "Settings",
  refresh: "Refresh",
  refreshAll: "Refresh all",
  refreshing: "Refreshing...",
  refreshFailed: "Unable to refresh usage",
  updated: "Updated",
  loading: "Loading usage...",
  empty: "No usage data",
  noHosts: "No configured hosts",
  errorTitle: "Unable to load usage",
  settingsUnavailable: "Unable to read host provider settings.",
  agentError: (reason: string) => `Unable to load usage: ${reason}`,
  hostUnavailable: (host: string) => `Connect to ${host} to see usage`,
  hostUpgradeRequired: (host: string) => `Update ${host} to see usage`,
  retry: "Try again",
  pin: "Pin",
  unpin: "Unpin",
  displayAs: "Percentages",
  displayUsed: "Used",
  displayRemaining: "Remaining",
  pendingReset: "Pending reset",
  resetsIn: (countdown: string) => `resets in ${countdown}`,
  showInSidebar: "Summary in sidebar",
  showInSidebarHint: "Pinned windows show in the sidebar footer",
} as const;
