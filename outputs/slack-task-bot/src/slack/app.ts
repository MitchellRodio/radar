import { App } from "@slack/bolt";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import { registerActions } from "../actions/registerActions";
import { registerCommands } from "../commands/registerCommands";
import { processSlackMessageForPulse } from "../services/pulseService";
import { createRequestFromSlackMessage, updateRequesterMessageReference } from "../services/requestService";
import { enrichSlackFileAttachments, extractMessageFileAttachments } from "../services/slackFileService";
import { notifyOwnerRequestCreated, sendRequesterEphemeralStatusMessage, sendRequesterStatusMessage } from "./notifications";

export function createSlackApp() {
  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    signingSecret: config.SLACK_SIGNING_SECRET,
    socketMode: config.SLACK_SOCKET_MODE,
    appToken: config.SLACK_APP_TOKEN
  });

  app.event("app_mention", async ({ event, client, context }: any) => {
    try {
      const request = await createRequestFromSlackMessage({
        text: event.text,
        requesterSlackUserId: event.user,
        channelId: event.channel,
        messageTs: event.ts,
        threadTs: event.thread_ts ?? event.ts,
        botUserId: context.botUserId,
        attachments: await enrichSlackFileAttachments(client, extractMessageFileAttachments(event.files))
      });

      const requesterMessage = await sendRequesterStatusMessage(client, request);
      const updatedRequest = requesterMessage.channel && requesterMessage.ts
        ? await updateRequesterMessageReference(request.id, requesterMessage.channel, requesterMessage.ts)
        : request;

      await sendRequesterEphemeralStatusMessage(client, updatedRequest);
      await notifyOwnerRequestCreated(client, updatedRequest);
    } catch (error) {
      logger.error(error, "Failed to create request from app mention");
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts ?? event.ts,
        text: "Sorry, I could not create that request. Please try again or use `/request-help`."
      });
    }
  });

  app.message(async ({ message, context }: any) => {
    try {
      if (!message?.text || !message.channel || !message.ts) return;
      if (message.subtype || message.bot_id || message.user === context.botUserId) return;
      if (context.botUserId && message.text.includes(`<@${context.botUserId}>`)) return;

      void processSlackMessageForPulse({
        slackChannelId: message.channel,
        slackUserId: message.user,
        messageTs: message.ts,
        threadTs: message.thread_ts ?? null,
        text: message.text
      }).catch((error) => logger.error({ error, channel: message.channel, ts: message.ts }, "Pulse message analysis failed"));
    } catch (error) {
      logger.error(error, "Failed to queue Pulse message analysis");
    }
  });

  registerCommands(app);
  registerActions(app);

  return app;
}
