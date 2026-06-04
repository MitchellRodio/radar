import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";

type CheckoutBusiness = {
  id: string;
  businessId: string;
  businessName: string;
  apiKey: string;
};

export type CheckoutProductOption = {
  value: string;
  businessName: string;
  productId: string;
  productTitle: string;
};

type CreateCheckoutLinkInput = {
  requestId: number;
  actorSlackUserId: string;
  productSelection: string;
  amount: number;
  title: string;
  description?: string;
  splititOnly: boolean;
};

export async function listCheckoutBusinessesForRequest(requestId: number) {
  const request = await prisma.request.findUnique({ where: { id: requestId } });
  if (!request) return [];

  return prisma.channelWhopBusiness.findMany({
    where: { slackChannelId: request.channelId },
    orderBy: [{ businessName: "asc" }, { businessId: "asc" }]
  });
}

export async function listCheckoutProductOptionsForRequest(requestId: number) {
  const businesses = await listCheckoutBusinessesForRequest(requestId);
  const options: CheckoutProductOption[] = [];
  const errors: string[] = [];

  for (const business of businesses) {
    if (!business.apiKey) {
      errors.push(`${business.businessName} is missing an API key.`);
      continue;
    }

    try {
      const products = await listWhopProducts(business);
      products.forEach((product) => {
        options.push({
          value: encodeProductSelection(business.id, product.id),
          businessName: business.businessName,
          productId: product.id,
          productTitle: product.title || product.id
        });
      });
    } catch (error) {
      logger.error({ error, businessId: business.businessId }, "Failed to list Whop products");
      errors.push(`${business.businessName}: ${checkoutErrorMessage(error)}`);
    }
  }

  return { options: options.slice(0, 100), errors };
}

export async function createCheckoutLink(input: CreateCheckoutLinkInput) {
  const selection = decodeProductSelection(input.productSelection);
  if (!selection) return { error: "Choose a product.", request: null, checkoutUrl: "" };

  const [request, business] = await Promise.all([
    prisma.request.findUnique({ where: { id: input.requestId } }),
    prisma.channelWhopBusiness.findUnique({ where: { id: selection.businessMappingId } })
  ]);

  if (!request) return { error: "Request not found.", request: null, checkoutUrl: "" };
  if (!business || business.slackChannelId !== request.channelId) {
    return { error: "That Whop business is not mapped to this request's Slack channel.", request, checkoutUrl: "" };
  }
  if (!business.apiKey) return { error: `Missing API key for ${business.businessName}. Add it in /dashboard/whop.`, request, checkoutUrl: "" };

  try {
    const checkout = await callWhopCheckoutApi(business, {
      requestId: input.requestId,
      actorSlackUserId: input.actorSlackUserId,
      productId: selection.productId,
      amount: input.amount,
      title: input.title,
      description: input.description,
      splititOnly: input.splititOnly
    });

    const checkoutUrl = normalizeWhopUrl(checkout.purchase_url || checkout.plan?.purchase_url || "");
    if (!checkoutUrl) return { error: "Whop created the checkout, but did not return a purchase URL.", request, checkoutUrl: "" };

    const updatedRequest = await prisma.request.update({
      where: { id: input.requestId },
      data: {
        status: "DONE",
        customStatus: null,
        completedAt: new Date(),
        updates: {
          create: {
            actorSlackUserId: input.actorSlackUserId,
            kind: "AUTOMATION_UPDATED",
            message: `Created checkout link for ${business.businessName}: ${checkoutUrl}`
          }
        }
      },
      include: { requester: true, owner: true, channel: true, notes: true, updates: true, splititAutomationJob: true }
    });

    return { error: "", request: updatedRequest, checkoutUrl };
  } catch (error) {
    logger.error({ error, requestId: input.requestId, businessId: business.businessId }, "Failed to create Whop checkout link");
    return { error: checkoutErrorMessage(error), request, checkoutUrl: "" };
  }
}

async function callWhopCheckoutApi(
  business: CheckoutBusiness,
  input: Omit<CreateCheckoutLinkInput, "productSelection"> & { productId: string }
) {
  const response = await fetch("https://api.whop.com/api/v1/checkout_configurations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${business.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      mode: "payment",
      allow_promo_codes: true,
      metadata: {
        radar_request_id: String(input.requestId),
        radar_actor_slack_user_id: input.actorSlackUserId,
        source: "radar_slack_bot"
      },
      plan: {
        company_id: business.businessId,
        product_id: input.productId,
        currency: "usd",
        plan_type: "one_time",
        release_method: "buy_now",
        visibility: "quick_link",
        title: input.title.slice(0, 30),
        description: input.description?.slice(0, 1000) || null,
        initial_price: input.amount,
        ...(input.splititOnly
          ? {
              payment_method_configuration: {
                enabled: ["splitit"],
                disabled: [],
                include_platform_defaults: false
              }
            }
          : {})
      }
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body?.message === "string" ? body.message : JSON.stringify(body);
    throw new Error(`Whop returned HTTP ${response.status}: ${message}`);
  }

  return body;
}

async function listWhopProducts(business: CheckoutBusiness): Promise<Array<{ id: string; title?: string }>> {
  const url = new URL("https://api.whop.com/api/v1/products");
  url.searchParams.set("company_id", business.businessId);
  url.searchParams.set("first", "100");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${business.apiKey}`
    }
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body?.message === "string" ? body.message : JSON.stringify(body);
    throw new Error(`Whop returned HTTP ${response.status}: ${message}`);
  }

  return Array.isArray(body?.data) ? body.data : [];
}

function encodeProductSelection(businessMappingId: string, productId: string) {
  return `${businessMappingId}:${productId}`;
}

function decodeProductSelection(value: string) {
  const [businessMappingId, productId] = value.split(":");
  if (!businessMappingId || !productId) return null;
  return { businessMappingId, productId };
}

function normalizeWhopUrl(value: string) {
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return `https://whop.com${value.startsWith("/") ? value : `/${value}`}`;
}

function checkoutErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Could not create checkout link.";
}
