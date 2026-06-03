import { UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";

export async function ensureUser(slackUserId: string, name?: string, isAdmin = false, role?: UserRole) {
  const resolvedRole = role ?? (isAdmin ? "ADMIN" : undefined);
  return prisma.user.upsert({
    where: { slackUserId },
    update: {
      ...(name ? { name } : {}),
      ...(isAdmin ? { isAdmin } : {}),
      ...(resolvedRole ? { role: resolvedRole } : {})
    },
    create: {
      slackUserId,
      name,
      isAdmin,
      role: resolvedRole ?? "REQUESTER"
    }
  });
}

export async function setUserRole(slackUserId: string, role: UserRole, name?: string) {
  return ensureUser(slackUserId, name, role === "ADMIN", role);
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
