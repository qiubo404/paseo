import { randomUUID } from "node:crypto";
import {
  parseAgentDeepLink,
  parseDraftDeepLink,
  type DesktopDeepLinkTarget,
  buildAgentDeepLinkRoute,
  buildDraftDeepLinkRoute,
} from "@getpaseo/protocol/agent-deep-link";

export function desktopDeepLinkRoute(target: DesktopDeepLinkTarget): string {
  return "draftId" in target ? buildDraftDeepLinkRoute(target) : buildAgentDeepLinkRoute(target);
}

export function parseDesktopDeepLink(input: string): DesktopDeepLinkTarget | null {
  const draft = parseDraftDeepLink(input);
  if (draft) return { ...draft, draftId: randomUUID() };
  return parseAgentDeepLink(input.replace(/^paseo-review:/, "paseo:"));
}

export function parseAgentDeepLinkFromArgv(argv: string[]): DesktopDeepLinkTarget | null {
  for (const arg of argv) {
    const target = parseDesktopDeepLink(arg);
    if (target) {
      return target;
    }
  }
  return null;
}

export class AgentNavigationInbox {
  private readonly readyWindows = new Set<number>();
  private readonly pendingByWindow = new Map<number, DesktopDeepLinkTarget>();

  windowLoading(webContentsId: number): void {
    this.readyWindows.delete(webContentsId);
  }

  windowReady(webContentsId: number): DesktopDeepLinkTarget | null {
    this.readyWindows.add(webContentsId);
    const pending = this.pendingByWindow.get(webContentsId) ?? null;
    this.pendingByWindow.delete(webContentsId);
    return pending;
  }

  deliverOrQueue(
    webContentsId: number,
    target: DesktopDeepLinkTarget,
  ): DesktopDeepLinkTarget | null {
    if (this.readyWindows.has(webContentsId)) {
      return target;
    }
    this.pendingByWindow.set(webContentsId, target);
    return null;
  }

  removeWindow(webContentsId: number): void {
    this.readyWindows.delete(webContentsId);
    this.pendingByWindow.delete(webContentsId);
  }
}
