import { prisma } from "../lib/prisma";

export async function ensureUser(slackUserId: string, name?: string, isAdmin = false) {
  return prisma.user.upsert({
    where: { slackUserId },
    update: {
      ...(name ? { name } : {}),
      ...(isAdmin ? { isAdmin } : {})
    },
    create: {
      slackUserId,
      name,
      isAdmin
    }
  });
}

export async function ensureChannel(slackChannelId: string, name?: string) {
  return prisma.channel.upsert({
    where: { slackChannelId },
    update: {
      ...(name ? { name } : {})
    },
    create: {
      slackChannelId,
      name
    }
  });
}
