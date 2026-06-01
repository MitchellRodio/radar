import { App } from "@slack/bolt";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import { registerActions } from "../actions/registerActions";
import { registerCommands } from "../commands/registerCommands";
import { createRequestFromSlackMessage } from "../services/requestService";
import { typeLabel } from "./format";
import { notifyOwnerRequestCreated } from "./notifications";

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

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts ?? event.ts,
        text: `Request created: #${request.id}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                `Request created: *#${request.id}*\n` +
                `*Title:* ${request.title}\n` +
                `*Type:* ${typeLabel(request.type)}\n` +
                `*Status:* Submitted\n` +
                `*Owner:* <@${request.ownerSlackUserId}>`
            }
          }
        ]
      });

      await notifyOwnerRequestCreated(client, request);
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
