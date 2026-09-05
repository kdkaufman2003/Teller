import type { JobType } from "@/types";
import { asNumber } from "@/lib/format";
import { invoicePaymentProgress } from "@/lib/accounting/payment-fees";
import type { HfacWonQuote } from "./hfac";

export type QuoteCogsBreakdown = {
  equipment: number;
  labor: number;
  materials: number;
  salesperson: string | null;
};

export function mapHfacJobType(value: string | null | undefined): JobType {
  const raw = String(value || "").toLowerCase();
  if (raw.includes("service") || raw.includes("repair")) return "service";
  if (raw.includes("maint")) return "maintenance";
  if (raw.includes("warrant")) return "warranty";
  return "install";
}

function centsOrDollars(dollars: unknown, cents: unknown): number {
  if (cents != null && cents !== "") return asNumber(cents) / 100;
  return asNumber(dollars);
}

export function quoteCogsBreakdown(quote: HfacWonQuote): QuoteCogsBreakdown {
  const nested =
    quote.cogs && typeof quote.cogs === "object" ? (quote.cogs as Record<string, unknown>) : {};

  return {
    equipment: centsOrDollars(quote.equipment_cost ?? nested.equipment, quote.equipment_cost_cents),
    labor: centsOrDollars(quote.labor_cost ?? nested.labor, quote.labor_cost_cents),
    materials: centsOrDollars(quote.materials_cost ?? nested.materials, quote.materials_cost_cents),
    salesperson: quote.salesperson?.trim() || null,
  };
}

export function quoteJobMetadata(quote: HfacWonQuote) {
  const cogs = quoteCogsBreakdown(quote);
  return {
    hfac: {
      source: quote.source || "deal",
      quote_id: quote.id,
      salesperson: cogs.salesperson,
      cogs,
    },
  };
}

export function invoicePaymentStatus(
  priorPaid: number,
  paymentAmount: number,
  invoiceTotal: number,
) {
  return invoicePaymentProgress(priorPaid, paymentAmount, invoiceTotal);
}
