import { config } from "./lib/config";
import { logger } from "./lib/logger";
import { createSlackApp } from "./slack/app";
import { startReminderJob } from "./jobs/reminders";
import { startSplititAutomationJob } from "./jobs/splititAutomation";
import { startDashboardServer } from "./web/dashboard";
import { ensureUser } from "./services/userService";

process.on("uncaughtException", (error) => {
  if (isSlackSocketModeStartupDisconnect(error)) {
    logger.warn({ error }, "Ignoring transient Slack Socket Mode startup disconnect");
    return;
  }

  logger.error(error, "Uncaught exception");
  process.exit(1);
});

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

function isSlackSocketModeStartupDisconnect(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.message.includes("server explicit disconnect") && Boolean(error.stack?.includes("@slack/socket-mode"));
}
