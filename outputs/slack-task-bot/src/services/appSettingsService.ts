import { config } from "../lib/config";
import { prisma } from "../lib/prisma";

const OPENAI_API_KEY = "OPENAI_API_KEY";
const OPENAI_MODEL = "OPENAI_MODEL";
const WHOP_API_KEY = "WHOP_API_KEY";
const SPLITIT_AGENT_WEBHOOK_URL = "SPLITIT_AGENT_WEBHOOK_URL";
const SPLITIT_AGENT_WEBHOOK_SECRET = "SPLITIT_AGENT_WEBHOOK_SECRET";

export async function getOpenAiSettings() {
  const settings = await prisma.appSetting.findMany({
    where: { key: { in: [OPENAI_API_KEY, OPENAI_MODEL] } }
  });

  const values = Object.fromEntries(settings.map((setting) => [setting.key, setting.value]));

  return {
    apiKey: values[OPENAI_API_KEY] || config.OPENAI_API_KEY,
    model: values[OPENAI_MODEL] || config.OPENAI_MODEL,
    source: values[OPENAI_API_KEY] ? "dashboard" : config.OPENAI_API_KEY ? "environment" : "missing"
  };
}

export async function saveOpenAiSettings(input: { apiKey?: string; model?: string; clearApiKey?: boolean }) {
  if (input.clearApiKey) {
    await prisma.appSetting.deleteMany({ where: { key: OPENAI_API_KEY } });
  } else if (input.apiKey?.trim()) {
    await upsertSetting(OPENAI_API_KEY, input.apiKey.trim());
  }

  if (input.model?.trim()) {
    await upsertSetting(OPENAI_MODEL, input.model.trim());
  }
}

export async function getOpenAiSettingsStatus() {
  const settings = await getOpenAiSettings();
  return {
    configured: Boolean(settings.apiKey),
    model: settings.model,
    source: settings.source
  };
}

export async function getWhopSettings() {
  const setting = await prisma.appSetting.findUnique({ where: { key: WHOP_API_KEY } });

  return {
    apiKey: setting?.value || config.WHOP_API_KEY,
    source: setting?.value ? "dashboard" : config.WHOP_API_KEY ? "environment" : "missing"
  };
}

export async function saveWhopSettings(input: { apiKey?: string; clearApiKey?: boolean }) {
  if (input.clearApiKey) {
    await prisma.appSetting.deleteMany({ where: { key: WHOP_API_KEY } });
  } else if (input.apiKey?.trim()) {
    await upsertSetting(WHOP_API_KEY, input.apiKey.trim());
  }
}

export async function getWhopSettingsStatus() {
  const settings = await getWhopSettings();
  return {
    configured: Boolean(settings.apiKey),
    source: settings.source
  };
}

export async function getSplititAgentSettings() {
  const settings = await prisma.appSetting.findMany({
    where: { key: { in: [SPLITIT_AGENT_WEBHOOK_URL, SPLITIT_AGENT_WEBHOOK_SECRET] } }
  });
  const values = Object.fromEntries(settings.map((setting) => [setting.key, setting.value]));

  return {
    webhookUrl: values[SPLITIT_AGENT_WEBHOOK_URL] || config.SPLITIT_AGENT_WEBHOOK_URL,
    webhookSecret: values[SPLITIT_AGENT_WEBHOOK_SECRET] || config.SPLITIT_AGENT_WEBHOOK_SECRET,
    source: values[SPLITIT_AGENT_WEBHOOK_URL] ? "dashboard" : config.SPLITIT_AGENT_WEBHOOK_URL ? "environment" : "missing"
  };
}

export async function saveSplititAgentSettings(input: { webhookUrl?: string; webhookSecret?: string; clearWebhookSecret?: boolean }) {
  if (input.webhookUrl?.trim()) {
    await upsertSetting(SPLITIT_AGENT_WEBHOOK_URL, input.webhookUrl.trim());
  }

  if (input.clearWebhookSecret) {
    await prisma.appSetting.deleteMany({ where: { key: SPLITIT_AGENT_WEBHOOK_SECRET } });
  } else if (input.webhookSecret?.trim()) {
    await upsertSetting(SPLITIT_AGENT_WEBHOOK_SECRET, input.webhookSecret.trim());
  }
}

export async function getSplititAgentSettingsStatus() {
  const settings = await getSplititAgentSettings();
  return {
    configured: Boolean(settings.webhookUrl),
    source: settings.source
  };
}

async function upsertSetting(key: string, value: string) {
  await prisma.appSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value }
  });
}
