import { config } from "./config";
import { prisma } from "./prisma";

export async function isAdmin(slackUserId: string): Promise<boolean> {
  if (config.adminSlackUserIds.includes(slackUserId)) return true;

  const user = await prisma.user.findUnique({
    where: { slackUserId },
    select: { isAdmin: true }
  });

  return Boolean(user?.isAdmin);
}

export async function canManageRequest(slackUserId: string, requestId: number): Promise<boolean> {
  if (await isAdmin(slackUserId)) return true;

  const request = await prisma.request.findUnique({
    where: { id: requestId },
    select: { ownerSlackUserId: true }
  });

  return request?.ownerSlackUserId === slackUserId;
}
