"use client";

import { useEffect, useRef, useState } from "react";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { Plus } from "@/lib/icons";
import type { CollectionAccount } from "@/lib/api/collections";
import type { CollectionRail } from "@matgary/domain/collections/types";
import { accountIdentity } from "./rules";

/**
 * Receiving accounts of the selected branch (doc 15 spec 12 §4.8, 09 §4.3
 * item 4): rows `collection-account-<id>` (label, provider, rail, identity,
 * badges) and the add menu. The IBAN never shows here — only inside the form.
 */
export function AccountsCard({
  accounts,
  enabled,
  ingestOn,
  onAdd,
  onOpen,
}: {
  accounts: CollectionAccount[];
  enabled: boolean;
  ingestOn: boolean;
  onAdd: (rail: CollectionRail) => void;
  onOpen: (account: CollectionAccount) => void;
}) {
  const dict = useDictionary();
  const t = dict.app.collectionsSettings.accounts;
  const providers = dict.app.collections.vocab.providers as Record<string, string>;
  const rails = dict.app.collections.vocab.rails as Record<string, string>;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menuOpen]);

  const addButtons = (inline: boolean) => (
    <div className={inline ? "flex flex-wrap justify-center gap-2 mt-3" : "py-1"}>
      <button
        type="button"
        data-testid="collection-accounts-add-instapay"
        onClick={() => {
          setMenuOpen(false);
          onAdd("instapay");
        }}
        className={
          inline
            ? "min-h-11 px-4 rounded-lg border border-accent text-accent text-sm font-semibold hover:bg-accent-light"
            : "w-full min-h-11 px-4 text-start text-sm hover:bg-bg-main"
        }
      >
        {t.addInstapay}
      </button>
      <button
        type="button"
        data-testid="collection-accounts-add-wallet"
        onClick={() => {
          setMenuOpen(false);
          onAdd("wallet");
        }}
        className={
          inline
            ? "min-h-11 px-4 rounded-lg border border-accent text-accent text-sm font-semibold hover:bg-accent-light"
            : "w-full min-h-11 px-4 text-start text-sm hover:bg-bg-main"
        }
      >
        {t.addWallet}
      </button>
    </div>
  );

  return (
    <section className="bg-white rounded-2xl border border-border">
      <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-text-primary">{t.heading}</h2>
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            data-testid="collection-accounts-add"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="inline-flex items-center gap-1 min-h-11 px-3 rounded-lg bg-accent text-white text-sm font-semibold hover:bg-accent-hover"
          >
            <Plus className="w-4 h-4" />
            {t.add}
          </button>
          {menuOpen && (
            <div role="menu" className="absolute end-0 top-full mt-1 z-20 w-56 rounded-xl border border-border bg-white shadow-lg">
              <p className="px-4 pt-2 text-[11px] text-text-secondary">{t.addChooseTitle}</p>
              {addButtons(false)}
            </div>
          )}
        </div>
      </div>

      {enabled && accounts.length === 0 && (
        <p className="mx-5 mt-3 text-xs text-orange-700 bg-orange-50 rounded-lg px-3 py-2">{t.noneWhileEnabled}</p>
      )}

      {accounts.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className="text-sm font-semibold text-text-primary">{t.empty.title}</p>
          <p className="text-xs text-text-secondary mt-1">{t.empty.hint}</p>
          {addButtons(true)}
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {accounts.map((a) => {
            const identity = a.rail === "wallet" && a.walletMsisdn ? a.walletMsisdn : accountIdentity(a);
            return (
              <li key={a.id}>
                <button
                  type="button"
                  data-testid={`collection-account-${a.id}`}
                  onClick={() => onOpen(a)}
                  className="w-full text-start px-5 py-3 min-h-11 hover:bg-bg-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-text-primary" dir="auto">
                      {a.label}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-light text-accent">
                      {rails[a.rail] ?? a.rail}
                    </span>
                    {a.branchId == null && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-main text-text-secondary">
                        {t.badges.allBranches}
                      </span>
                    )}
                    {a.isPosDefault && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-success-light text-success">
                        {t.badges.posDefault}
                      </span>
                    )}
                    {a.isDefaultForMobile && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-main text-text-secondary">
                        {t.badges.mobileDefault}
                      </span>
                    )}
                    {ingestOn && a.autoConfirmEnabled && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-main text-text-secondary">
                        {t.badges.autoConfirm}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-text-secondary mt-0.5">
                    {providers[a.provider] ?? a.provider}
                    {identity && (
                      <>
                        {" · "}
                        <span dir="ltr" className="tabular-nums">
                          {identity}
                        </span>
                      </>
                    )}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
