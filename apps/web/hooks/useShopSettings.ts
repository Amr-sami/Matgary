"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_SETTINGS, fetchShopSettings, type ShopSettings } from "@/lib/settings";

export function useShopSettings() {
  const [settings, setSettings] = useState<ShopSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchShopSettings();
      setSettings(next);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { settings, loading, refresh };
}
