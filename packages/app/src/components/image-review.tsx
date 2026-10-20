import { useCallback, useEffect, useLayoutEffect, useState, useRef } from "react";
import { Text, View, type GestureResponderEvent, type TextInputProps } from "react-native";
import { randomUUID } from "expo-crypto";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import type { ImageReviewBinding, ImageReviewComment } from "@/attachments/image-review";
import type { ViewportPoint } from "./zoomable-viewport/geometry";
import type { ViewportOverlayLayout } from "./zoomable-viewport/types";

interface CommentPinProps {
  comment: ImageReviewComment;
  index: number;
  pointX: number;
  pointY: number;
  onEdit(comment: ImageReviewComment, index: number): void;
  onDelete(id: string): void;
}

function CommentPin({ comment, index, pointX, pointY, onEdit, onDelete }: CommentPinProps) {
  const { t } = useTranslation();
  const press = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onEdit(comment, index);
    },
    [comment, index, onEdit],
  );
  const remove = useCallback(() => onDelete(comment.id), [comment.id, onDelete]);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        accessibilityRole="button"
        accessibilityLabel={t("composer.imageReview.commentNumber", { number: index + 1 })}
        testID={`image-review-pin-${index + 1}`}
        onPress={press}
        style={[styles.pin, { left: pointX, top: pointY }]}
      >
        <Text style={styles.pinText}>{index + 1}</Text>
      </ContextMenuTrigger>
      <ContextMenuContent width={160}>
        <ContextMenuItem onSelect={remove} testID="image-review-delete">
          {t("composer.imageReview.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface CommentDraft extends ImageReviewComment {
  index: number;
}

export function useImageReview(input: {
  binding?: ImageReviewBinding;
  sourceKey: string | null;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const { binding, onClose } = input;
  const editorRef = useRef<EditingTextInputHandle>(null);
  const [editorHeight, setEditorHeight] = useState(52);
  useEffect(() => setDraft(null), [input.sourceKey]);
  const resizeEditor = useCallback(() => {
    if (!isWeb || !editorRef.current) return;
    const element = editorRef.current?.getNativeRef();
    if (!(element instanceof HTMLTextAreaElement)) return;
    element.style.height = "0px";
    const height = Math.min(120, Math.max(30, element.scrollHeight));
    element.style.height = `${height}px`;
    setEditorHeight(height + 22);
  }, []);
  useLayoutEffect(resizeEditor, [draft?.id, draft?.text, resizeEditor]);

  const save = useCallback(() => {
    if (!binding || !draft) return;
    const text = (editorRef.current?.getText() ?? draft.text).trim();
    if (text) {
      const comments = [...binding.comments];
      comments[draft.index] = { id: draft.id, x: draft.x, y: draft.y, text };
      binding.onChange(comments);
    }
    setDraft(null);
  }, [binding, draft]);
  const close = useCallback(() => {
    save();
    onClose();
  }, [onClose, save]);
  const cancel = useCallback(() => setDraft(null), []);
  const open = useCallback(
    (point: ViewportPoint) => {
      if (!binding) return;
      save();
      const extra = draft && draft.index === binding.comments.length && draft.text.trim() ? 1 : 0;
      if (binding.comments.length + extra >= 200) return;
      setDraft({ id: randomUUID(), ...point, text: "", index: binding.comments.length + extra });
    },
    [binding, draft, save],
  );
  const edit = useCallback(
    (comment: ImageReviewComment, index: number) => {
      save();
      setDraft({ ...comment, index });
    },
    [save],
  );
  const remove = useCallback(
    (id: string) => {
      if (!binding) return;
      binding.onChange(binding.comments.filter((comment) => comment.id !== id));
      setDraft(null);
    },
    [binding],
  );

  const changeText = useCallback(
    (text: string) => setDraft((current) => (current ? { ...current, text } : null)),
    [],
  );
  const keyPress = useCallback<NonNullable<TextInputProps["onKeyPress"]>>(
    (event) => {
      const native = event.nativeEvent;
      const composing =
        Reflect.get(native, "isComposing") || Reflect.get(native, "keyCode") === 229;
      if (composing) return;
      if (native.key === "Enter" && !Reflect.get(native, "shiftKey")) {
        event.preventDefault();
        event.stopPropagation();
        save();
      }
    },
    [save],
  );

  // Keep controls in viewport space so they stay usable while the image zooms or pans.
  const renderOverlay = useCallback(
    ({ viewport, content }: ViewportOverlayLayout) => {
      if (!binding) return null;
      const width = Math.min(390, viewport.width - 24);
      const point = draft
        ? { x: content.x + content.width * draft.x, y: content.y + content.height * draft.y }
        : null;
      let left = point ? point.x + 15 - width / 2 : 12;
      let top = 12;
      if (point) {
        if (point.y - 42 - editorHeight >= 12) top = point.y - 42 - editorHeight;
        else if (point.y + 12 + editorHeight <= viewport.height - 12) top = point.y + 12;
        else {
          left = point.x + 42 + width <= viewport.width - 12 ? point.x + 42 : point.x - width - 12;
          top = point.y - 15 - editorHeight / 2;
        }
      }
      left = Math.max(12, Math.min(left, viewport.width - width - 12));
      top = Math.max(12, Math.min(top, viewport.height - editorHeight - 12));
      return (
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
          {binding.comments.map((comment, index) => (
            <CommentPin
              key={comment.id}
              comment={comment}
              index={index}
              pointX={content.x + content.width * comment.x}
              pointY={content.y + content.height * comment.y}
              onEdit={edit}
              onDelete={remove}
            />
          ))}
          {draft && point && draft.index === binding.comments.length ? (
            <View pointerEvents="none" style={[styles.pin, { left: point.x, top: point.y }]}>
              <Text style={styles.pinText}>{draft.index + 1}</Text>
            </View>
          ) : null}
          {draft ? (
            <View
              testID="image-review-editor"
              onLayout={resizeEditor}
              style={[styles.editor, { left, top, width }]}
            >
              <EditingTextInput
                ref={editorRef}
                key={draft.id}
                autoFocus
                multiline
                maxLength={10000}
                placeholderTextColor="#aaa"
                accessibilityLabel={t("composer.imageReview.comment")}
                placeholder={t("composer.imageReview.comment")}
                testID="image-review-comment"
                initialValue={draft.text}
                onChangeText={changeText}
                onKeyPress={keyPress}
                style={styles.input}
              />
              {draft.text.trim() ? (
                <Button
                  size="xs"
                  onPress={save}
                  accessibilityLabel={t("common.actions.save")}
                  testID="image-review-save"
                  style={styles.save}
                  textStyle={styles.saveText}
                >
                  ↑
                </Button>
              ) : null}
            </View>
          ) : null}
        </View>
      );
    },
    [binding, changeText, draft, edit, editorHeight, keyPress, remove, resizeEditor, save, t],
  );
  return {
    renderOverlay: binding ? renderOverlay : undefined,
    close,
    cancel,
    isEditing: draft !== null,
    onContentPress: binding ? open : undefined,
  };
}

// Match AppHub Workbench's screenshot-review.css annotation controls.
const styles = StyleSheet.create(() => ({
  pin: {
    position: "absolute",
    width: 30,
    height: 30,
    marginTop: -30,
    borderRadius: 15,
    borderBottomLeftRadius: 3,
    backgroundColor: "#2864d7",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 0 0 2px white, 0 2px 5px #0004",
  },
  pinText: {
    color: "#fff",
    fontSize: 14,
  },
  editor: {
    position: "absolute",
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 8,
    backgroundColor: "#2b2b2b",
    borderRadius: 28,
    borderWidth: 1,
    borderColor: "#ffffff18",
    boxShadow: "0 4px 18px #0004",
  },
  input: {
    flex: 1,
    minWidth: 0,
    height: 30,
    minHeight: 30,
    maxHeight: 120,
    paddingVertical: 4,
    paddingHorizontal: 0,
    color: "#fff",
    backgroundColor: "transparent",
    fontSize: 14,
    lineHeight: 22,
    borderWidth: 0,
    outlineWidth: 0,
  },
  save: {
    width: 28,
    height: 28,
    minWidth: 28,
    padding: 0,
    borderWidth: 0,
    borderRadius: 14,
    backgroundColor: "#fff",
  },
  saveText: { color: "#222", fontSize: 20, lineHeight: 28 },
}));
