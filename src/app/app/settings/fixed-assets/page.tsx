"use client";

import { useEffect, useState } from "react";

export default function FixedAssetSettingsPage() {
  const [settings, setSettings] = useState<{
    capitalization_threshold: number | null;
    depreciation_convention: string;
    rounding_policy: string;
  } | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void fetch("/api/fixed-asset-settings")
      .then((response) => response.json())
      .then((data) => setSettings(data.settings));
  }, []);

  async function save() {
    if (!settings) return;
    setMessage("");
    const response = await fetch("/api/fixed-asset-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || "Save failed");
      return;
    }
    setSettings(data.settings);
    setMessage("Saved.");
  }

  if (!settings) return <p className="text-muted p-6">Loading…</p>;

  return (
    <div className="mx-auto max-w-lg space-y-6 p-6">
      <header className="page-header">
        <h1>Fixed asset settings</h1>
      </header>
      <div className="card space-y-4 p-4">
        <label className="block space-y-1">
          <span className="text-sm">Capitalization threshold</span>
          <input
            className="input w-full"
            type="number"
            value={settings.capitalization_threshold ?? ""}
            onChange={(e) =>
              setSettings({
                ...settings,
                capitalization_threshold: e.target.value ? Number(e.target.value) : null,
              })
            }
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm">Depreciation convention</span>
          <select
            className="input w-full"
            value={settings.depreciation_convention}
            onChange={(e) => setSettings({ ...settings, depreciation_convention: e.target.value })}
          >
            <option value="full_month">Full month</option>
            <option value="next_full_month">Next full month</option>
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-sm">Rounding policy</span>
          <select
            className="input w-full"
            value={settings.rounding_policy}
            onChange={(e) => setSettings({ ...settings, rounding_policy: e.target.value })}
          >
            <option value="last_period">Last period</option>
            <option value="per_period">Per period</option>
          </select>
        </label>
        {message ? <p className="text-sm">{message}</p> : null}
        <button type="button" className="btn btn-primary" onClick={save}>
          Save settings
        </button>
      </div>
    </div>
  );
}
