import { App } from "@slack/bolt";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import { dueDateLabel } from "../lib/dates";
import { findRequestsNeedingReminder, markReminderSent } from "../services/requestService";
import { statusLabel } from "../slack/format";

export function startReminderJob(app: App) {
  const intervalMs = config.REMINDER_INTERVAL_MINUTES * 60 * 1000;

  async function run() {
    try {
      const requests = await findRequestsNeedingReminder();
      for (const request of requests) {
        await app.client.chat.postMessage({
          channel: request.ownerSlackUserId,
          text:
            `Reminder: request #${request.id} is due ${dueDateLabel(request.dueDate)} and is still ${statusLabel(request)}.\n` +
            `Title: ${request.title}\n` +
            `Channel: <#${request.channelId}>`
        });
        await markReminderSent(request.id);
      }
    } catch (error) {
      logger.error(error, "Reminder job failed");
    }
  }

  void run();
  setInterval(run, intervalMs).unref();
}
