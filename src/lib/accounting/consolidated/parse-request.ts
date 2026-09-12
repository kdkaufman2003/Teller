export function parseConsolidationRequestParams(url: URL): {
  legalEntityIds: string[] | null;
  includeAllEntities: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  asOf: string | null;
  reportMode: "pre" | "post";
} {
  const includeAllEntities =
    url.searchParams.get("includeAll") === "1" ||
    url.searchParams.get("includeAllEntities") === "1";

  const entityIdsParam = url.searchParams.get("entityIds");
  const legalEntityIds = entityIdsParam
    ? entityIdsParam.split(",").map((id) => id.trim()).filter(Boolean)
    : url.searchParams.getAll("legalEntityId").filter(Boolean);

  const reportModeParam = url.searchParams.get("reportMode");
  const reportMode = reportModeParam === "post" ? "post" : "pre";

  return {
    legalEntityIds: legalEntityIds.length ? legalEntityIds : null,
    includeAllEntities,
    periodStart: url.searchParams.get("periodStart"),
    periodEnd: url.searchParams.get("periodEnd"),
    asOf: url.searchParams.get("asOf"),
    reportMode,
  };
}
