"use client";

// Receipt Designer — owner-customisable layout for the printed/shared
// receipt. The live preview IS the drag surface: hover any block to reveal
// a control gutter [⋮⋮ drag] [✎ edit (custom only)] [✕ remove]. Removed
// blocks land in the "Hidden sections" tray; the [+ Custom text] button
// creates a new editable text block at the end.
//
// Two pieces of state live in settings:
//   * receiptBlockOrder — array of fixed block keys + "custom:<id>" refs in
//     render order. Anything NOT in the array is hidden.
//   * receiptCustomBlocks — { id → { text, align } } map referenced by the
//     "custom:<id>" entries above.
//
// The renderer (components/sales/Receipt.tsx + InvoiceReceipt.tsx) walks the
// same arrays so what the owner sees here is exactly what the cashier and
// customer get.

import { useId, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  ReceiptBlockAlign,
  ReceiptBlockKey,
  ReceiptCustomBlock,
  ReceiptFixedBlock,
  ReceiptFontFamily,
  ShopSettings,
} from "@/lib/settings";
import {
  DEFAULT_RECEIPT_BLOCK_ORDER,
  RECEIPT_FIXED_BLOCKS,
} from "@/lib/settings";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface Props {
  draft: ShopSettings;
  update: <K extends keyof ShopSettings>(key: K, value: ShopSettings[K]) => void;
  onError?: (message: string) => void;
}

const FONT_OPTIONS: { value: ReceiptFontFamily; label: string; cssVar: string }[] = [
  { value: "cairo", label: "Cairo", cssVar: "var(--font-cairo)" },
  { value: "tajawal", label: "Tajawal", cssVar: "var(--font-display)" },
  { value: "lemonada", label: "Lemonada", cssVar: "var(--font-catchy)" },
];

const LOGO_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
const LOGO_TARGET_MAX_BYTES = 180 * 1024;
const LOGO_TARGET_LONG_EDGE = 512;
const LOGO_ACCEPT = "image/png,image/jpeg,image/webp,image/svg+xml";

function bytesOf(dataUri: string): number {
  const comma = dataUri.indexOf(",");
  if (comma < 0) return dataUri.length;
  return Math.ceil((dataUri.length - comma - 1) * 0.75);
}
function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}
async function downscaleImage(file: File): Promise<string> {
  const img = await loadImageFromFile(file);
  const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = longEdge > LOGO_TARGET_LONG_EDGE ? LOGO_TARGET_LONG_EDGE / longEdge : 1;
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D unavailable");
  ctx.drawImage(img, 0, 0, w, h);
  const hasAlpha = file.type === "image/png" && ctx.getImageData(0, 0, 1, 1).data[3] < 255;
  if (hasAlpha) {
    const png = canvas.toDataURL("image/png");
    if (bytesOf(png) <= LOGO_TARGET_MAX_BYTES) return png;
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
  }
  for (const q of [0.85, 0.75, 0.65, 0.55]) {
    const jpg = canvas.toDataURL("image/jpeg", q);
    if (bytesOf(jpg) <= LOGO_TARGET_MAX_BYTES) return jpg;
  }
  return canvas.toDataURL("image/jpeg", 0.5);
}
function readAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(file);
  });
}

function newCustomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function ReceiptDesigner({ draft, update, onError }: Props) {
  const dict = useDictionary();
  const t = dict.app.receiptDesigner;
  const inputId = useId();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [editingCustomId, setEditingCustomId] = useState<string | null>(null);

  const order =
    draft.receiptBlockOrder.length > 0
      ? draft.receiptBlockOrder
      : DEFAULT_RECEIPT_BLOCK_ORDER;

  const visibleSet = new Set(order);
  const hiddenFixed = RECEIPT_FIXED_BLOCKS.filter((k) => !visibleSet.has(k));
  const hiddenCustom = Object.entries(draft.receiptCustomBlocks).filter(
    ([id]) => !visibleSet.has(`custom:${id}`),
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = order.indexOf(active.id as ReceiptBlockKey);
    const newIndex = order.indexOf(over.id as ReceiptBlockKey);
    if (oldIndex < 0 || newIndex < 0) return;
    update("receiptBlockOrder", arrayMove([...order], oldIndex, newIndex));
  };

  const hideBlock = (key: ReceiptBlockKey) => {
    update(
      "receiptBlockOrder",
      order.filter((k) => k !== key),
    );
  };
  const showBlock = (key: ReceiptBlockKey) => {
    if (order.includes(key)) return;
    update("receiptBlockOrder", [...order, key]);
  };
  const deleteCustomBlock = (id: string) => {
    const { [id]: _gone, ...rest } = draft.receiptCustomBlocks;
    void _gone;
    update("receiptCustomBlocks", rest);
    update(
      "receiptBlockOrder",
      order.filter((k) => k !== `custom:${id}`),
    );
    if (editingCustomId === id) setEditingCustomId(null);
  };
  const upsertCustomBlock = (id: string, patch: Partial<ReceiptCustomBlock>) => {
    const current = draft.receiptCustomBlocks[id] ?? { text: "", align: "center" as ReceiptBlockAlign };
    update("receiptCustomBlocks", {
      ...draft.receiptCustomBlocks,
      [id]: { ...current, ...patch },
    });
  };
  const addCustomBlock = () => {
    const id = newCustomId();
    update("receiptCustomBlocks", {
      ...draft.receiptCustomBlocks,
      [id]: { text: t.blockBody.newTextDefault, align: "center" },
    });
    update("receiptBlockOrder", [...order, `custom:${id}`]);
    setEditingCustomId(id);
  };

  const handleLogoPick = async (file: File) => {
    if (!LOGO_ACCEPT.split(",").includes(file.type)) {
      onError?.(t.errors.unsupportedType);
      return;
    }
    if (file.size > LOGO_SOURCE_MAX_BYTES) {
      onError?.(
        t.errors.tooLarge.replace(
          "{n}",
          String(Math.round(LOGO_SOURCE_MAX_BYTES / (1024 * 1024))),
        ),
      );
      return;
    }
    setUploading(true);
    try {
      let dataUri: string;
      if (file.type === "image/svg+xml") {
        dataUri = await readAsDataUri(file);
        if (bytesOf(dataUri) > LOGO_TARGET_MAX_BYTES) {
          onError?.(t.errors.svgTooLarge);
          return;
        }
      } else {
        dataUri = await downscaleImage(file);
      }
      if (!dataUri.startsWith("data:image/")) {
        onError?.(t.errors.readFailed);
        return;
      }
      update("receiptLogoUrl", dataUri);
    } catch {
      onError?.(t.errors.processFailed);
    } finally {
      setUploading(false);
    }
  };
  const clearLogo = () => {
    update("receiptLogoUrl", "");
    if (fileRef.current) fileRef.current.value = "";
  };

  const fontVar =
    FONT_OPTIONS.find((f) => f.value === draft.receiptFontFamily)?.cssVar ??
    "var(--font-cairo)";

  return (
    <div className="bg-white rounded-xl border border-border p-5 space-y-5">
      <div>
        <h3 className="font-bold text-lg">{t.title}</h3>
        <p className="text-xs text-text-secondary mt-0.5">
          {t.subhead}
        </p>
      </div>

      {/* Logo upload */}
      <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-4 items-start">
        <div className="flex items-center justify-center w-28 h-28 rounded-lg border border-dashed border-border bg-bg-main overflow-hidden shrink-0">
          {draft.receiptLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={draft.receiptLogoUrl} alt={t.logoAlt} className="max-w-full max-h-full object-contain" />
          ) : (
            <span className="text-[10px] text-text-secondary text-center px-2">
              {t.logoEmptyTitle}
              <br />
              {t.logoEmptySubtitle}
            </span>
          )}
        </div>
        <div className="space-y-2 min-w-0">
          <label htmlFor={inputId} className="inline-flex items-center justify-center px-3 py-2 rounded-lg bg-accent text-white text-sm font-medium cursor-pointer hover:bg-accent-hover">
            {uploading ? t.logoUploading : draft.receiptLogoUrl ? t.logoChange : t.logoUpload}
          </label>
          <input
            ref={fileRef}
            id={inputId}
            type="file"
            accept={LOGO_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleLogoPick(f);
            }}
          />
          {draft.receiptLogoUrl && (
            <button type="button" onClick={clearLogo} className="ms-2 text-xs text-danger hover:underline">
              {t.logoRemove}
            </button>
          )}
          <p className="text-[10px] text-text-secondary">
            {t.logoFormatHint}
          </p>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">{t.logoSizeLabel}</label>
            <select
              value={draft.receiptLogoSize}
              onChange={(e) =>
                update("receiptLogoSize", e.target.value as ShopSettings["receiptLogoSize"])
              }
              className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="hidden">{t.logoSize.hidden}</option>
              <option value="small">{t.logoSize.small}</option>
              <option value="medium">{t.logoSize.medium}</option>
              <option value="large">{t.logoSize.large}</option>
            </select>
          </div>
        </div>
      </div>

      {/* Font picker */}
      <div>
        <label className="block text-sm font-medium text-text-secondary mb-2">{t.fontLabel}</label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {FONT_OPTIONS.map((f) => (
            <label
              key={f.value}
              className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                draft.receiptFontFamily === f.value ? "border-accent bg-accent-light/30" : "border-border hover:border-accent"
              }`}
            >
              <input
                type="radio"
                name="receipt-font"
                checked={draft.receiptFontFamily === f.value}
                onChange={() => update("receiptFontFamily", f.value)}
                className="hidden"
              />
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium" dir="ltr">{f.label}</span>
                {draft.receiptFontFamily === f.value && <span className="text-[10px] text-accent">{t.fontSelected}</span>}
              </div>
              <p className="text-sm text-text-primary" style={{ fontFamily: `${f.cssVar}, sans-serif` }}>
                {t.fonts[f.value]}
              </p>
            </label>
          ))}
        </div>
      </div>

      {/* Interactive preview = drag surface */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-text-secondary">
            {t.previewLabel}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={addCustomBlock}
              className="text-xs px-2 py-1 rounded-md bg-accent-light text-accent hover:bg-accent hover:text-white transition-colors"
            >
              {t.addCustom}
            </button>
            <button
              type="button"
              onClick={() => {
                update("receiptBlockOrder", DEFAULT_RECEIPT_BLOCK_ORDER);
              }}
              className="text-xs text-text-secondary hover:text-accent"
            >
              {t.restoreOrder}
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-dashed border-border bg-bg-main p-3">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={order} strategy={verticalListSortingStrategy}>
              <div
                className="mx-auto bg-white border border-border rounded p-3 max-w-xs text-[11px] leading-relaxed text-black"
                style={{ fontFamily: `${fontVar}, sans-serif` }}
              >
                {order.map((key, idx) => (
                  <SortableBlock
                    key={key}
                    blockKey={key}
                    draft={draft}
                    onHide={() => hideBlock(key)}
                    onEditCustom={
                      key.startsWith("custom:")
                        ? () => setEditingCustomId(key.slice(7))
                        : undefined
                    }
                    onDeleteCustom={
                      key.startsWith("custom:")
                        ? () => deleteCustomBlock(key.slice(7))
                        : undefined
                    }
                    showDivider={idx < order.length - 1}
                  />
                ))}
                {order.length === 0 && (
                  <p className="text-center text-text-secondary text-[11px] py-6">
                    {t.emptyReceipt}
                  </p>
                )}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      </div>

      {/* Hidden blocks tray */}
      {(hiddenFixed.length > 0 || hiddenCustom.length > 0) && (
        <div>
          <p className="text-xs font-medium text-text-secondary mb-2">{t.hiddenTitle}</p>
          <div className="flex flex-wrap gap-1.5">
            {hiddenFixed.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => showBlock(k)}
                className="text-xs px-2 py-1 rounded-md bg-bg-main text-text-secondary hover:bg-accent-light hover:text-accent border border-border transition-colors"
              >
                + {t.blockLabels[k]}
              </button>
            ))}
            {hiddenCustom.map(([id, b]) => (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-md bg-bg-main border border-border px-1"
              >
                <button
                  type="button"
                  onClick={() => showBlock(`custom:${id}`)}
                  className="text-xs px-1 py-1 text-text-secondary hover:text-accent"
                >
                  + {b.text.trim().slice(0, 24) || t.customPlaceholder}
                </button>
                <button
                  type="button"
                  onClick={() => deleteCustomBlock(id)}
                  className="text-xs text-danger hover:text-danger/80 px-1"
                  title={t.permanentDelete}
                  aria-label={t.permanentDelete}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Custom block inline editor */}
      {editingCustomId && draft.receiptCustomBlocks[editingCustomId] && (
        <CustomBlockEditor
          block={draft.receiptCustomBlocks[editingCustomId]}
          onChange={(patch) => upsertCustomBlock(editingCustomId, patch)}
          onClose={() => setEditingCustomId(null)}
          onDelete={() => deleteCustomBlock(editingCustomId)}
        />
      )}
    </div>
  );
}

function SortableBlock({
  blockKey,
  draft,
  onHide,
  onEditCustom,
  onDeleteCustom,
  showDivider,
}: {
  blockKey: ReceiptBlockKey;
  draft: ShopSettings;
  onHide: () => void;
  onEditCustom?: () => void;
  onDeleteCustom?: () => void;
  showDivider: boolean;
}) {
  const dict = useDictionary();
  const t = dict.app.receiptDesigner.drag;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: blockKey });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative -mx-1 px-1 rounded ${isDragging ? "ring-2 ring-accent bg-white shadow" : "hover:bg-accent-light/40"}`}
    >
      <div className="absolute top-0 -left-1 -translate-x-full flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity bg-white border border-border rounded-lg shadow-sm p-0.5">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={t.dragLabel}
          className="cursor-grab active:cursor-grabbing text-text-secondary hover:text-accent text-[13px] leading-none w-5 h-5 flex items-center justify-center"
          title={t.dragLabel}
        >
          ⋮⋮
        </button>
        {onEditCustom && (
          <button
            type="button"
            onClick={onEditCustom}
            aria-label={t.editLabel}
            title={t.editLabel}
            className="text-text-secondary hover:text-accent text-[13px] leading-none w-5 h-5 flex items-center justify-center"
          >
            ✎
          </button>
        )}
        <button
          type="button"
          onClick={onDeleteCustom ?? onHide}
          aria-label={onDeleteCustom ? t.deleteLabel : t.hideLabel}
          title={onDeleteCustom ? t.deletePermTitle : t.hideTitle}
          className="text-text-secondary hover:text-danger text-[13px] leading-none w-5 h-5 flex items-center justify-center"
        >
          ✕
        </button>
      </div>

      <BlockBody blockKey={blockKey} draft={draft} />
      {showDivider && <hr className="my-1 border-black" />}
    </div>
  );
}

function BlockBody({
  blockKey,
  draft,
}: {
  blockKey: ReceiptBlockKey;
  draft: ShopSettings;
}) {
  const dict = useDictionary();
  const t = dict.app.receiptDesigner.blockBody;
  // The bilingual T() helper drives what the *customer* sees on the printed
  // receipt — owner picks AR / EN / bilingual from receiptLanguage, this is
  // intentionally not routed through the UI dictionary.
  const lang = draft.receiptLanguage;
  const T = (en: string, ar: string) =>
    lang === "en" ? en : lang === "ar" ? ar : `${en} · ${ar}`;
  const shopName = (draft.shopName || "STORE").toUpperCase();
  const sampleDate = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const dateString = `${pad(sampleDate.getDate())}/${pad(sampleDate.getMonth() + 1)}/${sampleDate.getFullYear()} - ${pad(sampleDate.getHours() % 12 || 12)}:${pad(sampleDate.getMinutes())} ${sampleDate.getHours() >= 12 ? "PM" : "AM"}`;

  if (blockKey.startsWith("custom:")) {
    const id = blockKey.slice(7);
    const custom = draft.receiptCustomBlocks[id];
    if (!custom) return <span className="text-text-secondary text-[10px]">{t.customDeletedMark}</span>;
    return (
      <div
        className="whitespace-pre-wrap text-[11px]"
        style={{ textAlign: custom.align }}
        dir="auto"
      >
        {custom.text || <span className="text-text-secondary">{t.customEmpty}</span>}
      </div>
    );
  }

  const showLoyaltyRows = draft.receiptShowLoyalty && draft.loyaltyEnabled;

  switch (blockKey as ReceiptFixedBlock) {
    case "logo":
      return draft.receiptLogoSize !== "hidden" ? (
        <div className="text-center mb-1">
          {draft.receiptLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={draft.receiptLogoUrl}
              alt="logo"
              className={
                draft.receiptLogoSize === "small"
                  ? "inline-block w-10 max-h-10 object-contain"
                  : draft.receiptLogoSize === "large"
                    ? "inline-block w-24 max-h-24 object-contain"
                    : "inline-block w-16 max-h-16 object-contain"
              }
            />
          ) : (
            <div
              className={`inline-block bg-bg-main rounded ${
                draft.receiptLogoSize === "small"
                  ? "w-10 h-10"
                  : draft.receiptLogoSize === "large"
                    ? "w-24 h-24"
                    : "w-16 h-16"
              }`}
              aria-hidden
            />
          )}
        </div>
      ) : (
        <span className="text-text-secondary text-[10px]">{t.logoHidden}</span>
      );
    case "shopInfo":
      return (
        <>
          <div className="text-center font-bold tracking-wide" dir="auto">{shopName}</div>
          {draft.shopPhone && <div className="text-center" dir="ltr">TEL: {draft.shopPhone}</div>}
        </>
      );
    case "purchaseDate":
      return (
        <div className="flex justify-between">
          <span dir="auto">{shopName}</span>
          <span dir="ltr">{dateString}</span>
        </div>
      );
    case "items":
      return (
        <>
          <div className="text-center font-black tracking-widest">{T("*** RECEIPT ***", "*** فاتورة ***")}</div>
          <div className="flex justify-between mt-1">
            <span>SAMPLE ITEM</span>
            <span>100.00 ج.م</span>
          </div>
        </>
      );
    case "totals":
      return (
        <>
          <div className="flex justify-between">
            <span>{T("SUBTOTAL", "المجموع")}</span>
            <span>100.00 ج.م</span>
          </div>
          {showLoyaltyRows && (
            <div className="flex justify-between">
              <span>{T("CREDIT APPLIED", "رصيد مستخدم")}</span>
              <span>- 10.00 ج.م</span>
            </div>
          )}
          <hr className="my-1 border-black" />
          <div className="flex justify-between font-black">
            <span>{T("TOTAL AMOUNT", "الإجمالي")}</span>
            <span>{showLoyaltyRows ? "90.00" : "100.00"} ج.م</span>
          </div>
        </>
      );
    case "loyalty":
      return showLoyaltyRows ? (
        <div className="flex justify-between">
          <span>{T("POINTS EARNED", "نقاط مكتسبة")}</span>
          <span>+9</span>
        </div>
      ) : (
        <span className="text-text-secondary text-[10px]">{t.loyaltyDisabled}</span>
      );
    case "footer":
      return (
        <>
          <div className="text-center font-bold">{T("THANK YOU FOR SHOPPING!", "شكراً لتسوقكم معنا")}</div>
          {draft.receiptFooterText && (
            <div dir="auto" className="text-center whitespace-pre-wrap mt-1 text-[10px]">
              {draft.receiptFooterText}
            </div>
          )}
        </>
      );
  }
}

function CustomBlockEditor({
  block,
  onChange,
  onClose,
  onDelete,
}: {
  block: ReceiptCustomBlock;
  onChange: (patch: Partial<ReceiptCustomBlock>) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const dict = useDictionary();
  const t = dict.app.receiptDesigner.editor;
  return (
    <div className="rounded-lg border border-accent/40 bg-accent-light/20 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-accent">{t.title}</p>
        <button type="button" onClick={onClose} className="text-xs text-text-secondary hover:text-text-primary">
          {t.done}
        </button>
      </div>
      <textarea
        value={block.text}
        onChange={(e) => onChange({ text: e.target.value })}
        rows={3}
        maxLength={500}
        dir="auto"
        className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        placeholder={t.placeholder}
      />
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-1">
          {(["right", "center", "left"] as const).map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => onChange({ align: a })}
              className={`px-2 py-1 text-xs rounded-md border ${
                block.align === a ? "border-accent bg-accent text-white" : "border-border bg-white text-text-secondary hover:border-accent"
              }`}
            >
              {t.align[a]}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onDelete}
          className="text-xs text-danger hover:underline"
        >
          {t.deletePermanently}
        </button>
      </div>
    </div>
  );
}
