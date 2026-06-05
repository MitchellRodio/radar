import { Prisma, RequestType } from "@prisma/client";
import { logger } from "../lib/logger";
import { getOpenAiSettings } from "./appSettingsService";
import { analyzeRequestMetadata, detectType } from "./requestParser";

type AiRequestMetadata = {
  type: RequestType;
  aiTags: string[];
  intent: string;
  extractedFields: Prisma.InputJsonValue;
  suggestedNextStep: string;
  confidence: number;
};

const requestTypes: RequestType[] = [
  "CHECKOUT_LINK",
  "SPLITIT_WHITELIST",
  "BUG_REPORT",
  "ENHANCEMENT_REQUEST",
  "KYC_KYB",
  "PAYMENT_ISSUE",
  "ACCOUNT_SETTINGS",
  "OTHER"
];

export async function analyzeRequestWithAi(input: {
  title: string;
  description: string;
  fallbackType?: RequestType;
  dueDate: Date | null;
}): Promise<AiRequestMetadata> {
  const text = `${input.title}\n${input.description}`.trim();
  const fallbackType = input.fallbackType ?? detectType(text);
  const fallback = {
    type: fallbackType,
    ...analyzeRequestMetadata(text, fallbackType, input.dueDate)
  };

  const settings = await getOpenAiSettings();
  if (!settings.apiKey) return fallback;

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: settings.model,
        instructions:
          "You classify customer Slack requests for a CSM task bot. " +
          "Use requestType only as a broad grouping. If a request does not clearly fit, use OTHER. " +
          "Still produce useful metadata for weird one-off requests.",
        input:
          `Known request types: ${requestTypes.join(", ")}\n` +
          `Fallback type: ${fallbackType}\n` +
          `Due date: ${input.dueDate ? input.dueDate.toISOString().slice(0, 10) : "none"}\n\n` +
          `Request title:\n${input.title}\n\nRequest details:\n${input.description}`,
        max_output_tokens: 450,
        text: {
          format: {
            type: "json_schema",
            name: "request_metadata",
            strict: false,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["requestType", "aiTags", "intent", "extractedFields", "suggestedNextStep", "confidence"],
              properties: {
                requestType: { type: "string", enum: requestTypes },
                aiTags: {
                  type: "array",
                  maxItems: 8,
                  items: { type: "string" }
                },
                intent: { type: "string" },
                extractedFields: {
                  type: "object",
                  additionalProperties: {
                    anyOf: [
                      { type: "string" },
                      { type: "number" },
                      { type: "boolean" },
                      { type: "null" }
                    ]
                  }
                },
                suggestedNextStep: { type: "string" },
                confidence: { type: "number", minimum: 0, maximum: 1 }
              }
            }
          }
        }
      })
    });

    if (!response.ok) {
      logger.warn({ status: response.status, body: await response.text() }, "OpenAI request metadata analysis failed");
      return fallback;
    }

    const body = await response.json();
    const parsed = JSON.parse(extractOutputText(body) || "{}") as {
      requestType?: RequestType;
      aiTags?: string[];
      intent?: string;
      extractedFields?: Prisma.InputJsonValue;
      suggestedNextStep?: string;
      confidence?: number;
    };

    const type = requestTypes.includes(parsed.requestType as RequestType) ? parsed.requestType as RequestType : fallbackType;

    return {
      type,
      aiTags: normalizeTags(parsed.aiTags, fallback.aiTags),
      intent: parsed.intent?.trim() || fallback.intent,
      extractedFields: isJsonObject(parsed.extractedFields) ? parsed.extractedFields : fallback.extractedFields,
      suggestedNextStep: parsed.suggestedNextStep?.trim() || fallback.suggestedNextStep,
      confidence: normalizeConfidence(parsed.confidence, fallback.confidence)
    };
  } catch (error) {
    logger.warn({ error }, "OpenAI request metadata analysis failed");
    return fallback;
  }
}

function normalizeTags(tags: string[] | undefined, fallback: string[]) {
  if (!Array.isArray(tags)) return fallback;
  const cleaned = tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  return Array.from(new Set(cleaned)).slice(0, 8);
}

function normalizeConfidence(confidence: number | undefined, fallback: number) {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) return fallback;
  return Math.min(1, Math.max(0, confidence));
}

function isJsonObject(value: unknown): value is Prisma.InputJsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractOutputText(body: any) {
  if (typeof body?.output_text === "string") return body.output_text;

  const parts = body?.output?.flatMap((item: any) => item.content ?? []) ?? [];
  const text = parts
    .map((part: any) => part.text ?? "")
    .filter(Boolean)
    .join("");

  return text;
}
