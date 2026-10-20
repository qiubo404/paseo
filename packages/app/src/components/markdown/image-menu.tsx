import type { ReactNode } from "react";
import type { AttachmentMetadata } from "@/attachments/types";

export interface MarkdownImageMenuProps {
  draftKey?: string;
  imageAttachments: Readonly<Record<string, AttachmentMetadata>>;
  children: ReactNode;
}

export function MarkdownImageMenu({ children }: MarkdownImageMenuProps) {
  return children;
}
