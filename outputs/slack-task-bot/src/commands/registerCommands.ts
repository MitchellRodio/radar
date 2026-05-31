import { App } from "@slack/bolt";
import { isAdmin } from "../lib/permissions";
import { logger } from "../lib/logger";
import { helpBlocks, requestListBlocks } from "../slack/blocks";
import {
  createRequestFromSlackMessage,
  extractSlackChannelId,
  extractSlackUserId,
  listAllOpenRequests,
  listAssignedOpenRequests,
  parseRequestId,
  reassignRequest
} from "../services/requestService";
import { mapChannelOwner } from "../services/channelOwnerService";

export function registerCommands(app: App) {
  app.command("/my-requests", async ({ ack, command, respond }: any) => {
    await ack();
    try {
      const requests = await listAssignedOpenRequests(command.user_id);
      await respond({
        response_type: "ephemeral",
        blocks: requestListBlocks(requests, "My open requests")
      });
    } catch (error) {
      logger.error(error, "Failed to handle /my-requests");
      await respond("Sorry, I could not load your requests.");
    }
  });

  app.command("/all-requests", async ({ ack, command, respond }: any) => {
    await ack();
    if (!(await isAdmin(command.user_id))) {
      await respond("Only admins can use `/all-requests`.");
      return;
    }

    try {
      const requests = await listAllOpenRequests();
      await respond({
        response_type: "ephemeral",
        blocks: requestListBlocks(requests, "All open requests")
      });
    } catch (error) {
      logger.error(error, "Failed to handle /all-requests");
      await respond("Sorry, I could not load all requests.");
    }
  });

  app.command("/request-create", async ({ ack, command, respond, client, context }: any) => {
    await ack();
    const text = command.text?.trim();
    if (!text) {
      await respond("Usage: `/request-create I need a checkout link due 2026-06-15`");
      return;
    }

    try {
      const request = await createRequestFromSlackMessage({
        text,
        requesterSlackUserId: command.user_id,
        channelId: command.channel_id,
        messageTs: `slash-${command.trigger_id}`,
        threadTs: `slash-${command.trigger_id}`,
        botUserId: context.botUserId
      });

      await respond({
        response_type: "ephemeral",
        text: `Request created: #${request.id}`
      });

      await client.chat.postMessage({
        channel: command.channel_id,
        text: `Request created: #${request.id}`,
        unfurl_links: false
      });
    } catch (error) {
      logger.error(error, "Failed to handle /request-create");
      await respond("Sorry, I could not create that request.");
    }
  });

  app.command("/request-map-channel", async ({ ack, command, respond }: any) => {
    await ack();
    if (!(await isAdmin(command.user_id))) {
      await respond("Only admins can map channel ownership.");
      return;
    }

    const [channelArg, ownerArg] = command.text.trim().split(/\s+/);
    const channelId = extractSlackChannelId(channelArg ?? "");
    const ownerSlackUserId = extractSlackUserId(ownerArg ?? "");

    if (!channelId || !ownerSlackUserId) {
      await respond("Usage: `/request-map-channel C123456 <@U123456>`");
      return;
    }

    await mapChannelOwner(channelId, ownerSlackUserId);
    await respond(`Mapped <#${channelId}> to <@${ownerSlackUserId}>.`);
  });

  app.command("/request-reassign", async ({ ack, command, respond }: any) => {
    await ack();
    const [requestArg, ownerArg] = command.text.trim().split(/\s+/);
    const requestId = parseRequestId(requestArg ?? "");
    const ownerSlackUserId = extractSlackUserId(ownerArg ?? "");

    if (!requestId || !ownerSlackUserId) {
      await respond("Usage: `/request-reassign 123 <@U123456>`");
      return;
    }

    if (!(await isAdmin(command.user_id))) {
      await respond("Only admins can reassign from this slash command. CSMs can reassign from the request detail view.");
      return;
    }

    await reassignRequest(requestId, command.user_id, ownerSlackUserId);
    await respond(`Request #${requestId} reassigned to <@${ownerSlackUserId}>.`);
  });

  app.command("/request-help", async ({ ack, respond }: any) => {
    await ack();
    await respond({
      response_type: "ephemeral",
      blocks: helpBlocks()
    });
  });
}
