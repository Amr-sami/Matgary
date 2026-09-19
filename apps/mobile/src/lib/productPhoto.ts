import { Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { ApiError } from "@matgary/api-client";
import { t } from "@/i18n";

/**
 * Photo picking shared by add-product, the product detail screen and the
 * receipt-logo pickers: one place for the permission dance, the MIME/filename
 * inference the picker skips on iOS, the client-side size gate and the error
 * mapping, so every screen fails the same way.
 */

/** Server cap in apps/web/lib/uploads.ts. */
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

// Editing on → the cashier crops on the counter and the picker re-encodes the
// crop as JPEG at `quality`, so the upload is small whatever the library holds.
export const PICKER_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ["images"],
  allowsEditing: true,
  quality: 0.5,
  exif: false,
};

/** A picked image plus the descriptor the upload helper wants. */
export interface PickedPhoto {
  uri: string;
  name: string;
  type: string;
  asset: ImagePicker.ImagePickerAsset;
}

export type PickResult =
  | { kind: "picked"; photo: PickedPhoto }
  | { kind: "cancelled" }
  /** Android < 13 media-library permission refused; `canAskAgain` false → settings deep link. */
  | { kind: "denied"; canAskAgain: boolean }
  | { kind: "pickFailed" }
  | { kind: "tooBig" };

/** Map an upload failure to the tile's message. 403 = audit-mode denial. */
export function uploadErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return t("mobile.product.photoNoPermission");
    if (err.status === 400 || err.status === 413) return t("mobile.product.photoInvalid");
  }
  return t("mobile.product.photoUploadFailed");
}

/** MIME + filename from what the picker reports (it often omits both on iOS). */
export function describeAsset(
  asset: ImagePicker.ImagePickerAsset,
  base = "photo",
): { name: string; type: string } {
  const ext = (asset.fileName ?? asset.uri).split(".").pop()?.toLowerCase();
  const type =
    asset.mimeType ??
    (ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg");
  const name =
    asset.fileName ?? `${base}.${type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg"}`;
  return { name, type };
}

/** Turn a picker result into a PickResult, applying the size gate. */
export function acceptPickerResult(
  res: ImagePicker.ImagePickerResult,
  maxBytes: number,
  base?: string,
): PickResult {
  const asset = res.canceled ? null : res.assets?.[0];
  if (!asset) return { kind: "cancelled" };
  if (asset.fileSize != null && asset.fileSize > maxBytes) return { kind: "tooBig" };
  return { kind: "picked", photo: { uri: asset.uri, ...describeAsset(asset, base), asset } };
}

/**
 * Open the photo library. iOS presents the picker out of process — no
 * permission needed (and asking would prompt for full-library access for
 * nothing). Android below 13 still needs the read permission.
 */
export async function pickLibraryPhoto(opts: {
  options?: ImagePicker.ImagePickerOptions;
  maxBytes?: number;
  /** Fallback filename stem when the picker reports none. */
  base?: string;
} = {}): Promise<PickResult> {
  if (Platform.OS === "android") {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return { kind: "denied", canAskAgain: perm.canAskAgain };
  }
  let res: ImagePicker.ImagePickerResult;
  try {
    res = await ImagePicker.launchImageLibraryAsync(opts.options ?? PICKER_OPTIONS);
  } catch {
    return { kind: "pickFailed" };
  }
  return acceptPickerResult(res, opts.maxBytes ?? MAX_PHOTO_BYTES, opts.base);
}
