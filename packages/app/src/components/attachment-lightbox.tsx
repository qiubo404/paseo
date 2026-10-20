import { useImageReview } from "./image-review";
import type { ImageReviewBinding } from "@/attachments/image-review";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Modal, Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { isNative, isWeb } from "@/constants/platform";
import { SPACING } from "@/styles/theme";
import { WindowChromeRootRegion } from "@/utils/desktop-window";
import { ZoomableImage } from "@/components/zoomable-viewport/image";
import { Button } from "@/components/ui/button";
import { fitContentSize, type ViewportSize } from "@/components/zoomable-viewport/geometry";
import {
  OverlayLayerProvider,
  getOverlayRoot,
  useGlobalWebOverlayLayer,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";

export type ImageLightboxSource =
  | { type: "attachment"; metadata: AttachmentMetadata }
  | { type: "uri"; uri: string; contentSize?: ViewportSize };

interface AttachmentLightboxProps {
  source: ImageLightboxSource | null;
  review?: ImageReviewBinding;
  onClose: () => void;
}

const ModalRoot = isNative ? GestureHandlerRootView : View;
const REVIEW_ACTIONS_WIDTH = 104;
const LIGHTBOX_VIEWPORT = {
  fit: { padding: SPACING[4], maxWidth: 960, maxHeight: 640 },
  toolbarPlacement: "top" as const,
};
const REVIEW_VIEWPORT = {
  fit: { padding: SPACING[2] },
  toolbarPlacement: "bottom" as const,
};

export function AttachmentLightbox({ source, onClose, review }: AttachmentLightboxProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const metadata = source?.type === "attachment" ? source.metadata : null;
  const attachmentUrl = useAttachmentPreviewUrl(metadata);
  const url = source?.type === "uri" ? source.uri : attachmentUrl;
  const contentSize = source?.type === "uri" ? source.contentSize : undefined;
  const imageReview = useImageReview({
    binding: review,
    sourceKey: source ? (metadata?.id ?? url) : null,
    onClose,
  });
  const { close, isEditing, cancel } = imageReview;
  const [errored, setErrored] = useState(false);
  const [imageSize, setImageSize] = useState<ViewportSize | null>(null);
  const [availableSize, setAvailableSize] = useState<ViewportSize | null>(null);
  const modalLayer = useGlobalWebOverlayLayer("modal", isWeb && source !== null);

  useEffect(() => {
    setErrored(false);
    setImageSize(null);
  }, [metadata?.id, url]);

  const handleWebOverlayKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      event.stopPropagation();
      if (isEditing) cancel();
      else close();
      return true;
    },
    [close, isEditing, cancel],
  );
  const setWebOverlayScope = useWebOverlayRegistration({
    active: isWeb && source !== null,
    layer: modalLayer,
    onKeyDown: handleWebOverlayKeyDown,
  });

  const contentLayerStyle = useMemo(() => {
    const inset = review ? SPACING[8] : 0;
    return [
      styles.contentLayer,
      {
        paddingTop: insets.top + inset,
        paddingRight: insets.right + inset,
        paddingBottom: insets.bottom + inset,
        paddingLeft: insets.left + inset,
      },
    ];
  }, [insets.bottom, insets.left, insets.right, insets.top, review]);
  const handleViewportLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      setAvailableSize({
        width: width - insets.left - insets.right,
        height: height - insets.top - insets.bottom,
      });
    },
    [insets.bottom, insets.left, insets.right, insets.top],
  );
  const frameStyle = useMemo(() => {
    if (!review) return styles.root;
    if (!imageSize || !availableSize) return styles.reviewFrame;
    const fitted = fitContentSize(
      imageSize,
      {
        width: Math.max(0, availableSize.width - SPACING[8] * 2 - REVIEW_ACTIONS_WIDTH * 2),
        height: Math.max(0, availableSize.height - SPACING[8] * 2),
      },
      REVIEW_VIEWPORT.fit,
    );
    return [
      styles.reviewFrame,
      {
        width: fitted.width + REVIEW_VIEWPORT.fit.padding * 2 + REVIEW_ACTIONS_WIDTH * 2,
        height: fitted.height + REVIEW_VIEWPORT.fit.padding * 2,
      },
    ];
  }, [availableSize, imageSize, review]);
  const actions = useMemo(
    () =>
      review
        ? []
        : [
            {
              icon: X,
              label: t("message.attachments.closeImage"),
              onPress: close,
              testID: "attachment-lightbox-close",
            },
          ],
    [close, review, t],
  );

  const handleImageError = useCallback(() => setErrored(true), []);

  if (!source) {
    return null;
  }

  const hasError = errored || !url;
  const viewportOptions = review ? REVIEW_VIEWPORT : LIGHTBOX_VIEWPORT;
  const reviewActions = review ? (
    <View style={styles.reviewActions}>
      <Button
        variant="default"
        size="sm"
        style={styles.reviewDoneButton}
        textStyle={styles.reviewDoneText}
        onPress={close}
        testID="image-review-done"
      >
        {t("composer.imageReview.done")}
      </Button>
    </View>
  ) : null;
  const imageContent = hasError ? (
    <Text style={styles.errorText}>{t("message.attachments.imageLoadFailed")}</Text>
  ) : (
    <ZoomableImage
      {...viewportOptions}
      accessibilityLabel={t("composer.attachments.openImage")}
      actions={actions}
      renderOverlay={imageReview.renderOverlay}
      onContentPress={imageReview.onContentPress}
      contentSize={contentSize}
      onContentSizeResolved={setImageSize}
      onError={handleImageError}
      onPressOutsideContent={close}
      style={styles.imageViewport}
      testID="attachment-lightbox"
      uri={url}
    />
  );

  const content = (
    <OverlayLayerProvider layer={modalLayer}>
      <ModalRoot style={styles.root}>
        <WindowChromeRootRegion corners="both">
          <View ref={setWebOverlayScope} style={styles.root} role="dialog" aria-modal>
            <Pressable
              testID="attachment-lightbox-backdrop"
              accessibilityRole="button"
              accessibilityLabel={t("message.attachments.dismissImage")}
              onPress={close}
              style={styles.backdrop}
            />
            <View
              pointerEvents="box-none"
              style={contentLayerStyle}
              onLayout={handleViewportLayout}
            >
              <View pointerEvents="box-none" style={frameStyle}>
                {imageContent}
                {reviewActions}
              </View>
            </View>
          </View>
        </WindowChromeRootRegion>
      </ModalRoot>
    </OverlayLayerProvider>
  );
  if (isWeb) {
    return createPortal(
      <View style={[styles.webOverlay, { zIndex: modalLayer }]}>{content}</View>,
      getOverlayRoot(),
    );
  }
  return (
    <Modal transparent animationType="fade" statusBarTranslucent visible onRequestClose={close}>
      {content}
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  },
  webOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    pointerEvents: "auto",
  },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.9)",
  },
  contentLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "center",
  },
  reviewFrame: {
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 0,
    width: "100%",
    alignSelf: "center",
    flexDirection: "row",
    // Equal gutters keep the image itself centered, with controls in the right gutter.
    paddingHorizontal: REVIEW_ACTIONS_WIDTH,
  },
  reviewActions: {
    position: "absolute",
    top: 0,
    right: 0,
    width: REVIEW_ACTIONS_WIDTH,
    padding: theme.spacing[3],
  },
  reviewDoneButton: {
    backgroundColor: theme.colors.palette.blue[600],
    borderColor: theme.colors.palette.blue[600],
  },
  reviewDoneText: {
    color: theme.colors.palette.white,
  },
  imageViewport: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    alignSelf: "stretch",
  },
  errorText: {
    flex: 1,
    alignSelf: "center",
    textAlign: "center",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
