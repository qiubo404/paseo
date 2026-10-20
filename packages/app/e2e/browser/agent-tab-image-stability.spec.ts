import type { Page } from "@playwright/test";
import type { SessionInboundMessage } from "@getpaseo/protocol/messages";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { delayFileReadResponse } from "../support/helpers/file-read-gate";
import { loadSessionMessageReaders } from "../support/helpers/new-workspace";
import {
  expectCompletedDiagram,
  openDiagramFullscreen,
  expectFullscreenDiagram,
} from "../support/helpers/diagram";
import { expect, test as base } from "../support/fixtures";
import {
  appendSettledTimelineTurns,
  createNearTenMegabyteAssistantPng,
  createSettledMockAgent,
  createSmallAssistantPng,
  emitSettledAssistantImage,
  expectAssistantImageNotMounted,
  expectAssistantImageRendered,
  openAssistantImageTimeline,
  openExistingImageAgentTabs,
  remountAndRecoverAssistantImageFromHistory,
  sendFollowUpAndExpectVisibleResponse,
  switchAwayAndBackWithoutImageInstability,
  userPagesUntilAssistantImageRenders,
} from "../support/helpers/assistant-images";
import { expectAgentReadyToInterrupt } from "../support/helpers/agent-stream";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import path from "node:path";
import {
  rememberTimelineViewport,
  scrollTimelinePromptIntoView,
} from "../support/helpers/timeline-pagination";
import {
  fillComposerDraft,
  expectComposerDraft,
  expectComposerFocused,
  openImageLightbox,
  closeImageLightbox,
} from "../support/helpers/composer";

const test = base.extend<{ imageWorkspace: SeededWorkspace }>({
  imageWorkspace: async ({ page: _page }, provide) => {
    const workspace = await seedWorkspace({ repoPrefix: "agent-tab-image-stability-" });
    try {
      await provide(workspace);
    } finally {
      await workspace.cleanup();
    }
  },
});

test("right-click adds the displayed assistant snapshot without replacing text or existing review comments", async ({
  imageWorkspace: workspace,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const frames = await loadSessionMessageReaders();
  const sent: Array<Extract<SessionInboundMessage, { type: "send_agent_message_request" }>> = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      const message = frames.client(payload);
      if (message?.type === "send_agent_message_request") sent.push(message);
    }),
  );
  const image = await createSmallAssistantPng(workspace, {
    alt: "Image to review",
    fileName: "review-original.png",
    width: 160,
    height: 240,
  });
  const agent = await createSettledMockAgent(
    workspace,
    "Add assistant image",
    `Before image.\n\n![${image.alt}](${image.relativePath})\n\nAfter image.`,
  );
  await emitSettledAssistantImage(workspace.client, agent, image);
  await openAssistantImageTimeline(page, agent);
  await expectAssistantImageRendered(page, image);
  const picture = page.getByRole("button", { name: image.alt, exact: true }).first();
  const prose = page.getByTestId("assistant-message").getByText("Before image.", { exact: true });
  const proseContextMenuWasPrevented = await prose.evaluate((element) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(proseContextMenuWasPrevented).toBe(false);
  await expect(page.getByTestId("assistant-image-add-to-chat")).not.toBeVisible();
  await picture.click();
  await expect(page.getByTestId("attachment-lightbox")).toBeVisible();
  await expect(page.getByTestId("image-review-done")).not.toBeVisible();
  await closeImageLightbox(page);
  const original = await picture.evaluate(async (element) => {
    const img = element instanceof HTMLImageElement ? element : element.querySelector("img");
    if (!img) throw new Error("Missing image element");
    return Array.from(new Uint8Array(await (await fetch(img.src)).arrayBuffer()));
  });
  await fillComposerDraft(page, "Keep this draft text");
  await writeFile(
    path.join(workspace.repoPath, image.relativePath),
    "The source file has since changed",
  );
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await picture.click({ button: "right" });
  await expect(page.getByTestId("assistant-image-copy")).toHaveText("Copy image");
  await page.getByTestId("assistant-image-copy").click();
  await expect(page.getByTestId("assistant-image-copy")).not.toBeVisible();
  const clipboardPixels = await page.evaluate(async () => {
    const clipboard = await navigator.clipboard.read();
    const blob = await clipboard[0].getType("image/png");
    const bitmap = await createImageBitmap(blob);
    const result = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return result;
  });
  expect(clipboardPixels).toEqual({ width: 160, height: 240 });
  await expectComposerDraft(page, "Keep this draft text");
  await expect(page.getByTestId("composer-image-attachment-pill")).toHaveCount(0);
  await picture.click({ button: "right" });
  await expect(page.getByTestId("assistant-image-add-to-chat")).toBeVisible();
  await page.getByTestId("assistant-image-add-to-chat").click();
  await expect(page.getByTestId("composer-image-attachment-pill")).toHaveCount(1);
  await expectComposerDraft(page, "Keep this draft text");
  await expectComposerFocused(page);
  await expect(page.getByTestId("attachment-lightbox")).not.toBeVisible();
  // Removing a draft copy must not delete the assistant's cached snapshot.
  const added = page.getByTestId("composer-image-attachment-pill");
  await added.hover();
  await added
    .locator("..")
    .getByRole("button", { name: "Remove image attachment", exact: true })
    .click();
  await expect(added).toHaveCount(0);
  await picture.click({ button: "right" });
  await page.getByTestId("assistant-image-add-to-chat").click();
  await expect(added).toHaveCount(1);
  await openImageLightbox(page);
  const preview = page.getByTestId("attachment-lightbox-image").locator("img");
  await expect(preview).toBeVisible();
  expect(
    await preview.evaluate(async (element) => {
      if (!(element instanceof HTMLImageElement)) throw new Error("Missing image element");
      return Array.from(new Uint8Array(await (await fetch(element.src)).arrayBuffer()));
    }),
  ).toEqual(original);
  await page.getByTestId("attachment-lightbox-image").click({ position: { x: 20, y: 20 } });
  await page.getByTestId("image-review-comment").fill("保留这个截图批注");
  await page.getByTestId("image-review-save").click();
  await page.getByTestId("image-review-done").click();
  await picture.click({ button: "right" });
  await page.getByTestId("assistant-image-add-to-chat").click();
  await expect(page.getByTestId("composer-image-attachment-pill")).toHaveCount(1);
  await expect(page.getByTestId("image-review-count")).toHaveText("1");
  await page.screenshot({ path: testInfo.outputPath("assistant-image-added-to-draft.png") });
  // The persisted attachment remains usable even though reloading the source message now fails.
  await page.reload();
  await expectComposerDraft(page, "Keep this draft text");
  await openImageLightbox(page);
  await expect(page.getByTestId("image-review-pin-1")).toBeVisible();
  await closeImageLightbox(page);
  await page.getByRole("textbox", { name: "Message agent..." }).first().press("Enter");
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].images).toEqual([
    expect.objectContaining({
      data: Buffer.from(original).toString("base64"),
      mimeType: "image/png",
    }),
  ]);
  expect(sent[0].attachments).toEqual([
    expect.objectContaining({ type: "text", text: expect.stringContaining("保留这个截图批注") }),
  ]);
  await expect(page.getByTestId("composer-image-attachment-pill")).toHaveCount(0);
  await workspace.client.waitForFinish(agent.id, 30_000);
});

test("network image addition retries failures and stays with its source chat while loading", async ({
  imageWorkspace: workspace,
  page,
}) => {
  test.setTimeout(120_000);
  const image = await createSmallAssistantPng(workspace, {
    alt: "Network image to review",
    fileName: "network.png",
    width: 100,
    height: 140,
  });
  const bytes = await readFile(path.join(workspace.repoPath, image.relativePath));
  let fail = false;
  let hold = false;
  let release: (() => void) | undefined;
  let heldResolve: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    heldResolve = resolve;
  });
  const server = createServer((_request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Cache-Control", "no-store");
    const finish = () => {
      if (response.writableEnded) return;
      response.writeHead(fail ? 503 : 200, { "Content-Type": "image/png" });
      response.end(fail ? "unavailable" : bytes);
    };
    if (hold) {
      release = finish;
      heldResolve?.();
    } else finish();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing image server port");
    const agent = await createSettledMockAgent(workspace, "Network source chat");
    const other = await createSettledMockAgent(workspace, "Other draft chat");
    await emitSettledAssistantImage(
      workspace.client,
      agent,
      image,
      `http://127.0.0.1:${address.port}/network.png`,
    );
    await openExistingImageAgentTabs(page, { imageAgent: agent, otherAgent: other });
    await expectAssistantImageRendered(page, image);
    await fillComposerDraft(page, "Source draft");
    const picture = page.getByRole("button", { name: image.alt, exact: true }).first();
    fail = true;
    await picture.click({ button: "right" });
    const action = page.getByTestId("assistant-image-add-to-chat");
    await action.click();
    await expect(action).toContainText("HTTP 503");
    await expect(page.getByTestId("composer-image-attachment-pill")).toHaveCount(0);
    fail = false;
    hold = true;
    await action.click();
    await held;
    await expect(action).toBeDisabled();
    await page.keyboard.press("Escape");
    await fillComposerDraft(page, "Source draft edited during loading");
    await page
      .getByTestId(`workspace-tab-agent_${other.id}`)
      .filter({ visible: true })
      .first()
      .click();
    await fillComposerDraft(page, "Other chat text");
    hold = false;
    release?.();
    await expect(
      page.getByTestId("composer-image-attachment-pill").filter({ visible: true }),
    ).toHaveCount(0);
    await expectComposerDraft(page, "Other chat text");
    await page
      .getByTestId(`workspace-tab-agent_${agent.id}`)
      .filter({ visible: true })
      .first()
      .click();
    await expect(
      page.getByTestId("composer-image-attachment-pill").filter({ visible: true }),
    ).toHaveCount(1);
    await expectComposerDraft(page, "Source draft edited during loading");
    await picture.click({ button: "right" });
    await action.click();
    await expect(action).not.toBeVisible();
    await expect(
      page.getByTestId("composer-image-attachment-pill").filter({ visible: true }),
    ).toHaveCount(1);
  } finally {
    hold = false;
    release?.();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("assistant images at paths with spaces, Unicode and literal percent escapes render", async ({
  imageWorkspace: workspace,
  page,
}) => {
  test.setTimeout(120_000);
  const image = await createSmallAssistantPng(workspace, {
    alt: "Angle destination image",
    fileName: "My image Мои.png",
  });
  const agent = await createSettledMockAgent(workspace, "Encoded image paths");
  await emitSettledAssistantImage(workspace.client, agent, image, `<${image.relativePath}>`);
  await openAssistantImageTimeline(page, agent);
  await expectAssistantImageRendered(page, image);

  const encodedImage = { ...image, alt: "Encoded destination image" };
  await emitSettledAssistantImage(
    workspace.client,
    agent,
    encodedImage,
    encodeURI(path.join(workspace.repoPath, image.relativePath)),
  );
  await expectAssistantImageRendered(page, encodedImage);

  const literalPercentImage = await createSmallAssistantPng(workspace, {
    alt: "Literal percent filename image",
    fileName: "literal%20name.png",
  });
  await emitSettledAssistantImage(
    workspace.client,
    agent,
    literalPercentImage,
    encodeURI(literalPercentImage.relativePath),
  );
  await expectAssistantImageRendered(page, literalPercentImage);
});

test("switching between settled agent tabs keeps a real assistant PNG rendered", async ({
  imageWorkspace: workspace,
  page,
}) => {
  test.setTimeout(120_000);
  const image = await createSmallAssistantPng(workspace, {
    alt: "Real file image",
    fileName: "assistant-preview.png",
  });
  const imageAgent = await createSettledMockAgent(workspace, "Image timeline");
  const otherAgent = await createSettledMockAgent(workspace, "Other timeline");
  await emitSettledAssistantImage(workspace.client, imageAgent, image);

  await openExistingImageAgentTabs(page, { imageAgent, otherAgent });
  await expectAssistantImageRendered(page, image);
  await switchAwayAndBackWithoutImageInstability(page, { image, imageAgent, otherAgent });
});

test("opens a timeline image in a zoomable lightbox", async ({
  imageWorkspace: workspace,
  page,
}) => {
  test.setTimeout(120_000);
  const image = await createSmallAssistantPng(workspace, {
    alt: "Zoomable timeline image",
    fileName: "zoomable-timeline-image.png",
  });
  const imageAgent = await createSettledMockAgent(workspace, "Zoomable image timeline");
  await emitSettledAssistantImage(workspace.client, imageAgent, image);
  await openAssistantImageTimeline(page, imageAgent);
  await expectAssistantImageRendered(page, image);

  await page.getByRole("button", { name: image.alt }).click();
  const lightboxImage = page.getByTestId("attachment-lightbox-image");
  const canvas = page.getByTestId("attachment-lightbox-canvas");
  await expect(lightboxImage).toBeVisible();
  await page.getByTestId("zoomable-viewport-toolbar").hover();
  const transformedContent = canvas.locator(":scope > div").first();
  const initialBox = await transformedContent.boundingBox();
  const canvasBox = await canvas.boundingBox();
  expect(initialBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();
  expect(initialBox!.width).toBeLessThan(canvasBox!.width);
  const zoomIn = page.getByRole("button", { name: "Zoom in", exact: true });
  await zoomIn.click();
  await zoomIn.click();
  await zoomIn.click();
  await zoomIn.click();
  await expect
    .poll(async () => (await transformedContent.boundingBox())?.width ?? 0)
    .toBeGreaterThan(canvasBox!.width);

  await canvas.dblclick({ position: { x: canvasBox!.width / 2, y: canvasBox!.height / 2 } });
  await expect
    .poll(async () => Math.round((await transformedContent.boundingBox())?.width ?? 0))
    .toBe(Math.round(initialBox!.width));

  await workspace.client.sendAgentMessage(
    imageAgent.id,
    "Stay running while the assistant image lightbox is closed.",
  );
  await expectAgentReadyToInterrupt(page);

  await page.keyboard.press("Escape");
  await expect(lightboxImage).toHaveCount(0);
  await expectAgentReadyToInterrupt(page);
});

test("reloading a timeline reserves image height without a load-time scroll jump", async ({
  imageWorkspace: workspace,
  page,
}) => {
  test.setTimeout(120_000);
  const image = await createSmallAssistantPng(workspace, {
    alt: "Reload geometry image",
    fileName: "reload-geometry-image.png",
  });
  const imageAgent = await createSettledMockAgent(workspace, "Reload image geometry");
  const delivery = await serveDelayedImage(path.join(workspace.repoPath, image.relativePath));
  try {
    delivery.release();
    await emitSettledAssistantImage(workspace.client, imageAgent, image, delivery.url);
    await appendSettledTimelineTurns(workspace.client, imageAgent, 3);
    await openAssistantImageTimeline(page, imageAgent);
    await expectAssistantImageRendered(page, image);

    delivery.holdNextRequest();
    await page.reload();
    await delivery.waitUntilRequested();
    const rendered = page.getByRole("button", { name: image.alt }).first();
    await expect(rendered).toHaveAttribute("src", /^data:image\/png/);
    await scrollTimelinePromptIntoView(
      page,
      "image-history-turn-2: emit 1 coalesced agent stream updates",
    );
    const beforeLoad = await rememberTimelineViewport(page);
    const reservedHeight = (await rendered.boundingBox())?.height;
    expect(reservedHeight).toBe(320);

    delivery.release();
    await expectAssistantImageRendered(page, image);
    expect((await rendered.boundingBox())?.height).toBe(reservedHeight);
    await expect.poll(() => rememberTimelineViewport(page)).toEqual(beforeLoad);
  } finally {
    await delivery.close();
  }
});

test("a real assistant PNG remains reachable through pagination and remount", async ({
  imageWorkspace: workspace,
  page,
}) => {
  test.setTimeout(120_000);
  const image = await createSmallAssistantPng(workspace, {
    alt: "Paginated real file image",
    fileName: "paginated-assistant-preview.png",
  });
  const imageAgent = await createSettledMockAgent(workspace, "Paginated image timeline");
  await emitSettledAssistantImage(workspace.client, imageAgent, image);
  await appendSettledTimelineTurns(workspace.client, imageAgent, 40);

  await openAssistantImageTimeline(page, imageAgent);
  await expectAssistantImageNotMounted(page, image);
  await userPagesUntilAssistantImageRenders(page, image);
  await remountAndRecoverAssistantImageFromHistory(page, image);
});

test("a near-10 MiB real assistant PNG renders and the app remains responsive", async ({
  imageWorkspace: workspace,
  page,
}) => {
  test.setTimeout(180_000);
  const image = await createNearTenMegabyteAssistantPng(workspace, {
    alt: "Large real file image",
    fileName: "large-assistant-preview.png",
  });
  const imageAgent = await createSettledMockAgent(workspace, "Large image timeline");
  await emitSettledAssistantImage(workspace.client, imageAgent, image);

  await openAssistantImageTimeline(page, imageAgent);
  await expectAssistantImageRendered(page, image);
  await sendFollowUpAndExpectVisibleResponse(page, {
    prompt: "confirm responsiveness: emit 1 coalesced agent stream updates",
    response: "stress-update-0",
  });
});

test("a later reply reads new bytes at the same workspace image path", async ({
  imageWorkspace: workspace,
  page,
}) => {
  const agent = await createSettledMockAgent(workspace, "Screenshot revisions");
  const first = await createSmallAssistantPng(workspace, {
    alt: "Earlier screenshot",
    fileName: "screenshot.png",
  });
  await emitSettledAssistantImage(workspace.client, agent, first);
  await openAssistantImageTimeline(page, agent);
  await expectAssistantImageRendered(page, first);
  const second = await createSmallAssistantPng(workspace, {
    alt: "Updated screenshot",
    fileName: "screenshot.png",
    width: 2,
    height: 3,
  });
  await emitSettledAssistantImage(workspace.client, agent, second);
  await expectAssistantImageRendered(page, second);
  await expectAssistantImageRendered(page, first);
});

test("pending assistant images reserve their decoded height", async ({
  imageWorkspace: workspace,
  page,
}, testInfo) => {
  const image = await createSmallAssistantPng(workspace, {
    alt: "Delayed remote image",
    fileName: "delayed.png",
    width: 32,
    height: 24,
  });
  const agent = await createSettledMockAgent(workspace, "Pending image geometry");
  const delivery = await serveDelayedImage(path.join(workspace.repoPath, image.relativePath));
  const { url } = delivery;
  try {
    await emitSettledAssistantImage(workspace.client, agent, image, url);
    await openAssistantImageTimeline(page, agent);
    const rendered = page.getByRole("button", { name: image.alt }).first();
    await expect(rendered).toHaveAttribute("src", /^data:image\/png/);
    await delivery.waitUntilRequested();
    const pendingBox = await rendered.boundingBox();
    expect(pendingBox?.height).toBe(320);
    await rendered.click();
    await expect(page.getByTestId("attachment-lightbox-image")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("pending-image.png") });
    delivery.release();
    await expect(rendered).toHaveAttribute("src", url);
    expect((await rendered.boundingBox())?.height).toBe(pendingBox?.height);
  } finally {
    await delivery.close();
  }
});

/** Serve the fixture's real PNG bytes; release controls when the decoder can finish. */
async function serveDelayedImage(file: string) {
  let release!: () => void;
  let ready: Promise<void>;
  let requested!: () => void;
  let requestStarted: Promise<void>;
  const holdNextRequest = () => {
    ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    requestStarted = new Promise<void>((resolve) => {
      requested = resolve;
    });
  };
  holdNextRequest();
  const server = createServer((_request, response) => {
    requested();
    void ready.then(() => {
      response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      return createReadStream(file).pipe(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Image server did not listen");
  return {
    url: `http://127.0.0.1:${address.port}/image.png`,
    release: () => release(),
    holdNextRequest,
    waitUntilRequested: () => requestStarted,
    close: async () => {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

test("late workspace image completion preserves selected prose", async ({
  imageWorkspace,
  page,
}) => {
  await withPendingWorkspaceImage(page, imageWorkspace, async (image, release) => {
    const selected = await selectImageFixtureParagraphs(page);
    release();
    await expectAssistantImageRendered(page, image);
    await expectSelectedParagraphsRetained(page, selected);
  });
});

test("late workspace image completion keeps Mermaid fullscreen open", async ({
  imageWorkspace,
  page,
}) => {
  await withPendingWorkspaceImage(page, imageWorkspace, async (image, release) => {
    await openDiagramFullscreen(page);
    await expectFullscreenDiagram(page, ["Start", "Done"]);
    release();
    await expectAssistantImageRendered(page, image);
    await expectFullscreenDiagram(page, ["Start", "Done"]);
  });
});

async function withPendingWorkspaceImage(
  page: Page,
  workspace: SeededWorkspace,
  run: (
    image: Awaited<ReturnType<typeof createSmallAssistantPng>>,
    release: () => void,
  ) => Promise<void>,
) {
  const image = await createSmallAssistantPng(workspace, {
    alt: "Late workspace image",
    fileName: "late.png",
    width: 32,
    height: 24,
  });
  const source = [
    "Paragraph one stays selected while the workspace image loads.",
    "Paragraph two remains in this reply.",
    "Paragraph three is the selection endpoint.",
    "```mermaid\nflowchart LR\n Start --> Done\n```",
    `![${image.alt}](${image.relativePath})`,
  ].join("\n\n");
  const agent = await createSettledMockAgent(workspace, "Delayed workspace read", source);
  await emitSettledAssistantImage(workspace.client, agent, image);
  const gate = await delayFileReadResponse(page, image.relativePath);
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      gate.release();
    }
  };
  try {
    await openAssistantImageTimeline(page, agent);
    await gate.waitUntilHeld();
    await expectCompletedDiagram(page, ["Start", "Done"]);
    await run(image, release);
  } finally {
    release();
  }
}

type SelectionProofWindow = Window & { __lateImageSelection?: { start: Node; end: Node } };

async function selectImageFixtureParagraphs(page: Page): Promise<string> {
  const message = page.getByTestId("assistant-message");
  await message
    .getByText("Paragraph one stays selected while the workspace image loads.", { exact: true })
    .scrollIntoViewIfNeeded();
  const bounds = await message.evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let start: Text | undefined;
    let end: Text | undefined;
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      if (text.data.startsWith("Paragraph one stays")) start = text;
      if (text.data.startsWith("Paragraph three is")) end = text;
    }
    if (!start || !end) throw new Error("Selection paragraphs are missing");
    (window as SelectionProofWindow).__lateImageSelection = { start, end };
    const first = document.createRange();
    first.selectNodeContents(start);
    const last = document.createRange();
    last.selectNodeContents(end);
    return {
      first: first.getBoundingClientRect().toJSON(),
      last: last.getBoundingClientRect().toJSON(),
    };
  });
  await page.mouse.move(bounds.first.x + 1, bounds.first.y + 5);
  await page.mouse.down();
  await page.mouse.move(bounds.last.right - 1, bounds.last.bottom - 2, { steps: 20 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected).toContain("Paragraph one");
  expect(selected).toContain("Paragraph three");
  return selected;
}

async function expectSelectedParagraphsRetained(page: Page, selected: string) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const proof = (window as SelectionProofWindow).__lateImageSelection;
        return {
          startConnected: proof?.start.isConnected,
          endConnected: proof?.end.isConnected,
          text: window.getSelection()?.toString(),
        };
      }),
    )
    .toEqual({ startConnected: true, endConnected: true, text: selected });
}
