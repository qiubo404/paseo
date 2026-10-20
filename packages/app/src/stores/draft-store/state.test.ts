import { describe, expect, it } from "vitest";
import {
  applyClearDraftRecord,
  pruneFinalizedDraftRecords,
  toDraftInputIfReady,
  editDraftRecordText,
  appendDraftImage,
  type DraftRecord,
} from "./state";

describe("append a chat image to its draft", () => {
  const metadata = {
    id: "preview-original",
    storageType: "web-indexeddb" as const,
    storageKey: "preview-original",
    mimeType: "image/png",
    createdAt: 1,
  };

  it("creates an ordinary persistent image attachment", () => {
    const record = appendDraftImage(undefined, metadata, 2);
    expect(record).toMatchObject({
      lifecycle: "active",
      version: 1,
      updatedAt: 2,
      input: { text: "", attachments: [{ kind: "image", metadata }] },
    });
    expect(toDraftInputIfReady(record)).toEqual(record.input);
  });

  it("preserves the latest text and attachments, and does not change an existing image's comments", () => {
    const first = appendDraftImage(undefined, metadata, 2);
    first.input.text = "Text entered while image loading";
    const image = first.input.attachments[0];
    if (image.kind !== "image") throw new Error("Expected image");
    image.comments = [{ id: "comment", text: "Keep this note", x: 0.3, y: 0.4 }];
    expect(appendDraftImage(first, metadata, 3)).toBe(first);
    const second = appendDraftImage(first, { ...metadata, id: "second", storageKey: "second" }, 4);
    expect(second.input.text).toBe(first.input.text);
    expect(second.input.attachments).toHaveLength(2);
    expect(second.input.attachments[0]).toBe(image);
    expect(second.version).toBe(2);
    expect(first.input.attachments).toHaveLength(1);
  });

  it("starts a new draft after sending instead of resurrecting sent content", () => {
    const previous = appendDraftImage(undefined, metadata, 2);
    previous.input.text = "Already sent";
    previous.lifecycle = "sent";
    const next = appendDraftImage(previous, metadata, 3);
    expect(next.input.text).toBe("");
    expect(next.input.attachments).toHaveLength(1);
    expect(next.lifecycle).toBe("active");
  });
});

describe("draft-store lifecycle", () => {
  it("edits text without invalidating attachment subscribers", () => {
    const draft: DraftRecord = {
      input: {
        text: "hello",
        attachments: [
          { kind: "workspace_file", path: "README.md", selection: { kind: "whole_file" } },
        ],
      },
      lifecycle: "active",
      updatedAt: 1,
      version: 1,
    };
    const edited = editDraftRecordText(draft, "hello\n", 2);
    expect(edited.input.text).toBe("hello\n");
    expect(edited.input.attachments).toBe(draft.input.attachments);
    expect(edited.version).toBe(2);
    expect(editDraftRecordText(edited, "hello\n", 3)).toBe(edited);
    expect(editDraftRecordText(edited, "", 3).lifecycle).toBe("active");
    expect(editDraftRecordText(undefined, "", 3).lifecycle).toBe("abandoned");
  });
  it("prunes finalized tombstones after TTL", () => {
    const nowMs = 1_000_000;
    const drafts = {
      oldSent: {
        input: { text: "", attachments: [] },
        lifecycle: "sent" as const,
        updatedAt: 0,
        version: 2,
      },
      recentAbandoned: {
        input: { text: "", attachments: [] },
        lifecycle: "abandoned" as const,
        updatedAt: nowMs + 2 * 60 * 1000,
        version: 2,
      },
      active: {
        input: { text: "a", attachments: [] },
        lifecycle: "active" as const,
        updatedAt: 0,
        version: 1,
      },
    };

    const pruned = pruneFinalizedDraftRecords({
      drafts,
      nowMs: nowMs + 6 * 60 * 1000,
    });

    expect(pruned.oldSent).toBeUndefined();
    expect(pruned.recentAbandoned).toBeDefined();
    expect(pruned.active).toBeDefined();
  });

  it("normalizes clear-with-lifecycle into a tombstone without attachments", () => {
    const cleared = applyClearDraftRecord({
      record: {
        input: {
          text: "hello",
          attachments: [
            {
              kind: "image",
              metadata: {
                id: "att-1",
                mimeType: "image/jpeg",
                storageType: "web-indexeddb",
                storageKey: "att-1",
                createdAt: 1,
              },
            },
          ],
        },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      },
      lifecycle: "sent",
      nowMs: 2,
    });

    expect(cleared).toEqual({
      input: { text: "", attachments: [] },
      lifecycle: "sent",
      updatedAt: 2,
      version: 2,
    });
  });
});

describe("draft-store normalization", () => {
  it("preserves plugin resources when hydrating a draft", () => {
    const attachment = {
      kind: "plugin_resource" as const,
      pluginId: "linear",
      sourceId: "issues",
      sourceTitle: "Linear issue",
      sourceIcon: "CircleDot",
      item: {
        id: "issue-uuid",
        identifier: "ENG-123",
        title: "Plugin attachments",
        subtitle: "In progress",
        url: "https://linear.app/acme/issue/ENG-123/plugin-attachments",
        text: "Linear issue ENG-123: Plugin attachments",
        resourceType: "issue",
      },
    };

    expect(
      toDraftInputIfReady({
        input: { text: "Implement this", attachments: [attachment] },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      }),
    ).toEqual({ text: "Implement this", attachments: [attachment] });
  });

  it("preserves uploaded file attachments when hydrating a draft", () => {
    const attachment = {
      kind: "file" as const,
      attachment: {
        type: "uploaded_file" as const,
        id: "file-1",
        fileName: "context.json",
        mimeType: "application/json",
        size: 42,
        path: "/tmp/context.json",
      },
    };

    expect(
      toDraftInputIfReady({
        input: { text: "Review this", attachments: [attachment] },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      }),
    ).toEqual({ text: "Review this", attachments: [attachment] });
  });

  it("preserves workspace file selections when hydrating a draft", () => {
    const attachment = {
      kind: "workspace_file" as const,
      path: "src/app.ts",
      selection: { kind: "line_range" as const, startLine: 12, endLine: 24 },
    };

    expect(
      toDraftInputIfReady({
        input: { text: "Review this", attachments: [attachment] },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      }),
    ).toEqual({ text: "Review this", attachments: [attachment] });
  });

  it("preserves New Workspace picker ownership when hydrating a draft", () => {
    const pickerAttachment = {
      kind: "github_pr" as const,
      owner: "new-workspace-picker" as const,
      item: {
        kind: "change_request" as const,
        number: 202,
        title: "Persist picker ownership",
        url: "https://example.com/pull/202",
        state: "open" as const,
        body: null,
        labels: [],
        baseRefName: "main",
        headRefName: "feature/picker-ownership",
      },
    };

    expect(
      toDraftInputIfReady({
        input: { text: "Keep this prompt", attachments: [pickerAttachment] },
        lifecycle: "active",
        updatedAt: 1,
        version: 1,
      }),
    ).toEqual({
      text: "Keep this prompt",
      attachments: [pickerAttachment],
    });
  });
});
