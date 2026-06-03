import { Prisma, Request, SplititAutomationJob, SplititMessageSender } from "@prisma/client";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { getSplititAgentSettings } from "./appSettingsService";
import { getRequest, setBlocker, setStatus } from "./requestService";
import { postRequesterUpdate, updateRequesterStatusMessage } from "../slack/notifications";

type RequestWithJob = Request & {
  splititAutomationJob?: SplititAutomationJob | null;
};

type SplititWebhookResponse = {
  status?: "waiting" | "done" | "blocked" | "failed";
  response?: string;
  error?: string;
  sentMessages?: string[];
};

export async function queueSplititAutomation(client: any, requestId: number, actorSlackUserId: string) {
  const request = await prisma.request.findUnique({
    where: { id: requestId },
    include: { splititAutomationJob: true }
  });

  if (!request) return { request: null, job: null, error: "Request not found." };
  if (request.type !== "SPLITIT_WHITELIST") {
    return { request, job: null, error: "This automation only runs for Splitit whitelist requests." };
  }

  const targetEmail = findTargetEmail(request);
  if (!targetEmail) {
    await setBlocker(requestId, actorSlackUserId, "Missing Splitit whitelist target email");
    await client.chat.postMessage({
      channel: actorSlackUserId,
      text: `I need the customer email before I can queue the Splitit agent for ${request.title}.`
    });
    return { request, job: null, error: "Missing customer email." };
  }

  const now = new Date();
  const job = await prisma.splititAutomationJob.upsert({
    where: { requestId },
    update: {
      targetEmail,
      approvedBySlackUserId: actorSlackUserId,
      status: "QUEUED",
      step: "QUEUED",
      error: null,
      nextRunAt: now
    },
    create: {
      requestId,
      targetEmail,
      approvedBySlackUserId: actorSlackUserId,
      csmName: config.SPLITIT_AGENT_CSM_NAME,
      merchantRole: config.SPLITIT_AGENT_MERCHANT_ROLE,
      storeName: config.SPLITIT_AGENT_STORE_NAME,
      merchantEmail: config.SPLITIT_AGENT_MERCHANT_EMAIL,
      nextRunAt: now
    }
  });
  await recordSplititMessage(job.id, "SYSTEM", `Automation queued by <@${actorSlackUserId}> for ${targetEmail}.`, actorSlackUserId);
  await recordSplititMessage(job.id, "SYSTEM", `Plan ready: ${splititPlan(job).map((step) => `${step.waitFor} -> ${step.send}`).join(" | ")}`, actorSlackUserId);

  const updatedRequest = await setStatus(requestId, actorSlackUserId, "CUSTOM", "Splitit agent queued");
  await updateRequesterStatusMessage(client, updatedRequest);
  await prisma.requestUpdate.create({
    data: {
      requestId,
      actorSlackUserId,
      kind: "AUTOMATION_UPDATED",
      message: `Splitit automation queued for ${targetEmail}`
    }
  });

  await client.chat.postMessage({
    channel: updatedRequest.ownerSlackUserId,
    text: `Splitit agent queued for ${updatedRequest.title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*Splitit agent queued*\n` +
            `*Request:* ${escapeMrkdwn(updatedRequest.title)}\n` +
            `*Target email:* ${escapeMrkdwn(targetEmail)}\n` +
            `*Script:* ${escapeMrkdwn(splititMessages(job).join(" -> "))}`
        }
      }
    ]
  });

  return { request: updatedRequest, job, error: null };
}

export async function processDueSplititJobs(client: any) {
  const jobs = await prisma.splititAutomationJob.findMany({
    where: {
      status: { in: ["QUEUED", "RUNNING", "WAITING_ON_SPLITIT"] },
      nextRunAt: { lte: new Date() }
    },
    include: { request: true },
    orderBy: { createdAt: "asc" },
    take: 5
  });

  for (const job of jobs) {
    await processSplititJob(client, job as SplititAutomationJob & { request: Request });
  }
}

export function splititMessages(job: Pick<SplititAutomationJob, "csmName" | "merchantRole" | "storeName" | "merchantEmail" | "riskAcknowledgement" | "targetEmail">) {
  return [
    job.csmName,
    job.merchantRole,
    `${job.storeName} ${job.merchantEmail}`,
    `${job.riskAcknowledgement} ${job.targetEmail}`
  ];
}

export function splititPlan(job: Pick<SplititAutomationJob, "csmName" | "merchantRole" | "storeName" | "merchantEmail" | "riskAcknowledgement" | "targetEmail">) {
  return [
    {
      step: "SENT_NAME",
      waitFor: "Splitit chat is open and asks who is chatting or requests a name",
      send: job.csmName
    },
    {
      step: "SENT_ROLE",
      waitFor: "Splitit asks for account type, role, or whether this is merchant/customer",
      send: job.merchantRole
    },
    {
      step: "SENT_STORE_AND_EMAIL",
      waitFor: "Splitit asks for store name and/or merchant account email",
      send: `${job.storeName} ${job.merchantEmail}`
    },
    {
      step: "SENT_WHITELIST_REQUEST",
      waitFor: "Splitit asks how it can help or is ready for the whitelist request",
      send: `${job.riskAcknowledgement} ${job.targetEmail}`
    }
  ];
}

export async function sendManualSplititMessage(jobId: string, actorSlackUserId: string, body: string) {
  const message = body.trim();
  if (!message) return { job: null, error: "Message cannot be blank." };

  const job = await prisma.splititAutomationJob.findUnique({
    where: { id: jobId },
    include: { request: true }
  });
  if (!job) return { job: null, error: "Splitit chat not found." };
  if (!isLiveSplititJob(job.status)) return { job, error: "This Splitit chat is no longer live." };

  await recordSplititMessage(job.id, "CSM", message, actorSlackUserId);

  const settings = await getSplititAgentSettings();
  if (!settings.webhookUrl) {
    await prisma.splititAutomationJob.update({
      where: { id: job.id },
      data: {
        status: "BLOCKED",
        step: "BLOCKED",
        error: "Splitit agent executor is not configured. Manual message was recorded but not sent."
      }
    });
    await recordSplititMessage(job.id, "SYSTEM", "Manual message recorded, but executor webhook is not configured.", actorSlackUserId);
    return { job, error: "Executor webhook is not configured, so the manual message was recorded but not sent." };
  }

  const response = await callSplititWebhook(job, settings.webhookUrl, settings.webhookSecret, {
    action: "manual_message",
    message
  });
  await applyWebhookResponse(null, job, response, actorSlackUserId);
  return { job, error: null };
}

export function isLiveSplititJob(status: SplititAutomationJob["status"]) {
  return status === "QUEUED" || status === "RUNNING" || status === "WAITING_ON_SPLITIT";
}

async function processSplititJob(client: any, job: SplititAutomationJob & { request: Request }) {
  try {
    await prisma.splititAutomationJob.update({
      where: { id: job.id },
      data: {
        status: "RUNNING",
        attempts: { increment: 1 },
        startedAt: job.startedAt ?? new Date()
      }
    });

    const settings = await getSplititAgentSettings();
    if (!settings.webhookUrl) {
      await blockForMissingExecutor(client, job);
      return;
    }

    const response = await callSplititWebhook(job, settings.webhookUrl, settings.webhookSecret, { action: "run_script" });
    await applyWebhookResponse(client, job, response);
  } catch (error) {
    logger.error({ error, jobId: job.id, requestId: job.requestId }, "Splitit automation job failed");
    await prisma.splititAutomationJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        step: "BLOCKED",
        error: error instanceof Error ? error.message : String(error),
        nextRunAt: new Date(Date.now() + 15 * 60 * 1000)
      }
    });
  }
}

async function callSplititWebhook(
  job: SplititAutomationJob,
  webhookUrl: string,
  webhookSecret: string,
  extra: { action: "run_script" | "manual_message"; message?: string }
): Promise<SplititWebhookResponse> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(webhookSecret ? { "X-Splitit-Agent-Secret": webhookSecret } : {})
    },
    body: JSON.stringify({
      jobId: job.id,
      requestId: job.requestId,
      targetEmail: job.targetEmail,
      messages: splititMessages(job),
      conversationPlan: splititPlan(job),
      action: extra.action,
      message: extra.message,
      splititUrl: "https://splitit.com"
    })
  });

  if (!response.ok) {
    throw new Error(`Splitit executor returned HTTP ${response.status}`);
  }

  return response.json() as Promise<SplititWebhookResponse>;
}

async function applyWebhookResponse(client: any, job: SplititAutomationJob & { request: Request }, response: SplititWebhookResponse, actorSlackUserId?: string) {
  const status = response.status ?? "waiting";
  const responseText = response.response ?? "";
  for (const message of response.sentMessages ?? []) {
    await recordSplititMessage(job.id, "AGENT", message, actorSlackUserId ?? job.approvedBySlackUserId ?? undefined);
  }
  if (responseText) await recordSplititMessage(job.id, "SPLITIT", responseText, actorSlackUserId);

  if (status === "done") {
    const updatedJob = await prisma.splititAutomationJob.update({
      where: { id: job.id },
      data: {
        status: "DONE",
        step: "COMPLETED",
        lastResponse: responseText || "Splitit whitelist request completed.",
        completedAt: new Date()
      }
    });
    const request = await setStatus(job.requestId, job.approvedBySlackUserId ?? job.request.ownerSlackUserId, "DONE");
    if (client) {
      await updateRequesterStatusMessage(client, request);
      await postRequesterUpdate(client, request, job.approvedBySlackUserId ?? job.request.ownerSlackUserId, "Splitit agent completed");
    }
    await recordAutomationUpdate(job.requestId, job.approvedBySlackUserId, `Splitit automation completed: ${updatedJob.lastResponse}`);
    return;
  }

  if (status === "blocked" || status === "failed") {
    const error = response.error || responseText || "Splitit automation blocked.";
    await prisma.splititAutomationJob.update({
      where: { id: job.id },
      data: {
        status: status === "failed" ? "FAILED" : "BLOCKED",
        step: "BLOCKED",
        lastResponse: responseText || null,
        error
      }
    });
    const request = await setBlocker(job.requestId, job.approvedBySlackUserId ?? job.request.ownerSlackUserId, error);
    if (client) {
      await updateRequesterStatusMessage(client, request);
      await client.chat.postMessage({
        channel: request.ownerSlackUserId,
        text: `Splitit agent blocked on ${request.title}: ${error}`
      });
    }
    await recordAutomationUpdate(job.requestId, job.approvedBySlackUserId, `Splitit automation blocked: ${error}`);
    return;
  }

  await prisma.splititAutomationJob.update({
    where: { id: job.id },
    data: {
      status: "WAITING_ON_SPLITIT",
      step: "WAITING_FOR_REPLY",
      lastResponse: responseText || "Submitted to Splitit and waiting for a reply.",
      nextRunAt: new Date(Date.now() + 30 * 60 * 1000)
    }
  });
  const request = await setStatus(job.requestId, job.approvedBySlackUserId ?? job.request.ownerSlackUserId, "CUSTOM", "Waiting on Splitit");
  if (client) await updateRequesterStatusMessage(client, request);
  await recordAutomationUpdate(job.requestId, job.approvedBySlackUserId, responseText || "Splitit automation waiting on Splitit");
}

async function blockForMissingExecutor(client: any, job: SplititAutomationJob & { request: Request }) {
  const plan = splititPlan(job);
  const error = "Splitit agent executor is not configured. Add a Splitit agent webhook URL in dashboard settings.";
  await prisma.splititAutomationJob.update({
    where: { id: job.id },
    data: {
      status: "BLOCKED",
      step: "BLOCKED",
      error,
      lastMessage: plan.map((step) => `${step.waitFor} -> ${step.send}`).join("\n")
    }
  });
  await recordSplititMessage(job.id, "SYSTEM", "Executor missing. No Splitit chat messages were sent.", job.approvedBySlackUserId ?? undefined);

  const request = await setBlocker(job.requestId, job.approvedBySlackUserId ?? job.request.ownerSlackUserId, error);
  await updateRequesterStatusMessage(client, request);
  await client.chat.postMessage({
    channel: request.ownerSlackUserId,
    text: `Splitit agent needs executor config for ${request.title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*Splitit agent blocked: executor missing*\n` +
            `${escapeMrkdwn(error)}\n\n` +
            `*Step-by-step plan:*\n${plan.map((step) => `- Wait for: ${escapeMrkdwn(step.waitFor)}\n  Send: ${escapeMrkdwn(step.send)}`).join("\n")}`
        }
      }
    ]
  });
  await recordAutomationUpdate(job.requestId, job.approvedBySlackUserId, error);
}

export async function recordSplititMessage(jobId: string, sender: SplititMessageSender, body: string, createdBySlackUserId?: string | null) {
  return prisma.splititAutomationMessage.create({
    data: {
      jobId,
      sender,
      body,
      createdBySlackUserId: createdBySlackUserId ?? undefined
    }
  });
}

function findTargetEmail(request: RequestWithJob) {
  const extracted = request.extractedFields as Prisma.JsonObject | null;
  const candidates = [
    ...emailsFromUnknown(extracted),
    ...emailsFromUnknown(request.description),
    ...emailsFromUnknown(request.title)
  ];

  return candidates.find((email) => !email.toLowerCase().endsWith("@whop.com")) ?? candidates[0] ?? null;
}

function emailsFromUnknown(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return extractEmails(value);
  if (Array.isArray(value)) return value.flatMap(emailsFromUnknown);
  if (typeof value === "object") return Object.values(value).flatMap(emailsFromUnknown);
  return [];
}

function extractEmails(value: string) {
  return value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
}

async function recordAutomationUpdate(requestId: number, actorSlackUserId: string | null, message: string) {
  await prisma.requestUpdate.create({
    data: {
      requestId,
      actorSlackUserId: actorSlackUserId ?? undefined,
      kind: "AUTOMATION_UPDATED",
      message
    }
  });
}

function escapeMrkdwn(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
