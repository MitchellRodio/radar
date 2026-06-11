import { WebClient } from "@slack/web-api";
import { Channel, Request, RequestAttachment } from "@prisma/client";
import { formatDate } from "../lib/dates";
import { statusLabel, threadLink, typeLabel } from "./format";
import { recordRequesterNotification } from "../services/requestService";

type RequestWithChannel = Request & {
  channel?: Channel | null;
  attachments?: RequestAttachment[];
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
  const tags = request.aiTags.length ? request.aiTags.join(", ") : "None";
  const nextStep = request.suggestedNextStep || "Review and triage this request.";

  await client.chat.postMessage({
    channel: request.ownerSlackUserId,
    text: `New request assigned to you: ${request.title}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "New request assigned" }
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${escapeMrkdwn(request.title)}*\n${statusPill(request)} | ${typeLabel(request.type)}` }
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Request ID*\n${request.id}` },
          { type: "mrkdwn", text: `*Created*\n${formatDate(request.createdAt)}` },
          { type: "mrkdwn", text: `*Channel*\n<#${request.channelId}>` },
          { type: "mrkdwn", text: `*Company*\n${escapeMrkdwn(company)}` },
          { type: "mrkdwn", text: `*Requester*\n<@${request.requesterSlackUserId}>` },
          { type: "mrkdwn", text: `*Due*\n${formatDate(request.dueDate)}` }
        ]
      },
      {
        type: "divider"
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Customer ask*\n${escapeMrkdwn(truncate(request.description || request.title, 700))}` }
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Intent*\n${escapeMrkdwn(truncate(request.intent || "None", 300))}` },
          { type: "mrkdwn", text: `*Tags*\n${escapeMrkdwn(truncate(tags, 300))}` }
        ]
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Next step*\n${escapeMrkdwn(truncate(nextStep, 700))}` }
      },
      ...attachmentBlocks(request),
      ...threadBlocks(request),
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

function attachmentBlocks(request: RequestWithChannel) {
  const attachments = request.attachments ?? [];
  if (!attachments.length) return [];
  const text = attachments
    .slice(0, 5)
    .map((attachment) => {
      const label = escapeMrkdwn(attachment.name ?? attachment.filetype ?? attachment.slackFileId);
      const url = attachment.permalink ?? attachment.urlPrivate;
      return url ? `- <${url}|${label}>` : `- \`${escapeMrkdwn(attachment.slackFileId)}\` ${label}`;
    })
    .join("\n");
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Screenshots / uploads*\n${text}` }
    }
  ];
}

export async function notifyOwnerRequesterReply(client: WebClient, request: RequestWithChannel, message: string) {
  await client.chat.postMessage({
    channel: request.ownerSlackUserId,
    text: `This issue has a reply from the requester: ${request.title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*This issue has a reply from the requester*\n` +
            `*Request:* ${escapeMrkdwn(request.title)}\n` +
            `*Requester:* <@${request.requesterSlackUserId}>\n` +
            `*Update:*\n${escapeMrkdwn(truncate(message, 1200))}`
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

function statusPill(request: Request) {
  return `*Status:* ${escapeMrkdwn(statusLabel(request))}`;
}

function threadBlocks(request: Request) {
  if (request.threadTs.startsWith("manual-")) return [];
  return [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Original thread: <${threadLink(request.channelId, request.threadTs)}|Open in Slack>` }]
    }
  ];
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
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
          `*Intent:* ${escapeMrkdwn(request.intent || "None")}`
      }
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Add info" },
          action_id: "requester_add_info_open",
          value: String(request.id),
          style: "primary"
        }
      ]
    }
  ];
}

function escapeMrkdwn(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
