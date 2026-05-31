import { config } from "./lib/config";
import { logger } from "./lib/logger";
import { createSlackApp } from "./slack/app";
import { startReminderJob } from "./jobs/reminders";

async function main() {
  const app = createSlackApp();
  startReminderJob(app);

  await app.start(config.PORT);
  logger.info({ port: config.PORT, socketMode: config.SLACK_SOCKET_MODE }, "Slack task bot started");
}

main().catch((error) => {
  logger.error(error, "Failed to start Slack task bot");
  process.exit(1);
});
