import { useState } from "react";
import type * as ImagePicker from "expo-image-picker";
import { ApiError, catalog } from "@matgary/api-client";
import { api } from "@/api/client";
import { t } from "@/i18n";
import { pickLibraryPhoto } from "@/lib/productPhoto";

// ---------------------------------------------------------------------------
// Receipt logo picker, shared by settings/store and settings/receipt. POST
// /api/uploads/product-image with kind=receipt-logo: the server validates
// (owner, jpg/png/webp, ≤ 190 KB), converts to a data URI and writes
// settings.receiptLogoUrl for the active branch itself, so the only follow-up
// is a query invalidation — the preview re-reads `server`.
//
// Known limit: there is no image manipulator in the dev client, so a full-res
// 1:1 crop at quality 0.3 can still exceed 190 KB and ends in `logoTooBig`.
// Adding expo-image-manipulator (resize to ≤ 512 px) needs a native rebuild.
const LOGO_MAX_BYTES = 190 * 1024;

const LOGO_PICKER_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ["images"],
  allowsEditing: true,
  aspect: [1, 1],
  quality: 0.3,
  exif: false,
};

export function useLogoPicker(onDone: () => Promise<unknown>) {
  const [status, setStatus] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const pick = async () => {
    setMessage(null);
    const res = await pickLibraryPhoto({
      options: LOGO_PICKER_OPTIONS,
      maxBytes: LOGO_MAX_BYTES,
      base: "logo",
    });
    if (res.kind === "cancelled") return;
    if (res.kind !== "picked") {
      setStatus("error");
      setMessage(
        res.kind === "tooBig"
          ? t("mobile.settings.logoTooBig")
          : res.kind === "denied"
            ? t("mobile.product.libraryDenied")
            : t("mobile.product.photoPickFailed"),
      );
      return;
    }
    setStatus("uploading");
    try {
      await catalog.uploadReceiptLogo(api, {
        uri: res.photo.uri,
        name: res.photo.name,
        type: res.photo.type,
      });
      await onDone();
      setStatus("done");
      setMessage(t("mobile.settings.logoUploaded"));
    } catch (e) {
      setStatus("error");
      setMessage(
        e instanceof ApiError && (e.status === 400 || e.status === 413)
          ? t("mobile.settings.logoTooBig")
          : e instanceof ApiError && e.status === 403
            ? t("mobile.common.forbidden")
            : t("mobile.settings.logoUploadFailed"),
      );
    }
  };
  return { pick, status, message };
}
