export function hfacWebhookAuthorized(request: Request): boolean {
  const secret =
    process.env.TELLER_HFAC_WEBHOOK_SECRET?.trim() ||
    process.env.TELLER_QUOTER_WEBHOOK_SECRET?.trim();
  if (!secret) return false;
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${secret}`;
}
