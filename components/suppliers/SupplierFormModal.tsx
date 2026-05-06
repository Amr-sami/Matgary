"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { SupplierDescriptor } from "@/lib/types";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** When provided, the modal acts as edit; otherwise it's create. */
  supplier?: SupplierDescriptor | null;
  onSaved: (id: string) => void;
  onError: (message: string) => void;
}

export function SupplierFormModal({ isOpen, onClose, supplier, onSaved, onError }: Props) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setName(supplier?.name ?? "");
    setPhone(supplier?.phone ?? "");
    setEmail(supplier?.email ?? "");
    setAddress(supplier?.address ?? "");
    setNotes(supplier?.notes ?? "");
  }, [isOpen, supplier]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        address: address.trim() || null,
        notes: notes.trim() || null,
      };
      const url = supplier ? `/api/suppliers/${supplier.id}` : "/api/suppliers";
      const method = supplier ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        onError(json.error || "تعذر الحفظ");
        return;
      }
      const data = supplier ? { id: supplier.id } : await res.json();
      onSaved(data.id);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={supplier ? "تعديل مورد" : "مورد جديد"}>
      <form onSubmit={submit} className="space-y-4">
        <Input
          label="الاسم *"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus
        />
        <Input
          label="رقم الهاتف"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="tel"
        />
        <Input
          label="البريد الإلكتروني"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
        />
        <Input
          label="العنوان"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            ملاحظات
          </label>
          <textarea
            dir="rtl"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg border border-border bg-white text-text-primary placeholder:text-text-secondary focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-colors resize-none"
          />
        </div>
        <div className="flex gap-2 justify-end pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            إلغاء
          </Button>
          <Button type="submit" disabled={!name.trim() || submitting}>
            {submitting ? "جاري الحفظ…" : supplier ? "حفظ" : "إضافة"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
