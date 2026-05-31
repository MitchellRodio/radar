import { prisma } from "../lib/prisma";
import { ensureChannel, ensureUser } from "./userService";

export async function getChannelOwner(slackChannelId: string): Promise<string | null> {
  const mapping = await prisma.channelOwnerMapping.findUnique({
    where: { slackChannelId },
    select: { ownerSlackUserId: true }
  });

  return mapping?.ownerSlackUserId ?? null;
}

export async function mapChannelOwner(slackChannelId: string, ownerSlackUserId: string) {
  await ensureChannel(slackChannelId);
  await ensureUser(ownerSlackUserId);

  return prisma.channelOwnerMapping.upsert({
    where: { slackChannelId },
    update: { ownerSlackUserId },
    create: { slackChannelId, ownerSlackUserId }
  });
}
