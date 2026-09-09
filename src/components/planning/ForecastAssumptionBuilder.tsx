"use client";

import { useState } from "react";
import { monthLabel } from "@/lib/planning/budgets/periods";
import type {
  AssumptionTargetScope,
  AssumptionType,
  ForecastAssumptionKind,
} from "@/lib/planning/forecasts/types";

type AccountOption = { id: string; code: string; name: string; type: string };

export type AssumptionFormState = {
  name: string;
  description: string;
  assumptionType: AssumptionType;
  assumptionKind: ForecastAssumptionKind;
  targetScope: AssumptionTargetScope;
  targetAccountId: string;
  valueNumeric: string;
  effectiveStartMonth: string;
  effectiveEndMonth: string;
  seasonMonth: string;
};

const defaultForm = (forwardMonths: string[]): AssumptionFormState => ({
  name: "",
  description: "",
  assumptionType: "percentage_change",
  assumptionKind: "revenue_growth",
  targetScope: "all_revenue",
  targetAccountId: "",
  valueNumeric: "",
  effectiveStartMonth: forwardMonths[0]?.slice(0, 7) ?? "",
  effectiveEndMonth: "",
  seasonMonth: "12",
});

export function ForecastAssumptionBuilder({
  accounts,
  forwardMonths,
  pending,
  onSubmit,
}: {
  accounts: AccountOption[];
  forwardMonths: string[];
  pending: boolean;
  onSubmit: (form: AssumptionFormState) => Promise<void>;
}) {
  const [form, setForm] = useState(defaultForm(forwardMonths));

  function update<K extends keyof AssumptionFormState>(key: K, value: AssumptionFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function syncTypeAndScope(type: AssumptionType) {
    const next = { ...form, assumptionType: type };
    if (type === "target_margin") {
      next.targetScope = "all_cogs";
      next.assumptionKind = "material_inflation";
    } else if (type === "month_multiplier") {
      next.targetScope = "all_revenue";
      next.assumptionKind = "seasonality";
    } else if (type === "fixed_monthly_amount") {
      next.targetScope = "account";
      next.assumptionKind = "rent_increase";
    } else if (type === "percentage_change" && next.targetScope === "all_cogs") {
      next.assumptionKind = "material_inflation";
    } else if (type === "percentage_change" && next.targetScope === "all_expense") {
      next.assumptionKind = "labor_cost";
    } else if (type === "percentage_change") {
      next.assumptionKind = "revenue_growth";
    }
    setForm(next);
  }

  return (
    <div className="mt-4 grid gap-3 rounded-lg border bg-muted/20 p-4">
      <h3 className="text-sm font-medium">Add assumption</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm sm:col-span-2">
          Name
          <input
            className="mt-1 w-full rounded border px-3 py-2"
            value={form.name}
            onChange={(event) => update("name", event.target.value)}
            placeholder="Revenue growth"
          />
        </label>
        <label className="text-sm">
          Type
          <select
            className="mt-1 w-full rounded border px-3 py-2"
            value={form.assumptionType}
            onChange={(event) => syncTypeAndScope(event.target.value as AssumptionType)}
          >
            <option value="percentage_change">Increase / decrease by %</option>
            <option value="fixed_monthly_amount">Fixed monthly amount</option>
            <option value="target_margin">Target gross margin</option>
            <option value="month_multiplier">Seasonal month adjustment</option>
            <option value="note">Note only</option>
          </select>
        </label>
        <label className="text-sm">
          Applies to
          <select
            className="mt-1 w-full rounded border px-3 py-2"
            value={form.targetScope}
            disabled={form.assumptionType === "target_margin"}
            onChange={(event) => {
              const targetScope = event.target.value as AssumptionTargetScope;
              update("targetScope", targetScope);
              if (targetScope === "all_cogs") update("assumptionKind", "material_inflation");
              if (targetScope === "all_expense") update("assumptionKind", "labor_cost");
              if (targetScope === "all_revenue") update("assumptionKind", "revenue_growth");
            }}
          >
            <option value="all_revenue">All revenue</option>
            <option value="all_cogs">All COGS</option>
            <option value="all_expense">All operating expenses</option>
            <option value="account">Selected account</option>
          </select>
        </label>
        {form.targetScope === "account" ? (
          <label className="text-sm sm:col-span-2">
            Account
            <select
              className="mt-1 w-full rounded border px-3 py-2"
              value={form.targetAccountId}
              onChange={(event) => update("targetAccountId", event.target.value)}
            >
              <option value="">Select account</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} · {account.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {form.assumptionType !== "note" ? (
          <label className="text-sm">
            {form.assumptionType === "fixed_monthly_amount"
              ? "Amount"
              : form.assumptionType === "target_margin"
                ? "Target margin %"
                : "Percent change"}
            <input
              type="number"
              step="0.01"
              className="mt-1 w-full rounded border px-3 py-2"
              value={form.valueNumeric}
              onChange={(event) => update("valueNumeric", event.target.value)}
              placeholder={form.assumptionType === "fixed_monthly_amount" ? "5000" : "8"}
            />
          </label>
        ) : null}
        {form.assumptionType === "month_multiplier" ? (
          <label className="text-sm">
            Month
            <select
              className="mt-1 w-full rounded border px-3 py-2"
              value={form.seasonMonth}
              onChange={(event) => update("seasonMonth", event.target.value)}
            >
              {Array.from({ length: 12 }, (_, index) => {
                const month = String(index + 1).padStart(2, "0");
                return (
                  <option key={month} value={month}>
                    {monthLabel(`2027-${month}-01`)}
                  </option>
                );
              })}
            </select>
          </label>
        ) : null}
        {form.assumptionType !== "note" && form.assumptionType !== "month_multiplier" ? (
          <label className="text-sm">
            Starting
            <input
              type="month"
              className="mt-1 w-full rounded border px-3 py-2"
              value={form.effectiveStartMonth}
              onChange={(event) => update("effectiveStartMonth", event.target.value)}
            />
          </label>
        ) : null}
        <label className="text-sm sm:col-span-2">
          Description (optional)
          <input
            className="mt-1 w-full rounded border px-3 py-2"
            value={form.description}
            onChange={(event) => update("description", event.target.value)}
          />
        </label>
      </div>
      <button
        type="button"
        disabled={pending || !form.name.trim()}
        onClick={() => void onSubmit(form)}
        className="w-fit rounded-md border px-4 py-2 text-sm disabled:opacity-50"
      >
        Add assumption
      </button>
    </div>
  );
}

export function assumptionFormToPayload(form: AssumptionFormState) {
  const effectiveStartMonth = form.effectiveStartMonth
    ? `${form.effectiveStartMonth}-01`
    : null;
  const parameters: Record<string, unknown> = {
    assumptionType: form.assumptionType,
    targetScope: form.targetScope,
  };
  if (form.assumptionType === "month_multiplier") {
    parameters.month = Number(form.seasonMonth);
  }

  return {
    name: form.name.trim(),
    description: form.description.trim(),
    assumptionKind: form.assumptionKind,
    assumptionType: form.assumptionType,
    targetScope: form.targetScope,
    valueType:
      form.assumptionType === "fixed_monthly_amount"
        ? "currency"
        : form.assumptionType === "note"
          ? "text"
          : "percentage",
    valueNumeric: form.valueNumeric ? Number(form.valueNumeric) : null,
    effectiveStartMonth,
    effectiveEndMonth: form.effectiveEndMonth ? `${form.effectiveEndMonth}-01` : null,
    targetAccountId: form.targetScope === "account" ? form.targetAccountId || null : null,
    parameters,
  };
}
