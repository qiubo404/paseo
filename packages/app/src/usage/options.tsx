import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Settings } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { extraMutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { SettingsRow, SettingsSwitch } from "@/components/settings";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { settingsStyles } from "@/styles/settings";
import { HostFilter } from "@/components/hosts/host-filter";
import { usageCopy } from "./copy";
import { useUsagePreferences } from "./display";
import { useUsageInSidebar } from "./in-sidebar";
import { useUsageHostSelection } from "./hosts";
import type { UsageDisplayAs } from "./preferences";

const DISPLAY_AS_OPTIONS: SegmentedControlOption<UsageDisplayAs>[] = [
  { value: "used", label: usageCopy.displayUsed, testID: "usage-display-used" },
  { value: "remaining", label: usageCopy.displayRemaining, testID: "usage-display-remaining" },
];

const ThemedSettings = withUnistyles(Settings);

function usageHostOptionTestID(serverId: string): string {
  return `usage-host-filter-item-${serverId}`;
}

/** The shared usage preferences, opened from a cog as a popover or compact sheet. */
export function UsageOptions() {
  const { t } = useTranslation();
  const sidebarHostLabel = t("sidebar.usageHost");
  const compact = useIsCompactFormFactor();
  const { display } = useUsagePreferences();
  const { inSidebar, setInSidebar } = useUsageInSidebar();
  const { serverId, connectedHosts, select } = useUsageHostSelection();
  return (
    <DropdownMenu compactMode="sheet">
      <ToolbarButton
        kind="menu"
        label={usageCopy.options}
        compact={compact}
        testID="usage-options-menu"
      >
        <ThemedSettings
          size={paneContentToolbarIconSize(compact)}
          uniProps={extraMutedIconColorMapping}
        />
      </ToolbarButton>
      <DropdownMenuContent
        align="end"
        width={340}
        sheetTitle={usageCopy.options}
        testID="usage-options-surface"
      >
        <View testID="usage-options-fields">
          <SettingsSwitch
            label={usageCopy.showInSidebar}
            hint={usageCopy.showInSidebarHint}
            value={inSidebar}
            onValueChange={setInSidebar}
            testID="usage-show-in-sidebar"
          />
          {inSidebar && serverId && connectedHosts.length > 1 ? (
            <View style={settingsStyles.rowBorder}>
              <SettingsRow label={sidebarHostLabel}>
                <HostFilter
                  hosts={connectedHosts}
                  selectedHost={serverId}
                  onSelectHost={select}
                  includeAllHost={false}
                  title={sidebarHostLabel}
                  triggerTestID="usage-host-filter-trigger"
                  hostOptionTestID={usageHostOptionTestID}
                />
              </SettingsRow>
            </View>
          ) : null}
          <View style={settingsStyles.rowBorder}>
            <SettingsRow label={usageCopy.displayAs}>
              <SegmentedControl
                options={DISPLAY_AS_OPTIONS}
                value={display.displayAs}
                onValueChange={display.setDisplayAs}
                size="sm"
                testID="usage-display-as"
              />
            </SettingsRow>
          </View>
        </View>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
