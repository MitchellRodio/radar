import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_SOCKET_MODE: z
    .string()
    .optional()
    .default("true")
    .transform((value) => value === "true"),
  PORT: z.coerce.number().default(3000),
  ADMIN_SLACK_USER_IDS: z.string().optional().default(""),
  DASHBOARD_ADMIN_TOKEN: z.string().optional().default(""),
  REMINDER_INTERVAL_MINUTES: z.coerce.number().default(60)
});

const parsed = schema.parse(process.env);

export const config = {
  ...parsed,
  adminSlackUserIds: parsed.ADMIN_SLACK_USER_IDS.split(",")
    .map((id) => id.trim())
    .filter(Boolean)
};
