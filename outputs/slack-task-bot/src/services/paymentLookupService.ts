import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";

type Payment = {
  id: string;
  status?: string | null;
  substatus?: string | null;
  created_at?: string | null;
  paid_at?: string | null;
  currency?: string | null;
  total?: number | null;
  usd_total?: number | null;
  refunded_amount?: number | null;
  product?: { title?: string | null } | null;
  plan?: { id?: string | null } | null;
  user?: { email?: string | null; name?: string | null; username?: string | null } | null;
  payment_method_type?: string | null;
  card_brand?: string | null;
  card_last4?: string | null;
  failure_message?: string | null;
};

type BusinessPayments = {
  businessName: string;
  businessId: string;
  payments: Payment[];
  error?: string;
};

export async function lookupPaymentsForChannel(input: { channelId: string; email: string }) {
  const businesses = await prisma.channelWhopBusiness.findMany({
    where: { slackChannelId: input.channelId },
    orderBy: [{ businessName: "asc" }, { businessId: "asc" }]
  });

  if (!businesses.length) {
    return {
      email: input.email,
      results: [],
      errors: ["No Whop businesses are mapped to this Slack channel yet."]
    };
  }

  const results: BusinessPayments[] = [];
  const errors: string[] = [];

  for (const business of businesses) {
    if (!business.apiKey) {
      const error = `${business.businessName} is missing an API key.`;
      errors.push(error);
      results.push({ businessName: business.businessName, businessId: business.businessId, payments: [], error });
      continue;
    }

    try {
      const payments = await listWhopPayments({
        apiKey: business.apiKey,
        businessId: business.businessId,
        email: input.email
      });
      results.push({
        businessName: business.businessName,
        businessId: business.businessId,
        payments
      });
    } catch (error) {
      logger.error({ error, businessId: business.businessId, email: input.email }, "Failed to look up Whop payments");
      const message = error instanceof Error ? error.message : "Could not fetch payments.";
      errors.push(`${business.businessName}: ${message}`);
      results.push({
        businessName: business.businessName,
        businessId: business.businessId,
        payments: [],
        error: message
      });
    }
  }

  return { email: input.email, results, errors };
}

export function paymentLookupBlocks(input: Awaited<ReturnType<typeof lookupPaymentsForChannel>>) {
  const total = input.results.reduce((sum, result) => sum + result.payments.length, 0);

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Payments for ${escapeMrkdwn(input.email)}*\nFound ${total} payment${total === 1 ? "" : "s"} across mapped Whop businesses.`
      }
    },
    ...(input.errors.length
      ? [
          {
            type: "section",
            text: { type: "mrkdwn", text: `*Lookup notes*\n${escapeMrkdwn(input.errors.join("\n"))}` }
          }
        ]
      : []),
    ...input.results.flatMap((result) => businessPaymentBlocks(result))
  ].slice(0, 48);
}

async function listWhopPayments(input: { apiKey: string; businessId: string; email: string }): Promise<Payment[]> {
  const matches: Payment[] = [];
  let after = "";

  for (let page = 0; page < 10 && matches.length < 50; page += 1) {
    const url = new URL("https://api.whop.com/api/v1/payments");
    url.searchParams.set("company_id", input.businessId);
    url.searchParams.set("first", "100");
    url.searchParams.set("order", "created_at");
    url.searchParams.set("direction", "desc");
    if (after) url.searchParams.set("after", after);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${input.apiKey}`
      }
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof body?.message === "string" ? body.message : JSON.stringify(body);
      throw new Error(`Whop returned HTTP ${response.status}: ${message}`);
    }

    const payments = Array.isArray(body?.data) ? body.data : [];
    matches.push(...payments.filter((payment: Payment) => payment.user?.email?.toLowerCase() === input.email.toLowerCase()));

    after = body?.page_info?.end_cursor ?? "";
    if (!body?.page_info?.has_next_page || !after) break;
  }

  return matches;
}

function businessPaymentBlocks(result: BusinessPayments) {
  if (result.error) {
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${escapeMrkdwn(result.businessName)}*\n${escapeMrkdwn(result.error)}` }
      }
    ];
  }

  if (!result.payments.length) {
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${escapeMrkdwn(result.businessName)}*\nNo payments found.` }
      }
    ];
  }

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${escapeMrkdwn(result.businessName)}*\n` +
          result.payments.slice(0, 10).map(formatPayment).join("\n")
      }
    }
  ];
}

function formatPayment(payment: Payment) {
  const amount = formatAmount(payment);
  const status = [payment.status, payment.substatus].filter(Boolean).join(" / ") || "unknown";
  const product = payment.product?.title ?? payment.plan?.id ?? "Unknown product";
  const date = payment.paid_at ?? payment.created_at ?? "";
  const method = [payment.payment_method_type, payment.card_brand, payment.card_last4 ? `•••• ${payment.card_last4}` : ""].filter(Boolean).join(" ");
  const refund = payment.refunded_amount ? `, refunded ${formatCurrency(payment.refunded_amount, payment.currency ?? "usd")}` : "";
  const failure = payment.failure_message ? `, ${payment.failure_message}` : "";

  return `• \`${payment.id}\` ${amount} ${escapeMrkdwn(product)} - ${escapeMrkdwn(status)}${refund}${failure}${method ? ` - ${escapeMrkdwn(method)}` : ""}${date ? ` - ${formatDate(date)}` : ""}`;
}

function formatAmount(payment: Payment) {
  const amount = payment.total ?? payment.usd_total ?? 0;
  return formatCurrency(amount, payment.currency ?? "usd");
}

function formatCurrency(amount: number, currency: string) {
  return `${currency.toUpperCase()} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
}

function escapeMrkdwn(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
