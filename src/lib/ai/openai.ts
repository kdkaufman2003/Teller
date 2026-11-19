export function openAiApiKey(): string | null {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key || null;
}

type ChatContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "high" } }
  | { type: "file"; file: { filename: string; file_data: string } };

export async function openAiJson(input: {
  prompt: string;
  text?: string;
  imageBase64?: string;
  imageMime?: string;
  pdfBase64?: string;
  fileName?: string;
}): Promise<unknown> {
  const apiKey = openAiApiKey();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const content: ChatContent[] = [{ type: "text", text: input.prompt }];
  if (input.text?.trim()) {
    content.push({ type: "text", text: input.text.trim().slice(0, 20_000) });
  }
  if (
    input.imageBase64 &&
    input.imageMime?.startsWith("image/") &&
    input.imageMime !== "image/heic" &&
    input.imageMime !== "image/heif"
  ) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${input.imageMime};base64,${input.imageBase64}`,
        detail: "high",
      },
    });
  }
  if (input.pdfBase64) {
    const filename = input.fileName?.toLowerCase().endsWith(".pdf")
      ? input.fileName
      : "document.pdf";
    content.push({
      type: "file",
      file: {
        filename,
        file_data: `data:application/pdf;base64,${input.pdfBase64}`,
      },
    });
  }
  if (content.length === 1) {
    throw new Error("Nothing was attached to send to OpenAI");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content }],
    }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      detail = body.error?.message?.trim().slice(0, 200) || "";
    } catch {
      detail = "";
    }
    throw new Error(
      detail ? `OpenAI request failed (${response.status}): ${detail}` : `OpenAI request failed (${response.status})`,
    );
  }

  const json = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const raw = json.choices?.[0]?.message?.content;
  if (!raw) throw new Error("OpenAI returned an empty reading");
  return JSON.parse(raw) as unknown;
}
