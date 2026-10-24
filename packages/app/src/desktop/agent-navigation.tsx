import { useEffect } from "react";
import { router } from "expo-router";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost } from "@/desktop/host";
import { useStableEvent } from "@/hooks/use-stable-event";
import { navigateToAgent } from "@/utils/navigate-to-agent";

interface OpenAgentEventPayload {
  serverId?: unknown;
  agentId?: unknown;
  path?: unknown;
  prompt?: unknown;
  draftId?: unknown;
}

export function AgentNavigationListener() {
  const openAgent = useStableEvent((payload: OpenAgentEventPayload | null) => {
    if (
      typeof payload?.path === "string" &&
      typeof payload.prompt === "string" &&
      typeof payload.draftId === "string"
    ) {
      router.navigate({
        pathname: "/new",
        params: {
          dir: payload.path,
          prompt: payload.prompt,
          draftId: payload.draftId,
          local: "1",
        },
      });
      return;
    }
    const serverId = typeof payload?.serverId === "string" ? payload.serverId.trim() : "";
    const agentId = typeof payload?.agentId === "string" ? payload.agentId.trim() : "";
    if (!serverId || !agentId) {
      return;
    }
    navigateToAgent({ serverId, agentId });
  });

  useEffect(() => {
    const host = getDesktopHost();
    const ready = host?.agentNavigation?.ready;
    if (typeof host?.events?.on !== "function" || typeof ready !== "function") {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      let dispose: (() => void) | null = null;
      try {
        dispose = await listenToDesktopEvent<OpenAgentEventPayload>("open-agent", openAgent);
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
        const pending = await ready();
        if (!disposed && pending) {
          openAgent(pending);
        }
      } catch {
        dispose?.();
        if (unlisten === dispose) {
          unlisten = null;
        }
        if (!disposed) {
          retryTimer = setTimeout(() => void connect(), 1_000);
        }
      }
    };

    void connect();

    return () => {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      unlisten?.();
    };
  }, [openAgent]);

  return null;
}
