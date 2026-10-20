import { useCallback, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  useContextMenu,
} from "@/components/ui/context-menu";
import { useAssistantFileLinkEnvironment } from "@/assistant-file-links";
import { getAttachmentStore } from "@/attachments/store";
import { getDesktopHost } from "@/desktop/host";
import { persistAttachmentFromBlob } from "@/attachments/service";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import { getFileNameFromPath } from "@/attachments/utils";
import type { AttachmentMetadata } from "@/attachments/types";
import { useDraftStore } from "@/stores/draft-store";
import { PENDING_MARKDOWN_IMAGE } from "./source";
import type { MarkdownImageMenuProps } from "./image-menu";

interface SelectedImage {
  draftKey: string;
  uri: string;
  metadata?: AttachmentMetadata;
}

export function MarkdownImageMenu(props: MarkdownImageMenuProps) {
  if (!props.draftKey) return props.children;
  return (
    <ContextMenu>
      <ImageMenuContent {...props} />
    </ContextMenu>
  );
}

function ImageMenuContent({ draftKey, imageAttachments, children }: MarkdownImageMenuProps) {
  const { t } = useTranslation();
  const { toast } = useAssistantFileLinkEnvironment();
  const { setOpen, setAnchorRect } = useContextMenu();
  const [selected, setSelected] = useState<SelectedImage | null>(null);
  const [pending, setPending] = useState<"add" | "copy" | null>(null);
  const [failedAction, setFailedAction] = useState<"add" | "copy" | null>(null);
  const [error, setError] = useState<string | undefined>();
  const inFlight = useRef(false);
  const openImageMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!draftKey || !(event.target instanceof Element)) return;
      const image = event.target.closest("img");
      if (!(image instanceof HTMLImageElement) || !event.currentTarget.contains(image)) return;
      const uri = image.currentSrc || image.src;
      if (!uri || uri === PENDING_MARKDOWN_IMAGE) return;
      event.preventDefault();
      event.stopPropagation();
      if (inFlight.current) return;
      setSelected({ draftKey, uri, metadata: imageAttachments[uri] });
      setError(undefined);
      setAnchorRect({ x: event.clientX, y: event.clientY, width: 0, height: 0 });
      setOpen(true);
    },
    [draftKey, imageAttachments, setAnchorRect, setOpen],
  );

  const addImage = useCallback(() => {
    if (!selected || inFlight.current) return;
    const snapshot = selected;
    inFlight.current = true;
    setPending("add");
    setError(undefined);
    const releaseSnapshot = snapshot.metadata
      ? retainAttachmentForGarbageCollection(snapshot.metadata.id)
      : null;
    void (async () => {
      let releaseSaved: (() => void) | null = null;
      try {
        const blob = await loadImageBlob(snapshot.uri, t("message.imageAddInvalid"));
        // The draft owns separate bytes: removing it must not delete the displayed snapshot.
        // Scope content identity to the source draft so other chats own separate copies too.
        const digest = await crypto.subtle.digest(
          "SHA-256",
          await new Blob([snapshot.draftKey, "\0", blob]).arrayBuffer(),
        );
        const id = `chat-image-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
        const fileName =
          snapshot.metadata?.fileName ??
          (/^https?:/i.test(snapshot.uri)
            ? getFileNameFromPath(new URL(snapshot.uri).pathname)
            : "image");
        const metadata = await persistAttachmentFromBlob({ id, blob, fileName });
        releaseSaved = retainAttachmentForGarbageCollection(metadata.id);
        await useDraftStore.getState().attachImage({ draftKey: snapshot.draftKey, metadata });
        setOpen(false);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        const message = t("message.imageAddFailed", { reason });
        setFailedAction("add");
        setError(message);
        toast?.error(message);
      } finally {
        releaseSaved?.();
        releaseSnapshot?.();
        inFlight.current = false;
        setPending(null);
      }
    })();
  }, [selected, setOpen, t, toast]);

  const copyImage = useCallback(() => {
    if (!selected || inFlight.current) return;
    const snapshot = selected;
    inFlight.current = true;
    setPending("copy");
    setError(undefined);
    const releaseSnapshot = snapshot.metadata
      ? retainAttachmentForGarbageCollection(snapshot.metadata.id)
      : null;
    void (async () => {
      try {
        const copyElement = getDesktopHost()?.browser?.copyElement;
        if (copyElement) {
          // Read the displayed snapshot, never the potentially changed source file.
          const imageDataUrl = snapshot.metadata
            ? `data:${snapshot.metadata.mimeType};base64,${await (await getAttachmentStore()).encodeBase64({ attachment: snapshot.metadata })}`
            : await blobDataUrl(await loadImageBlob(snapshot.uri, t("message.imageAddInvalid")));
          if (!(await copyElement({ imageDataUrl }))) throw new Error(t("message.imageAddInvalid"));
        } else {
          const blob = await loadImageBlob(snapshot.uri, t("message.imageAddInvalid"));
          // Browser clipboards accept PNG; keep the original pixels at their full dimensions.
          const bitmap = await createImageBitmap(blob);
          let png: Blob;
          try {
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext("2d");
            if (!context) throw new Error(t("message.imageAddInvalid"));
            context.drawImage(bitmap, 0, 0);
            png = await canvas.convertToBlob({ type: "image/png" });
          } finally {
            bitmap.close();
          }
          await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
        }
        setOpen(false);
        toast?.show(t("message.imageCopied"), { variant: "success" });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        const message = t("message.imageCopyFailed", { reason });
        setFailedAction("copy");
        setError(message);
        toast?.error(message);
      } finally {
        releaseSnapshot?.();
        inFlight.current = false;
        setPending(null);
      }
    })();
  }, [selected, setOpen, t, toast]);

  return (
    <div style={CONTENTS_STYLE} onContextMenu={openImageMenu}>
      {children}
      <ContextMenuContent width={240}>
        <ContextMenuItem
          onSelect={addImage}
          closeOnSelect={false}
          disabled={pending === "copy"}
          status={pending === "add" ? "pending" : "idle"}
          pendingLabel={t("message.imageAddingToChat")}
          description={failedAction === "add" ? error : undefined}
          testID="assistant-image-add-to-chat"
        >
          {t("message.imageAddToChat")}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={copyImage}
          closeOnSelect={false}
          disabled={pending === "add"}
          status={pending === "copy" ? "pending" : "idle"}
          pendingLabel={t("message.imageCopying")}
          description={failedAction === "copy" ? error : undefined}
          testID="assistant-image-copy"
        >
          {t("message.imageCopy")}
        </ContextMenuItem>
      </ContextMenuContent>
    </div>
  );
}

const CONTENTS_STYLE = { display: "contents" } as const;

async function loadImageBlob(uri: string, invalidMessage: string): Promise<Blob> {
  const response = await fetch(uri, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  if (!blob.type.startsWith("image/") || blob.size === 0) throw new Error(invalidMessage);
  return blob;
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error("Unable to read image")),
      { once: true },
    );
    reader.readAsDataURL(blob);
  });
}
