import { RequestStatus, RequestType } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getChannelOwner } from "./channelOwnerService";
import { analyzeRequestMetadata, parseRequestText } from "./requestParser";
import { ensureChannel, ensureUser } from "./userService";

const includeRelations = {
  requester: true,
  owner: true,
  channel: true,
  notes: { orderBy: { createdAt: "desc" as const } },
  updates: { orderBy: { createdAt: "desc" as const }, take: 10 }
};

export async function createRequestFromSlackMessage(input: {
  text: string;
  requesterSlackUserId: string;
  channelId: string;
  messageTs: string;
  threadTs?: string;
  botUserId?: string;
}) {
  const parsed = parseRequestText(input.text, input.botUserId);
  await ensureUser(input.requesterSlackUserId);
  await ensureChannel(input.channelId);

  const ownerSlackUserId = (await getChannelOwner(input.channelId)) ?? input.requesterSlackUserId;
  await ensureUser(ownerSlackUserId);

  return prisma.request.create({
    data: {
      title: parsed.title,
      description: parsed.description,
      type: parsed.type,
      aiTags: parsed.aiTags,
      intent: parsed.intent,
      extractedFields: parsed.extractedFields,
      suggestedNextStep: parsed.suggestedNextStep,
      confidence: parsed.confidence,
      dueDate: parsed.dueDate,
      requesterSlackUserId: input.requesterSlackUserId,
      ownerSlackUserId,
      channelId: input.channelId,
      messageTs: input.messageTs,
      threadTs: input.threadTs ?? input.messageTs,
      updates: {
        create: {
          actorSlackUserId: input.requesterSlackUserId,
          kind: "CREATED",
          message: "Request created from Slack"
        }
      }
    },
    include: includeRelations
  });
}

export async function createRequestFromManualInput(input: {
  title: string;
  description: string;
  type: RequestType;
  requesterSlackUserId: string;
  channelId: string;
  dueDate?: Date | null;
  blocker?: string | null;
}) {
  await ensureUser(input.requesterSlackUserId);
  await ensureChannel(input.channelId);

  const ownerSlackUserId = (await getChannelOwner(input.channelId)) ?? input.requesterSlackUserId;
  await ensureUser(ownerSlackUserId);

  const aiMetadata = analyzeRequestMetadata(`${input.title}\n${input.description}`, input.type, input.dueDate ?? null);
  const placeholderTs = `manual-${Date.now()}`;
  return prisma.request.create({
    data: {
      title: input.title,
      description: input.description,
      type: input.type,
      aiTags: aiMetadata.aiTags,
      intent: aiMetadata.intent,
      extractedFields: aiMetadata.extractedFields,
      suggestedNextStep: aiMetadata.suggestedNextStep,
      confidence: aiMetadata.confidence,
      dueDate: input.dueDate ?? null,
      blocker: input.blocker?.trim() || null,
      requesterSlackUserId: input.requesterSlackUserId,
      ownerSlackUserId,
      channelId: input.channelId,
      messageTs: placeholderTs,
      threadTs: placeholderTs,
      updates: {
        create: {
          actorSlackUserId: input.requesterSlackUserId,
          kind: "CREATED",
          message: "Request created from Slack modal"
        }
      }
    },
    include: includeRelations
  });
}

export async function updateRequestSlackReference(requestId: number, messageTs: string, threadTs = messageTs) {
  return prisma.request.update({
    where: { id: requestId },
    data: { messageTs, threadTs },
    include: includeRelations
  });
}

export async function updateRequesterMessageReference(requestId: number, channelId: string, messageTs: string) {
  return prisma.request.update({
    where: { id: requestId },
    data: {
      requesterMessageChannelId: channelId,
      requesterMessageTs: messageTs
    },
    include: includeRelations
  });
}

export async function listAssignedOpenRequests(ownerSlackUserId: string) {
  return prisma.request.findMany({
    where: {
      ownerSlackUserId,
      status: { not: "DONE" }
    },
    orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
    include: includeRelations,
    take: 50
  });
}

export async function listAllOpenRequests() {
  return prisma.request.findMany({
    where: { status: { not: "DONE" } },
    orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
    include: includeRelations,
    take: 100
  });
}

export async function getRequest(id: number) {
  return prisma.request.findUnique({
    where: { id },
    include: includeRelations
  });
}

export async function setStatus(requestId: number, actorSlackUserId: string, status: RequestStatus, customStatus?: string) {
  const completedAt = status === "DONE" ? new Date() : null;

  return prisma.request.update({
    where: { id: requestId },
    data: {
      status,
      customStatus: status === "CUSTOM" ? customStatus : null,
      completedAt,
      updates: {
        create: {
          actorSlackUserId,
          kind: "STATUS_CHANGED",
          message: status === "CUSTOM" ? `Status changed to ${customStatus}` : `Status changed to ${status}`
        }
      }
    },
    include: includeRelations
  });
}

export async function setDueDate(requestId: number, actorSlackUserId: string, dueDate: Date | null) {
  return prisma.request.update({
    where: { id: requestId },
    data: {
      dueDate,
      updates: {
        create: {
          actorSlackUserId,
          kind: "DUE_DATE_CHANGED",
          message: dueDate ? `Due date set to ${dueDate.toISOString().slice(0, 10)}` : "Due date cleared"
        }
      }
    },
    include: includeRelations
  });
}

export async function setBlocker(requestId: number, actorSlackUserId: string, blocker: string | null) {
  return prisma.request.update({
    where: { id: requestId },
    data: {
      blocker,
      updates: {
        create: {
          actorSlackUserId,
          kind: "BLOCKER_CHANGED",
          message: blocker ? `Blocker set: ${blocker}` : "Blocker cleared"
        }
      }
    },
    include: includeRelations
  });
}

export async function addInternalNote(requestId: number, actorSlackUserId: string, body: string) {
  await ensureUser(actorSlackUserId);
  return prisma.request.update({
    where: { id: requestId },
    data: {
      notes: {
        create: {
          authorSlackUserId: actorSlackUserId,
          body
        }
      },
      updates: {
        create: {
          actorSlackUserId,
          kind: "NOTE_ADDED",
          message: "Internal note added"
        }
      }
    },
    include: includeRelations
  });
}

export async function reassignRequest(requestId: number, actorSlackUserId: string, ownerSlackUserId: string) {
  await ensureUser(ownerSlackUserId);
  return prisma.request.update({
    where: { id: requestId },
    data: {
      ownerSlackUserId,
      updates: {
        create: {
          actorSlackUserId,
          kind: "REASSIGNED",
          message: `Reassigned to ${ownerSlackUserId}`
        }
      }
    },
    include: includeRelations
  });
}

export async function recordRequesterNotification(requestId: number, actorSlackUserId: string, message: string) {
  return prisma.requestUpdate.create({
    data: {
      requestId,
      actorSlackUserId,
      kind: "REQUESTER_NOTIFIED",
      message
    }
  });
}

export async function markReminderSent(requestId: number) {
  return prisma.request.update({
    where: { id: requestId },
    data: { lastReminderSentAt: new Date() }
  });
}

export async function findRequestsNeedingReminder(now = new Date()) {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);

  return prisma.request.findMany({
    where: {
      status: { not: "DONE" },
      dueDate: { lt: tomorrowStart },
      OR: [
        { lastReminderSentAt: null },
        { lastReminderSentAt: { lt: todayStart } }
      ]
    },
    include: includeRelations
  });
}

export function parseRequestId(value: string): number | null {
  const id = Number(value.trim().replace(/^#/, ""));
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function extractSlackUserId(value: string): string | null {
  return value.match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/)?.[1] ?? value.match(/\bU[A-Z0-9]+\b/)?.[0] ?? null;
}

export function extractSlackChannelId(value: string): string | null {
  return value.match(/<#([A-Z0-9]+)(?:\|[^>]+)?>/)?.[1] ?? value.match(/\bC[A-Z0-9]+\b/)?.[0] ?? null;
}
