import { useCallback, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { HostStatusDot } from "@/components/host-status-dot";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useHostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import type { UsageHost } from "./model";
import { builtinSidebarNavLabelKey } from "@/sidebar-nav/model";
import { usageCopy } from "./copy";
import { useUsageDisplay } from "./display";
import { UsageOptions } from "./options";
import { useAllHostsUsage } from "./queries";
import { UsageRefreshButton } from "./refresh-button";
import { UsageBody, UsageMessage } from "./usage-section";
import type { UsageView } from "./types";

interface UsageModalProps {
  visible: boolean;
  onClose: () => void;
  onDismiss: () => void;
}

/**
 * Usage over the current screen: a dialog on wide layouts, a bottom sheet on compact ones. It
 * shows every configured host independently, with Refresh all and Settings in its title row.
 */
export function UsageModal(props: UsageModalProps) {
  const { t } = useTranslation();
  const { groups, refreshHost, refreshAll, isRefreshing, canRefresh } = useAllHostsUsage();
  const controls = useMemo(
    () => (
      <View style={styles.controls}>
        <UsageRefreshButton busy={isRefreshing} disabled={!canRefresh} onRefresh={refreshAll} />
        <UsageOptions />
      </View>
    ),
    [canRefresh, isRefreshing, refreshAll],
  );
  if (groups.length === 0) {
    return (
      <UsageModalFrame {...props}>
        <UsageMessage text={t("providerUsage.noHosts")} />
      </UsageModalFrame>
    );
  }
  return (
    <UsageModalFrame {...props} actions={controls}>
      <View style={styles.groups}>
        {groups.map(({ host, view, refreshError }) => (
          <HostUsageGroup
            key={host.serverId}
            host={host}
            view={view}
            refreshError={refreshError}
            onRefreshHost={refreshHost}
          />
        ))}
      </View>
    </UsageModalFrame>
  );
}

function HostUsageGroup({
  host,
  view,
  refreshError,
  onRefreshHost,
}: {
  host: UsageHost;
  view: UsageView;
  refreshError: string | null;
  onRefreshHost: (serverId: string) => void;
}) {
  const { t } = useTranslation();
  const status = useHostRuntimeConnectionStatus(host.serverId);
  const refresh = useCallback(() => onRefreshHost(host.serverId), [host.serverId, onRefreshHost]);
  const { display } = useUsageDisplay(view.kind === "ready" ? view.reports : []);
  return (
    <View style={styles.group} testID={`usage-host-${host.serverId}`}>
      <View style={styles.hostHeader}>
        <HostStatusDot serverId={host.serverId} />
        <Text style={styles.hostLabel}>{host.label}</Text>
        <Text style={styles.hostStatus}>{t(`common.connectionStatus.${status}`)}</Text>
      </View>
      {refreshError ? (
        <Alert size="sm" variant="error" title={usageCopy.refreshFailed} description={refreshError}>
          <Button variant="outline" size="sm" onPress={refresh}>
            {usageCopy.retry}
          </Button>
        </Alert>
      ) : null}
      <UsageBody serverId={host.serverId} view={view} display={display} onRefresh={refresh} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  controls: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  groups: { gap: theme.spacing[6] },
  group: { gap: theme.spacing[3] },
  hostHeader: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  hostLabel: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  hostStatus: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));

function UsageModalFrame({
  visible,
  onClose,
  onDismiss,
  actions,
  children,
}: UsageModalProps & { actions?: ReactNode; children: ReactNode }) {
  const { t } = useTranslation();
  const title = t(builtinSidebarNavLabelKey("usage"));
  const header = useMemo(() => ({ title, actions }), [actions, title]);
  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      desktopMaxWidth={640}
      contextBridge={null}
      testID="usage-modal"
    >
      <View testID="usage-modal-body">{children}</View>
    </AdaptiveModalSheet>
  );
}
