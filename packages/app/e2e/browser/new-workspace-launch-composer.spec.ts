import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import {
  expectNewWorkspaceDraft,
  fillNewWorkspaceDraft,
  openNewWorkspaceComposer,
} from "../support/helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import {
  attachButton,
  expectChatComposerActive,
  expectTerminalComposerActive,
  fillTerminalPrompt,
  seedTerminalProfiles,
  submitTerminalLaunch,
  expectWorkspaceOpensWithTerminalTab,
  selectChatLaunch,
  selectLaunchOption,
  terminalPromptInput,
  type TerminalProfile,
  type TerminalProfileSeed,
} from "../support/helpers/new-workspace-launch";
import { getServerId } from "../support/helpers/server-id";

const PROFILE: TerminalProfile = {
  id: "e2e-composer-profile",
  name: "Composer Profile",
  command: "/bin/echo",
  args: ["{{{prompt}}}"],
};

test.describe("New workspace: the composer is one control in two modes", () => {
  let workspace: SeededWorkspace;
  let profileSeed: TerminalProfileSeed;

  test.beforeEach(async () => {
    workspace = await seedWorkspace({ repoPrefix: "launch-composer-" });
    profileSeed = await seedTerminalProfiles([PROFILE]);
  });

  test.afterEach(async () => {
    await profileSeed.restore();
    await workspace?.cleanup();
  });

  test("creating a terminal workspace preserves the project's remembered agent setup", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const preferences = {
      provider: "mock",
      providerPreferences: { mock: { model: "ten-second-stream", mode: "load-test" } },
      isolation: "local",
    };
    await page.evaluate(
      ({ key, serverId, preferences: saved }) =>
        localStorage.setItem(
          "@paseo:project-workspace-defaults",
          JSON.stringify({ [key]: { serverId, preferences: saved } }),
        ),
      { key: workspace.projectKey, serverId: getServerId(), preferences },
    );
    await page.reload();
    await openNewWorkspaceComposer(page, workspace);
    await selectLaunchOption(page, PROFILE.id);
    await fillTerminalPrompt(page, "Terminal project defaults verification");
    await submitTerminalLaunch(page);
    await expectWorkspaceOpensWithTerminalTab(page);
    expect(
      await page.evaluate(
        (key) => JSON.parse(localStorage.getItem("@paseo:project-workspace-defaults") ?? "{}")[key],
        workspace.projectKey,
      ),
    ).toEqual({
      serverId: getServerId(),
      preferences,
      hostPreferences: { [getServerId()]: preferences },
    });
  });

  test("switching launch target does not leak draft text between chat and terminal, and drops the chat-only controls", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    await openNewWorkspaceComposer(page, {
      projectKey: workspace.projectKey,
      projectDisplayName: workspace.projectDisplayName,
    });

    await test.step("a chat draft does not leak into the terminal prompt", async () => {
      await fillNewWorkspaceDraft(page, "a chat-only draft");
      await selectLaunchOption(page, PROFILE.id);
      await expectTerminalComposerActive(page);
      await expect(terminalPromptInput(page)).toHaveValue("");
    });

    await test.step("the attachment button and mic are absent in terminal mode, and the submit button is inside the same surface", async () => {
      await expect(attachButton(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Start dictation" })).toHaveCount(0);
      await expect(
        page.locator('[data-testid="message-input-root"]:visible').getByRole("button", {
          name: "Launch",
        }),
      ).toBeVisible();
    });

    await test.step("a terminal draft does not leak back into chat, which keeps its own draft", async () => {
      await fillTerminalPrompt(page, "a terminal-only draft");
      await selectChatLaunch(page);
      await expectChatComposerActive(page);
      await expectNewWorkspaceDraft(page, "a chat-only draft");
    });

    await test.step("each side keeps its own draft across toggles, without either leaking into the other", async () => {
      await selectLaunchOption(page, PROFILE.id);
      await expectTerminalComposerActive(page);
      await expect(terminalPromptInput(page)).toHaveValue("a terminal-only draft");
    });
  });
});
