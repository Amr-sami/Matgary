"use client";

import { useRef, useState } from "react";
import { Upload, Trash2, Loader2 } from "@/lib/icons";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface Props {
  label: string;
  /** Currently saved relative path (under /api/uploads/team/) — null if none. */
  path: string | null;
  /** Local data URL preview while a freshly-picked file hasn't been uploaded yet. */
  previewUrl?: string | null;
  /** Aspect ratio of the preview area. "circle" for profile, "card" (3/2) for ID. */
  shape?: "circle" | "card";
  uploading?: boolean;
  onPick: (file: File) => void;
  onClear: () => void;
}

export function PhotoUploadZone({
  label,
  path,
  previewUrl,
  shape = "card",
  uploading,
  onPick,
  onClear,
}: Props) {
  const dict = useDictionary();
  const t = dict.app.photoUpload;
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const hasImage = !!previewUrl || !!path;
  const src =
    previewUrl ||
    (path ? `/api/uploads/team/${path.replace(/^\/+/, "")}` : null);

  const isCircle = shape === "circle";

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-text-secondary">{label}</label>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!uploading) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (uploading) return;
          const f = e.dataTransfer.files?.[0];
          if (f) onPick(f);
        }}
        className={[
          "relative bg-bg-main border-2 border-dashed rounded-xl flex flex-col items-center justify-center gap-2 transition-colors overflow-hidden",
          isCircle ? "aspect-square" : "aspect-[3/2]",
          dragOver
            ? "border-accent bg-accent-light"
            : hasImage
              ? "border-border"
              : "border-border hover:border-accent/50",
        ].join(" ")}
      >
        {src && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={label}
            className={[
              "absolute inset-0 w-full h-full object-cover",
              isCircle ? "rounded-xl" : "",
              uploading ? "opacity-50" : "",
            ].join(" ")}
          />
        )}

        {!src && (
          <div className="text-center px-4 py-6">
            <Upload className="w-6 h-6 text-text-secondary mx-auto mb-1.5" />
            <p className="text-xs text-text-secondary">{t.dropHint}</p>
            <p className="text-[10px] text-text-secondary mt-0.5">{t.fileTypeHint}</p>
          </div>
        )}

        {uploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/40">
            <Loader2 className="w-6 h-6 text-accent animate-spin" />
          </div>
        )}

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          aria-label={hasImage ? t.changeAria : t.uploadAria}
          className="absolute inset-0 cursor-pointer disabled:cursor-default"
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="text-xs font-medium text-accent hover:underline disabled:opacity-50"
        >
          {hasImage ? t.change : t.choose}
        </button>
        {hasImage && !uploading && (
          <button
            type="button"
            onClick={onClear}
            className="text-xs font-medium text-danger hover:underline inline-flex items-center gap-1"
          >
            <Trash2 className="w-3 h-3" />
            {t.delete}
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          // Reset value so picking the same file twice still fires onChange.
          e.target.value = "";
        }}
      />
    </div>
  );
}
