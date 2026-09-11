#!/usr/bin/env node
/**
 * Read-only production smoke for Phase 15 deploy (no auth session).
 * Usage: node scripts/verify-phase15-production-smoke.mjs [baseUrl]
 */
const BASE_URL = (process.argv[2] ?? process.env.TELLER_PRODUCTION_URL ?? "https://teller-indol.vercel.app").replace(
  /\/$/,
  "",
);

const ROUTES = [
  { path: "/login", expectStatus: [200], label: "login page" },
  { path: "/app/settings/tax", expectStatus: [307, 308], label: "tax settings (auth redirect)" },
  { path: "/app/settings/tax/configure", expectStatus: [307, 308], label: "tax configure (auth redirect)" },
  { path: "/app/reports/tax", expectStatus: [307, 308], label: "tax reports (auth redirect)" },
  { path: "/api/tax/overview", expectStatus: [401], label: "tax overview API (unauthenticated)" },
  { path: "/api/tax/calculate", expectStatus: [401, 405], label: "tax calculate API (unauthenticated)" },
  { path: "/api/reports/tax", expectStatus: [401], label: "tax reports API (unauthenticated)" },
  { path: "/api/tax/state-packs", expectStatus: [401], label: "state packs API (unauthenticated)" },
];

async function checkRoute(route) {
  const url = `${BASE_URL}${route.path}`;
  const response = await fetch(url, { redirect: "manual" });
  const ok = route.expectStatus.includes(response.status);
  return {
    ...route,
    url,
    status: response.status,
    ok,
  };
}

async function main() {
  const results = [];
  for (const route of ROUTES) {
    results.push(await checkRoute(route));
  }

  const ok = results.every((row) => row.ok);
  console.log(
    JSON.stringify(
      {
        PHASE15_PRODUCTION_SMOKE: ok ? "PASS" : "FAIL",
        baseUrl: BASE_URL,
        results,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
