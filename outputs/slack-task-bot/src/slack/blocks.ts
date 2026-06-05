import { InternalNote, Request, RequestType, RequestUpdate, User, Channel, SplititAutomationJob } from "@prisma/client";
import { formatDate } from "../lib/dates";
import type { CheckoutProductOption } from "../services/checkoutLinkService";
import { statusLabel, threadLink, typeLabel } from "./format";

type RequestWithRelations = Request & {
  requester?: User;
  owner?: User;
  channel?: Channel;
  notes?: InternalNote[];
  updates?: RequestUpdate[];
  splititAutomationJob?: SplititAutomationJob | null;
};

export function requestListBlocks(requests: RequestWithRelations[], heading: string) {
  if (requests.length === 0) {
    return [
      section(`*${heading}*`),
      section("No open requests found.")
    ];
  }

  return [
    section(`*${heading}*`),
    divider(),
    ...requests.flatMap((request) => [
      section(
        `*${escapeMrkdwn(request.title)}*\n` +
          `*Request ID:* ${request.id}\n` +
          `*Company/channel:* ${companyChannelLink(request)}\n` +
          `*Type:* ${typeLabel(request.type)}  *Status:* ${statusLabel(request)}\n` +
          `*Due:* ${formatDate(request.dueDate)}  *Blocker:* ${escapeMrkdwn(request.blocker ?? "None")}\n` +
          `*Created:* ${formatDate(request.createdAt)}`
      ),
      actions([
        button("View/update", "request_view", String(request.id)),
        button("Mark done", "request_set_done", `${request.id}:DONE`, "primary")
      ]),
      divider()
    ])
  ];
}

export function requestDetailBlocks(request: RequestWithRelations) {
  const notes = request.notes?.length
    ? request.notes
        .slice(0, 8)
        .map((note) => `- <@${note.authorSlackUserId}> ${formatDate(note.createdAt)}: ${escapeMrkdwn(note.body)}`)
        .join("\n")
    : "None";

  return [
    section(`*${escapeMrkdwn(request.title)}*`),
    section(
      `*Request ID:* ${request.id}\n` +
        `*Original message:*\n${escapeMrkdwn(request.description)}\n\n` +
        `*Requester:* <@${request.requesterSlackUserId}>\n` +
        `*Slack channel:* <#${request.channelId}>\n` +
        `*Thread:* ${threadText(request)}\n` +
        `*Type:* ${typeLabel(request.type)}\n` +
        `*Status:* ${statusLabel(request)}\n` +
        `*AI tags:* ${escapeMrkdwn(request.aiTags.length ? request.aiTags.join(", ") : "None")}\n` +
        `*Intent:* ${escapeMrkdwn(request.intent || "None")}\n` +
        `*Suggested next step:* ${escapeMrkdwn(request.suggestedNextStep || "None")}\n` +
        `*Confidence:* ${formatConfidence(request.confidence)}\n` +
        `*Owner CSM:* <@${request.ownerSlackUserId}>\n` +
        `*Due date:* ${formatDate(request.dueDate)}\n` +
        `*Blocker:* ${escapeMrkdwn(request.blocker ?? "None")}\n` +
        `*Created:* ${formatDate(request.createdAt)}\n` +
        `*Updated:* ${formatDate(request.updatedAt)}`
    ),
    section(`*Extracted fields*\n${escapeMrkdwn(formatExtractedFields(request.extractedFields))}`),
    divider(),
    section(`*Splitit agent*\n${splititAutomationText(request)}`),
    section(`*Internal notes*\n${notes}`),
    actions([
      button("Set Submitted", "request_set_submitted", `${request.id}:SUBMITTED`),
      button("Set In Progress", "request_set_in_progress", `${request.id}:IN_PROGRESS`),
      button("Set Done", "request_set_done", `${request.id}:DONE`, "primary")
    ]),
    actions([
      button("Set Custom Status", "request_custom_status_open", String(request.id)),
      button("Add/Edit Due Date", "request_due_date_open", String(request.id)),
      button("Add/Edit Blocker", "request_blocker_open", String(request.id))
    ]),
    actions([
      button("Add Internal Note", "request_note_open", String(request.id)),
      button("Reassign CSM", "request_reassign_open", String(request.id)),
      button("Request Info", "request_needs_info_open", String(request.id)),
      button("Notify requester", "request_notify_requester", String(request.id))
    ]),
    ...(request.type === "SPLITIT_WHITELIST"
      ? [
          actions([
            button("Queue Splitit agent", "request_splitit_agent_queue", String(request.id), "primary")
          ])
        ]
      : []),
    ...(request.type === "CHECKOUT_LINK"
      ? [
          actions([
            button("Create checkout link", "request_checkout_link_open", String(request.id), "primary")
          ])
        ]
      : []),
    actions([
      button("Close View", "request_close_view", String(request.id), "danger")
    ])
  ];
}

function splititAutomationText(request: RequestWithRelations) {
  if (request.type !== "SPLITIT_WHITELIST") return "Not applicable.";
  const job = request.splititAutomationJob;
  if (!job) return "Not queued yet.";
  return (
    `*Status:* ${job.status.toLowerCase().replace(/_/g, " ")}\n` +
    `*Step:* ${job.step.toLowerCase().replace(/_/g, " ")}\n` +
    `*Target:* ${escapeMrkdwn(job.targetEmail)}\n` +
    `*Last response:* ${escapeMrkdwn(job.lastResponse ?? "None")}\n` +
    `*Error:* ${escapeMrkdwn(job.error ?? "None")}`
  );
}

export function requestDetailModal(request: RequestWithRelations) {
  return {
    type: "modal",
    callback_id: `request_detail:${request.id}`,
    title: { type: "plain_text", text: request.title.slice(0, 24) || `Request ${request.id}` },
    close: { type: "plain_text", text: "Close" },
    blocks: requestDetailBlocks(request)
  };
}

export function checkoutLinkModal(request: RequestWithRelations, products: CheckoutProductOption[]) {
  const extracted = request.extractedFields as Record<string, unknown>;
  const initialAmount = parseAmountFromText(String(extracted.amount ?? "") || request.description);
  const initialSplititOnly = /splitit/i.test(request.description) || /splitit/i.test(String(extracted.paymentProvider ?? ""));

  return {
    type: "modal",
    callback_id: `checkout_link_create:${request.id}`,
    title: { type: "plain_text", text: "Checkout link" },
    submit: { type: "plain_text", text: "Create" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "product",
        element: {
          type: "static_select",
          action_id: "value",
          placeholder: { type: "plain_text", text: "Choose product" },
          options: products.slice(0, 100).map((product) => checkoutProductOption(product)),
          ...(products.length === 1 ? { initial_option: checkoutProductOption(products[0]) } : {})
        },
        label: { type: "plain_text", text: "Whop product" }
      },
      {
        type: "input",
        block_id: "amount",
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "2100" },
          ...(initialAmount ? { initial_value: String(initialAmount) } : {})
        },
        label: { type: "plain_text", text: "Amount in USD" }
      },
      {
        type: "input",
        block_id: "title",
        element: {
          type: "plain_text_input",
          action_id: "value",
          initial_value: request.title.slice(0, 30) || "Checkout link"
        },
        label: { type: "plain_text", text: "Checkout title" }
      },
      {
        type: "input",
        block_id: "description",
        optional: true,
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          initial_value: request.description.slice(0, 1000)
        },
        label: { type: "plain_text", text: "Checkout description" }
      },
      {
        type: "input",
        block_id: "splititOnly",
        optional: true,
        element: {
          type: "checkboxes",
          action_id: "value",
          options: [{ text: { type: "plain_text", text: "Splitit only" }, value: "splitit_only" }],
          ...(initialSplititOnly
            ? { initial_options: [{ text: { type: "plain_text", text: "Splitit only" }, value: "splitit_only" }] }
            : {})
        },
        label: { type: "plain_text", text: "Payment method" }
      }
    ]
  };
}

export function inputModal(callbackId: string, title: string, fieldLabel: string, initialValue = "", multiline = false) {
  return {
    type: "modal",
    callback_id: callbackId,
    title: { type: "plain_text", text: title.slice(0, 24) },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "input",
        element: {
          type: "plain_text_input",
          action_id: "value",
          initial_value: initialValue,
          multiline
        },
        label: { type: "plain_text", text: fieldLabel }
      }
    ]
  };
}

export function requestCreateModal(input: { channelId: string; initialDescription?: string }) {
  return {
    type: "modal",
    callback_id: "request_create",
    private_metadata: JSON.stringify({ channelId: input.channelId }),
    title: { type: "plain_text", text: "New request" },
    submit: { type: "plain_text", text: "Create" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "title",
        optional: true,
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "Checkout link for Splitit" }
        },
        label: { type: "plain_text", text: "Title" }
      },
      {
        type: "input",
        block_id: "description",
        optional: true,
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          ...(input.initialDescription ? { initial_value: input.initialDescription } : {}),
          placeholder: { type: "plain_text", text: "What does the customer need?" }
        },
        label: { type: "plain_text", text: "Request details" }
      },
      {
        type: "input",
        block_id: "customerEmail",
        optional: true,
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "customer@example.com" }
        },
        label: { type: "plain_text", text: "Customer email" }
      },
      {
        type: "input",
        block_id: "type",
        element: {
          type: "static_select",
          action_id: "value",
          initial_option: requestTypeOption("OTHER"),
          options: [
            requestTypeOption("CHECKOUT_LINK"),
            requestTypeOption("SPLITIT_WHITELIST"),
            requestTypeOption("REFUND_PAYMENT"),
            requestTypeOption("BUG_REPORT"),
            requestTypeOption("ENHANCEMENT_REQUEST"),
            requestTypeOption("KYC_KYB"),
            requestTypeOption("PAYMENT_ISSUE"),
            requestTypeOption("ACCOUNT_SETTINGS"),
            requestTypeOption("OTHER"),
            selfServeOption("VIEW_PAYMENTS", "View payments")
          ]
        },
        label: { type: "plain_text", text: "Request type" }
      }
    ]
  };
}

export function helpBlocks() {
  return [
    section("*CSM request bot commands*"),
    section(
      "`/my-requests` - view requests assigned to you\n" +
        "`/all-requests` - admin view of all open requests\n" +
        "`/request` - open a request creation form in the current channel\n" +
        "`/request-map-channel <channel_id> <@csm|user_id>` - admin maps channel ownership\n" +
        "`/request-reassign <request_id> <@csm|user_id>` - reassign a request\n" +
        "`/request-help` - show this help"
    )
  ];
}

function section(text: string, accessory?: unknown[]) {
  return {
    type: "section",
    text: { type: "mrkdwn", text },
    ...(accessory?.length ? { accessory: accessory[0] } : {})
  };
}

function actions(elements: unknown[]) {
  return { type: "actions", elements };
}

function button(text: string, actionId: string, value: string, style?: "primary" | "danger") {
  return {
    type: "button",
    text: { type: "plain_text", text },
    action_id: actionId,
    value,
    ...(style ? { style } : {})
  };
}

function formatConfidence(confidence: number) {
  return `${Math.round(confidence * 100)}%`;
}

function formatExtractedFields(value: unknown) {
  if (!value || (typeof value === "object" && Object.keys(value).length === 0)) return "None";
  return JSON.stringify(value, null, 2);
}

function divider() {
  return { type: "divider" };
}

function threadText(request: Request) {
  if (request.threadTs.startsWith("manual-")) return "Created from /request";
  return `<${threadLink(request.channelId, request.messageTs || request.threadTs)}|Open message>`;
}

function companyChannelLink(request: RequestWithRelations) {
  const label = escapeMrkdwn(request.channel?.companyName ?? request.channel?.name ?? request.channelId);
  const messageUrl = requestMessageUrl(request);
  if (messageUrl) return `<${messageUrl}|${label}>`;
  return `<#${request.channelId}>`;
}

function requestMessageUrl(request: RequestWithRelations) {
  if (!request.threadTs.startsWith("manual-")) return threadLink(request.channelId, request.messageTs || request.threadTs);
  if (request.requesterMessageChannelId && request.requesterMessageTs) {
    return threadLink(request.requesterMessageChannelId, request.requesterMessageTs);
  }
  return "";
}

function checkoutProductOption(product: CheckoutProductOption) {
  return {
    text: { type: "plain_text", text: `${product.businessName} - ${product.productTitle}`.slice(0, 75) },
    value: product.value
  };
}

function requestTypeOption(type: RequestType) {
  return {
    text: { type: "plain_text", text: typeLabel(type) },
    value: type
  };
}

function selfServeOption(value: string, label: string) {
  return {
    text: { type: "plain_text", text: label },
    value
  };
}

function parseAmountFromText(text: string) {
  const match = text.match(/(?:\$|usd\s*)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)\s*([kK])?\b/);
  if (!match) return "";
  const number = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(number) || number <= 0) return "";
  return match[2] ? Math.round(number * 1000) : number;
}

function escapeMrkdwn(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
