import { Clock3, PauseCircle, Check, CircleAlert, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { DensityIcon } from "@/components/ui/density-icon";
import { StatusRing } from "@/components/status-ring";

export type RelayIndicatorKind =
  | "waiting"
  | "paused"
  | "running"
  | "completed"
  | "canceled"
  | "invalid";

export function RelayIndicator({ kind }: { kind: RelayIndicatorKind }) {
  const { t } = useTranslation();
  const label =
    kind === "waiting" || kind === "paused" || kind === "running"
      ? t(`executionRelay.${kind}`)
      : t(`executionRelay.statuses.${kind}`);
  const Icon = {
    waiting: Clock3,
    paused: PauseCircle,
    completed: Check,
    canceled: X,
    invalid: CircleAlert,
  }[kind === "running" ? "waiting" : kind];
  return (
    <View accessibilityRole="image" accessibilityLabel={label} testID={`relay-indicator-${kind}`}>
      {kind === "running" ? (
        <StatusRing />
      ) : (
        <DensityIcon
          icon={Icon}
          size="sm"
          color={kind === "invalid" ? "statusWarning" : "foregroundMuted"}
        />
      )}
    </View>
  );
}
