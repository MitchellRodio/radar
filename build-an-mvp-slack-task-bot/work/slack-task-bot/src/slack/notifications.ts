import { WebClient } from "@slack/web-api";
import { Request } from "@prisma/client";
import { statusLabel } from "./format";
import { recordRequesterNotification } from "../services/requestService";

export async function postRequesterUpdate(client: WebClient, request: Request, actorSlackUserId: string, prefix = "Update") {
  const text = `${prefix} on request #${request.id}: ${statusLabel(request)}`;

  await client.chat.postMessage({
    channel: request.channelId,
    thread_ts: request.threadTs,
    text: `<@${request.requesterSlackUserId}> ${text}`
  });

  await recordRequesterNotification(request.id, actorSlackUserId, text);
}
