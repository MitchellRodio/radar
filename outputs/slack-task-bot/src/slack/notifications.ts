import { WebClient } from "@slack/web-api";
import { Channel, Request } from "@prisma/client";
import { formatDate } from "../lib/dates";
import { statusLabel, threadLink, typeLabel } from "./format";
import { recordRequesterNotification } from "../services/requestService";

type RequestWithChannel = Request & {
  channel?: Channel | null;
};

export async function postRequesterUpdate(client: WebClient, request: Request, actorSlackUserId: string, prefix = "Update") {
  const text = `${prefix} on request #${request.id}: ${statusLabel(request)}`;

  await client.chat.postMessage({
    channel: request.channelId,
    thread_ts: request.threadTs,
    text: `<@${request.requesterSlackUserId}> ${text}`
  });

  await recordRequesterNotification(request.id, actorSlackUserId, text);
}

export async function notifyOwnerRequestCreated(client: WebClient, request: RequestWithChannel) {
  const company = request.channel?.companyName ?? request.channel?.name ?? request.channelId;

  await client.chat.postMessage({
    channel: request.ownerSlackUserId,
    text: `New request assigned to you: #${request.id} ${request.title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*New request assigned to you: #${request.id}*\n` +
            `*Title:* ${request.title}\n` +
            `*Channel:* <#${request.channelId}> (${company})\n` +
            `*Requester:* <@${request.requesterSlackUserId}>\n` +
            `*Type:* ${typeLabel(request.type)}\n` +
            `*Due:* ${formatDate(request.dueDate)}\n` +
            `*Thread:* <${threadLink(request.channelId, request.threadTs)}|Open thread>`
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View/update" },
            action_id: "request_view",
            value: String(request.id)
          }
        ]
      }
    ]
  });
}
