import { Prisma, RequestType } from "@prisma/client";
import { parseDueDate } from "../lib/dates";

const typeRules: Array<{ type: RequestType; patterns: RegExp[] }> = [
  { type: "CHECKOUT_LINK", patterns: [/checkout link/i, /payment link/i, /invoice link/i] },
  { type: "SPLITIT_WHITELIST", patterns: [/splitit/i, /whitelist/i] },
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

export function analyzeRequestMetadata(text: string, type: RequestType, dueDate: Date | null) {
  const normalized = text.replace(/\s+/g, " ").trim();
  const extractedFields = extractFields(normalized, dueDate);
  const tags = uniqueTags([
    typeToTag(type),
    ...keywordTags(normalized),
    ...(dueDate ? ["due-date"] : []),
    ...(type === "OTHER" ? ["one-off"] : [])
  ]);

  return {
    aiTags: tags,
    intent: summarizeIntent(normalized, type),
    extractedFields,
    suggestedNextStep: suggestNextStep(type, extractedFields),
    confidence: confidenceFor(type, normalized, tags)
  };
}

function extractFields(text: string, dueDate: Date | null): Prisma.InputJsonObject {
  const fields: Record<string, string> = {};
  const amount = text.match(/(?:\$|usd\s*)\s?([0-9][0-9,]*(?:\.\d{1,2})?)/i);
  const email = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  const url = text.match(/\bhttps?:\/\/\S+/i);

  if (amount) fields.amount = amount[0].replace(/\s+/g, "");
  if (email) fields.email = email[0];
  if (url) fields.url = url[0];
  if (/splitit/i.test(text)) fields.paymentProvider = "Splitit";
  if (dueDate) fields.dueDate = dueDate.toISOString().slice(0, 10);

  return fields as Prisma.InputJsonObject;
}

function keywordTags(text: string) {
  const checks: Array<[string, RegExp]> = [
    ["urgent", /\burgent\b|\basap\b|\bcritical\b/i],
    ["customer-facing", /\bcustomer\b|\bclient\b|\buser\b/i],
    ["payment", /\bpayment\b|\bcheckout\b|\binvoice\b|\bcard\b|\bcharge\b|\bbilling\b/i],
    ["compliance", /\bkyc\b|\bkyb\b|\bverification\b|\bcompliance\b/i],
    ["bug", /\bbug\b|\bbroken\b|\berror\b|\bfailing\b|\bnot working\b/i],
    ["access", /\baccess\b|\blogin\b|\bpermission\b|\brole\b/i],
    ["docs", /\bdoc\b|\bguide\b|\barticle\b|\bcopy\b/i]
  ];

  return checks.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
}

function summarizeIntent(text: string, type: RequestType) {
  if (!text) return "Customer needs help with an unspecified request.";
  const prefix = type === "OTHER" ? "Customer has a one-off request" : `Customer needs help with ${typeToLabel(type).toLowerCase()}`;
  return `${prefix}: ${toTitle(text)}`;
}

function suggestNextStep(type: RequestType, extractedFields: Prisma.InputJsonValue) {
  const fields = extractedFields as Record<string, unknown>;

  if (type === "CHECKOUT_LINK") {
    return fields.amount ? "Create or confirm the checkout link details, then send the link to the requester." : "Ask for the checkout amount and product/customer details.";
  }

  if (type === "SPLITIT_WHITELIST") return "Confirm the account or buyer details needed for Splitit whitelist review.";
  if (type === "BUG_REPORT") return "Collect reproduction steps, affected account, screenshots, and expected behavior.";
  if (type === "ENHANCEMENT_REQUEST") return "Capture the use case and impact, then decide whether it belongs in product feedback.";
  if (type === "KYC_KYB") return "Confirm which verification entity is blocked and gather missing compliance details.";
  if (type === "PAYMENT_ISSUE") return "Ask for payment ID, buyer email, amount, and error details.";
  if (type === "ACCOUNT_SETTINGS") return "Confirm the setting to change, target account, and desired final state.";

  return "Review the request, identify missing details, and either resolve directly or ask the requester for the next required piece of info.";
}

function confidenceFor(type: RequestType, text: string, tags: string[]) {
  if (type !== "OTHER") return 0.82;
  if (tags.length > 1 || /\bneed\b|\bcan you\b|\bplease\b|\bhelp\b/i.test(text)) return 0.55;
  return 0.35;
}

function typeToTag(type: RequestType) {
  return type.toLowerCase().replace(/_/g, "-");
}

function typeToLabel(type: RequestType) {
  return type.toLowerCase().replace(/_/g, " ");
}

function uniqueTags(tags: string[]) {
  return Array.from(new Set(tags.filter(Boolean))).slice(0, 8);
}
