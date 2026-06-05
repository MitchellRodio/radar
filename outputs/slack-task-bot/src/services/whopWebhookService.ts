import { createHmac, timingSafeEqual } from "crypto";
import { WebClient } from "@slack/web-api";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getWhopWebhookSettings } from "./appSettingsService";

export const WHOP_WEBHOOK_EVENT_TYPES = [
  "payment.succeeded",
  "payment.failed",
  "payment.pending",
  "payment.created",
  "membership.activated",
  "membership.deactivated",
  "membership.cancel_at_period_end_changed",
  "entry.created",
  "entry.approved",
  "entry.denied",
  "entry.deleted",
  "refund.created",
  "refund.updated",
  "dispute.created",
  "dispute.updated",
  "dispute_alert.created",
  "resolution_center_case.created",
  "resolution_center_case.updated",
  "resolution_center_case.decided",
  "invoice.created",
  "invoice.paid",
  "invoice.past_due",
  "invoice.marked_uncollectible",
  "invoice.voided",
  "verification.succeeded",
  "payout_account.status_updated",
  "withdrawal.created",
  "withdrawal.updated"
] as const;

export async function upsertWhopWebhookRoute(input: { eventType: string; slackChannelId: string; businessId?: string | null; enabled: boolean }) {
  const eventType = normalizeEventType(input.eventType);
  if (!eventType) throw new Error("Unsupported Whop event type.");

  return prisma.whopWebhookRoute.create({
    data: {
      eventType,
      slackChannelId: input.slackChannelId,
      businessId: input.businessId?.trim() || null,
      enabled: input.enabled
    }
  });
}

export async function setWhopWebhookRouteEnabled(routeId: string, enabled: boolean) {
  return prisma.whopWebhookRoute.update({
    where: { id: routeId },
    data: { enabled }
  });
}

export async function deleteWhopWebhookRoute(routeId: string) {
  return prisma.whopWebhookRoute.deleteMany({ where: { id: routeId } });
}

export async function handleWhopWebhook(input: { bodyText: string; headers: Record<string, string | string[] | undefined>; slack: WebClient }) {
  const settings = await getWhopWebhookSettings();
  if (settings.webhookSecret && !verifyStandardWebhook(input.bodyText, input.headers, settings.webhookSecret)) {
    throw new Error("Invalid Whop webhook signature.");
  }

  const payload = JSON.parse(input.bodyText || "{}");
  const eventType = String(payload.type ?? "");
  const webhookId = headerValue(input.headers["webhook-id"]) || String(payload.id ?? "");
  const businessId = extractBusinessId(payload);

  if (webhookId) {
    const existing = await prisma.whopWebhookDelivery.findUnique({ where: { webhookId } });
    if (existing) return { status: "duplicate", routed: 0 };
  }

  const routes = await prisma.whopWebhookRoute.findMany({
    where: {
      eventType,
      enabled: true,
      OR: [{ businessId: null }, { businessId }]
    },
    include: { channel: true },
    orderBy: { createdAt: "asc" }
  });

  let routed = 0;
  for (const route of routes) {
    await input.slack.chat.postMessage({
      channel: route.slackChannelId,
      text: `Whop ${eventType}`,
      blocks: whopWebhookSlackBlocks(payload, route.channel?.companyName ?? route.channel?.name ?? route.slackChannelId)
    });
    routed += 1;
  }

  await prisma.whopWebhookDelivery.create({
    data: {
      webhookId: webhookId || null,
      eventType: eventType || "unknown",
      businessId,
      slackChannelId: routes[0]?.slackChannelId ?? null,
      status: routed ? "ROUTED" : "NO_ROUTE",
      payload: payload as Prisma.InputJsonValue
    }
  });

  return { status: routed ? "routed" : "no_route", routed };
}

export function whopWebhookSlackBlocks(payload: any, routeLabel: string) {
  const eventType = String(payload.type ?? "unknown");
  const data = payload.data ?? {};
  const company = data.company?.title ?? data.company?.id ?? extractBusinessId(payload) ?? routeLabel;
  const product = data.product?.title ?? data.product?.id ?? data.plan?.id ?? "";
  const user = data.user?.email ?? data.user?.username ?? data.user?.name ?? "";
  const amount = formatAmount(data);
  const status = data.status ?? data.substatus ?? "";
  const reason = data.reason ?? data.failure_message ?? data.cancellation_reason ?? "";
  const manageUrl = data.manage_url ? `\n*Manage:* <${data.manage_url}|Open>` : "";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Whop event: ${escapeMrkdwn(eventType)}*\n` +
          `*Company:* ${escapeMrkdwn(String(company))}\n` +
          (user ? `*Customer:* ${escapeMrkdwn(String(user))}\n` : "") +
          (product ? `*Product:* ${escapeMrkdwn(String(product))}\n` : "") +
          (amount ? `*Amount:* ${escapeMrkdwn(amount)}\n` : "") +
          (status ? `*Status:* ${escapeMrkdwn(String(status))}\n` : "") +
          (reason ? `*Reason:* ${escapeMrkdwn(String(reason))}` : "") +
          manageUrl
      }
    }
  ];
}

export function normalizeEventType(value: string) {
  const eventType = value.trim();
  return WHOP_WEBHOOK_EVENT_TYPES.includes(eventType as any) ? eventType : "";
}

function verifyStandardWebhook(bodyText: string, headers: Record<string, string | string[] | undefined>, secret: string) {
  const webhookId = headerValue(headers["webhook-id"]);
  const timestamp = headerValue(headers["webhook-timestamp"]);
  const signature = headerValue(headers["webhook-signature"]);
  if (!webhookId || !timestamp || !signature) return false;

  const signedContent = `${webhookId}.${timestamp}.${bodyText}`;
  const expectedSignatures = parseWebhookSignatures(signature);
  const secretBuffers = candidateSecretBuffers(secret);

  return secretBuffers.some((secretBuffer) => {
    const digest = createHmac("sha256", secretBuffer).update(signedContent).digest("base64");
    return expectedSignatures.some((candidate) => timingSafeCompare(candidate.replace(/^v\d+,?/, ""), digest));
  });
}

function parseWebhookSignatures(signature: string) {
  return signature
    .split(/\s+/)
    .flatMap((part) => {
      const pieces = part.split(",").map((piece) => piece.trim()).filter(Boolean);
      if (pieces.length >= 2 && /^v\d+$/.test(pieces[0])) return [pieces[1]];
      return pieces.filter((piece) => !/^v\d+$/.test(piece));
    })
    .filter(Boolean);
}

function candidateSecretBuffers(secret: string) {
  const trimmed = secret.trim();
  const buffers = [Buffer.from(trimmed)];
  try {
    buffers.push(Buffer.from(trimmed, "base64"));
  } catch {}
  return buffers;
}

function timingSafeCompare(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function extractBusinessId(payload: any) {
  return payload?.data?.company?.id ?? payload?.data?.company_id ?? payload?.data?.business_id ?? null;
}

function formatAmount(data: any) {
  const amount = data.usd_total ?? data.total ?? data.amount;
  if (amount === undefined || amount === null) return "";
  const currency = data.currency ?? "usd";
  return `${String(currency).toUpperCase()} ${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeMrkdwn(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
