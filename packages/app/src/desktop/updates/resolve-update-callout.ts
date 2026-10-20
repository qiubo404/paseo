import type { DesktopAppUpdateStatus } from "@/desktop/updates/use-desktop-app-updater";
import { i18n } from "@/i18n/i18next";

export type UpdateCalloutBody =
  | { kind: "notice"; versionLabel: string | null }
  | { kind: "available"; versionLabel: string | null }
  | { kind: "installing" }
  | { kind: "error"; message: string };

export type UpdateCalloutActionRole = "changelog" | "install" | "retry";

export interface UpdateCalloutActionDescriptor {
  role: UpdateCalloutActionRole;
  label: string;
  variant?: "primary" | "secondary";
  disabled?: boolean;
}

export interface UpdateCalloutDescriptor {
  id: "desktop-update";
  dismissalKey: string;
  priority: number;
  title: string;
  body: UpdateCalloutBody;
  showGiftIcon: boolean;
  variant: "default" | "error";
  actions: UpdateCalloutActionDescriptor[];
  testID: "update-callout";
}

export interface ResolveUpdateCalloutInput {
  notificationOnly?: boolean;
  isDesktopApp: boolean;
  status: DesktopAppUpdateStatus;
  isInstalling: boolean;
  availableUpdate: { latestVersion?: string | null } | null;
  errorMessage: string | null;
}

function formatVersionLabel(latestVersion: string | null | undefined): string | null {
  if (!latestVersion) return null;
  return `v${latestVersion.replace(/^v/i, "")}`;
}

export function resolveUpdateCalloutDescriptor(
  input: ResolveUpdateCalloutInput,
): UpdateCalloutDescriptor | null {
  if (!input.isDesktopApp) return null;
  if (input.status !== "available" && input.status !== "installing" && input.status !== "error") {
    return null;
  }

  const isError = input.status === "error";
  const isInstalling = input.isInstalling;
  const isAvailable = !isInstalling && !isError;

  const latestVersion = input.availableUpdate?.latestVersion ?? null;
  const dismissalKey = `desktop-update:${input.status}:${latestVersion ?? "unknown"}`;

  if (input.notificationOnly) {
    if (!isAvailable) return null;
    return {
      id: "desktop-update",
      dismissalKey,
      priority: 200,
      title: i18n.t("desktop.updates.callout.officialReleaseTitle"),
      body: { kind: "notice", versionLabel: formatVersionLabel(latestVersion) },
      showGiftIcon: true,
      variant: "default",
      actions: [],
      testID: "update-callout",
    };
  }

  let title: string;
  let body: UpdateCalloutBody;
  if (isInstalling) {
    title = i18n.t("desktop.updates.callout.installingTitle");
    body = { kind: "installing" };
  } else if (isError) {
    title = i18n.t("desktop.updates.callout.failedTitle");
    body = {
      kind: "error",
      message: input.errorMessage ?? i18n.t("desktop.updates.callout.genericError"),
    };
  } else {
    title = i18n.t("desktop.updates.callout.availableTitle");
    body = { kind: "available", versionLabel: formatVersionLabel(latestVersion) };
  }

  const actions: UpdateCalloutActionDescriptor[] = [
    { role: "changelog", label: i18n.t("desktop.updates.callout.whatsNew") },
  ];
  if (isError) {
    actions.push({ role: "retry", label: i18n.t("common.actions.retry"), variant: "primary" });
  } else {
    actions.push({
      role: "install",
      label: isInstalling
        ? i18n.t("desktop.updates.callout.installingAction")
        : i18n.t("desktop.updates.callout.installAndRestart"),
      variant: "primary",
      disabled: isInstalling,
    });
  }

  return {
    id: "desktop-update",
    dismissalKey,
    priority: 200,
    title,
    body,
    showGiftIcon: isAvailable,
    variant: isError ? "error" : "default",
    actions,
    testID: "update-callout",
  };
}
