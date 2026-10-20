import { mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { test, expect } from "../support/fixtures";
import { seedModelProvider } from "../support/helpers/agent-profiles";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { gotoWorkspace } from "../support/helpers/launcher";
import {
  openGlobalNewWorkspaceComposer,
  openNewWorkspaceComposer,
  selectWorkspaceIsolation,
  expectWorkspaceIsolationSelected,
  submitNewWorkspaceEmpty,
  submitNewWorkspacePrompt,
} from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { getServerId } from "../support/helpers/server-id";

import {
  chooseModel,
  reselectModel,
  startWithoutRememberedModel,
  expectSavedSelection,
  expectCreatedModelAgents,
  expectRememberedModel,
} from "../support/helpers/model-memory";

const PROVIDER = "model-memory-diagnostic";
const MODEL = "pi-profile-model";
const LABEL = "Pi profile model";

test("keeps a successfully created workspace when saving its preferences fails", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "project-defaults-save-failure-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, workspace);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === "@paseo:project-workspace-defaults")
          throw new DOMException("Preference storage full", "QuotaExceededError");
        original.call(this, key, value);
      };
    });
    await submitNewWorkspacePrompt(page, "Create once even if preference storage is full");
    await expect(page).toHaveURL(/\/workspace\//);
    await expect(
      page.getByText(/Workspace created, but its project configuration could not be saved/).first(),
    ).toBeVisible();
    const created = (await workspace.client.fetchWorkspaces()).entries.filter(
      (entry) => entry.projectId === workspace.projectId && entry.id !== workspace.workspaceId,
    );
    expect(created).toHaveLength(1);
    expect(
      await page.evaluate(() => localStorage.getItem("@paseo:project-workspace-defaults")),
    ).toBeNull();
    await page.screenshot({ path: test.info().outputPath("preference-save-failure.png") });
  } finally {
    await workspace.cleanup();
  }
});

test("keeps two projects independent through creation, cancellation, project changes and reload", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const first = await seedWorkspace({ repoPrefix: "project-defaults-a-" });
  const second = await seedWorkspace({ repoPrefix: "project-defaults-b-" });
  const provider = await seedModelProvider({
    id: PROVIDER,
    label: "Project defaults diagnostic",
    extends: "pi",
    command: [process.execPath, path.resolve("e2e/fixtures/fake-pi-rpc.mjs")],
    models: [
      { id: MODEL, label: LABEL, description: "First project model" },
      {
        id: "second-model",
        label: "Second project model",
        description: "Second project diagnostic",
      },
    ],
  });
  try {
    await gotoWorkspace(page, first.workspaceId);
    await page.evaluate(() => {
      localStorage.removeItem("@paseo:create-agent-preferences");
      const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
      if (!nonce) throw new Error("Missing fixture seed nonce");
      localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
    });
    await page.reload();
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, first);
    await chooseModel(page, PROVIDER, LABEL);
    expect(
      await page.evaluate(() => localStorage.getItem("@paseo:project-workspace-defaults")),
    ).toBeNull();
    await submitNewWorkspacePrompt(page, "Remember first project");
    await expect(page).toHaveURL(/\/workspace\//);
    await expectSavedSelection(page, PROVIDER, MODEL, first.projectKey);

    await openNewWorkspaceComposer(page, second);
    await chooseModel(page, PROVIDER, "Second project model");
    await submitNewWorkspacePrompt(page, "Remember second project");
    await expect(page).toHaveURL(/\/workspace\//);
    await expectSavedSelection(page, PROVIDER, "second-model", second.projectKey);

    await openNewWorkspaceComposer(page, first);
    await expectRememberedModel(page, LABEL);
    await selectWorkspaceIsolation(page, "worktree");
    await openNewWorkspaceComposer(page, second);
    await expectRememberedModel(page, "Second project model");
    await openNewWorkspaceComposer(page, first);
    await expectWorkspaceIsolationSelected(page, "local");
    await page.reload();
    await expectRememberedModel(page, LABEL);
    await expectWorkspaceIsolationSelected(page, "local");
    await page.screenshot({ path: test.info().outputPath("project-defaults-restored.png") });
  } finally {
    await provider.restore();
    await second.cleanup();
    await first.cleanup();
  }
});

test("replaces an unavailable remembered provider with an available host default without changing saved memory", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "project-defaults-unavailable-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await waitForSidebarHydration(page);
    await page.evaluate(
      ({ key, serverId }) =>
        localStorage.setItem(
          "@paseo:project-workspace-defaults",
          JSON.stringify({
            [key]: {
              serverId,
              preferences: {
                provider: "missing-provider",
                providerPreferences: { "missing-provider": { model: "removed-model" } },
              },
            },
          }),
        ),
      { key: workspace.projectKey, serverId: getServerId() },
    );
    await page.reload();
    await openNewWorkspaceComposer(page, workspace);
    await expect(page.getByTestId("new-workspace-model-switch-notice")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^Select model \(/ }).filter({ visible: true }),
    ).not.toHaveAccessibleName(/removed-model|Loading/);
    await expect(page.getByTestId("new-workspace-defaults-issue")).toHaveCount(0);
    expect(
      await page.evaluate(
        (key) =>
          JSON.parse(localStorage.getItem("@paseo:project-workspace-defaults")!)[key].preferences
            .provider,
        workspace.projectKey,
      ),
    ).toBe("missing-provider");
    await page.screenshot({ path: test.info().outputPath("unavailable-project-defaults.png") });
  } finally {
    await workspace.cleanup();
  }
});

test("retains a removed remembered host until the user explicitly selects an available host", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "project-defaults-host-" });
  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await waitForSidebarHydration(page);
    await page.evaluate(
      (key) =>
        localStorage.setItem(
          "@paseo:project-workspace-defaults",
          JSON.stringify({
            [key]: { serverId: "removed-host", preferences: { isolation: "local" } },
          }),
        ),
      workspace.projectKey,
    );
    await page.reload();
    await openNewWorkspaceComposer(page, workspace);
    await expect(page.getByTestId("host-picker-trigger")).toContainText("removed-host");
    await expect(page.getByTestId("new-workspace-defaults-issue")).toContainText("removed-host");
    await page.getByTestId("host-picker-trigger").click();
    await page.getByTestId(`new-workspace-host-picker-option-${getServerId()}`).click();
    await expect(page.getByTestId("new-workspace-defaults-issue")).toHaveCount(0);
    await submitNewWorkspaceEmpty(page);
    await expect(page).toHaveURL(/\/workspace\//);
    await expect
      .poll(() =>
        page.evaluate(
          (key) =>
            JSON.parse(localStorage.getItem("@paseo:project-workspace-defaults") ?? "{}")[key]
              ?.serverId,
          workspace.projectKey,
        ),
      )
      .toBe(getServerId());
  } finally {
    await workspace.cleanup();
  }
});

async function expectProviderStatus(client: DaemonClient, cwd: string | undefined, status: string) {
  await expect
    .poll(
      async () =>
        (await client.getProvidersSnapshot(cwd ? { cwd } : undefined)).entries.find(
          (entry) => entry.provider === PROVIDER,
        )?.status,
      { timeout: 30_000 },
    )
    .toBe(status);
}

async function prepareCatalogState(
  client: DaemonClient,
  executable: string,
  cwd: string,
  hostStatus: "ready" | "unavailable",
) {
  await expectProviderStatus(client, undefined, "ready");
  await expectProviderStatus(client, cwd, "ready");
  await rename(executable, `${executable}.parked`);
  await client.refreshProvidersSnapshot({ providers: [PROVIDER] });
  await expectProviderStatus(client, undefined, "unavailable");
  await rename(`${executable}.parked`, executable);
  if (hostStatus === "ready") await client.refreshProvidersSnapshot({ providers: [PROVIDER] });
  await client.refreshProvidersSnapshot({ cwd, providers: [PROVIDER] });
  await expectProviderStatus(client, cwd, "ready");
  await expectProviderStatus(client, undefined, hostStatus);
}

for (const hostStatus of ["ready", "unavailable"] as const) {
  test(`remembers the manually selected model after two creations with a ${hostStatus} host catalog and ready project catalog`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const workspace = await seedWorkspace({ repoPrefix: "model-memory-scope-" });
    const binDir = await mkdtemp(path.join(tmpdir(), "paseo-model-memory-bin-"));
    const executable = path.join(binDir, "provider-node");
    await symlink(process.execPath, executable);
    const provider = await seedModelProvider({
      id: PROVIDER,
      label: "Model memory diagnostic",
      extends: "pi",
      command: [executable, path.resolve("e2e/fixtures/fake-pi-rpc.mjs")],
      models: [{ id: MODEL, label: LABEL, description: "Remembered selection diagnostic" }],
    });
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "model-memory" });
    try {
      await prepareCatalogState(client, executable, workspace.repoPath, hostStatus);

      await startWithoutRememberedModel(page);
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);
      for (const [index, select] of [chooseModel, reselectModel].entries()) {
        const count = index + 1;
        await test.step(`create workspace ${count} and return`, async () => {
          await select(page, PROVIDER, LABEL);
          expect(
            await page.evaluate(
              () =>
                JSON.parse(localStorage.getItem("@paseo:create-agent-preferences") ?? "{}")
                  .provider ?? null,
            ),
          ).toBeNull();
          await submitNewWorkspacePrompt(page, "Remember this model on the next workspace");
          await expect(page).toHaveURL(/\/workspace\//);
          await expectCreatedModelAgents(page, client, PROVIDER, MODEL, count);
          await openGlobalNewWorkspaceComposer(page);
          await expectSavedSelection(page, PROVIDER, MODEL, workspace.projectKey);
          await expectRememberedModel(page, LABEL);
        });
      }
      await submitNewWorkspaceEmpty(page);
      await expect(page).toHaveURL(/\/workspace\//);
      await openGlobalNewWorkspaceComposer(page);
      await expectSavedSelection(page, PROVIDER, MODEL, workspace.projectKey);
      await expectRememberedModel(page, LABEL);
    } finally {
      await client.close();
      await provider.restore();
      await workspace.cleanup();
      await rm(binDir, { recursive: true, force: true });
    }
  });
}
