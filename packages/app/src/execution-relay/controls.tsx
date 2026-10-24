import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { RelayAddress, RelayMember } from "@getpaseo/protocol/execution-relay";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { relayAddressKey, selectRelayTargets } from "./model";
import { useRelay } from "./query";
import { useRelayDisplay } from "./display";
import { RelayIndicator, type RelayIndicatorKind } from "./indicator";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { DensityIcon } from "@/components/ui/density-icon";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";

export function RelayPlanActions({
  serverId,
  agentId,
  requestId,
  children,
}: {
  serverId: string;
  agentId: string;
  requestId: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const panelActive = useRetainedPanelActive();
  const relay = useRelay({ serverId, agentId });
  const [open, setOpen] = useState(false);
  const anchor = useRef<View>(null);
  const address = { serverId, agentId };
  const targets = selectRelayTargets(relay.query.data, address);
  const display = useRelayDisplay(relay.query.data);
  const showPicker = useCallback(() => {
    relay.mutation.reset();
    setOpen(true);
    void relay.query.refetch();
  }, [relay.mutation, relay.query]);
  const selectTarget = useCallback(
    (id: string) => {
      const target = targets.find((candidate) => relayAddressKey(candidate.address) === id);
      if (target) relay.mutation.mutate({ kind: "join", target: target.address, requestId });
    },
    [targets, relay.mutation, requestId],
  );
  if (!relay.client) return children;
  const managed =
    relay.member && relay.member.status !== "canceled" && relay.member.status !== "completed";
  if (managed && relay.member?.planRequestId === requestId) return null;
  return (
    <View style={styles.container}>
      <View style={styles.planActions}>
        {!relay.mutation.isPending ? (
          <View style={styles.container}>{children}</View>
        ) : (
          <Text style={styles.muted}>{t("executionRelay.waitingFullAccess")}</Text>
        )}
        <Button
          ref={anchor}
          variant="outline"
          size="sm"
          testID="plan-relay-picker"
          loading={relay.mutation.isPending}
          onPress={showPicker}
        >
          {t("executionRelay.choose")}
        </Button>
        <Combobox
          anchorRef={anchor}
          open={open && panelActive}
          onOpenChange={setOpen}
          value=""
          searchable={false}
          title={t("executionRelay.choose")}
          emptyText={
            relay.query.isFetching ? t("executionRelay.loading") : t("executionRelay.empty")
          }
          options={targets.map((candidate) => ({
            id: relayAddressKey(candidate.address),
            label:
              display.get(relayAddressKey(candidate.address))?.title ||
              t("executionRelay.untitled"),
            description: `${display.get(relayAddressKey(candidate.address))?.host || t("executionRelay.unknownHost")} · ${t(candidate.state === "running" ? "executionRelay.running" : "executionRelay.planReady")}`,
          }))}
          onSelect={selectTarget}
        />
      </View>
      {relay.query.data?.unavailableHosts.length ? (
        <Text style={styles.muted}>
          {t("executionRelay.unavailableHosts", {
            hosts: relay.query.data.unavailableHosts.join(", "),
          })}
        </Text>
      ) : null}
      {relay.mutation.error || relay.query.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {(relay.mutation.error ?? relay.query.error)?.message}
        </Text>
      ) : null}
    </View>
  );
}

export function RelayStatus({
  serverId,
  agentId,
  onOpenAgent,
}: {
  serverId: string;
  agentId: string;
  onOpenAgent(address: RelayAddress): void;
}) {
  const { t } = useTranslation();
  const panelActive = useRetainedPanelActive();
  const relay = useRelay({ serverId, agentId });
  const display = useRelayDisplay(relay.query.data);
  const [visible, setVisible] = useState(false);
  const [showFinished, setShowFinished] = useState(false);
  const { group, member } = relay;
  const show = useCallback(() => {
    setShowFinished(false);
    setVisible(true);
  }, []);
  const close = useCallback(() => setVisible(false), []);
  const toggleFinished = useCallback(() => setShowFinished((value) => !value), []);
  const togglePaused = useCallback(
    () => relay.mutation.mutate({ kind: group?.paused ? "resume" : "pause" }),
    [relay.mutation, group?.paused],
  );
  const leave = useCallback(() => relay.mutation.mutate({ kind: "leave" }), [relay.mutation]);
  const header = useMemo(
    () => ({
      title: t("executionRelay.members"),
      subtitle: (
        <Text style={styles.muted}>
          {t("executionRelay.summary", { count: group?.members.length ?? 0 })}
        </Text>
      ),
    }),
    [t, group?.members.length],
  );
  const kind = entryKind(member, Boolean(group?.paused));
  const leading = useMemo(() => <RelayIndicator kind={kind} />, [kind]);
  const finishedState = useMemo(() => ({ expanded: showFinished }), [showFinished]);
  const webFinishedState = useMemo(
    () => (isWeb ? { "aria-expanded": showFinished } : null),
    [showFinished],
  );
  const footer = useMemo(
    () => <RelayGroupFooter relay={relay} togglePaused={togglePaused} leave={leave} />,
    [relay, togglePaused, leave],
  );
  if (!relay.client || !group || !member) return null;
  const label =
    kind === "waiting" || kind === "paused" || kind === "running"
      ? t(`executionRelay.${kind}`)
      : t(`executionRelay.statuses.${kind}`);
  const reasonKey = `executionRelay.reasons.${group.reason ?? "manual"}`;
  const finished = group.members.filter(isFinished);
  const pending = group.members
    .filter((entry) => !isFinished(entry))
    .toSorted((a, b) => Number(isRunning(b)) - Number(isRunning(a)));
  const row = (entry: RelayMember) => {
    const info = display.get(relayAddressKey(entry.address));
    return (
      <RelayMemberRow
        key={relayAddressKey(entry.address)}
        member={entry}
        title={info?.title || t("executionRelay.untitled")}
        host={info?.host || t("executionRelay.unknownHost")}
        paused={group.paused}
        onClose={close}
        onOpenAgent={onOpenAgent}
      />
    );
  };
  return (
    <View style={styles.container} testID="execution-relay-status">
      <Button variant="ghost" size="sm" onPress={show} leftIcon={leading}>
        {`${label} · ${group.members.length}`}
      </Button>
      <AdaptiveModalSheet
        visible={visible && panelActive}
        onClose={close}
        header={header}
        footer={footer}
        contentStyle={styles.memberList}
      >
        {group.paused ? (
          <View style={styles.pauseReason}>
            <Text style={styles.muted}>
              {t(reasonKey, { defaultValue: t("executionRelay.paused") })}
            </Text>
          </View>
        ) : null}
        {pending.map(row)}
        {finished.length ? (
          <>
            <PressHighlight
              {...webFinishedState}
              onPress={toggleFinished}
              style={styles.finishedToggle}
              accessibilityRole="button"
              accessibilityState={finishedState}
            >
              <DensityIcon
                icon={showFinished ? ChevronDown : ChevronRight}
                size="sm"
                color="foregroundMuted"
              />
              <Text style={styles.muted}>
                {t("executionRelay.finishedMembers", { count: finished.length })}
              </Text>
            </PressHighlight>
            {showFinished ? finished.map(row) : null}
          </>
        ) : null}
      </AdaptiveModalSheet>
    </View>
  );
}

function RelayGroupFooter({
  relay,
  togglePaused,
  leave,
}: {
  relay: ReturnType<typeof useRelay>;
  togglePaused(): void;
  leave(): void;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const actionStyle = useMemo(() => [styles.actions, compact && styles.actionsCompact], [compact]);
  if (!relay.group || !relay.member) return null;
  return (
    <View style={styles.container}>
      <View style={actionStyle}>
        <Button
          variant="outline"
          size="sm"
          loading={relay.mutation.isPending}
          onPress={togglePaused}
        >
          {t(relay.group.paused ? "executionRelay.resume" : "executionRelay.pause")}
        </Button>
        {!isRunning(relay.member) && !isFinished(relay.member) ? (
          <Button variant="ghost" size="sm" disabled={relay.mutation.isPending} onPress={leave}>
            {t("executionRelay.leave")}
          </Button>
        ) : null}
      </View>
      {relay.mutation.error || relay.query.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {(relay.mutation.error ?? relay.query.error)?.message}
        </Text>
      ) : null}
    </View>
  );
}

function entryKind(member: RelayMember | undefined, paused: boolean): RelayIndicatorKind {
  if (paused) return "paused";
  return member ? memberKind(member, false) : "waiting";
}

function isRunning(member: RelayMember) {
  return member.status === "running" || member.status === "starting";
}
function isFinished(member: RelayMember) {
  return member.status === "completed" || member.status === "canceled";
}
function memberKind(member: RelayMember, paused: boolean): RelayIndicatorKind {
  if (member.status === "queued") return paused ? "paused" : "waiting";
  return member.status === "running" || member.status === "starting" ? "running" : member.status;
}

function RelayMemberRow({
  member,
  title,
  host,
  paused,
  onClose,
  onOpenAgent,
}: {
  member: RelayMember;
  title: string;
  host: string;
  paused: boolean;
  onClose(): void;
  onOpenAgent(address: RelayAddress): void;
}) {
  const { t } = useTranslation();
  const open = useCallback(() => {
    onClose();
    onOpenAgent(member.address);
  }, [member.address, onClose, onOpenAgent]);
  const [hovered, setHovered] = useState(false);
  const hoverIn = useCallback(() => setHovered(true), []);
  const hoverOut = useCallback(() => setHovered(false), []);
  const rowStyle = useMemo(() => [styles.member, hovered && styles.memberHighlight], [hovered]);
  const kind = memberKind(member, paused);
  const label =
    kind === "paused" ? t("executionRelay.paused") : t(`executionRelay.statuses.${member.status}`);
  return (
    <PressHighlight
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${host}, ${label}`}
      style={rowStyle}
      onHoverIn={hoverIn}
      onHoverOut={hoverOut}
      highlightStyle={styles.memberHighlight}
    >
      <View style={styles.memberIcon}>
        <RelayIndicator kind={kind} />
      </View>
      <View style={styles.memberText}>
        <Text
          style={isFinished(member) ? styles.finishedTitle : styles.memberTitle}
          numberOfLines={2}
        >
          {title}
        </Text>
        <Text
          style={styles.muted}
          numberOfLines={1}
        >{`${host} · ${member.provider === "claude" ? "Claude Code" : "Codex"}`}</Text>
      </View>
      <StatusBadge
        label={label}
        size="xs"
        variant={member.status === "invalid" ? "warning" : "muted"}
      />
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[2] },
  planActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-end",
    gap: theme.spacing[2],
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  actionsCompact: { flexDirection: "column", alignItems: "stretch" },
  memberList: { paddingVertical: theme.spacing[2], gap: 0 },
  member: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  memberHighlight: { backgroundColor: theme.colors.surface2 },
  memberIcon: { paddingTop: theme.spacing[0.5] },
  memberText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  memberTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.5,
  },
  finishedTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.5,
  },
  finishedToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
  },
  pauseReason: { paddingVertical: theme.spacing[2] },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
