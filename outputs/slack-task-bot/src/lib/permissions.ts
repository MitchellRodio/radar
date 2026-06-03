import { config } from "./config";
import { prisma } from "./prisma";

export async function isAdmin(slackUserId: string): Promise<boolean> {
  if (config.adminSlackUserIds.includes(slackUserId)) return true;

  const user = await prisma.user.findUnique({
    where: { slackUserId },
    select: { isAdmin: true, role: true }
  });

  return Boolean(user?.isAdmin || user?.role === "ADMIN");
}

export async function canManageRequest(slackUserId: string, requestId: number): Promise<boolean> {
  if (await isAdmin(slackUserId)) return true;

  const request = await prisma.request.findUnique({
    where: { id: requestId },
    select: {
      ownerSlackUserId: true,
      channelId: true
    }
  });

  if (!request) return false;
  if (request.ownerSlackUserId === slackUserId) return true;

  const channelMember = await prisma.channelMember.findUnique({
    where: { slackChannelId_slackUserId: { slackChannelId: request.channelId, slackUserId } },
    select: { role: true }
  });

  return Boolean(channelMember && (channelMember.role === "CSM" || channelMember.role === "ADMIN"));
}
