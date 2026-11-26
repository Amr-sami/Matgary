"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { DEFAULT_SETTINGS, fetchShopSettings, type ShopSettings } from "@/lib/settings";

interface SettingsContextValue {
  settings: ShopSettings;
  loading: boolean;
  refresh: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

const CACHE_KEY = "shop:settings:v1";

// Read the last successfully-fetched settings from localStorage. Used to
// seed initial state so the sidebar shows the correct store name on the
// very first paint instead of flashing DEFAULT_SETTINGS for ~50ms.
const readCachedSettings = (): ShopSettings | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as ShopSettings) : null;
  } catch {
    return null;
  }
};

const writeCachedSettings = (next: ShopSettings) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    // Quota or private mode — ignore; fetch will still hydrate the UI.
  }
};

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<ShopSettings>(
    () => readCachedSettings() ?? DEFAULT_SETTINGS,
  );
  const [loading, setLoading] = useState(() => readCachedSettings() === null);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchShopSettings();
      setSettings(next);
      writeCachedSettings(next);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <SettingsContext.Provider value={{ settings, loading, refresh }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    return {
      settings: DEFAULT_SETTINGS,
      loading: false,
      refresh: async () => {},
    };
  }
  return ctx;
}
