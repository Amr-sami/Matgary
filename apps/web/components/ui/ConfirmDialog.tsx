"use client";

import { Modal } from "./Modal";
import { Button } from "./Button";
import { AlertTriangle } from "@/lib/icons";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "primary";
  loading?: boolean;
}

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText,
  cancelText,
  variant = "danger",
  loading,
}: ConfirmDialogProps) {
  const dict = useDictionary();
  const t = dict.app.ui.confirm;
  const handleConfirm = async () => {
    await onConfirm();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title}>
      <div className="text-center">
        <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-danger-light flex items-center justify-center">
          <AlertTriangle className="w-6 h-6 text-danger" />
        </div>
        <p className="text-text-secondary mb-6">{message}</p>
        <div className="flex gap-3 justify-center">
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {cancelText ?? t.cancel}
          </Button>
          <Button variant={variant} onClick={handleConfirm} loading={loading}>
            {confirmText ?? t.confirm}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
