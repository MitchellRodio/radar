import { WebClient } from "@slack/web-api";
import { Channel, Request } from "@prisma/client";
import { formatDate } from "../lib/dates";
import { statusLabel, threadLink, typeLabel } from "./format";
import { recordRequesterNotification } from "../services/requestService";

type RequestWithChannel = Request & {
  channel?: Channel | null;
};

export async function postRequesterUpdate(client: WebClient, request: Request, actorSlackUserId: string, prefix = "Update") {
  const text = `${prefix} on ${request.title}: ${statusLabel(request)}`;
  const message = `<@${request.requesterSlackUserId}> ${text}`;

  if (request.threadTs.startsWith("manual-")) {
    await client.chat.postMessage({
      channel: request.requesterSlackUserId,
      text: message
    });
  } else {
    await client.chat.postMessage({
      channel: request.channelId,
      thread_ts: request.threadTs,
      text: message
    });
  }

  await recordRequesterNotification(request.id, actorSlackUserId, text);
}

export async function sendRequesterStatusMessage(client: WebClient, request: RequestWithChannel) {
  return client.chat.postMessage({
    channel: request.requesterSlackUserId,
    text: `Request created: ${request.title}`,
    blocks: requesterStatusBlocks(request)
  });
}

export async function sendRequesterEphemeralStatusMessage(client: WebClient, request: RequestWithChannel) {
  return client.chat.postEphemeral({
    channel: request.channelId,
    user: request.requesterSlackUserId,
    text: `Request created: ${request.title}`,
    blocks: requesterStatusBlocks(request)
  });
}

export async function updateRequesterStatusMessage(client: WebClient, request: RequestWithChannel) {
  if (!request.requesterMessageChannelId || !request.requesterMessageTs) return;

  await client.chat.update({
    channel: request.requesterMessageChannelId,
    ts: request.requesterMessageTs,
    text: `${request.title}: ${statusLabel(request)}`,
    blocks: requesterStatusBlocks(request)
  });
}

export async function postRequesterNeedsInfo(client: WebClient, request: Request, actorSlackUserId: string, message: string) {
  const text = `Need info on ${request.title}: ${message}`;
  const body = `<@${request.requesterSlackUserId}> ${text}`;

  if (request.threadTs.startsWith("manual-")) {
    await client.chat.postMessage({
      channel: request.requesterSlackUserId,
      text: body
    });
  } else {
    await client.chat.postMessage({
      channel: request.channelId,
      thread_ts: request.threadTs,
      text: body
    });
  }

  await recordRequesterNotification(request.id, actorSlackUserId, text);
}

export async function notifyOwnerRequestCreated(client: WebClient, request: RequestWithChannel) {
  const company = request.channel?.companyName ?? request.channel?.name ?? request.channelId;

  await client.chat.postMessage({
    channel: request.ownerSlackUserId,
    text: `New request assigned to you: ${request.title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*New request assigned to you*\n` +
            `*Title:* ${escapeMrkdwn(request.title)}\n` +
            `*Channel:* <#${request.channelId}> (${company})\n` +
            `*Requester:* <@${request.requesterSlackUserId}>\n` +
            `*Type:* ${typeLabel(request.type)}\n` +
            `*Status:* ${statusLabel(request)}\n` +
            `*Intent:* ${escapeMrkdwn(request.intent || "None")}\n` +
            `*Tags:* ${escapeMrkdwn(request.aiTags.length ? request.aiTags.join(", ") : "None")}\n` +
            `*Next step:* ${escapeMrkdwn(request.suggestedNextStep || "Review and triage this request.")}\n` +
            `*Due:* ${formatDate(request.dueDate)}` +
            originalThreadLine(request)
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View/update" },
            action_id: "owner_request_view",
            value: String(request.id),
            style: "primary"
          }
        ]
      }
    ]
  });
}

function originalThreadLine(request: Request) {
  if (request.threadTs.startsWith("manual-")) return "";
  return `\n*Thread:* <${threadLink(request.channelId, request.threadTs)}|Open thread>`;
}

function requesterStatusBlocks(request: RequestWithChannel) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${escapeMrkdwn(request.title)}*\n` +
          `*Status:* ${statusLabel(request)}\n` +
          `*Type:* ${typeLabel(request.type)}\n` +
          `*Intent:* ${escapeMrkdwn(request.intent || "None")}\n` +
          `*Due:* ${formatDate(request.dueDate)}`
      }
    }
  ];
}

function escapeMrkdwn(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
