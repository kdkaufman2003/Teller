import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd());

describe("platform admin", () => {
  it("migration defines operator table and service RPCs", () => {
    const sql = readFileSync(join(ROOT, "supabase/migrations/048_platform_admin.sql"), "utf8");
    expect(sql).toContain("teller_platform_admins");
    expect(sql).toContain("teller_platform_complete_setup");
    expect(sql).toContain("teller_platform_attach_org_member");
  });

  it("ops routes and API are present", () => {
    expect(existsSync(join(ROOT, "src/app/ops/layout.tsx"))).toBe(true);
    expect(existsSync(join(ROOT, "src/app/api/platform/users/route.ts"))).toBe(true);
  });

  it("does not log temporary passwords", () => {
    const src = readFileSync(join(ROOT, "src/lib/platform/provision-user.ts"), "utf8");
    expect(src).not.toMatch(/console\.(log|info|debug).*temporaryPassword/i);
  });
});
