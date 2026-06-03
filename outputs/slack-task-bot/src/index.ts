import { config } from "./lib/config";
import { logger } from "./lib/logger";
import { createSlackApp } from "./slack/app";
import { startReminderJob } from "./jobs/reminders";
import { startSplititAutomationJob } from "./jobs/splititAutomation";
import { startDashboardServer } from "./web/dashboard";
import { ensureUser } from "./services/userService";

async function main() {
  await ensureConfiguredAdmins();

  const app = createSlackApp();
  startReminderJob(app);
  startSplititAutomationJob(app);
  if (config.SLACK_SOCKET_MODE) {
    startDashboardServer(config.PORT);
  }

  if (config.SLACK_SOCKET_MODE) {
    await app.start();
  } else {
    await app.start(config.PORT);
  }
  logger.info({ port: config.PORT, socketMode: config.SLACK_SOCKET_MODE }, "Slack task bot started");
}

main().catch((error) => {
  logger.error(error, "Failed to start Slack task bot");
  process.exit(1);
});

async function ensureConfiguredAdmins() {
  await Promise.all(config.adminSlackUserIds.map((slackUserId) => ensureUser(slackUserId, undefined, true)));
}
