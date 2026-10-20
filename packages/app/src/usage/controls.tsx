import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { UsageRefreshButton } from "./refresh-button";
import { UsageOptions } from "./options";
import type { UsageView } from "./types";

/** Refresh and preferences for a single host settings section. */
export function UsageControls({ view, onRefresh }: { view: UsageView; onRefresh: () => void }) {
  const busy = view.kind === "loading" || (view.kind === "ready" && view.isRefreshing);
  return (
    <View style={styles.controls}>
      {view.kind === "unavailable" ? null : (
        <>
          <UsageRefreshButton busy={busy} onRefresh={onRefresh} />
          <UsageOptions />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  controls: {
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
