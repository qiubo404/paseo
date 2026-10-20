import { z } from "zod";
import type { AttachmentMetadata } from "./types";

export const ImageReviewCommentSchema = z.strictObject({
  id: z.string().min(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  text: z.string().trim().min(1).max(10000),
});
export const ImageReviewCommentsSchema = z.array(ImageReviewCommentSchema).max(200);
export type ImageReviewComment = z.infer<typeof ImageReviewCommentSchema>;

export interface ImageReviewBinding {
  comments: ImageReviewComment[];
  onChange(comments: ImageReviewComment[]): void;
}

export function imageReviewAttachment(input: {
  metadata: AttachmentMetadata;
  imageNumber: number;
  comments: ImageReviewComment[];
}) {
  const name = input.metadata.fileName || input.metadata.id;
  const percent = (value: number) => Number((value * 100).toFixed(1));
  const rows = input.comments.map(
    (comment, index) =>
      `${index + 1}. ${comment.text.trim()}（位置：x ${percent(comment.x)}%，y ${percent(comment.y)}%）`,
  );
  return {
    type: "text" as const,
    mimeType: "text/plain" as const,
    title: `截图 ${input.imageNumber} 评审：${name}`,
    text: `截图 ${input.imageNumber}（${name}）\n\n${rows.join("\n\n")}`,
  };
}
