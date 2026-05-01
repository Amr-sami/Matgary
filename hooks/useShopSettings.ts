"use client";

import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS, subscribeToSettings, type ShopSettings } from "@/lib/settings";

export function useShopSettings() {
  const [settings, setSettings] = useState<ShopSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = subscribeToSettings((s) => {
      setSettings(s);
      setLoading(false);
    });
    return unsub;
  }, []);

  return { settings, loading };
}
