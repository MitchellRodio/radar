import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";

type WhopPayment = {
  id: string;
  status?: string | null;
  substatus?: string | null;
  total?: number | null;
  usd_total?: number | null;
  currency?: string | null;
  paid_at?: string | null;
  created_at?: string | null;
  failure_message?: string | null;
  product?: { id?: string | null; title?: string | null } | null;
  plan?: { id?: string | null } | null;
  user?: { id?: string | null; email?: string | null; name?: string | null; username?: string | null } | null;
};

type WhopMembership = {
  id: string;
  status?: string | null;
  manage_url?: string | null;
  renewal_period_end?: string | null;
  cancel_at_period_end?: boolean | null;
  canceled_at?: string | null;
  product?: { id?: string | null; title?: string | null } | null;
  plan?: { id?: string | null } | null;
  user?: { id?: string | null; email?: string | null; name?: string | null; username?: string | null } | null;
};

type BusinessLookup = {
  businessName: string;
  businessId: string;
  payments: WhopPayment[];
  memberships: WhopMembership[];
  error?: string;
};

export async function lookupCustomerAccount(input: { channelId: string; email: string }) {
  const businesses = await prisma.channelWhopBusiness.findMany({
    where: { slackChannelId: input.channelId },
    orderBy: [{ businessName: "asc" }, { businessId: "asc" }]
  });

  const results: BusinessLookup[] = [];
  const errors: string[] = [];

  if (!businesses.length) {
    return {
      email: input.email,
      results,
      errors: ["No Whop businesses are mapped to this Slack channel yet."]
    };
  }

  for (const business of businesses) {
    if (!business.apiKey) {
      const error = `${business.businessName} is missing an API key.`;
      errors.push(error);
      results.push({ businessName: business.businessName, businessId: business.businessId, payments: [], memberships: [], error });
      continue;
    }

    try {
      const payments = await listPayments({ apiKey: business.apiKey, businessId: business.businessId, email: input.email });
      const userIds = Array.from(new Set(payments.map((payment) => payment.user?.id).filter(Boolean) as string[]));
      const memberships = await listMemberships({ apiKey: business.apiKey, businessId: business.businessId, email: input.email, userIds });
      results.push({ businessName: business.businessName, businessId: business.businessId, payments, memberships });
    } catch (error) {
      logger.error({ error, businessId: business.businessId, email: input.email }, "Failed customer account lookup");
      const message = error instanceof Error ? error.message : "Could not fetch customer account.";
      errors.push(`${business.businessName}: ${message}`);
      results.push({ businessName: business.businessName, businessId: business.businessId, payments: [], memberships: [], error: message });
    }
  }

  return { email: input.email, results, errors };
}

export function customerLookupBlocks(input: Awaited<ReturnType<typeof lookupCustomerAccount>>) {
  const paymentCount = input.results.reduce((sum, result) => sum + result.payments.length, 0);
  const membershipCount = input.results.reduce((sum, result) => sum + result.memberships.length, 0);

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Customer lookup: ${escapeMrkdwn(input.email)}*\n` +
          `${paymentCount} payment${paymentCount === 1 ? "" : "s"} | ${membershipCount} membership${membershipCount === 1 ? "" : "s"}`
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
    ...input.results.flatMap((result) => businessBlocks(result))
  ].slice(0, 48);
}

async function listPayments(input: { apiKey: string; businessId: string; email: string }) {
  const url = new URL("https://api.whop.com/api/v1/payments");
  url.searchParams.set("company_id", input.businessId);
  url.searchParams.set("query", input.email);
  url.searchParams.set("first", "20");
  url.searchParams.set("order", "created_at");
  url.searchParams.set("direction", "desc");

  const body = await whopGet(url, input.apiKey);
  return Array.isArray(body?.data) ? body.data as WhopPayment[] : [];
}

async function listMemberships(input: { apiKey: string; businessId: string; email: string; userIds: string[] }) {
  const matches: WhopMembership[] = [];
  let after = "";

  for (let page = 0; page < 5 && matches.length < 50; page += 1) {
    const url = new URL("https://api.whop.com/api/v1/memberships");
    url.searchParams.set("company_id", input.businessId);
    url.searchParams.set("first", "100");
    url.searchParams.set("order", "created_at");
    url.searchParams.set("direction", "desc");
    if (after) url.searchParams.set("after", after);
    for (const userId of input.userIds) url.searchParams.append("user_ids[]", userId);

    const body = await whopGet(url, input.apiKey);
    const memberships = Array.isArray(body?.data) ? body.data as WhopMembership[] : [];
    matches.push(...memberships.filter((membership) => {
      const userIdMatch = membership.user?.id && input.userIds.includes(membership.user.id);
      const emailMatch = membership.user?.email?.toLowerCase() === input.email.toLowerCase();
      return userIdMatch || emailMatch;
    }));

    after = body?.page_info?.end_cursor ?? "";
    if (!body?.page_info?.has_next_page || !after) break;
  }

  return matches;
}

async function whopGet(url: URL, apiKey: string) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body?.message === "string" ? body.message : JSON.stringify(body);
    throw new Error(`Whop returned HTTP ${response.status}: ${message}`);
  }
  return body;
}

function businessBlocks(result: BusinessLookup) {
  if (result.error) {
    return [{ type: "section", text: { type: "mrkdwn", text: `*${escapeMrkdwn(result.businessName)}*\n${escapeMrkdwn(result.error)}` } }];
  }

  const membershipText = result.memberships.length
    ? result.memberships.slice(0, 8).map(formatMembership).join("\n")
    : "No memberships found.";
  const paymentText = result.payments.length
    ? result.payments.slice(0, 8).map(formatPayment).join("\n")
    : "No payments found.";

  return [
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: `*${escapeMrkdwn(result.businessName)}*` } },
    { type: "section", text: { type: "mrkdwn", text: `*Memberships*\n${membershipText}` } },
    { type: "section", text: { type: "mrkdwn", text: `*Recent payments*\n${paymentText}` } }
  ];
}

function formatMembership(membership: WhopMembership) {
  const product = membership.product?.title ?? membership.product?.id ?? membership.plan?.id ?? "Unknown product";
  const manage = membership.manage_url ? ` | <${membership.manage_url}|Manage>` : "";
  const renew = membership.renewal_period_end ? ` | renews ${formatDate(membership.renewal_period_end)}` : "";
  const canceling = membership.cancel_at_period_end ? " | canceling" : "";
  return `• \`${membership.id}\` ${escapeMrkdwn(product)} | ${escapeMrkdwn(membership.status ?? "unknown")}${renew}${canceling}${manage}`;
}

function formatPayment(payment: WhopPayment) {
  const product = payment.product?.title ?? payment.product?.id ?? payment.plan?.id ?? "Unknown product";
  const status = [payment.status, payment.substatus].filter(Boolean).join(" / ") || "unknown";
  const failure = payment.failure_message ? ` | ${payment.failure_message}` : "";
  return `• \`${payment.id}\` ${formatAmount(payment)} | ${escapeMrkdwn(product)} | ${escapeMrkdwn(status)}${failure ? escapeMrkdwn(failure) : ""} | ${formatDate(payment.paid_at ?? payment.created_at ?? "")}`;
}

function formatAmount(payment: WhopPayment) {
  const amount = payment.usd_total ?? payment.total ?? 0;
  const currency = payment.currency ?? "usd";
  return `${currency.toUpperCase()} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value: string) {
  if (!value) return "unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
}

function escapeMrkdwn(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
