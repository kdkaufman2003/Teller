import { describe, expect, it } from "vitest";
import {
  CSV_MAX_BYTES,
  csvImportFingerprint,
  mapCsvRowsToTransactions,
  normalizeDescription,
  parseBankCsv,
  parseCsvText,
  sanitizeCsvCell,
} from "./csv";

describe("sanitizeCsvCell", () => {
  it("prefixes formula injection cells", () => {
    expect(sanitizeCsvCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(sanitizeCsvCell("+100")).toBe("'+100");
    expect(sanitizeCsvCell("-100")).toBe("'-100");
    expect(sanitizeCsvCell("@cmd")).toBe("'@cmd");
  });
});

describe("parseCsvText", () => {
  it("parses quoted CSV with commas", () => {
    const parsed = parseCsvText(`Date,Description,Amount
2026-05-01,"Home Depot, LLC",-87.42`);
    expect(parsed.headers).toEqual(["Date", "Description", "Amount"]);
    expect(parsed.rows[0][1]).toBe("Home Depot, LLC");
  });

  it("rejects duplicate headers", () => {
    expect(() => parseCsvText("Date,Date\n2026-05-01,1")).toThrow(/Duplicate CSV headers/);
  });

  it("rejects oversized files", () => {
    expect(() => parseCsvText("a".repeat(CSV_MAX_BYTES + 1))).toThrow(/maximum size/);
  });
});

describe("mapCsvRowsToTransactions", () => {
  const base = {
    organizationId: "org-1",
    bankAccountId: "bank-1",
    headers: ["Date", "Description", "Amount"],
    bankAccountType: "depository",
    bankAccountSubtype: "checking",
  };

  it("maps amount column to normalized asset-bank inflow", () => {
    const result = mapCsvRowsToTransactions({
      ...base,
      rows: [["2026-05-01", "Stripe deposit", "-1250.00"]],
      mapping: { date: "Date", description: "Description", amount: "Amount" },
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].rawAmount).toBe(-1250);
    expect(result.rows[0].normalizedAmount).toBe(1250);
    expect(result.rows[0].importFingerprint).toBeTruthy();
  });

  it("parses sanitized formula-prefixed negative amounts", () => {
    const result = mapCsvRowsToTransactions({
      ...base,
      rows: [["2026-05-01", "Interest", "'-25.00"]],
      mapping: { date: "Date", description: "Description", amount: "Amount" },
    });

    expect(result.rows[0].rawAmount).toBe(-25);
    expect(result.rows[0].normalizedAmount).toBe(25);
  });

  it("maps debit/credit columns", () => {
    const result = mapCsvRowsToTransactions({
      ...base,
      headers: ["Date", "Description", "Debit", "Credit"],
      rows: [["2026-05-02", "Vendor payment", "428.16", ""]],
      mapping: {
        date: "Date",
        description: "Description",
        debit: "Debit",
        credit: "Credit",
      },
    });

    expect(result.rows[0].rawAmount).toBe(428.16);
    expect(result.rows[0].normalizedAmount).toBe(-428.16);
  });

  it("warns on duplicate fingerprints but imports both legitimate rows", () => {
    const result = mapCsvRowsToTransactions({
      ...base,
      rows: [
        ["2026-05-01", "Duplicate", "-10.00"],
        ["2026-05-01", "Duplicate", "-10.00"],
      ],
      mapping: { date: "Date", description: "Description", amount: "Amount" },
    });

    expect(result.rows).toHaveLength(2);
    expect(result.duplicates).toHaveLength(1);
    expect(result.skipped).toBe(0);
    expect(result.rows[0].providerTransactionId).not.toBe(result.rows[1].providerTransactionId);
  });

  it("captures row-level validation errors", () => {
    const result = mapCsvRowsToTransactions({
      ...base,
      rows: [["not-a-date", "Bad row", "abc"]],
      mapping: { date: "Date", description: "Description", amount: "Amount" },
    });

    expect(result.rows).toHaveLength(0);
    expect(result.errors[0]?.row).toBe(2);
  });
});

describe("csvImportFingerprint", () => {
  it("is deterministic for normalized values", () => {
    const input = {
      organizationId: "org-1",
      bankAccountId: "bank-1",
      postedDate: "2026-05-01",
      normalizedAmount: 100,
      description: "  Stripe   Deposit ",
    };
    const first = csvImportFingerprint(input);
    const second = csvImportFingerprint({
      ...input,
      description: "stripe deposit",
    });
    expect(first).toBe(second);
    expect(first).toHaveLength(64);
  });

  it("changes when amount changes", () => {
    const base = {
      organizationId: "org-1",
      bankAccountId: "bank-1",
      postedDate: "2026-05-01",
      description: "Deposit",
    };
    expect(
      csvImportFingerprint({ ...base, normalizedAmount: 100 }),
    ).not.toBe(csvImportFingerprint({ ...base, normalizedAmount: 101 }));
  });
});

describe("parseBankCsv", () => {
  it("sanitizes formula injection in preview output", () => {
    const parsed = parseBankCsv({
      organizationId: "org-1",
      bankAccountId: "bank-1",
      content: `Date,Description,Amount
2026-05-01,=CMD,10`,
      mapping: { date: "Date", description: "Description", amount: "Amount" },
    });
    expect(parsed.rows[0].description.startsWith("'")).toBe(true);
  });
});

describe("normalizeDescription", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeDescription("  ACME   Corp  ")).toBe("acme corp");
  });
});
