import React, { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { RelayState } from "@getpaseo/protocol/execution-relay";
import { useSessionStore } from "@/stores/session-store";
import { i18n } from "@/i18n/i18next";
import { RelayPlanActions, RelayStatus } from "./controls";
import { PlanCard } from "@/components/plan-card";
import { useIsRelayPlanManaged } from "./query";

// The parser's WASM loader is Metro-specific; these tests exercise the real card/footer layout.
vi.mock("@/components/markdown/renderer", () => ({
  MarkdownRenderer: ({ text }: { text: string }) => <span>{text}</span>,
}));
// Supply the host-registry adapter without bootstrapping app-wide connections in this harness.
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [
    { serverId: "local", label: "mac-studio" },
    { serverId: "remote", label: "us-193" },
  ],
}));

const openAgent = vi.fn();
const metrics = {
  frame: { x: 0, y: 0, width: 1200, height: 900 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
const source = { serverId: "local", agentId: "source" };
const target = { serverId: "remote", agentId: "target" };
const initial: RelayState = {
  groups: [],
  unavailableHosts: [],
  candidates: [
    { address: source, title: "Current plan", host: "Local", provider: "claude", state: "plan" },
    {
      address: target,
      title: "Other ready plan",
      host: "Remote",
      provider: "codex",
      state: "plan",
    },
  ],
};
beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
  useSessionStore.getState().clearSession("local");
  vi.restoreAllMocks();
  openAgent.mockClear();
});

function CurrentPlan() {
  const managed = useIsRelayPlanManaged(source, "source-plan");
  const footer = useMemo(
    () =>
      managed ? null : (
        <RelayPlanActions serverId="local" agentId="source" requestId="source-plan">
          <button type="button">Implement</button>
        </RelayPlanActions>
      ),
    [managed],
  );
  return <PlanCard text="A ready plan" footer={footer} />;
}

async function mount(failure = false) {
  const client = new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "relay-ui-test" });
  const get = vi
    .spyOn(client, "getExecutionRelayState")
    .mockResolvedValue(structuredClone(initial));
  const joined: RelayState = {
    ...initial,
    groups: [
      {
        id: "group",
        paused: false,
        reason: null,
        members: [
          {
            address: target,
            title: "Other ready plan",
            host: "Remote",
            provider: "codex",
            status: "running",
            planRequestId: "target-plan",
            planHash: "target",
            turnId: "target-turn",
          },
          {
            address: source,
            title: "Current plan",
            host: "Local",
            provider: "claude",
            status: "queued",
            planRequestId: "source-plan",
            planHash: "source",
            turnId: null,
          },
          {
            address: { serverId: "local", agentId: "completed" },
            title: "Finished implementation",
            host: "Local",
            provider: "claude",
            status: "completed",
            planRequestId: "completed-plan",
            planHash: "done",
            turnId: "done",
          },
        ],
      },
    ],
  };
  const join = vi.spyOn(client, "joinExecutionRelay").mockImplementation(async () => {
    if (failure) throw new Error("The selected host disconnected. Retry when it reconnects.");
    get.mockResolvedValue(joined);
    return joined;
  });
  const update = vi
    .spyOn(client, "updateExecutionRelay")
    .mockImplementation(async (_address, action) => {
      const state =
        action === "leave"
          ? { ...initial, groups: [] }
          : {
              ...joined,
              groups: [
                {
                  ...joined.groups[0],
                  paused: action === "pause",
                  reason: action === "pause" ? "manual" : null,
                },
              ],
            };
      get.mockResolvedValue(state);
      return state;
    });
  useSessionStore.getState().initializeSession("local", client);
  useSessionStore.getState().updateSessionServerInfo("local", {
    serverId: "local",
    hostname: "Local",
    version: "0.13.0",
    features: { executionRelay: true },
    desktopManaged: true,
  });
  await act(async () =>
    root.render(
      <SafeAreaProvider initialMetrics={metrics}>
        <QueryClientProvider client={queryClient}>
          <CurrentPlan />
          <RelayStatus serverId="local" agentId="source" onOpenAgent={openAgent} />
        </QueryClientProvider>
      </SafeAreaProvider>,
    ),
  );
  await expect.poll(() => get.mock.calls.length).toBeGreaterThan(0);
  await act(async () => within(container).getByRole("button", { name: "Relay ▾" }).click());
  const option = await within(document.body).findByRole("button", { name: /Other ready plan/ });
  await act(async () => option.click());
  return { join, update };
}

test("selecting a relay hides the entire plan footer and keeps a single relay entry", async () => {
  const { join } = await mount();
  await expect.poll(() => container.textContent).toContain("Waiting for relay · 3");
  expect(container.querySelector('[data-testid="plan-card-footer"]')).toBeNull();
  expect(within(container).queryByRole("button", { name: "Relay ▾" })).toBeNull();
  expect(join.mock.calls).toEqual([[source, "source-plan", target]]);
  expect(within(container).queryByRole("button", { name: "Implement" })).toBeNull();
  expect(within(container).getByRole("button", { name: /Waiting for relay · 3/ })).toBeVisible();
});

test("failed selection keeps the error visible and allows choosing the relay again", async () => {
  await mount(true);
  await expect
    .poll(() => container.textContent)
    .toContain("The selected host disconnected. Retry when it reconnects.");
  expect(within(container).getByRole("button", { name: "Implement" })).toBeVisible();
  const retry = within(container).getByRole("button", { name: "Relay ▾" });
  expect(retry).toBeEnabled();
  await act(async () => retry.click());
  expect(
    await within(document.body).findByRole("button", { name: /Other ready plan/ }),
  ).toBeVisible();
});

test("member list aligns readable metadata, folds finished conversations and opens a member", async () => {
  await mount();
  await act(async () =>
    (await within(container).findByRole("button", { name: /Waiting for relay · 3/ })).click(),
  );
  const modal = within(document.body);
  expect(modal.getByText("3 conversations · Full Access")).toBeVisible();
  expect(modal.getByText("us-193 · Codex")).toBeVisible();
  expect(modal.getByText("mac-studio · Claude Code")).toBeVisible();
  expect(modal.queryByText("Finished implementation")).toBeNull();
  const finished = modal.getByRole("button", { name: "Finished (1)" });
  expect(finished).toHaveAttribute("aria-expanded", "false");
  await act(async () => finished.click());
  expect(modal.getByText("Finished implementation")).toBeVisible();
  await act(async () =>
    modal.getByRole("button", { name: "Other ready plan, us-193, Running" }).click(),
  );
  expect(openAgent).toHaveBeenLastCalledWith(target);
});

test("canceling the current queued relay restores the plan controls", async () => {
  const { update } = await mount();
  await act(async () =>
    (await within(container).findByRole("button", { name: /Waiting for relay · 3/ })).click(),
  );
  await act(async () =>
    within(document.body)
      .getByRole("button", { name: "Cancel relay for this conversation" })
      .click(),
  );
  await expect
    .poll(() => within(container).queryByRole("button", { name: "Implement" }))
    .not.toBeNull();
  expect(update).toHaveBeenCalledWith(source, "leave");
  expect(within(container).getByRole("button", { name: "Relay ▾" })).toBeVisible();
  expect(container.querySelector('[data-testid="execution-relay-status"]')).toBeNull();
});

test("pausing the group exposes its state while keeping the selected plan approval hidden", async () => {
  const { update } = await mount();
  await act(async () =>
    (await within(container).findByRole("button", { name: /Waiting for relay · 3/ })).click(),
  );
  await act(async () => within(document.body).getByRole("button", { name: "Pause relay" }).click());
  expect(update).toHaveBeenCalledWith(source, "pause");
  await expect.poll(() => document.body.textContent).toContain("Relay is paused.");
  expect(within(document.body).getByRole("button", { name: "Resume relay" })).toBeVisible();
  expect(container.querySelector('[data-testid="plan-card-footer"]')).toBeNull();
});
