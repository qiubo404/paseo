import { describe, expect, it } from "vitest";
import type { UserComposerAttachment } from "@/attachments/types";
import { splitComposerAttachmentsForSubmit } from "./submit";
import { imageReviewAttachment } from "@/attachments/image-review";
import {
  UserComposerAttachmentSchema,
  normalizeComposerAttachment,
} from "@/stores/draft-store/state";

const image: Extract<UserComposerAttachment, { kind: "image" }> = {
  kind: "image",
  metadata: {
    id: "one",
    storageKey: "one",
    storageType: "desktop-file",
    mimeType: "image/png",
    fileName: "screen.png",
    createdAt: 1,
  },
  comments: [{ id: "first", x: 0.194, y: 0.608, text: "Remove this label" }],
};

describe("image review attachments", () => {
  it("preserves comments through draft validation and normalization", () => {
    expect(normalizeComposerAttachment(UserComposerAttachmentSchema.parse(image))).toEqual(image);
    expect(UserComposerAttachmentSchema.parse({ ...image, comments: undefined })).toEqual({
      ...image,
      comments: undefined,
    });
  });
  it("rejects invalid coordinates and empty comments at the persistence boundary", () => {
    for (const comment of [
      { id: "invalid", x: -1, y: 0.5, text: "x" },
      { id: "invalid", x: 0.5, y: Infinity, text: "x" },
      { id: "invalid", x: 0, y: 0, text: " " },
    ]) {
      expect(
        UserComposerAttachmentSchema.safeParse({ ...image, comments: [comment] }).success,
      ).toBe(false);
    }
  });
  it("sends original images and associates comments with the correct image, without mutating the draft on retry", () => {
    const plain = { ...image, metadata: { ...image.metadata, id: "plain" }, comments: undefined };
    const attachments = [plain, image];
    const result = splitComposerAttachmentsForSubmit(attachments);
    expect(result.images).toEqual([plain.metadata, image.metadata]);
    expect(result.attachments).toEqual([
      {
        type: "text",
        mimeType: "text/plain",
        title: "截图 2 评审：screen.png",
        text: "截图 2（screen.png）\n\n1. Remove this label（位置：x 19.4%，y 60.8%）",
      },
    ]);
    expect(splitComposerAttachmentsForSubmit(attachments)).toEqual(result);
    expect(attachments[1]).toEqual(image);
    expect(splitComposerAttachmentsForSubmit([plain]).attachments).toEqual([]);
  });
  it("matches the VS Code screenshot review comment format", () => {
    const result = imageReviewAttachment({
      metadata: image.metadata,
      imageNumber: 1,
      comments: [
        { id: "one", x: 0.29, y: 0.429, text: " 22121 " },
        { id: "two", x: 1, y: 0, text: "调整按钮\n保留换行" },
      ],
    });
    expect(result.text).toBe(
      "截图 1（screen.png）\n\n1. 22121（位置：x 29%，y 42.9%）\n\n2. 调整按钮\n保留换行（位置：x 100%，y 0%）",
    );
  });
});
