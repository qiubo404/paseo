import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type LayoutChangeEvent, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { RotateCw } from "lucide-react-native";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { extraMutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor } from "@/constants/layout";
import { builtinSidebarNavLabelKey } from "@/sidebar-nav/model";
import { useUsageDisplay } from "./display";
import { useUsageHostId } from "./hosts";
import { useSidebarUsageQuery } from "./queries";
import { usageCopy } from "./copy";
import { resolveUsageReport } from "./model";
import { UsageSourceIcon } from "./source-icon";
import { UsageMeter } from "./meter";
import {
  choosePinnedUsageLayout,
  METER_GAP,
  MIN_METER_WIDTH,
  resolvePinnedUsage,
  type PinnedUsageLayout,
  type PinnedUsageSource,
} from "./pinned";
import { UsageModal } from "./usage-modal";

const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const SidebarUsageContext = createContext<ReturnType<typeof useSidebarUsageQuery> | null>(null);

function useSidebarUsage() {
  const usage = useContext(SidebarUsageContext);
  if (!usage) throw new Error("Sidebar Usage must be inside UsageSidebarRoot.");
  return usage;
}

/** Each summary window with data on the usage host, under its source; empty while none has. */
function useUsageSummary(): readonly PinnedUsageSource[] {
  const { reports } = useSidebarUsage();
  const { preferences } = useUsageDisplay(reports);
  return useMemo(
    () =>
      resolvePinnedUsage(
        reports.map((entry) =>
          entry.report.status !== "available" && entry.lastSuccessful
            ? { ...entry, report: entry.lastSuccessful.report }
            : entry,
        ),
        preferences,
      ),
    [preferences, reports],
  );
}

/** Whether the sidebar Usage item has anything to show. */
export function useHasUsageSummary(): boolean {
  const { hasChat } = useSidebarUsage();
  return useUsageSummary().length > 0 || hasChat;
}

/**
 * The sidebar footer's usage entry: each summary window's source icon and percent, and nothing
 * while no summary window has data, since the footer's Usage icon already opens Usage.
 * Pressing it opens the Usage modal.
 */
export function UsageSidebarItem() {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const usage = useSidebarUsage();
  const label = `${t(builtinSidebarNavLabelKey("usage"))}${usage.label ? ` · ${usage.label}` : ""}`;
  const openUsage = useOpenSidebarUsage();
  const sources = useUsageSummary();
  const messages = usage.reports.flatMap((entry) => resolveUsageReport(entry).messages);
  const error = usage.error ?? (messages.length ? messages.join("\n") : null);
  const status = error ?? (usage.loading ? usageCopy.loading : usageCopy.empty);
  const refreshLabel = t("sidebar.refreshUsage");
  const accountLabels = usage.reports
    .map((entry) => entry.account.label)
    .filter(Boolean)
    .join(", ");
  const detail = [label, accountLabels, error].filter(Boolean).join("\n");
  const refreshTooltip = useMemo(
    () => <Text style={styles.detail}>{`${refreshLabel}\n${detail}`}</Text>,
    [refreshLabel, detail],
  );
  if (sources.length === 0 && !usage.hasChat) return null;
  return (
    <View>
      <View style={styles.row}>
        <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
          <PinnedUsageTrigger
            label={label}
            sources={sources}
            placeholder={status}
            onPress={openUsage}
          />
          <TooltipContent side="top" offset={8}>
            <Text style={styles.detail}>
              {[
                detail,
                ...sources.flatMap((source) => source.windows.map((window) => window.label)),
              ].join("\n")}
            </Text>
          </TooltipContent>
        </Tooltip>
        <ToolbarButton
          label={refreshLabel}
          tooltip={refreshTooltip}
          tooltipSide="top"
          compact={compact}
          onPress={usage.refresh}
          disabled={usage.disabled || usage.busy}
          testID="sidebar-usage-refresh"
        >
          {usage.busy ? (
            <ThemedLoadingSpinner size={14} uniProps={extraMutedIconColorMapping} />
          ) : (
            <ThemedRotateCw size={14} uniProps={extraMutedIconColorMapping} />
          )}
        </ToolbarButton>
      </View>
      {error && sources.length > 0 ? (
        <Text
          style={styles.error}
          numberOfLines={2}
          accessibilityLiveRegion="polite"
          testID="sidebar-usage-error"
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const OpenSidebarUsageContext = createContext<(() => void) | null>(null);

/**
 * One owner for the footer icon and summary: both open the Usage modal over the current screen.
 * The modal mounts on first open and unmounts once it has finished closing, so its host's reports
 * load only while it is shown.
 */
export function UsageSidebarRoot({ children }: { children: ReactNode }) {
  const usage = useSidebarUsageQuery(useUsageHostId());
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const openUsage = useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, []);
  const closeUsage = useCallback(() => setOpen(false), []);
  const unmountUsage = useCallback(() => setMounted(false), []);

  return (
    <SidebarUsageContext.Provider value={usage}>
      <OpenSidebarUsageContext.Provider value={openUsage}>
        {children}
        {mounted ? (
          <UsageModal visible={open} onClose={closeUsage} onDismiss={unmountUsage} />
        ) : null}
      </OpenSidebarUsageContext.Provider>
    </SidebarUsageContext.Provider>
  );
}

/** Both sidebar entry points send the same open command. */
export function useOpenSidebarUsage(): () => void {
  const openUsage = useContext(OpenSidebarUsageContext);
  if (!openUsage) throw new Error("Sidebar Usage must be inside UsageSidebarRoot.");
  return openUsage;
}

function pinnedUsageLabel(label: string, sources: readonly PinnedUsageSource[]): string {
  const windows = sources.flatMap((source) => source.windows);
  return `${label}: ${windows.map((window) => window.label).join(", ")}`;
}

function triggerStyle({ hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return hovered ? [styles.trigger, styles.triggerHovered] : styles.trigger;
}

function layoutWidth(event: LayoutChangeEvent): number {
  return event.nativeEvent.layout.width;
}

/**
 * One line: each account's icon, then per window a meter and "31% 5h". Off-screen copies measure
 * the line with labels and with percents alone; the richest layout that fits is shown, and what
 * it leaves out takes no space at all.
 */
function PinnedUsageTrigger({
  label,
  sources,
  onPress,
  placeholder,
}: {
  label: string;
  sources: readonly PinnedUsageSource[];
  onPress: () => void;
  placeholder: string;
}) {
  const [available, setAvailable] = useState<number | null>(null);
  const [labelsWidth, setLabelsWidth] = useState<number | null>(null);
  const [percentsWidth, setPercentsWidth] = useState<number | null>(null);
  const handleAvailableLayout = useCallback((event: LayoutChangeEvent) => {
    setAvailable(layoutWidth(event));
  }, []);
  const handleLabelsLayout = useCallback((event: LayoutChangeEvent) => {
    setLabelsWidth(layoutWidth(event));
  }, []);
  const handlePercentsLayout = useCallback((event: LayoutChangeEvent) => {
    setPercentsWidth(layoutWidth(event));
  }, []);
  const layout = choosePinnedUsageLayout({
    available,
    labelsWidth,
    percentsWidth,
    windowCount: sources.reduce((count, source) => count + source.windows.length, 0),
  });
  return (
    <TooltipTrigger
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={pinnedUsageLabel(label, sources)}
      style={triggerStyle}
      testID="sidebar-usage"
    >
      <View style={styles.line} onLayout={handleAvailableLayout}>
        {sources.length ? (
          <PinnedUsageLine sources={sources} layout={layout} />
        ) : (
          <Text style={styles.placeholder} numberOfLines={1}>
            {placeholder}
          </Text>
        )}
      </View>
      <View
        style={styles.measure}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        aria-hidden
      >
        <View style={styles.measured} onLayout={handleLabelsLayout}>
          <PinnedUsageLine sources={sources} layout="labels" measuring />
        </View>
        <View style={styles.measured} onLayout={handlePercentsLayout}>
          <PinnedUsageLine sources={sources} layout="percents" measuring />
        </View>
      </View>
    </TooltipTrigger>
  );
}

/**
 * The line's items as direct children of one row, so every meter shares the leftover width
 * equally.
 */
function PinnedUsageLine({
  sources,
  layout,
  measuring = false,
}: {
  sources: readonly PinnedUsageSource[];
  layout: PinnedUsageLayout;
  measuring?: boolean;
}) {
  return sources.map((source, sourceIndex) => (
    <Fragment key={source.key}>
      <View
        style={sourceIndex === 0 ? null : styles.sourceGap}
        testID={measuring ? undefined : "sidebar-usage-source"}
      >
        <UsageSourceIcon svg={source.icon} size={14} />
      </View>
      {source.windows.map((window, windowIndex) => {
        const leadStyle = windowIndex === 0 ? styles.iconGap : styles.windowGap;
        return (
          <Fragment key={window.key}>
            {layout === "meters" ? (
              <View style={[styles.meterSlot, leadStyle]}>
                <UsageMeter
                  percent={window.percent}
                  tone={window.tone}
                  quiet
                  style={styles.meter}
                />
              </View>
            ) : null}
            <Text
              style={[styles.percent, layout === "meters" ? null : leadStyle]}
              numberOfLines={1}
              testID={measuring ? undefined : "sidebar-usage-pinned-window"}
            >
              {window.percentText}
              {layout === "percents" || window.shortLabel === "" ? null : (
                <Text style={styles.windowLabel}>{` ${window.shortLabel}`}</Text>
              )}
            </Text>
          </Fragment>
        );
      })}
    </Fragment>
  ));
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", alignItems: "center", paddingRight: theme.spacing[2] },
  detail: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  placeholder: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[2],
  },
  trigger: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
    // Same row geometry and leading rail as Add project and the footer icons.
    minHeight: 28,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  line: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
  },
  // Wide enough that nothing inside wraps or shrinks; each child reports its natural width.
  measure: {
    position: "absolute",
    top: 0,
    left: 0,
    width: 10_000,
    opacity: 0,
  },
  measured: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
  },
  sourceGap: {
    marginLeft: theme.spacing[3],
  },
  iconGap: {
    marginLeft: theme.spacing[1.5],
  },
  windowGap: {
    marginLeft: theme.spacing[2],
  },
  // Every slot takes an equal share of the leftover width, so the line fills the row.
  meterSlot: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: MIN_METER_WIDTH,
    marginRight: METER_GAP,
  },
  meter: {
    height: 6,
    borderRadius: 3,
  },
  percent: {
    flexShrink: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  windowLabel: {
    color: theme.colors.foregroundMuted,
  },
}));
