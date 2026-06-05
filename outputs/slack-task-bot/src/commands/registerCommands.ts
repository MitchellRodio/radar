import { App } from "@slack/bolt";
import { isAdmin } from "../lib/permissions";
import { logger } from "../lib/logger";
import { helpBlocks, requestCreateModal, requestListBlocks } from "../slack/blocks";
import {
  extractSlackChannelId,
  extractSlackUserId,
  listAllOpenRequests,
  listAssignedOpenRequests,
  parseRequestId,
  reassignRequest
} from "../services/requestService";
import { mapChannelOwner } from "../services/channelOwnerService";
import { customerLookupBlocks, lookupCustomerAccount } from "../services/customerLookupService";

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
      logger.warn({ userId: command.user_id }, "Non-admin used /all-requests; allowing for MVP visibility");
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

  app.command("/request", async ({ ack, command, respond, client }: any) => {
    await ack();
    try {
      await client.views.open({
        trigger_id: command.trigger_id,
        view: requestCreateModal({
          channelId: command.channel_id,
          initialDescription: command.text?.trim()
        })
      });
    } catch (error) {
      logger.error(error, "Failed to handle /request");
      await respond("Sorry, I could not open the request form.");
    }
  });

  app.command("/customer-lookup", async ({ ack, command, respond }: any) => {
    await ack();
    const email = extractEmail(command.text ?? "");
    if (!email) {
      await respond({
        response_type: "ephemeral",
        text: "Usage: `/customer-lookup customer@example.com`"
      });
      return;
    }

    try {
      const lookup = await lookupCustomerAccount({ channelId: command.channel_id, email });
      await respond({
        response_type: "ephemeral",
        text: `Customer lookup: ${email}`,
        blocks: customerLookupBlocks(lookup)
      });
    } catch (error) {
      logger.error(error, "Failed to handle /customer-lookup");
      await respond("Sorry, I could not look up that customer.");
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

function extractEmail(value: string) {
  return value.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0] ?? "";
}
