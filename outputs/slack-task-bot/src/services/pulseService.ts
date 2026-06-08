import { Prisma } from "@prisma/client";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { getOpenAiSettings } from "./appSettingsService";
import { ensureChannel, ensureUser } from "./userService";

type PulseAnalysis = {
  riskScore: number;
  churnRisk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "MIXED";
  blockerType: string;
  blockerSummary: string;
  dissatisfactionSignals: string[];
  aiTags: string[];
  suggestedCsmAction: string;
  confidence: number;
  needsAttention: boolean;
};

export async function processSlackMessageForPulse(input: {
  slackChannelId: string;
  slackUserId?: string | null;
  messageTs: string;
  threadTs?: string | null;
  text: string;
}) {
  const text = input.text.replace(/\s+/g, " ").trim();
  if (!text || text.length < 3) return null;
  if (await prisma.slackMessageInsight.findUnique({ where: { slackChannelId_messageTs: { slackChannelId: input.slackChannelId, messageTs: input.messageTs } } })) return null;

  await ensureChannel(input.slackChannelId);
  if (input.slackUserId) await ensureUser(input.slackUserId);

  const businesses = await prisma.channelWhopBusiness.findMany({ where: { slackChannelId: input.slackChannelId } });
  const analysis = await analyzeMessage(text);

  const insight = await prisma.slackMessageInsight.create({
    data: {
      slackChannelId: input.slackChannelId,
      slackUserId: input.slackUserId || null,
      messageTs: input.messageTs,
      threadTs: input.threadTs || null,
      text,
      businessIds: businesses.map((business) => business.businessId),
      riskScore: analysis.riskScore,
      churnRisk: analysis.churnRisk,
      sentiment: analysis.sentiment,
      blockerType: analysis.blockerType || null,
      blockerSummary: analysis.blockerSummary,
      dissatisfactionSignals: analysis.dissatisfactionSignals,
      aiTags: analysis.aiTags,
      suggestedCsmAction: analysis.suggestedCsmAction,
      confidence: analysis.confidence,
      needsAttention: analysis.needsAttention
    }
  });

  await updateChannelPulse(input.slackChannelId);
  return insight;
}

export async function addChannelPulseNote(input: { slackChannelId: string; authorSlackUserId: string; body: string }) {
  await ensureChannel(input.slackChannelId);
  await ensureUser(input.authorSlackUserId);
  return prisma.channelPulseNote.create({
    data: {
      slackChannelId: input.slackChannelId,
      authorSlackUserId: input.authorSlackUserId,
      body: input.body
    }
  });
}

async function analyzeMessage(text: string): Promise<PulseAnalysis> {
  const fallback = fallbackAnalysis(text);
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
          "You are analyzing customer Slack messages for a CSM account health product like HubSpot Pulse. " +
          "Be conservative: normal requests are not churn risk unless frustration, blockers, urgency, repeated failure, cancellation, lost trust, or inability to operate is present. " +
          "Extract blockers, dissatisfaction, and the CSM's next best action.",
        input: `Slack message:\n${text}`,
        max_output_tokens: 500,
        text: {
          format: {
            type: "json_schema",
            name: "pulse_message_analysis",
            strict: false,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["riskScore", "churnRisk", "sentiment", "blockerType", "blockerSummary", "dissatisfactionSignals", "aiTags", "suggestedCsmAction", "confidence", "needsAttention"],
              properties: {
                riskScore: { type: "number", minimum: 0, maximum: 100 },
                churnRisk: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
                sentiment: { type: "string", enum: ["POSITIVE", "NEUTRAL", "NEGATIVE", "MIXED"] },
                blockerType: { type: "string" },
                blockerSummary: { type: "string" },
                dissatisfactionSignals: { type: "array", maxItems: 8, items: { type: "string" } },
                aiTags: { type: "array", maxItems: 8, items: { type: "string" } },
                suggestedCsmAction: { type: "string" },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                needsAttention: { type: "boolean" }
              }
            }
          }
        }
      })
    });

    if (!response.ok) {
      logger.warn({ status: response.status, body: await response.text() }, "OpenAI pulse analysis failed");
      return fallback;
    }

    const body = await response.json();
    const parsed = JSON.parse(extractOutputText(body) || "{}") as Partial<PulseAnalysis>;
    return normalizeAnalysis(parsed, fallback);
  } catch (error) {
    logger.warn({ error }, "OpenAI pulse analysis failed");
    return fallback;
  }
}

async function updateChannelPulse(slackChannelId: string) {
  const recent = await prisma.slackMessageInsight.findMany({
    where: { slackChannelId },
    orderBy: { createdAt: "desc" },
    take: 40
  });

  if (!recent.length) return;

  const weightedRisk = Math.round(
    recent.reduce((sum, insight, index) => sum + insight.riskScore * (index < 8 ? 1.5 : 1), 0) /
      recent.reduce((sum, _insight, index) => sum + (index < 8 ? 1.5 : 1), 0)
  );
  const highestRisk = Math.max(...recent.map((insight) => insight.riskScore));
  const riskScore = Math.max(weightedRisk, Math.round(highestRisk * 0.75));
  const risky = recent.filter((insight) => insight.needsAttention || insight.riskScore >= 55).slice(0, 8);
  const signals = topStrings(recent.flatMap((insight) => [...insight.dissatisfactionSignals, ...insight.aiTags]), 8);
  const blockers = risky
    .filter((insight) => insight.blockerSummary)
    .map((insight) => ({
      summary: insight.blockerSummary,
      type: insight.blockerType,
      riskScore: insight.riskScore,
      messageTs: insight.messageTs,
      createdAt: insight.createdAt.toISOString()
    }));
  const negativeCount = recent.filter((insight) => insight.sentiment === "NEGATIVE").length;
  const mixedCount = recent.filter((insight) => insight.sentiment === "MIXED").length;
  const positiveCount = recent.filter((insight) => insight.sentiment === "POSITIVE").length;
  const sentiment = negativeCount >= 3 ? "NEGATIVE" : mixedCount >= 3 ? "MIXED" : positiveCount > negativeCount ? "POSITIVE" : "NEUTRAL";

  await prisma.channelPulse.upsert({
    where: { slackChannelId },
    update: {
      riskScore,
      churnRisk: riskBucket(riskScore),
      sentiment,
      blockerSummary: summarizeBlockers(blockers),
      unhappySummary: summarizeUnhappySignals(signals),
      suggestedCsmAction: risky[0]?.suggestedCsmAction || "Monitor account sentiment and respond to blockers as they surface.",
      openBlockers: blockers as Prisma.InputJsonValue,
      topSignals: signals,
      lastMessageAt: recent[0]?.createdAt ?? new Date(),
      lastAnalyzedAt: new Date()
    },
    create: {
      slackChannelId,
      riskScore,
      churnRisk: riskBucket(riskScore),
      sentiment,
      blockerSummary: summarizeBlockers(blockers),
      unhappySummary: summarizeUnhappySignals(signals),
      suggestedCsmAction: risky[0]?.suggestedCsmAction || "Monitor account sentiment and respond to blockers as they surface.",
      openBlockers: blockers as Prisma.InputJsonValue,
      topSignals: signals,
      lastMessageAt: recent[0]?.createdAt ?? new Date(),
      lastAnalyzedAt: new Date()
    }
  });
}

function fallbackAnalysis(text: string): PulseAnalysis {
  const riskTerms = /\b(cancel|churn|leaving|refund|angry|upset|unhappy|frustrated|blocked|broken|down|failed|not working|urgent|asap|terrible|bad experience|losing money)\b/i;
  const blockerTerms = /\b(blocked|can't|cannot|not working|broken|failed|stuck|issue|error|bug|missing)\b/i;
  const riskScore = riskTerms.test(text) ? 72 : blockerTerms.test(text) ? 45 : 12;
  return {
    riskScore,
    churnRisk: riskBucket(riskScore),
    sentiment: riskScore >= 55 ? "NEGATIVE" : "NEUTRAL",
    blockerType: blockerTerms.test(text) ? "Operational blocker" : "",
    blockerSummary: blockerTerms.test(text) ? text.slice(0, 220) : "",
    dissatisfactionSignals: riskTerms.test(text) ? ["frustration or churn language"] : [],
    aiTags: blockerTerms.test(text) ? ["blocker"] : ["normal"],
    suggestedCsmAction: riskScore >= 55 ? "Reply quickly, acknowledge the issue, and identify the owner/blocker." : "No urgent action needed.",
    confidence: 0.35,
    needsAttention: riskScore >= 55
  };
}

function normalizeAnalysis(parsed: Partial<PulseAnalysis>, fallback: PulseAnalysis): PulseAnalysis {
  const riskScore = clampNumber(parsed.riskScore, fallback.riskScore, 0, 100);
  return {
    riskScore,
    churnRisk: normalizeEnum(parsed.churnRisk, ["LOW", "MEDIUM", "HIGH", "CRITICAL"], riskBucket(riskScore)),
    sentiment: normalizeEnum(parsed.sentiment, ["POSITIVE", "NEUTRAL", "NEGATIVE", "MIXED"], fallback.sentiment),
    blockerType: parsed.blockerType?.trim() || fallback.blockerType,
    blockerSummary: parsed.blockerSummary?.trim() || fallback.blockerSummary,
    dissatisfactionSignals: normalizeStringArray(parsed.dissatisfactionSignals, fallback.dissatisfactionSignals),
    aiTags: normalizeStringArray(parsed.aiTags, fallback.aiTags),
    suggestedCsmAction: parsed.suggestedCsmAction?.trim() || fallback.suggestedCsmAction,
    confidence: clampNumber(parsed.confidence, fallback.confidence, 0, 1),
    needsAttention: typeof parsed.needsAttention === "boolean" ? parsed.needsAttention : riskScore >= 55
  };
}

function riskBucket(score: number): PulseAnalysis["churnRisk"] {
  if (score >= 85) return "CRITICAL";
  if (score >= 65) return "HIGH";
  if (score >= 35) return "MEDIUM";
  return "LOW";
}

function topStrings(values: string[], limit: number) {
  const counts = new Map<string, number>();
  values.map((value) => value.trim().toLowerCase()).filter(Boolean).forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value]) => value);
}

function summarizeBlockers(blockers: Array<{ summary: string }>) {
  if (!blockers.length) return "No active blockers detected in recent Slack messages.";
  return blockers.slice(0, 3).map((blocker) => blocker.summary).join(" | ");
}

function summarizeUnhappySignals(signals: string[]) {
  if (!signals.length) return "No strong dissatisfaction patterns detected yet.";
  return signals.slice(0, 6).join(", ");
}

function normalizeStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean).slice(0, 8);
}

function normalizeEnum<T extends string>(value: unknown, allowed: T[], fallback: T) {
  return allowed.includes(value as T) ? value as T : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function extractOutputText(body: any): string {
  if (typeof body?.output_text === "string") return body.output_text;
  const content = body?.output?.flatMap((item: any) => item.content ?? []) ?? [];
  return content.map((item: any) => item.text ?? "").join("");
}
