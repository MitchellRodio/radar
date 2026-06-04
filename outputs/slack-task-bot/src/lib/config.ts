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
  OPENAI_API_KEY: z.string().optional().default(""),
  OPENAI_MODEL: z.string().optional().default("gpt-5-nano"),
  WHOP_API_KEY: z.string().optional().default(""),
  REMINDER_INTERVAL_MINUTES: z.coerce.number().default(60),
  SPLITIT_AGENT_INTERVAL_SECONDS: z.coerce.number().default(30),
  SPLITIT_AGENT_WEBHOOK_URL: z.string().optional().default(""),
  SPLITIT_AGENT_WEBHOOK_SECRET: z.string().optional().default(""),
  SPLITIT_AGENT_CSM_NAME: z.string().optional().default("Mitchell Rodio"),
  SPLITIT_AGENT_MERCHANT_ROLE: z.string().optional().default("Merchant"),
  SPLITIT_AGENT_STORE_NAME: z.string().optional().default("Whop.com"),
  SPLITIT_AGENT_MERCHANT_EMAIL: z.string().optional().default("mitchell.rodio@whop.com")
});

const parsed = schema.parse(process.env);

export const config = {
  ...parsed,
  adminSlackUserIds: parsed.ADMIN_SLACK_USER_IDS.split(",")
    .map((id) => id.trim())
    .filter(Boolean)
};
