"use client";

import { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { parseCsv, type ParsedRow } from "@/lib/csvImport";
import { bulkAddProducts } from "@/lib/firestore";
import { Upload, AlertTriangle, CheckCircle2 } from "lucide-react";

interface CsvImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (count: number) => void;
}

export function CsvImportModal({ isOpen, onClose, onSuccess }: CsvImportModalProps) {
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState("");

  const valid = rows.filter((r) => r.ok);
  const invalid = rows.filter((r) => !r.ok);

  const handleFile = async (file: File) => {
    const text = await file.text();
    const parsed = parseCsv(text);
    setRows(parsed);
    setFileName(file.name);
  };

  const handleImport = async () => {
    if (valid.length === 0) return;
    setBusy(true);
    try {
      const added = await bulkAddProducts(valid.map((r) => r.data!));
      onSuccess(added);
      handleClose();
    } catch (e: any) {
      alert(e.message || "تعذر استيراد الملف");
    } finally {
      setBusy(false);
    }
  };

  const handleClose = () => {
    setRows([]);
    setFileName("");
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="استيراد منتجات من CSV" className="max-w-2xl">
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          الأعمدة المطلوبة: الاسم، الصنف (ساعات/برفانات/نظارات)، الجنس (رجالي/حريمي)، الكمية، سعر البيع.
          الأعمدة الاختيارية: البراند، سعر الشراء، حد التنبيه، الكود/الباركود، التاجات (مفصولة بـ | أو فاصلة)، المورد، مكان التخزين.
        </p>

        <label className="block">
          <div className="border-2 border-dashed border-border rounded-xl p-6 text-center cursor-pointer hover:border-accent transition-colors">
            <Upload className="w-8 h-8 mx-auto text-text-secondary mb-2" />
            <p className="font-medium">اختر ملف CSV</p>
            {fileName && (
              <p className="text-xs text-text-secondary mt-1">{fileName}</p>
            )}
          </div>
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
        </label>

        {rows.length > 0 && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="p-3 rounded-lg bg-success-light/50 border border-success/20 flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-success" />
                <div>
                  <p className="text-xs text-text-secondary">صفوف صالحة</p>
                  <p className="font-bold text-lg">{valid.length}</p>
                </div>
              </div>
              <div className="p-3 rounded-lg bg-danger-light/50 border border-danger/20 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-danger" />
                <div>
                  <p className="text-xs text-text-secondary">صفوف بها أخطاء</p>
                  <p className="font-bold text-lg">{invalid.length}</p>
                </div>
              </div>
            </div>

            {invalid.length > 0 && (
              <div className="border border-danger/20 rounded-lg max-h-40 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-danger-light/30 sticky top-0">
                    <tr>
                      <th className="text-start p-2">الاسم</th>
                      <th className="text-start p-2">الأخطاء</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invalid.map((r, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="p-2">{r.raw["الاسم"] || r.raw["name"] || "-"}</td>
                        <td className="p-2 text-danger">{r.errors.join("، ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <Button variant="ghost" onClick={handleClose} className="flex-1">
            إلغاء
          </Button>
          <Button
            onClick={handleImport}
            loading={busy}
            disabled={valid.length === 0}
            className="flex-1"
          >
            استيراد {valid.length > 0 ? `(${valid.length})` : ""}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
