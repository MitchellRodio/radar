import { config } from "../lib/config";
import { prisma } from "../lib/prisma";

const OPENAI_API_KEY = "OPENAI_API_KEY";
const OPENAI_MODEL = "OPENAI_MODEL";

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

async function upsertSetting(key: string, value: string) {
  await prisma.appSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value }
  });
}
