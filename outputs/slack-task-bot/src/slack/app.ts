import { App } from "@slack/bolt";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import { registerActions } from "../actions/registerActions";
import { registerCommands } from "../commands/registerCommands";
import { createRequestFromSlackMessage, updateRequesterMessageReference } from "../services/requestService";
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
        botUserId: context.botUserId
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

  registerCommands(app);
  registerActions(app);

  return app;
}
