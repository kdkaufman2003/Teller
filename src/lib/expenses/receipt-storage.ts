import type { SupabaseClient } from "@supabase/supabase-js";

export function guessReceiptMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "heic":
      return "image/heic";
    case "jpg":
    case "jpeg":
    default:
      return "image/jpeg";
  }
}

export function isPdfMime(mime: string): boolean {
  return mime === "application/pdf";
}

export function isBrowserDisplayableImage(mime: string): boolean {
  return mime.startsWith("image/") && mime !== "image/heic";
}

export async function getReceiptSignedUrl(
  supabase: SupabaseClient,
  attachmentPath: string,
  expiresInSeconds = 3600,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from("receipts")
    .createSignedUrl(attachmentPath, expiresInSeconds);

  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}
