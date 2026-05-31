import { RequestType } from "@prisma/client";
import { parseDueDate } from "../lib/dates";

const typeRules: Array<{ type: RequestType; patterns: RegExp[] }> = [
  { type: "CHECKOUT_LINK", patterns: [/checkout link/i, /payment link/i, /invoice link/i] },
  { type: "SPLITIT_WHITELIST", patterns: [/splitit/i, /whitelist/i] },
  { type: "REFUND_PAYMENT", patterns: [/refund/i, /reverse payment/i] },
  { type: "BUG_REPORT", patterns: [/bug/i, /broken/i, /error/i, /not working/i] },
  { type: "ENHANCEMENT_REQUEST", patterns: [/enhancement/i, /feature request/i, /can you add/i] },
  { type: "KYC_KYB", patterns: [/\bkyc\b/i, /\bkyb\b/i, /verification/i] },
  { type: "PAYMENT_ISSUE", patterns: [/payment issue/i, /card declined/i, /charge failed/i, /billing/i] },
  { type: "ACCOUNT_SETTINGS", patterns: [/account setting/i, /settings/i, /profile/i, /account config/i] }
];

export type ParsedRequest = {
  title: string;
  description: string;
  type: RequestType;
  dueDate: Date | null;
};

export function parseRequestText(rawText: string, botUserId?: string): ParsedRequest {
  const text = stripBotMention(rawText, botUserId).trim();
  const dueDate = detectDueDate(text);
  const cleanText = text
    .replace(/\bdue(?: date)?\s*[:=]?\s*\d{4}-\d{2}-\d{2}\b/i, "")
    .replace(/\bdue(?: date)?\s*[:=]?\s*\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/i, "")
    .trim();

  return {
    title: toTitle(cleanText || "New customer request"),
    description: cleanText || text || rawText,
    type: detectType(text),
    dueDate
  };
}

export function detectType(text: string): RequestType {
  for (const rule of typeRules) {
    if (rule.patterns.some((pattern) => pattern.test(text))) return rule.type;
  }

  return "OTHER";
}

function stripBotMention(text: string, botUserId?: string): string {
  if (!botUserId) return text.replace(/<@[^>]+>/g, "").trim();
  return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
}

function detectDueDate(text: string): Date | null {
  const iso = text.match(/\bdue(?: date)?\s*[:=]?\s*(\d{4}-\d{2}-\d{2})\b/i);
  if (iso) return parseDueDate(iso[1]);

  const slash = text.match(/\bdue(?: date)?\s*[:=]?\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i);
  if (slash) return parseDueDate(slash[1]);

  return null;
}

function toTitle(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 80) return compact;
  return `${compact.slice(0, 77).trim()}...`;
}
