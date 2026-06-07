"use client";

import { useEffect, useRef, useState } from "react";
import {
  Save,
  MapPin,
  Plus,
  Trash2,
  Clock,
  Check,
  Settings as SettingsIcon,
} from "@/lib/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

type Toast = { type: "success" | "error"; message: string };

interface AttendanceSettings {
  workHoursPerDay: number;
  weekendDays: number[];
  overtimeMultiplier: number;
  graceMinutesLate: number;
}

interface StoreLocation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  geofenceRadiusM: number;
}

const WEEKDAY_KEYS: { iso: number; key: "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat" }[] = [
  { iso: 7, key: "sun" },
  { iso: 1, key: "mon" },
  { iso: 2, key: "tue" },
  { iso: 3, key: "wed" },
  { iso: 4, key: "thu" },
  { iso: 5, key: "fri" },
  { iso: 6, key: "sat" },
];

interface Props {
  onToast: (t: Toast) => void;
}

export function AttendanceSettingsEditor({ onToast }: Props) {
  const dict = useDictionary();
  const t = dict.app.team.attendanceSettings;
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingLocation, setSavingLocation] = useState(false);

  const [settings, setSettings] = useState<AttendanceSettings>({
    workHoursPerDay: 8,
    weekendDays: [5, 6],
    overtimeMultiplier: 1,
    graceMinutesLate: 0,
  });
  const [locations, setLocations] = useState<StoreLocation[]>([]);

  // Add-location form
  const [locName, setLocName] = useState("");
  /** Free-form input — accepts a Google Maps URL or "lat, lng" pair. */
  const [locInput, setLocInput] = useState("");
  const [locRadius, setLocRadius] = useState("50");
  const [resolvingShort, setResolvingShort] = useState(false);
  const parsedCoords = parseGoogleMapsLocation(locInput);

  // Short-link auto-resolver: when the user pastes a maps.app.goo.gl link,
  // hit our server endpoint to follow the redirect and replace the field
  // with the resolved long URL (which the client parser then handles).
  const triedShortLinks = useRef<Set<string>>(new Set());
  useEffect(() => {
    const trimmed = locInput.trim();
    if (!isShortMapsLink(trimmed)) return;
    if (parsedCoords) return; // already parseable, nothing to do
    if (triedShortLinks.current.has(trimmed)) return;
    triedShortLinks.current.add(trimmed);

    let cancelled = false;
    (async () => {
      setResolvingShort(true);
      try {
        const res = await fetch("/api/attendance/locations/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: trimmed }),
        });
        const json = await res.json();
        if (cancelled) return;
        if (res.ok && json.resolvedUrl && json.resolvedUrl !== trimmed) {
          setLocInput(json.resolvedUrl);
        } else if (!res.ok) {
          onToast({
            type: "error",
            message: json.error || t.toast.shortLinkFailed,
          });
        }
      } catch {
        if (!cancelled) {
          onToast({
            type: "error",
            message: t.toast.shortLinkNetwork,
          });
        }
      } finally {
        if (!cancelled) setResolvingShort(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locInput]);

  const refresh = async () => {
    setLoading(true);
    try {
      const [sRes, lRes] = await Promise.all([
        fetch("/api/attendance/settings", { cache: "no-store" }),
        fetch("/api/attendance/locations", { cache: "no-store" }),
      ]);
      if (!sRes.ok) throw new Error(t.toast.loadSettingsFailed);
      if (!lRes.ok) throw new Error(t.toast.loadLocationsFailed);
      const sJson = await sRes.json();
      const lJson = await lRes.json();
      setSettings(sJson.settings);
      setLocations(lJson.locations);
    } catch (e) {
      onToast({
        type: "error",
        message: e instanceof Error ? e.message : t.toast.loadFailed,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleWeekend = (iso: number) => {
    setSettings((s) => ({
      ...s,
      weekendDays: s.weekendDays.includes(iso)
        ? s.weekendDays.filter((d) => d !== iso)
        : [...s.weekendDays, iso].sort((a, b) => a - b),
    }));
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      const res = await fetch("/api/attendance/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const json = await res.json();
      if (!res.ok) {
        onToast({ type: "error", message: json.error || t.toast.saveFailed });
        return;
      }
      onToast({ type: "success", message: t.toast.saveSuccess });
    } finally {
      setSavingSettings(false);
    }
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      onToast({
        type: "error",
        message: t.toast.geoUnsupported,
      });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocInput(
          `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`,
        );
      },
      () => {
        onToast({
          type: "error",
          message: t.toast.geoDenied,
        });
      },
    );
  };

  const addLocation = async () => {
    if (!locName.trim()) {
      onToast({ type: "error", message: t.toast.nameRequired });
      return;
    }
    if (!parsedCoords) {
      onToast({
        type: "error",
        message: t.toast.coordsRequired,
      });
      return;
    }
    setSavingLocation(true);
    try {
      const res = await fetch("/api/attendance/locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: locName.trim(),
          latitude: parsedCoords.latitude,
          longitude: parsedCoords.longitude,
          geofenceRadiusM: Number(locRadius) || 50,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        onToast({ type: "error", message: json.error || t.toast.addFailed });
        return;
      }
      setLocations((prev) => [json.location, ...prev]);
      setLocName("");
      setLocInput("");
      setLocRadius("50");
      onToast({ type: "success", message: t.toast.addSuccess });
    } finally {
      setSavingLocation(false);
    }
  };

  const deleteLocation = async (id: string) => {
    const res = await fetch(`/api/attendance/locations/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      onToast({ type: "error", message: t.toast.deleteFailed });
      return;
    }
    setLocations((prev) => prev.filter((l) => l.id !== id));
  };

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-border p-8 text-center text-text-secondary">
        {t.loading}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Work hours / weekend / overtime */}
      <section className="bg-white rounded-xl border border-border p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Clock className="w-5 h-5 text-accent" />
          <h3 className="font-bold text-base">{t.workHoursSection}</h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            label={t.fields.workHoursPerDay}
            type="number"
            inputMode="decimal"
            min={1}
            max={24}
            value={settings.workHoursPerDay}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                workHoursPerDay: Number(e.target.value) || 0,
              }))
            }
          />
          <Input
            label={t.fields.overtimeMultiplier}
            type="number"
            inputMode="decimal"
            min={1}
            max={5}
            step={0.1}
            value={settings.overtimeMultiplier}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                overtimeMultiplier: Number(e.target.value) || 1,
              }))
            }
          />
          <Input
            label={t.fields.graceMinutesLate}
            type="number"
            inputMode="numeric"
            min={0}
            max={120}
            value={settings.graceMinutesLate}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                graceMinutesLate: Number(e.target.value) || 0,
              }))
            }
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-secondary mb-2">
            {t.weekend.label}
          </label>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAY_KEYS.map((d) => {
              const active = settings.weekendDays.includes(d.iso);
              return (
                <button
                  key={d.iso}
                  type="button"
                  onClick={() => toggleWeekend(d.iso)}
                  className={cn(
                    "px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors",
                    active
                      ? "bg-accent text-white border-accent"
                      : "bg-white text-text-secondary border-border hover:border-accent/40",
                  )}
                >
                  {t.weekend.days[d.key]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end pt-1">
          <Button
            onClick={saveSettings}
            loading={savingSettings}
            disabled={savingSettings}
            className="flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            {t.saveSettings}
          </Button>
        </div>
      </section>

      {/* Store locations */}
      <section className="bg-white rounded-xl border border-border p-5 space-y-4">
        <div className="flex items-center gap-2">
          <MapPin className="w-5 h-5 text-accent" />
          <h3 className="font-bold text-base">{t.locations.title}</h3>
        </div>
        <p className="text-xs text-text-secondary leading-relaxed">
          {t.locations.intro}
        </p>

        {locations.length > 0 && (
          <ul className="space-y-2">
            {locations.map((l) => (
              <li
                key={l.id}
                className="flex items-center justify-between gap-3 p-3 rounded-lg border border-border bg-bg-main/30"
              >
                <div className="min-w-0">
                  <p className="font-medium text-sm text-text-primary truncate" dir="auto">
                    {l.name}
                  </p>
                  <p
                    dir="ltr"
                    className="text-[11px] text-text-secondary mt-0.5 font-mono"
                  >
                    {l.latitude.toFixed(6)}, {l.longitude.toFixed(6)} ·{" "}
                    {l.geofenceRadiusM}m
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => deleteLocation(l.id)}
                  className="shrink-0 p-2 rounded-lg text-text-secondary hover:text-danger hover:bg-danger-light"
                  aria-label={t.locations.deleteAria}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Add new location */}
        <div className="rounded-lg border border-border p-3 space-y-3">
          <p className="text-sm font-medium flex items-center gap-1.5">
            <Plus className="w-4 h-4 text-accent" />
            {t.locations.addHeading}
          </p>
          <Input
            label={t.locations.nameLabel}
            value={locName}
            onChange={(e) => setLocName(e.target.value)}
            placeholder={t.locations.namePlaceholder}
          />

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              {t.locations.linkLabel}
            </label>
            <input
              type="text"
              value={locInput}
              onChange={(e) => setLocInput(e.target.value)}
              dir="ltr"
              placeholder={t.locations.linkPlaceholder}
              className="w-full px-3 py-2.5 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-text-secondary/60"
            />
            <p className="text-[11px] text-text-secondary mt-1.5 leading-relaxed">
              {t.locations.linkHelp}
            </p>

            {locInput.trim() &&
              (parsedCoords ? (
                <div
                  className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-success/10 text-success text-xs font-medium"
                  dir="ltr"
                >
                  <Check className="w-3.5 h-3.5" weight="bold" />
                  <span>
                    {parsedCoords.latitude.toFixed(6)},{" "}
                    {parsedCoords.longitude.toFixed(6)}
                  </span>
                </div>
              ) : resolvingShort ? (
                <p className="text-xs text-text-secondary mt-2">
                  {t.locations.resolvingShort}
                </p>
              ) : (
                <p className="text-xs text-danger mt-2">
                  {t.locations.parseFailed}
                </p>
              ))}
          </div>

          <Input
            label={t.locations.radiusLabel}
            type="number"
            min={10}
            max={2000}
            value={locRadius}
            onChange={(e) => setLocRadius(e.target.value)}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="secondary"
              onClick={useMyLocation}
              className="flex items-center gap-1.5"
            >
              <MapPin className="w-4 h-4" />
              {t.locations.useMyLocation}
            </Button>
            <Button
              onClick={addLocation}
              loading={savingLocation}
              disabled={savingLocation}
              className="flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              {t.locations.addButton}
            </Button>
          </div>
        </div>
      </section>

      <div className="bg-bg-card/60 border border-border rounded-xl p-4 flex items-start gap-2">
        <SettingsIcon className="w-4 h-4 text-text-secondary shrink-0 mt-0.5" />
        <p className="text-xs text-text-secondary leading-relaxed">
          {t.footnote}
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Google Maps location parser
//
// Accepts the formats a user actually copies:
//   • "30.044420, 31.235712"  (right-click → copy coordinates)
//   • https://www.google.com/maps/place/.../@30.044420,31.235712,17z/...
//   • https://www.google.com/maps?q=30.044420,31.235712
//   • https://www.google.com/maps?q=loc:30.044420,31.235712
//   • https://maps.google.com/?ll=30.044420,31.235712
//   • https://www.google.com/maps/@30.044420,31.235712,17z
//
// Short links (maps.app.goo.gl/xyz) require a network redirect and are not
// resolved here — the user is told to use the long URL or paste coordinates.
// ─────────────────────────────────────────────────────────────────────────────
/** Recognize Google Maps short-link hosts that need server-side redirect-follow. */
function isShortMapsLink(s: string): boolean {
  return /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//i.test(s);
}

function parseGoogleMapsLocation(
  input: string,
): { latitude: number; longitude: number } | null {
  const s = input.trim();
  if (!s) return null;

  const NUM = "(-?\\d+(?:\\.\\d+)?)";
  // Try, in order: @lat,lng — q=lat,lng — q=loc:lat,lng — ll=lat,lng — bare lat,lng
  const patterns = [
    new RegExp(`@${NUM},${NUM}`),
    new RegExp(`[?&]q=(?:loc:)?${NUM},${NUM}`),
    new RegExp(`[?&]ll=${NUM},${NUM}`),
    new RegExp(`^${NUM}\\s*,\\s*${NUM}$`),
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        lat >= -90 &&
        lat <= 90 &&
        lng >= -180 &&
        lng <= 180
      ) {
        return { latitude: lat, longitude: lng };
      }
    }
  }
  return null;
}
