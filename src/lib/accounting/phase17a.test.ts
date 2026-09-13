import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("Phase 17A accounting integrity audit (static)", () => {
  it("canonical postJournal gateway exists", () => {
    const post = read("src/lib/accounting/post.ts");
    expect(post).toMatch(/export async function postJournal/);
    expect(post).toMatch(/assertBalanced/);
  });

  it("no direct journal entry mutations in src/", () => {
    const unsafeEntry = /\.from\(["']teller_journal_entries["']\)\s*\.\s*(insert|update|delete|upsert)/;
    function walk(dir: string): string[] {
      const hits: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) hits.push(...walk(full));
        else if (/\.(ts|tsx)$/.test(entry.name) && unsafeEntry.test(readFileSync(full, "utf8"))) {
          hits.push(full);
        }
      }
      return hits;
    }
    expect(walk(join(ROOT, "src"))).toEqual([]);
  });

  it("no journal line mutations in src/", () => {
    const unsafeLine = /\.from\(["']teller_journal_lines["']\)\s*\.\s*(insert|update|delete|upsert)/;
    const hits: string[] = [];
    function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && unsafeLine.test(readFileSync(full, "utf8"))) {
          hits.push(full);
        }
      }
    }
    walk(join(ROOT, "src"));
    expect(hits).toEqual([]);
  });

  it("entity books migration enforces one journal one entity", () => {
    const sql = read("supabase/migrations/042_phase16c_entity_books.sql");
    expect(sql).toMatch(/legal_entity_id is distinct from NEW.legal_entity_id/);
  });

  it("journal immutability — no UPDATE policy in 047", () => {
    const sql = read("supabase/migrations/047_phase16h_entity_controls.sql");
    expect(sql.toLowerCase()).not.toMatch(/teller_journal_entries[\s\S]*for update/);
  });

  it("integrity and subledger modules exist", () => {
    expect(existsSync(join(ROOT, "src/lib/accounting/integrity.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "src/lib/accounting/subledger.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "src/lib/accounting/subledger-reconciliation.test.ts"))).toBe(true);
  });

  it("Phase 17A diagnostic doc exists", () => {
    expect(existsSync(join(ROOT, "docs/PHASE-17A-DIAGNOSTIC.md"))).toBe(true);
  });

  it("Phase 17A production verify script exists", () => {
    expect(existsSync(join(ROOT, "scripts/verify-phase17a-production.mjs"))).toBe(true);
  });
});
