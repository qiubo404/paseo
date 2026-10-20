import { expect, test as base } from "../support/fixtures";
import { openProjectDirectoryWithHosts } from "../support/helpers/project-grouping";
import { projectPlacementViewKey } from "../support/helpers/project-view-key";
import {
  type IsolatedHostDaemon,
  startIsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import {
  expectNewWorkspaceProjectSelected,
  openGlobalNewWorkspaceComposer,
  openNewWorkspaceComposer,
  submitNewWorkspaceEmpty,
  selectWorkspaceIsolation,
  expectWorkspaceIsolationSelected,
  selectNewWorkspaceHost,
  selectNewWorkspaceProject,
} from "../support/helpers/new-workspace";
import {
  connectSeedClient,
  seedWorkspace,
  type SeedDaemonClient,
} from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { addConnectedHostsAndReload } from "../support/helpers/hosts";
import { switchWorkspaceViaSidebar } from "../support/helpers/workspace-ui";
import { createTempGitRepo } from "../support/helpers/workspace";
import path from "node:path";
import { chooseModel, expectRememberedModel } from "../support/helpers/model-memory";
import { seedModelProvider } from "../support/helpers/agent-profiles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import {
  submitNewWorkspacePrompt,
  fillNewWorkspaceDraft,
  expectNewWorkspaceDraft,
} from "../support/helpers/new-workspace";

const PRIMARY_HOST_LABEL = "Primary host";
const SECONDARY_HOST_LABEL = "Secondary host";
const SHARED_PROJECT_NAME = "Paseo";
const SHARED_REMOTE_URL = "https://github.com/getpaseo/paseo.git";

async function expectSavedProjectHost(
  page: Parameters<typeof selectNewWorkspaceHost>[0],
  projectKey: string,
  serverId: string,
) {
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          JSON.parse(localStorage.getItem("@paseo:project-workspace-defaults") ?? "{}")[key]
            ?.serverId,
        projectKey,
      ),
    )
    .toBe(serverId);
}

interface CreatedProject {
  projectId: string;
  projectKey: string;
  workspaceId: string;
}

interface CrossHostProjectScenario {
  contextWorkspaceId: string;
  primarySharedWorkspaceId: string;
  selectedProjectViewKey: string;
  sharedProjectKey: string;
  secondaryHost: {
    serverId: string;
    label: string;
    port: number;
  };
}

async function createProject(
  client: SeedDaemonClient,
  input: { projectPath: string; projectName: string; workspaceName: string },
): Promise<CreatedProject> {
  const created = await client.createWorkspace({
    source: { kind: "directory", path: input.projectPath },
    title: input.workspaceName,
  });
  if (!created.workspace) {
    throw new Error(created.error ?? `Failed to create project ${input.projectName}`);
  }

  await client.renameProject(created.workspace.projectId, input.projectName);
  const listed = await client.listProjects();
  const project = listed.projects.find(
    (candidate) => candidate.projectId === created.workspace?.projectId,
  );
  if (!project?.projectKey) {
    throw new Error(`Created project ${created.workspace.projectId} has no project key`);
  }

  return {
    projectId: created.workspace.projectId,
    projectKey: project.projectKey,
    workspaceId: created.workspace.id,
  };
}

async function openNewWorkspaceFromContextProject(
  page: Parameters<typeof openProjectDirectoryWithHosts>[0],
  scenario: CrossHostProjectScenario,
): Promise<void> {
  await openProjectDirectoryWithHosts(page, {
    hosts: [scenario.secondaryHost],
    primaryLabel: PRIMARY_HOST_LABEL,
  });
  await expect(
    page.getByTestId(`sidebar-project-row-${scenario.selectedProjectViewKey}`),
  ).toBeVisible();
  await switchWorkspaceViaSidebar({
    page,
    serverId: getServerId(),
    workspaceId: scenario.contextWorkspaceId,
  });
  await openGlobalNewWorkspaceComposer(page);
  await expectNewWorkspaceProjectSelected(page, "Context project");
}

const test = base.extend<{ crossHostProject: CrossHostProjectScenario }>({
  crossHostProject: async ({ page: _page }, provide) => {
    const secondaryDaemon: IsolatedHostDaemon = await startIsolatedHostDaemon(
      "new-workspace-project-preservation-secondary",
    );
    const contextRepo = await createTempGitRepo("new-workspace-context-");
    const primarySharedRepo = await createTempGitRepo("new-workspace-paseo-primary-", {
      originUrl: SHARED_REMOTE_URL,
    });
    const primaryDuplicateRepo = await createTempGitRepo("new-workspace-paseo-duplicate-", {
      originUrl: SHARED_REMOTE_URL,
    });
    const secondaryFallbackRepo = await createTempGitRepo("new-workspace-fallback-");
    const secondarySharedRepo = await createTempGitRepo("new-workspace-paseo-secondary-", {
      originUrl: SHARED_REMOTE_URL,
    });
    const primaryClient = await connectSeedClient();
    const secondaryClient = await connectSeedClient({ port: secondaryDaemon.port });
    const primaryProjects: CreatedProject[] = [];
    const secondaryProjects: CreatedProject[] = [];

    try {
      const contextProject = await createProject(primaryClient, {
        projectPath: contextRepo.path,
        projectName: "Context project",
        workspaceName: "Context workspace",
      });
      primaryProjects.push(contextProject);
      const primarySharedProject = await createProject(primaryClient, {
        projectPath: primarySharedRepo.path,
        projectName: SHARED_PROJECT_NAME,
        workspaceName: "Primary Paseo workspace",
      });
      primaryProjects.push(primarySharedProject);
      const primaryDuplicateProject = await createProject(primaryClient, {
        projectPath: primaryDuplicateRepo.path,
        projectName: "Paseo duplicate",
        workspaceName: "Duplicate Paseo workspace",
      });
      primaryProjects.push(primaryDuplicateProject);
      secondaryProjects.push(
        await createProject(secondaryClient, {
          projectPath: secondaryFallbackRepo.path,
          projectName: "Aardvark project",
          workspaceName: "Secondary fallback workspace",
        }),
      );
      const secondarySharedProject = await createProject(secondaryClient, {
        projectPath: secondarySharedRepo.path,
        projectName: SHARED_PROJECT_NAME,
        workspaceName: "Secondary Paseo workspace",
      });
      secondaryProjects.push(secondarySharedProject);

      if (
        primarySharedProject.projectKey !== primaryDuplicateProject.projectKey ||
        primarySharedProject.projectKey !== secondarySharedProject.projectKey
      ) {
        throw new Error("Expected the Paseo clones to have the same equivalence key");
      }

      await provide({
        contextWorkspaceId: contextProject.workspaceId,
        primarySharedWorkspaceId: primarySharedProject.workspaceId,
        selectedProjectViewKey: projectPlacementViewKey(
          getServerId(),
          primarySharedProject.projectId,
        ),
        sharedProjectKey: primarySharedProject.projectKey,
        secondaryHost: {
          serverId: secondaryDaemon.serverId,
          label: SECONDARY_HOST_LABEL,
          port: secondaryDaemon.port,
        },
      });
    } finally {
      for (const project of primaryProjects) {
        await primaryClient.removeProject(project.projectId).catch(() => undefined);
      }
      for (const project of secondaryProjects) {
        await secondaryClient.removeProject(project.projectId).catch(() => undefined);
      }
      await primaryClient.close().catch(() => undefined);
      await secondaryClient.close().catch(() => undefined);
      await contextRepo.cleanup().catch(() => undefined);
      await primarySharedRepo.cleanup().catch(() => undefined);
      await primaryDuplicateRepo.cleanup().catch(() => undefined);
      await secondaryFallbackRepo.cleanup().catch(() => undefined);
      await secondarySharedRepo.cleanup().catch(() => undefined);
      await secondaryDaemon.close().catch(() => undefined);
    }
  },
});

test.describe("New workspace host project preservation", () => {
  test.describe.configure({ timeout: 180_000 });

  test("remembers model configurations per project and host, preserving drafts through switches and reload", async ({
    page,
    crossHostProject,
  }) => {
    const primaryId = "primary-host-model";
    const secondaryId = "secondary-host-model";
    const command = [process.execPath, path.resolve("e2e/fixtures/fake-pi-rpc.mjs")];
    const primaryProvider = await seedModelProvider({
      id: primaryId,
      label: "Primary provider",
      extends: "pi",
      command,
      models: [{ id: "primary-model", label: "Primary model", description: "Primary" }],
    });
    const secondaryClient = await connectDaemonClient<DaemonClient>({
      clientIdPrefix: "per-host-defaults",
      port: crossHostProject.secondaryHost.port,
    });
    await secondaryClient.patchDaemonConfig({
      providers: {
        [secondaryId]: {
          extends: "pi",
          label: "Secondary provider",
          enabled: true,
          command,
          models: [{ id: "secondary-model", label: "Secondary model", description: "Secondary" }],
        },
      },
    });
    const key = crossHostProject.selectedProjectViewKey;
    const open = async () => {
      const row = page.getByTestId(`sidebar-project-row-${key}`).filter({ visible: true });
      await row.hover();
      await page
        .getByTestId(`sidebar-project-new-worktree-${key}`)
        .filter({ visible: true })
        .click();
      await expect(page).toHaveURL(/\/new/);
    };
    try {
      await openProjectDirectoryWithHosts(page, {
        hosts: [crossHostProject.secondaryHost],
        primaryLabel: PRIMARY_HOST_LABEL,
      });
      await switchWorkspaceViaSidebar({
        page,
        serverId: getServerId(),
        workspaceId: crossHostProject.primarySharedWorkspaceId,
      });
      await open();
      await chooseModel(page, primaryId, "Primary model");
      await submitNewWorkspacePrompt(page, "Remember the primary host model");
      await expect(page).toHaveURL(/\/workspace\//);
      await expectSavedProjectHost(page, key, getServerId());
      await open();
      await fillNewWorkspaceDraft(page, "Keep this unsent message across hosts");
      await selectNewWorkspaceHost(page, SECONDARY_HOST_LABEL);
      await expect(page.getByTestId("new-workspace-model-switch-notice")).toHaveCount(0);
      await expect(page.getByTestId("new-workspace-defaults-issue")).toHaveCount(0);
      await expectNewWorkspaceDraft(page, "Keep this unsent message across hosts");
      await chooseModel(page, secondaryId, "Secondary model");
      await selectNewWorkspaceHost(page, PRIMARY_HOST_LABEL);
      await expectRememberedModel(page, "Primary model");
      await selectNewWorkspaceHost(page, SECONDARY_HOST_LABEL);
      await expectRememberedModel(page, "Secondary model");
      await expectSavedProjectHost(page, key, getServerId());
      await submitNewWorkspacePrompt(page, "Remember the secondary host model");
      await expect(page).toHaveURL(/\/workspace\//);
      await expectSavedProjectHost(page, key, crossHostProject.secondaryHost.serverId);
      await open();
      await expectRememberedModel(page, "Secondary model");
      await selectNewWorkspaceHost(page, PRIMARY_HOST_LABEL);
      await expectRememberedModel(page, "Primary model");
      await addConnectedHostsAndReload(page, [crossHostProject.secondaryHost], {
        primaryLabel: PRIMARY_HOST_LABEL,
      });
      await expectRememberedModel(page, "Secondary model");
      await selectNewWorkspaceHost(page, PRIMARY_HOST_LABEL);
      await expectRememberedModel(page, "Primary model");
      await page.screenshot({ path: test.info().outputPath("per-host-models-restored.png") });
    } finally {
      await secondaryClient
        .patchDaemonConfig({ removeProviders: [secondaryId] })
        .catch(() => undefined);
      await secondaryClient.close();
      await primaryProvider.restore();
    }
  });

  test("restores a project's successful host even when the active workspace is on another host", async ({
    page,
    crossHostProject,
  }) => {
    const originUrl = "https://github.com/paseo-e2e/project-workspace-defaults.git";
    const primary = await seedWorkspace({ repoPrefix: "defaults-primary-", repo: { originUrl } });
    const secondary = await seedWorkspace({
      repoPrefix: "defaults-secondary-",
      port: crossHostProject.secondaryHost.port,
      repo: { originUrl },
    });
    try {
      await openProjectDirectoryWithHosts(page, {
        hosts: [crossHostProject.secondaryHost],
        primaryLabel: PRIMARY_HOST_LABEL,
      });
      await switchWorkspaceViaSidebar({
        page,
        serverId: getServerId(),
        workspaceId: primary.workspaceId,
      });
      await openNewWorkspaceComposer(page, primary);
      await selectNewWorkspaceHost(page, SECONDARY_HOST_LABEL);
      await submitNewWorkspaceEmpty(page);
      await expect(page).toHaveURL(/\/workspace\//);
      await expectSavedProjectHost(
        page,
        primary.projectKey,
        crossHostProject.secondaryHost.serverId,
      );
      await switchWorkspaceViaSidebar({
        page,
        serverId: getServerId(),
        workspaceId: primary.workspaceId,
      });
      await openNewWorkspaceComposer(page, primary);
      await expect(page.getByTestId("host-picker-trigger")).toContainText(SECONDARY_HOST_LABEL);
      await selectNewWorkspaceHost(page, PRIMARY_HOST_LABEL);
      await expect(page.getByTestId("host-picker-trigger")).toContainText(PRIMARY_HOST_LABEL);
      await addConnectedHostsAndReload(page, [crossHostProject.secondaryHost], {
        primaryLabel: PRIMARY_HOST_LABEL,
      });
      await expect(page.getByTestId("host-picker-trigger")).toContainText(SECONDARY_HOST_LABEL);
      await page.screenshot({ path: test.info().outputPath("project-host-restored.png") });
    } finally {
      await secondary.cleanup();
      await primary.cleanup();
    }
  });

  test("keeps the equivalent project selected when one host has another clone", async ({
    page,
    crossHostProject,
  }) => {
    await openNewWorkspaceFromContextProject(page, crossHostProject);
    await selectNewWorkspaceProject(page, {
      projectKey: crossHostProject.sharedProjectKey,
      projectViewKey: crossHostProject.selectedProjectViewKey,
      projectDisplayName: SHARED_PROJECT_NAME,
    });
    await selectWorkspaceIsolation(page, "worktree");
    await selectNewWorkspaceHost(page, SECONDARY_HOST_LABEL);

    await expectNewWorkspaceProjectSelected(page, SHARED_PROJECT_NAME);
    await expectWorkspaceIsolationSelected(page, "worktree");
  });

  test("keeps the active workspace project selected when switching hosts", async ({
    page,
    crossHostProject,
  }) => {
    await openProjectDirectoryWithHosts(page, {
      hosts: [crossHostProject.secondaryHost],
      primaryLabel: PRIMARY_HOST_LABEL,
    });
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: crossHostProject.primarySharedWorkspaceId,
    });
    await openGlobalNewWorkspaceComposer(page);
    await expectNewWorkspaceProjectSelected(page, SHARED_PROJECT_NAME);

    await selectNewWorkspaceHost(page, SECONDARY_HOST_LABEL);

    await expectNewWorkspaceProjectSelected(page, SHARED_PROJECT_NAME);

    await addConnectedHostsAndReload(page, [crossHostProject.secondaryHost], {
      primaryLabel: PRIMARY_HOST_LABEL,
    });
    await expectNewWorkspaceProjectSelected(page, SHARED_PROJECT_NAME);
    await selectNewWorkspaceHost(page, SECONDARY_HOST_LABEL);

    await expectNewWorkspaceProjectSelected(page, SHARED_PROJECT_NAME);
  });
});
