import { test, expect } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { gotoWorkspace } from "../support/helpers/launcher";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  openNewWorkspaceComposer,
  submitNewWorkspacePrompt,
  submitNewWorkspaceEmpty,
} from "../support/helpers/new-workspace";

test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
        omp: { enabled: false },
        mock: { enabled: false },
        "mock-slow": { enabled: false },
      },
    },
  },
});

test("blocks a chat without available models, but allows an empty workspace", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "no-host-models-" });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "no-models-diagnostic",
  });
  try {
    const entries = (await client.getProvidersSnapshot()).entries;
    await client.patchDaemonConfig({
      providers: Object.fromEntries(entries.map((entry) => [entry.provider, { enabled: false }])),
    });
    await client.refreshProvidersSnapshot();
    await gotoWorkspace(page, workspace.workspaceId);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, workspace);
    await expect(page.getByTestId("new-workspace-defaults-issue")).toContainText(
      "No models are available on this host",
    );
    const before = (await workspace.client.fetchWorkspaces()).entries.length;
    await submitNewWorkspacePrompt(page, "Cannot start a chat without a model");
    await expect(page).toHaveURL(/\/new/);
    expect((await workspace.client.fetchWorkspaces()).entries).toHaveLength(before);
    await page.getByRole("textbox", { name: "Message agent..." }).fill("");
    await submitNewWorkspaceEmpty(page);
    await expect(page).toHaveURL(/\/workspace\//);
    expect((await workspace.client.fetchWorkspaces()).entries).toHaveLength(before + 1);
  } finally {
    await client.close();
    await workspace.cleanup();
  }
});
