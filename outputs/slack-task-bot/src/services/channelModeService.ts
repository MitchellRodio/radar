import { ChannelBotMode } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { ensureChannel } from "./userService";

export async function getChannelBotMode(slackChannelId: string): Promise<ChannelBotMode> {
  const channel = await prisma.channel.findUnique({
    where: { slackChannelId },
    select: { botMode: true }
  });
  return channel?.botMode ?? "FULL";
}

export async function isKycOnlyChannel(slackChannelId: string) {
  return (await getChannelBotMode(slackChannelId)) === "KYC_ONLY";
}

export async function setChannelBotMode(slackChannelId: string, botMode: ChannelBotMode) {
  await ensureChannel(slackChannelId);
  return prisma.channel.update({
    where: { slackChannelId },
    data: { botMode }
  });
}
