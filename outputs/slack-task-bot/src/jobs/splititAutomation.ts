import { App } from "@slack/bolt";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import { processDueSplititJobs } from "../services/splititAutomationService";

export function startSplititAutomationJob(app: App) {
  const intervalMs = Math.max(config.SPLITIT_AGENT_INTERVAL_SECONDS, 10) * 1000;

  setInterval(async () => {
    try {
      await processDueSplititJobs(app.client);
    } catch (error) {
      logger.error(error, "Splitit automation polling failed");
    }
  }, intervalMs);
}
