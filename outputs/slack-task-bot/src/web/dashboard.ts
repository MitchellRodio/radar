import { createServer, IncomingMessage, ServerResponse } from "http";
import { createHmac, timingSafeEqual } from "crypto";
import { WebClient } from "@slack/web-api";
import type { ChannelBotMode, RequestStatus, RequestType, UserRole } from "@prisma/client";
import { config } from "../lib/config";
import { formatDate, parseDueDate } from "../lib/dates";
import { logger } from "../lib/logger";
import { canManageRequest, isAdmin } from "../lib/permissions";
import { prisma } from "../lib/prisma";
import {
  getOpenAiSettingsStatus,
  getSplititAgentSettings,
  getSplititAgentSettingsStatus,
  getWhopWebhookSettings,
  saveOpenAiSettings,
  saveSplititAgentSettings,
  saveWhopWebhookSettings
} from "../services/appSettingsService";
import { mapChannelOwner } from "../services/channelOwnerService";
import { isKycOnlyChannel, setChannelBotMode } from "../services/channelModeService";
import { deleteChannelWhopBusiness, upsertChannelWhopBusiness } from "../services/channelWhopBusinessService";
import { customerLookupBlocks, lookupCustomerAccount } from "../services/customerLookupService";
import { addChannelPulseNote } from "../services/pulseService";
import { enrichSlackFileAttachments, extractModalFileAttachments } from "../services/slackFileService";
import {
  addInternalNote,
  addRequesterReply,
  createRequestFromManualInput,
  extractSlackChannelId,
  extractSlackUserId,
  getRequest,
  listAllOpenRequests,
  listAssignedOpenRequests,
  parseRequestId,
  reassignRequest,
  setBlocker,
  setDueDate,
  setStatus,
  updateRequesterMessageReference
} from "../services/requestService";
import { ensureChannel, ensureUser } from "../services/userService";
import { isLiveSplititJob, queueSplititAutomation, sendManualSplititMessage } from "../services/splititAutomationService";
import {
  deleteWhopWebhookRoute,
  handleWhopWebhook,
  normalizeEventType,
  setWhopWebhookRouteEnabled,
  upsertWhopWebhookRoute,
  WHOP_WEBHOOK_EVENT_TYPES
} from "../services/whopWebhookService";
import { helpBlocks, inputModal, requesterReplyModal, requestCreateModal, requestDetailModal, requestListBlocks } from "../slack/blocks";
import { statusLabel, typeLabel } from "../slack/format";
import {
  notifyOwnerRequestCreated,
  notifyOwnerRequesterReply,
  postRequesterNeedsInfo,
  postRequesterUpdate,
  sendRequesterEphemeralStatusMessage,
  sendRequesterStatusMessage,
  updateRequesterStatusMessage
} from "../slack/notifications";

const slack = new WebClient(config.SLACK_BOT_TOKEN);

type DashboardChannel = {
  slackChannelId: string;
  name: string | null;
  companyName: string | null;
  botMode: ChannelBotMode;
  ownerSlackUserId: string | null;
  members: DashboardChannelMember[];
  whopBusinesses: DashboardChannelWhopBusiness[];
  openRequests: number;
  totalRequests: number;
};

type DashboardUser = {
  slackUserId: string;
  name: string | null;
  role: UserRole;
};

type DashboardChannelMember = DashboardUser & {
  channelRole: UserRole;
};

type DashboardChannelWhopBusiness = {
  id: string;
  businessId: string;
  businessName: string;
  apiKeyConfigured: boolean;
};

export function startDashboardServer(port: number) {
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (error) {
      logger.error(error, "Dashboard request failed");
      sendHtml(res, 500, page("Dashboard error", "<p>Something went wrong.</p>"));
    }
  });

  server.listen(port, () => {
    logger.info({ port }, "Dashboard server started");
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/") {
    redirect(res, "/dashboard");
    return;
  }

  if (url.pathname === "/health") {
    sendText(res, 200, "ok");
    return;
  }

  if (url.pathname === "/slack/events" && req.method === "POST") {
    await handleSlackHttpRequest(req, res);
    return;
  }

  if (url.pathname === "/whop/webhooks" && req.method === "POST") {
    await handleWhopWebhookRequest(req, res);
    return;
  }

  if (!url.pathname.startsWith("/dashboard")) {
    sendText(res, 404, "Not found");
    return;
  }

  const token = dashboardToken();
  if (!isAuthorized(req, url, token)) {
    renderLogin(res, token);
    return;
  }

  if (url.searchParams.get("token")) {
    res.setHeader("Set-Cookie", `dashboard_token=${encodeURIComponent(url.searchParams.get("token") ?? "")}; Path=/dashboard; HttpOnly; SameSite=Lax; Secure`);
  }

  if (req.method === "GET" && url.pathname === "/dashboard") {
    redirect(res, `/dashboard/pulse${url.search ? url.search : ""}`);
    return;
  }

  if (req.method === "GET" && url.pathname === "/dashboard/metrics") {
    await renderMetrics(res, url.searchParams.get("notice") ?? "");
    return;
  }

  if (req.method === "GET" && url.pathname === "/dashboard/pulse") {
    await renderPulse(res, url.searchParams.get("notice") ?? "", url.searchParams.get("channel") ?? "");
    return;
  }

  if (req.method === "GET" && url.pathname === "/dashboard/channels") {
    await renderChannels(res, url.searchParams.get("notice") ?? "", url.searchParams.get("channel") ?? "");
    return;
  }

  if (req.method === "GET" && url.pathname === "/dashboard/whop") {
    await renderWhop(res, url.searchParams.get("notice") ?? "");
    return;
  }

  if (req.method === "GET" && url.pathname === "/dashboard/whop-events") {
    await renderWhopEvents(res, req, url.searchParams.get("notice") ?? "");
    return;
  }

  if (req.method === "GET" && url.pathname === "/dashboard/splitit") {
    await renderSplitit(res, url.searchParams.get("notice") ?? "", url.searchParams.get("job") ?? "");
    return;
  }

  if (req.method === "GET" && url.pathname === "/dashboard/settings") {
    await renderSettings(res, url.searchParams.get("notice") ?? "");
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/sync") {
    await syncSlackChannels();
    redirect(res, "/dashboard/channels?notice=Channels synced from Slack");
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/settings/openai") {
    const body = await readForm(req);
    await saveOpenAiSettings({
      apiKey: body.get("openaiApiKey")?.toString(),
      model: body.get("openaiModel")?.toString(),
      clearApiKey: body.get("clearOpenAiKey") === "on"
    });
    redirect(res, "/dashboard/settings?notice=OpenAI settings updated");
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/pulse/note") {
    const body = await readForm(req);
    const channelId = body.get("channelId")?.toString().trim() ?? "";
    const authorSlackUserId = normalizeSlackUserId(body.get("authorSlackUserId")?.toString() ?? "") || config.adminSlackUserIds[0] || "dashboard";
    const note = body.get("note")?.toString().trim() ?? "";
    if (channelId && note) {
      await addChannelPulseNote({ slackChannelId: channelId, authorSlackUserId, body: note });
    }
    redirect(res, `/dashboard/pulse?channel=${encodeURIComponent(channelId)}&notice=Pulse note added`);
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/settings/splitit-agent") {
    const body = await readForm(req);
    await saveSplititAgentSettings({
      webhookUrl: body.get("splititWebhookUrl")?.toString(),
      webhookSecret: body.get("splititWebhookSecret")?.toString(),
      clearWebhookSecret: body.get("clearSplititWebhookSecret") === "on"
    });
    redirect(res, "/dashboard/settings?notice=Splitit agent settings updated");
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/whop-events/settings") {
    const body = await readForm(req);
    await saveWhopWebhookSettings({
      webhookSecret: body.get("whopWebhookSecret")?.toString(),
      clearWebhookSecret: body.get("clearWhopWebhookSecret") === "on"
    });
    redirect(res, "/dashboard/whop-events?notice=Whop webhook settings updated");
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/whop-events/routes") {
    const body = await readForm(req);
    const eventType = normalizeEventType(body.get("eventType")?.toString() ?? "");
    const slackChannelId = extractSlackChannelId(body.get("slackChannelId")?.toString() ?? "") || body.get("slackChannelId")?.toString().trim() || "";
    const businessId = body.get("businessId")?.toString().trim() || null;
    if (eventType && slackChannelId) {
      await ensureChannel(slackChannelId);
      await upsertWhopWebhookRoute({ eventType, slackChannelId, businessId, enabled: true });
    }
    redirect(res, "/dashboard/whop-events?notice=Whop event route saved");
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/whop-events/routes/toggle") {
    const body = await readForm(req);
    const routeId = body.get("routeId")?.toString() ?? "";
    const enabled = body.get("enabled") === "true";
    if (routeId) await setWhopWebhookRouteEnabled(routeId, enabled);
    redirect(res, "/dashboard/whop-events?notice=Whop event route updated");
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/whop-events/routes/delete") {
    const body = await readForm(req);
    const routeId = body.get("routeId")?.toString() ?? "";
    if (routeId) await deleteWhopWebhookRoute(routeId);
    redirect(res, "/dashboard/whop-events?notice=Whop event route deleted");
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/splitit/manual-message") {
    const body = await readForm(req);
    const jobId = (body.get("jobId") ?? "").trim();
    const message = (body.get("message") ?? "").trim();
    const actorSlackUserId = (body.get("actorSlackUserId") ?? "").trim() || config.adminSlackUserIds[0] || "dashboard";
    const result = jobId ? await sendManualSplititMessage(jobId, actorSlackUserId, message) : { error: "Missing Splitit job.", job: null };
    const notice = result.error ? result.error : "Manual message sent";
    redirect(res, `/dashboard/splitit?job=${encodeURIComponent(jobId)}&notice=${encodeURIComponent(notice)}`);
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/splitit/delete") {
    const body = await readForm(req);
    const jobId = (body.get("jobId") ?? "").trim();
    if (jobId) await prisma.splititAutomationJob.deleteMany({ where: { id: jobId } });
    redirect(res, "/dashboard/splitit?notice=Splitit chat deleted");
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/splitit/clear-off") {
    await prisma.splititAutomationJob.deleteMany({
      where: { status: { in: ["DONE", "BLOCKED", "FAILED"] } }
    });
    redirect(res, "/dashboard/splitit?notice=Off Splitit chats cleared");
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/splitit/clear-all") {
    await prisma.splititAutomationJob.deleteMany({});
    redirect(res, "/dashboard/splitit?notice=All Splitit chats cleared");
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/channel-member-role") {
    const body = await readForm(req);
    const channelId = (body.get("channelId") ?? "").trim();
    const slackUserId = normalizeSlackUserId(body.get("slackUserId") ?? "");
    const role = normalizeUserRole(body.get("role") ?? "");
    if (channelId && slackUserId && role) {
      await ensureNamedUser(slackUserId);
      await prisma.channelMember.upsert({
        where: { slackChannelId_slackUserId: { slackChannelId: channelId, slackUserId } },
        update: { role },
        create: { slackChannelId: channelId, slackUserId, role }
      });
    }
    redirect(res, `/dashboard/channels?channel=${encodeURIComponent(channelId)}&notice=Channel role updated`);
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/channel-bot-mode") {
    const body = await readForm(req);
    const channelId = (body.get("channelId") ?? "").trim();
    const botMode = normalizeChannelBotMode(body.get("botMode") ?? "");
    if (channelId && botMode) {
      await setChannelBotMode(channelId, botMode);
    }
    redirect(res, `/dashboard/channels?channel=${encodeURIComponent(channelId)}&notice=Channel bot mode updated`);
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/channel-owner") {
    const body = await readForm(req);
    const channelId = (body.get("channelId") ?? "").trim();
    const ownerSlackUserId = normalizeSlackUserId(body.get("ownerSlackUserId") ?? "");
    await ensureNamedUser(ownerSlackUserId);
    if (channelId && ownerSlackUserId) {
      await mapChannelOwner(channelId, ownerSlackUserId);
      await prisma.channelMember.upsert({
        where: { slackChannelId_slackUserId: { slackChannelId: channelId, slackUserId: ownerSlackUserId } },
        update: { role: "CSM" },
        create: { slackChannelId: channelId, slackUserId: ownerSlackUserId, role: "CSM" }
      });
    }
    redirect(res, `/dashboard/channels?channel=${encodeURIComponent(channelId)}&notice=Channel owner updated`);
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/channel-whop-business") {
    const body = await readForm(req);
    const channelId = (body.get("channelId") ?? "").toString().trim();
    const businessId = (body.get("businessId") ?? "").toString().trim();
    const businessName = (body.get("businessName") ?? "").toString().trim();
    const apiKey = (body.get("apiKey") ?? "").toString().trim();
    if (channelId && businessId && businessName) {
      await upsertChannelWhopBusiness({ slackChannelId: channelId, businessId, businessName, apiKey });
    }
    redirect(res, safeReturnPath(body.get("returnTo")?.toString(), `/dashboard/channels?channel=${encodeURIComponent(channelId)}&notice=Whop business mapping saved`));
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/channel-whop-business/delete") {
    const body = await readForm(req);
    const channelId = (body.get("channelId") ?? "").toString().trim();
    const businessMappingId = (body.get("businessMappingId") ?? "").toString().trim();
    if (businessMappingId) await deleteChannelWhopBusiness(businessMappingId);
    redirect(res, safeReturnPath(body.get("returnTo")?.toString(), `/dashboard/channels?channel=${encodeURIComponent(channelId)}&notice=Whop business mapping removed`));
    return;
  }

  sendText(res, 404, "Not found");
}

async function handleSlackHttpRequest(req: IncomingMessage, res: ServerResponse) {
  const rawBody = await readBody(req);

  if (!isValidSlackSignature(req, rawBody)) {
    logger.warn("Rejected Slack HTTP request with invalid signature");
    sendText(res, 401, "Invalid signature");
    return;
  }

  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    const payload = JSON.parse(rawBody || "{}");
    if (payload.type === "url_verification" && payload.challenge) {
      sendText(res, 200, payload.challenge);
      return;
    }
    sendText(res, 200, "ok");
    return;
  }

  const body = new URLSearchParams(rawBody);
  if (body.get("ssl_check") === "1") {
    sendText(res, 200, "ok");
    return;
  }

  const interactivePayload = body.get("payload");
  if (interactivePayload) {
    await handleSlackInteraction(JSON.parse(interactivePayload), res);
    return;
  }

  const command = body.get("command") ?? "";
  const userId = body.get("user_id") ?? "";
  const channelId = body.get("channel_id") ?? "";
  const text = body.get("text")?.trim() ?? "";

  try {
    switch (command) {
      case "/request": {
        const kycOnly = await isKycOnlyChannel(channelId);
        await slack.views.open({
          trigger_id: body.get("trigger_id") ?? "",
          view: requestCreateModal({ channelId, initialDescription: text, kycOnly }) as any
        });
        sendText(res, 200, "");
        return;
      }

      case "/customer-lookup": {
        if (await isKycOnlyChannel(channelId)) {
          sendSlackJson(res, {
            response_type: "ephemeral",
            text: "This channel is in KYC-only mode. Use `/request` to create or update KYC issues."
          });
          return;
        }

        const email = extractEmail(text);
        if (!email) {
          sendSlackJson(res, { response_type: "ephemeral", text: "Usage: `/customer-lookup customer@example.com`" });
          return;
        }

        const lookup = await lookupCustomerAccount({ channelId, email });
        sendSlackJson(res, {
          response_type: "ephemeral",
          text: `Customer lookup: ${email}`,
          blocks: customerLookupBlocks(lookup)
        });
        return;
      }

      case "/my-requests": {
        const requests = await listAssignedOpenRequests(userId);
        sendSlackJson(res, { response_type: "ephemeral", blocks: requestListBlocks(requests, "My open requests") });
        return;
      }

      case "/all-requests": {
        if (!(await isAdmin(userId))) {
          logger.warn({ userId }, "Non-admin used /all-requests over HTTP; allowing for MVP visibility");
        }
        const requests = await listAllOpenRequests();
        sendSlackJson(res, { response_type: "ephemeral", blocks: requestListBlocks(requests, "All open requests") });
        return;
      }

      case "/request-map-channel": {
        if (!(await isAdmin(userId))) {
          sendSlackJson(res, { response_type: "ephemeral", text: "Only admins can map channel ownership." });
          return;
        }

        const [channelArg, ownerArg] = text.split(/\s+/);
        const mappedChannelId = extractSlackChannelId(channelArg ?? "");
        const ownerSlackUserId = extractSlackUserId(ownerArg ?? "");

        if (!mappedChannelId || !ownerSlackUserId) {
          sendSlackJson(res, { response_type: "ephemeral", text: "Usage: `/request-map-channel C123456 <@U123456>`" });
          return;
        }

        await mapChannelOwner(mappedChannelId, ownerSlackUserId);
        sendSlackJson(res, { response_type: "ephemeral", text: `Mapped <#${mappedChannelId}> to <@${ownerSlackUserId}>.` });
        return;
      }

      case "/request-reassign": {
        const [requestArg, ownerArg] = text.split(/\s+/);
        const requestId = parseRequestId(requestArg ?? "");
        const ownerSlackUserId = extractSlackUserId(ownerArg ?? "");

        if (!requestId || !ownerSlackUserId) {
          sendSlackJson(res, { response_type: "ephemeral", text: "Usage: `/request-reassign 123 <@U123456>`" });
          return;
        }

        if (!(await isAdmin(userId))) {
          sendSlackJson(res, {
            response_type: "ephemeral",
            text: "Only admins can reassign from this slash command. CSMs can reassign from the request detail view."
          });
          return;
        }

        await reassignRequest(requestId, userId, ownerSlackUserId);
        sendSlackJson(res, { response_type: "ephemeral", text: `Request ${requestId} reassigned to <@${ownerSlackUserId}>.` });
        return;
      }

      case "/request-help": {
        sendSlackJson(res, { response_type: "ephemeral", blocks: helpBlocks() });
        return;
      }

      default:
        sendSlackJson(res, { response_type: "ephemeral", text: "Unknown request command. Try `/request-help`." });
        return;
    }
  } catch (error) {
    logger.error({ error, command }, "Failed to handle Slack HTTP slash command");
    sendSlackJson(res, { response_type: "ephemeral", text: "Sorry, I could not handle that command." });
  }
}

async function handleWhopWebhookRequest(req: IncomingMessage, res: ServerResponse) {
  const bodyText = await readBody(req);
  try {
    await handleWhopWebhook({ bodyText, headers: req.headers, slack });
    sendText(res, 200, "ok");
  } catch (error) {
    logger.error({ error }, "Failed to handle Whop webhook");
    sendText(res, 400, "invalid webhook");
  }
}

async function handleSlackInteraction(payload: any, res: ServerResponse) {
  try {
    if (payload.type === "block_actions") {
      await handleSlackBlockAction(payload, res);
      return;
    }

    if (payload.type === "view_submission") {
      await handleSlackViewSubmission(payload, res);
      return;
    }

    sendText(res, 200, "");
  } catch (error) {
    logger.error({ error, payloadType: payload?.type }, "Failed to handle Slack interaction over HTTP");
    sendText(res, 200, "");
  }
}

async function handleSlackBlockAction(payload: any, res: ServerResponse) {
  const action = payload.actions?.[0];
  const actionId = action?.action_id;
  const [valueIdPart] = String(action?.value ?? "").split(":");
  const requestId = parseRequestId(valueIdPart);
  const actorSlackUserId = payload.user?.id;

  if (actionId === "request_close_view") {
    sendSlackJson(res, { response_action: "clear" });
    return;
  }

  sendText(res, 200, "");

  if (!actionId || !actorSlackUserId) return;

  if (actionId === "request_view" || actionId === "owner_request_view") {
    const request = requestId ? await getRequest(requestId) : null;
    if (!request) return;
    await slack.views.open({ trigger_id: payload.trigger_id, view: requestDetailModal(request) as any });
    return;
  }

  if (actionId === "requester_add_info_open") {
    const request = requestId ? await getRequest(requestId) : null;
    if (!request || request.requesterSlackUserId !== actorSlackUserId) return;
    await slack.views.open({ trigger_id: payload.trigger_id, view: requesterReplyModal(request.id) as any });
    return;
  }

  if (!requestId || !(await canManageRequest(actorSlackUserId, requestId))) return;

  if (isStatusActionId(actionId)) {
    const [idPart, statusPart] = action.value.split(":");
    const statusRequestId = parseRequestId(idPart);
    if (!statusRequestId) return;

    const request = await setStatus(statusRequestId, actorSlackUserId, statusPart as RequestStatus);
    await updateRequesterStatusMessage(slack, request);
    if (statusPart === "DONE") await postRequesterUpdate(slack, request, actorSlackUserId);
    await updateCurrentSlackModal(payload, request);
    return;
  }

  if (actionId === "request_custom_status_open") {
    await openInput(payload.trigger_id, `request_custom_status:${requestId}`, "Custom status", "Status", "", false);
    return;
  }

  if (actionId === "request_due_date_open") {
    await openInput(payload.trigger_id, `request_due_date:${requestId}`, "Due date", "Date, yyyy-mm-dd", "", false);
    return;
  }

  if (actionId === "request_blocker_open") {
    const request = await getRequest(requestId);
    await openInput(payload.trigger_id, `request_blocker:${requestId}`, "Blocker", "Blocker, blank to clear", request?.blocker ?? "", true);
    return;
  }

  if (actionId === "request_note_open") {
    await openInput(payload.trigger_id, `request_note:${requestId}`, "Internal note", "Note", "", true);
    return;
  }

  if (actionId === "request_reassign_open") {
    await openInput(payload.trigger_id, `request_reassign:${requestId}`, "Reassign CSM", "CSM Slack user ID or mention", "", false);
    return;
  }

  if (actionId === "request_needs_info_open") {
    await openInput(payload.trigger_id, `request_needs_info:${requestId}`, "Need info", "Message to requester", "", true);
    return;
  }

  if (actionId === "request_notify_requester") {
    const request = await getRequest(requestId);
    if (!request) return;
    await updateRequesterStatusMessage(slack, request);
    await postRequesterUpdate(slack, request, actorSlackUserId);
    await updateCurrentSlackModal(payload, request);
    return;
  }

  if (actionId === "request_splitit_agent_queue") {
    const result = await queueSplititAutomation(slack, requestId, actorSlackUserId);
    const request = result.request ? await getRequest(requestId) : null;
    if (request) await updateCurrentSlackModal(payload, request);
  }
}

async function handleSlackViewSubmission(payload: any, res: ServerResponse) {
  const view = payload.view;
  const callbackId = view?.callback_id ?? "";
  const actorSlackUserId = payload.user?.id;

  if (!actorSlackUserId) {
    sendText(res, 200, "");
    return;
  }

  if (callbackId === "request_create") {
    const title = modalValue(view, "title").trim();
    const description = modalValue(view, "description").trim();
    const type = modalSelectedValue(view, "type") as RequestType;

    const errors: Record<string, string> = {};
    if (!title) errors.title = "Add a short title.";
    if (!description) errors.description = "Add request details.";

    if (Object.keys(errors).length) {
      sendSlackJson(res, { response_action: "errors", errors });
      return;
    }

    sendText(res, 200, "");

    const metadata = JSON.parse(view.private_metadata || "{}");
    const channelId = metadata.channelId;
    if (!channelId) throw new Error("Missing channel ID in request_create metadata");
    const kycOnly = await isKycOnlyChannel(channelId);
    const attachments = await enrichSlackFileAttachments(slack, extractModalFileAttachments(view, "screenshots"));

    const request = await createRequestFromManualInput({
      title,
      description,
      type: kycOnly ? "KYC_KYB" : type || "OTHER",
      requesterSlackUserId: actorSlackUserId,
      channelId,
      dueDate: null,
      blocker: null,
      attachments
    });

    const result = await sendRequesterStatusMessage(slack, request);
    if (result.channel && result.ts) {
      const updatedRequest = await updateRequesterMessageReference(request.id, result.channel, result.ts);
      await sendRequesterEphemeralStatusMessage(slack, updatedRequest);
      await notifyOwnerRequestCreated(slack, updatedRequest);
    } else {
      await sendRequesterEphemeralStatusMessage(slack, request);
      await notifyOwnerRequestCreated(slack, request);
    }
    return;
  }

  if (callbackId.startsWith("request_custom_status:")) {
    await handleSlackInputSubmission(res, payload, async (requestId, value) => setStatus(requestId, actorSlackUserId, "CUSTOM", value.trim()), updateRequesterStatusMessage);
    return;
  }

  if (callbackId.startsWith("request_due_date:")) {
    const value = modalValue(view, "input").trim();
    const dueDate = value ? parseDueDate(value) : null;
    if (value && !dueDate) {
      sendSlackJson(res, { response_action: "errors", errors: { input: "Use yyyy-mm-dd or mm/dd/yyyy." } });
      return;
    }

    await handleSlackInputSubmission(res, payload, async (requestId) => setDueDate(requestId, actorSlackUserId, dueDate), updateRequesterStatusMessage);
    return;
  }

  if (callbackId.startsWith("request_blocker:")) {
    await handleSlackInputSubmission(res, payload, async (requestId, value) => setBlocker(requestId, actorSlackUserId, value.trim() || null));
    return;
  }

  if (callbackId.startsWith("request_note:")) {
    await handleSlackInputSubmission(res, payload, async (requestId, value) => addInternalNote(requestId, actorSlackUserId, value.trim()));
    return;
  }

  if (callbackId.startsWith("request_reassign:")) {
    const ownerSlackUserId = extractSlackUserId(modalValue(view, "input"));
    if (!ownerSlackUserId) {
      sendSlackJson(res, { response_action: "errors", errors: { input: "Enter a Slack user mention or user ID." } });
      return;
    }
    await handleSlackInputSubmission(res, payload, async (requestId) => reassignRequest(requestId, actorSlackUserId, ownerSlackUserId));
    return;
  }

  if (callbackId.startsWith("request_needs_info:")) {
    await handleSlackInputSubmission(res, payload, async (requestId, value) => {
      const request = await setStatus(requestId, actorSlackUserId, "CUSTOM", "Waiting on customer");
      await updateRequesterStatusMessage(slack, request);
      await postRequesterNeedsInfo(slack, request, actorSlackUserId, value.trim());
      return request;
    });
    return;
  }

  if (callbackId.startsWith("requester_add_info:")) {
    const requestId = parseRequestId(callbackId.split(":")[1]);
    const value = modalValue(view, "input").trim();
    if (!value) {
      sendSlackJson(res, { response_action: "errors", errors: { input: "Add a short update." } });
      return;
    }

    const request = requestId ? await getRequest(requestId) : null;
    if (!request || request.requesterSlackUserId !== actorSlackUserId) {
      sendText(res, 200, "");
      return;
    }

    const updatedRequest = await addRequesterReply(request.id, actorSlackUserId, value);
    await notifyOwnerRequesterReply(slack, updatedRequest, value);
    sendText(res, 200, "");
    return;
  }

  sendText(res, 200, "");
}

async function handleSlackInputSubmission(
  res: ServerResponse,
  payload: any,
  update: (requestId: number, value: string) => Promise<any | null>,
  afterUpdate?: (client: any, request: any) => Promise<void>
) {
  const requestId = parseRequestId(payload.view.callback_id.split(":")[1]);
  const actorSlackUserId = payload.user?.id;
  const value = modalValue(payload.view, "input");

  if (!requestId || !actorSlackUserId || !(await canManageRequest(actorSlackUserId, requestId))) {
    sendText(res, 200, "");
    return;
  }

  try {
    const request = await update(requestId, value);
    if (!request) {
      sendText(res, 200, "");
      return;
    }
    if (afterUpdate) await afterUpdate(slack, request);
    sendSlackJson(res, { response_action: "update", view: requestDetailModal(request) });
  } catch (error) {
    logger.error(error, "Failed to submit request modal over HTTP");
    sendSlackJson(res, { response_action: "errors", errors: { input: "Could not save this update." } });
  }
}

async function openInput(triggerId: string, callbackId: string, title: string, label: string, initialValue: string, multiline: boolean) {
  await slack.views.push({
    trigger_id: triggerId,
    view: inputModal(callbackId, title, label, initialValue, multiline) as any
  });
}

async function updateCurrentSlackModal(payload: any, request: any) {
  if (!payload.view?.id) return;
  await slack.views.update({
    view_id: payload.view.id,
    view: requestDetailModal(request) as any
  });
}

async function renderMetrics(res: ServerResponse, notice: string) {
  const [channels, requestStats] = await Promise.all([loadChannels(), loadRequestStats()]);
  const channelOperators = channelOperatorCount(channels);

  sendHtml(
    res,
    200,
    page(
      "Radar Metrics",
      `
      ${nav("metrics")}
      <section class="hero">
        <div>
          <p class="eyebrow">Immediate metrics</p>
          <h1>Request pulse</h1>
          <p class="muted">A quick view of request volume, status mix, and channels with the most active work.</p>
        </div>
        <a class="button-link" href="/dashboard/channels">Manage channels</a>
      </section>
      ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
      <section class="stat-grid">
        ${statCard("Known channels", channels.length)}
        ${statCard("Assigned channels", channels.filter((channel) => channel.ownerSlackUserId).length)}
        ${statCard("Channel operators", channelOperators)}
        ${statCard("Open requests", requestStats.openRequests)}
        ${statCard("Done requests", requestStats.doneRequests)}
        ${statCard("Waiting on customer", requestStats.waitingOnCustomer)}
      </section>
      <section class="grid">
        <div class="panel">
          <div class="panel-head">
            <h2>Status mix</h2>
            <span class="muted">All time</span>
          </div>
          ${metricList(requestStats.statusCounts)}
        </div>
        <div class="panel">
          <div class="panel-head">
            <h2>Request types</h2>
            <span class="muted">All time</span>
          </div>
          ${metricList(requestStats.typeCounts)}
        </div>
      </section>
      <section class="grid">
        <div class="panel">
          <div class="panel-head">
            <h2>Top open channels</h2>
            <span class="muted">By open request count</span>
          </div>
          ${metricList(channels.filter((channel) => channel.openRequests > 0).sort((a, b) => b.openRequests - a.openRequests).slice(0, 8).map((channel) => ({
            label: channel.companyName ?? channel.name ?? channel.slackChannelId,
            value: channel.openRequests
          })))}
        </div>
        <div class="panel">
          <div class="panel-head">
            <h2>Recent requests</h2>
            <span class="muted">Latest 10</span>
          </div>
          ${recentRequests(requestStats.recentRequests)}
        </div>
      </section>
      `
    )
  );
}

async function renderPulse(res: ServerResponse, notice: string, selectedChannelId: string) {
  const pulseChannels = await loadPulseChannels();
  const selected = selectedChannelId
    ? pulseChannels.find((channel) => channel.slackChannelId === selectedChannelId) ?? pulseChannels[0] ?? null
    : pulseChannels[0] ?? null;
  const highRisk = pulseChannels.filter((channel) => (channel.pulse?.riskScore ?? 0) >= 65).length;
  const attentionMessages = pulseChannels.reduce((sum, channel) => sum + channel.messageInsights.filter((insight) => insight.needsAttention).length, 0);

  sendHtml(
    res,
    200,
    page(
      "Radar Pulse",
      `
      ${nav("pulse")}
      <section class="hero">
        <div>
          <p class="eyebrow">Customer health</p>
          <h1>Pulse</h1>
          <p class="muted">Every customer-channel message is analyzed for blockers, dissatisfaction, churn language, and the next CSM move.</p>
        </div>
        <a class="button-link secondary" href="/dashboard/settings">AI settings</a>
      </section>
      ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
      <section class="stat-grid splitit-stats">
        ${statCard("Tracked channels", pulseChannels.length)}
        ${statCard("High risk", highRisk)}
        ${statCard("Needs attention", attentionMessages)}
      </section>
      <section class="pulse-layout">
        <div class="panel pulse-sidebar">
          <div class="panel-head">
            <h2>Accounts</h2>
            <span class="muted">Sorted by risk</span>
          </div>
          <div class="pulse-account-list">
            ${pulseChannels.length ? pulseChannels.map((channel) => pulseAccountCard(channel, selected?.slackChannelId ?? "")).join("") : `<p class="muted">No Pulse data yet. Messages will appear here after Slack activity.</p>`}
          </div>
        </div>
        <div class="pulse-detail">
          ${selected ? pulseDetail(selected) : `<section class="panel"><p class="muted">No Pulse data yet.</p></section>`}
        </div>
      </section>
      `
    )
  );
}

async function renderChannels(res: ServerResponse, notice: string, selectedChannelId: string) {
  const channels = await loadChannels();
  const selectedChannel = selectedChannelId
    ? channels.find((channel) => channel.slackChannelId === selectedChannelId) ?? null
    : null;
  const channelOperators = new Set<string>();
  channels.forEach((channel) => channel.members.forEach((member) => {
    if (isChannelOperator(member)) channelOperators.add(member.slackUserId);
  }));

  sendHtml(
    res,
    200,
    page(
      "Radar Dashboard",
      `
      ${nav("channels")}
      <section class="hero">
        <div>
          <p class="eyebrow">Workspace map</p>
          <h1>Channel ownership</h1>
          <p class="muted">Sync Slack channels, then manage owners, roles, and Whop businesses inside each customer channel.</p>
        </div>
        <form method="post" action="/dashboard/sync">
          <button type="submit">Sync Slack channels</button>
        </form>
      </section>
      ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
      <section class="grid">
        <div class="panel stat-row">
          <div>
            <span class="stat">${channels.length}</span>
            <span class="muted">channels</span>
          </div>
          <div>
            <span class="stat">${channelOperators.size}</span>
            <span class="muted">channel operators</span>
          </div>
          <div>
            <span class="stat">${channels.reduce((sum, channel) => sum + channel.whopBusinesses.length, 0)}</span>
            <span class="muted">Whop businesses</span>
          </div>
          <div>
            <span class="stat">${channels.reduce((sum, channel) => sum + channel.openRequests, 0)}</span>
            <span class="muted">open requests</span>
          </div>
        </div>
      </section>
      ${selectedChannel ? channelMemberPanel(selectedChannel) : ""}
      <section class="panel">
        <div class="panel-head">
          <h2>Channels</h2>
          <span class="muted">Open a channel to assign owner, member roles, and Whop biz IDs.</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Slack ID</th>
                <th>Mode</th>
                <th>Owner</th>
                <th>Members</th>
                <th>Whop biz</th>
                <th>Open</th>
                <th>Total</th>
                <th>Manage</th>
              </tr>
            </thead>
            <tbody>
              ${channels.map((channel) => channelRow(channel)).join("")}
            </tbody>
          </table>
        </div>
      </section>
      `
    )
  );
}

async function renderSettings(res: ServerResponse, notice: string) {
  const [openAi, splititAgent] = await Promise.all([getOpenAiSettingsStatus(), getSplititAgentSettingsStatus()]);

  sendHtml(
    res,
    200,
    page(
      "Radar Settings",
      `
      ${nav("settings")}
      <section class="hero">
        <div>
          <p class="eyebrow">Controls</p>
          <h1>Settings</h1>
          <p class="muted">Manage AI enrichment. Channel roles live in the Channels area so they stay scoped to each customer channel.</p>
        </div>
      </section>
      ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
      <section class="grid">
        <div class="panel">
          <div class="panel-head">
            <h2>OpenAI</h2>
            <span class="pill ${openAi.configured ? "ok" : ""}">${openAi.configured ? `Configured via ${openAi.source}` : "Not configured"}</span>
          </div>
          <form class="stack" method="post" action="/dashboard/settings/openai">
            <label>API key
              <input name="openaiApiKey" type="password" placeholder="${openAi.configured ? "Leave blank to keep current key" : "sk-..."}" />
            </label>
            <label>Model
              <input name="openaiModel" value="${escapeHtml(openAi.model)}" />
            </label>
            <label class="check-row">
              <input name="clearOpenAiKey" type="checkbox" />
              <span>Clear dashboard-saved key</span>
            </label>
            <button type="submit">Save AI settings</button>
          </form>
        </div>
        <div class="panel settings-note">
          <div class="panel-head">
            <h2>Splitit agent</h2>
            <span class="pill ${splititAgent.configured ? "ok" : ""}">${splititAgent.configured ? `Configured via ${splititAgent.source}` : "Not configured"}</span>
          </div>
          <form class="stack" method="post" action="/dashboard/settings/splitit-agent">
            <label>Executor webhook URL
              <input name="splititWebhookUrl" placeholder="https://..." />
            </label>
            <label>Webhook secret
              <input name="splititWebhookSecret" type="password" placeholder="Leave blank to keep current secret" />
            </label>
            <label class="check-row">
              <input name="clearSplititWebhookSecret" type="checkbox" />
              <span>Clear dashboard-saved secret</span>
            </label>
            <button type="submit">Save Splitit agent</button>
          </form>
        </div>
      </section>
      <section class="panel settings-note">
        <h2>Roles moved to channels</h2>
        <p class="muted">Use the Channels page to set a member as CSM, sales rep, admin, or requester for that channel only.</p>
        <a class="button-link" href="/dashboard/channels">Manage channel roles</a>
      </section>
      `
    )
  );
}

async function renderWhop(res: ServerResponse, notice: string) {
  const channels = await loadChannels();
  const mappedBusinessCount = channels.reduce((sum, channel) => sum + channel.whopBusinesses.length, 0);
  const channelsWithBusinesses = channels.filter((channel) => channel.whopBusinesses.length > 0).length;
  const businessesWithKeys = channels.reduce((sum, channel) => sum + channel.whopBusinesses.filter((business) => business.apiKeyConfigured).length, 0);

  sendHtml(
    res,
    200,
    page(
      "Radar Whop",
      `
      ${nav("whop")}
      <section class="hero">
        <div>
          <p class="eyebrow">Checkout link setup</p>
          <h1>Whop businesses</h1>
          <p class="muted">Map each customer Slack channel to one or more Whop businesses, with the API key for that exact business.</p>
        </div>
        <form method="post" action="/dashboard/sync">
          <button type="submit">Sync Slack channels</button>
        </form>
      </section>
      ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
      <section class="grid single-grid">
        <div class="panel stat-row">
          <div>
            <span class="stat">${channels.length}</span>
            <span class="muted">channels</span>
          </div>
          <div>
            <span class="stat">${channelsWithBusinesses}</span>
            <span class="muted">mapped channels</span>
          </div>
          <div>
            <span class="stat">${mappedBusinessCount}</span>
            <span class="muted">business IDs</span>
          </div>
          <div>
            <span class="stat">${businessesWithKeys}</span>
            <span class="muted">keys configured</span>
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head">
          <h2>Channel business mappings</h2>
          <span class="muted">Add the biz name, biz ID, and API key for the specific business.</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Current businesses</th>
                <th>Add business</th>
              </tr>
            </thead>
            <tbody>
              ${channels.map((channel) => whopChannelRow(channel)).join("")}
            </tbody>
          </table>
        </div>
      </section>
      `
    )
  );
}

async function renderWhopEvents(res: ServerResponse, req: IncomingMessage, notice: string) {
  const [settings, routes, deliveries] = await Promise.all([
    getWhopWebhookSettings(),
    loadWhopWebhookRoutes(),
    loadWhopWebhookDeliveries()
  ]);
  const webhookUrl = `${dashboardBaseUrl(req)}/whop/webhooks`;
  const enabledRoutes = routes.filter((route) => route.enabled).length;

  sendHtml(
    res,
    200,
    page(
      "Radar Whop Events",
      `
      ${nav("whop-events")}
      <section class="hero">
        <div>
          <p class="eyebrow">CSM event routing</p>
          <h1>Whop event router</h1>
          <p class="muted">Route exact Whop webhook events into specific customer Slack channels. This page is dashboard-side so sales reps do not configure event routing.</p>
        </div>
      </section>
      ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
      <section class="stat-grid splitit-stats">
        ${statCard("Routes", routes.length)}
        ${statCard("Enabled", enabledRoutes)}
        ${statCard("Deliveries", deliveries.length)}
      </section>
      <section class="grid">
        <div class="panel">
          <div class="panel-head">
            <h2>Webhook setup</h2>
            <span class="pill ${settings.webhookSecret ? "ok" : ""}">${settings.webhookSecret ? `Secret via ${settings.source}` : "No secret"}</span>
          </div>
          <div class="stack">
            <label>Webhook URL
              <input readonly value="${escapeHtml(webhookUrl)}" />
            </label>
            <form class="stack" method="post" action="/dashboard/whop-events/settings">
              <label>Webhook secret
                <input name="whopWebhookSecret" type="password" placeholder="${settings.webhookSecret ? "Leave blank to keep current secret" : "Paste Whop webhook secret"}" />
              </label>
              <label class="check-row">
                <input name="clearWhopWebhookSecret" type="checkbox" />
                <span>Clear dashboard-saved secret</span>
              </label>
              <button type="submit">Save webhook secret</button>
            </form>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head">
            <h2>Add route</h2>
            <span class="muted">Pick the exact event to send</span>
          </div>
          <form class="stack" method="post" action="/dashboard/whop-events/routes">
            <label>Slack channel ID
              <input name="slackChannelId" placeholder="C0123456789 or #channel" />
            </label>
            <label>Whop event
              <select name="eventType">
                ${WHOP_WEBHOOK_EVENT_TYPES.map((eventType) => `<option value="${escapeHtml(eventType)}">${escapeHtml(eventType)}</option>`).join("")}
              </select>
            </label>
            <label>Business ID filter (optional)
              <input name="businessId" placeholder="biz_...; blank means any business for that event" />
            </label>
            <button type="submit">Create route</button>
          </form>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head">
          <h2>Active routing rules</h2>
          <span class="muted">Only enabled routes post to Slack</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Slack channel</th>
                <th>Business filter</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${routes.length ? routes.map(whopRouteRow).join("") : `<tr><td colspan="5" class="muted">No routes yet.</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head">
          <h2>Recent deliveries</h2>
          <span class="muted">Webhook delivery history and route status</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>Business</th>
                <th>Routed channel</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${deliveries.length ? deliveries.map(whopDeliveryRow).join("") : `<tr><td colspan="5" class="muted">No deliveries yet.</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
      `
    )
  );
}

async function renderSplitit(res: ServerResponse, notice: string, selectedJobId: string) {
  const [jobs, splititSettings] = await Promise.all([loadSplititJobs(), getSplititAgentSettings()]);
  const selectedJob = selectedJobId
    ? jobs.find((job) => job.id === selectedJobId) ?? jobs[0] ?? null
    : jobs[0] ?? null;
  const liveJobs = jobs.filter((job) => isLiveSplititJob(job.status)).length;
  const browserViewUrl = selectedJob ? splititBrowserViewUrl(splititSettings.webhookUrl, splititSettings.webhookSecret, selectedJob.id) : "";

  sendHtml(
    res,
    200,
    page(
      "Radar Splitit",
      `
      ${nav("splitit")}
      <section class="hero">
        <div>
          <p class="eyebrow">Splitit agent desk</p>
          <h1>Live Splitit chats</h1>
          <p class="muted">Watch concurrent Splitit whitelist sessions, review the full transcript, and manually send a message when you need to take over.</p>
        </div>
        <div class="hero-actions">
          <form method="post" action="/dashboard/splitit/clear-off">
            <button type="submit" class="secondary-button">Clear off agents</button>
          </form>
          <form method="post" action="/dashboard/splitit/clear-all">
            <button type="submit" class="danger-button">Clear all</button>
          </form>
          <a class="button-link secondary" href="/dashboard/settings">Agent settings</a>
        </div>
      </section>
      ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
      <section class="stat-grid splitit-stats">
        ${statCard("All Splitit chats", jobs.length)}
        ${statCard("Live agents", liveJobs)}
        ${statCard("Off or done", jobs.length - liveJobs)}
      </section>
      <section class="splitit-layout">
        <div class="panel">
          <div class="panel-head">
            <h2>Concurrent chats</h2>
            <span class="muted">${liveJobs} live</span>
          </div>
          <div class="splitit-chat-list">
            ${jobs.length ? jobs.map((job) => splititJobCard(job, selectedJob?.id ?? "")).join("") : `<p class="muted">No Splitit chats yet.</p>`}
          </div>
        </div>
        <div class="panel splitit-detail">
          ${selectedJob ? splititJobDetail(selectedJob, browserViewUrl) : `<p class="muted">Queue a Splitit agent from a Splitit whitelist request to see it here.</p>`}
        </div>
      </section>
      `
    )
  );
}

function nav(active: "metrics" | "pulse" | "channels" | "whop" | "whop-events" | "splitit" | "settings") {
  return `
    <nav class="top-nav">
      <a class="${active === "metrics" ? "active" : ""}" href="/dashboard/metrics">Metrics</a>
      <a class="${active === "pulse" ? "active" : ""}" href="/dashboard/pulse">Pulse</a>
      <a class="${active === "channels" ? "active" : ""}" href="/dashboard/channels">Channels</a>
      <a class="${active === "whop" ? "active" : ""}" href="/dashboard/whop">Whop</a>
      <a class="${active === "whop-events" ? "active" : ""}" href="/dashboard/whop-events">Whop Events</a>
      <a class="${active === "splitit" ? "active" : ""}" href="/dashboard/splitit">Splitit</a>
      <a class="${active === "settings" ? "active" : ""}" href="/dashboard/settings">Settings</a>
    </nav>
  `;
}

function statCard(label: string, value: number) {
  return `<div class="panel stat-card"><span class="stat">${value}</span><span class="muted">${escapeHtml(label)}</span></div>`;
}

function metricList(items: Array<{ label: string; value: number }>) {
  if (!items.length) return `<p class="muted">No data yet.</p>`;
  const max = Math.max(...items.map((item) => item.value), 1);
  return `
    <div class="metric-list">
      ${items.map((item) => `
        <div class="metric-row">
          <div class="metric-label"><span>${escapeHtml(item.label)}</span><strong>${item.value}</strong></div>
          <div class="bar"><span style="width: ${Math.round((item.value / max) * 100)}%"></span></div>
        </div>
      `).join("")}
    </div>
  `;
}

function recentRequests(requests: Awaited<ReturnType<typeof loadRequestStats>>["recentRequests"]) {
  if (!requests.length) return `<p class="muted">No requests yet.</p>`;
  return `
    <div class="recent-list">
      ${requests.map((request) => `
        <div class="recent-item">
          <strong>${escapeHtml(request.title)}</strong>
          <span>${escapeHtml(request.channel?.companyName ?? request.channel?.name ?? request.channelId)} | ${statusLabel(request)} | ${typeLabel(request.type)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function pulseAccountCard(channel: Awaited<ReturnType<typeof loadPulseChannels>>[number], selectedChannelId: string) {
  const pulse = channel.pulse;
  const riskScore = pulse?.riskScore ?? 0;
  const displayName = channel.companyName ?? channel.name ?? channel.slackChannelId;
  const signals = pulse?.topSignals?.slice(0, 3).join(", ") || "No signals yet";
  return `
    <a class="pulse-account ${channel.slackChannelId === selectedChannelId ? "active" : ""}" href="/dashboard/pulse?channel=${encodeURIComponent(channel.slackChannelId)}">
      <span class="risk-dot ${riskClass(riskScore)}"></span>
      <span>
        <strong>${escapeHtml(displayName)}</strong>
        <small>${riskScore} risk | ${escapeHtml(pulse?.churnRisk ?? "LOW")} | ${escapeHtml(signals)}</small>
      </span>
    </a>
  `;
}

function pulseDetail(channel: Awaited<ReturnType<typeof loadPulseChannels>>[number]) {
  const pulse = channel.pulse;
  const displayName = channel.companyName ?? channel.name ?? channel.slackChannelId;
  const riskScore = pulse?.riskScore ?? 0;
  const blockers = Array.isArray(pulse?.openBlockers) ? pulse.openBlockers as any[] : [];
  const riskyMessages = channel.messageInsights.filter((insight) => insight.needsAttention || insight.riskScore >= 45).slice(0, 12);

  return `
    <section class="panel pulse-hero-card">
      <div>
        <p class="eyebrow">Account pulse</p>
        <h2>${escapeHtml(displayName)}</h2>
        <p class="muted"><code>${escapeHtml(channel.slackChannelId)}</code>${channel.ownerMapping?.ownerSlackUserId ? ` | Owner <code>${escapeHtml(channel.ownerMapping.ownerSlackUserId)}</code>` : ""}</p>
      </div>
      <div class="risk-meter ${riskClass(riskScore)}">
        <strong>${riskScore}</strong>
        <span>${escapeHtml(pulse?.churnRisk ?? "LOW")} risk</span>
      </div>
    </section>
    <section class="grid">
      <div class="panel">
        <div class="panel-head"><h2>What is blocked</h2><span class="muted">${blockers.length} active signals</span></div>
        <p>${escapeHtml(pulse?.blockerSummary ?? "No active blockers detected in recent Slack messages.")}</p>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>What feels off</h2><span class="muted">${escapeHtml(pulse?.sentiment ?? "NEUTRAL")}</span></div>
        <p>${escapeHtml(pulse?.unhappySummary ?? "No strong dissatisfaction patterns detected yet.")}</p>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Suggested CSM move</h2><span class="muted">${pulse?.lastAnalyzedAt ? `Updated ${formatDate(pulse.lastAnalyzedAt)}` : "Waiting for data"}</span></div>
      <p class="action-copy">${escapeHtml(pulse?.suggestedCsmAction ?? "Monitor account sentiment and respond to blockers as they surface.")}</p>
      <div class="signal-row">${(pulse?.topSignals ?? []).slice(0, 8).map((signal) => `<span>${escapeHtml(signal)}</span>`).join("")}</div>
    </section>
    <section class="grid">
      <div class="panel">
        <div class="panel-head"><h2>Recent risk messages</h2><span class="muted">${channel.messageInsights.length} analyzed</span></div>
        <div class="pulse-message-list">
          ${riskyMessages.length ? riskyMessages.map(pulseMessage).join("") : `<p class="muted">No risky messages yet.</p>`}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>CSM notes</h2><span class="muted">Private dashboard notes</span></div>
        <form class="stack" method="post" action="/dashboard/pulse/note">
          <input type="hidden" name="channelId" value="${escapeHtml(channel.slackChannelId)}" />
          <label>Note
            <textarea name="note" rows="4" placeholder="Add context, CSM read, promised follow-up, exec risk, renewal notes..."></textarea>
          </label>
          <label>Author Slack user ID <span class="muted">(optional)</span>
            <input name="authorSlackUserId" placeholder="${escapeHtml(config.adminSlackUserIds[0] ?? "dashboard")}" />
          </label>
          <button type="submit">Add note</button>
        </form>
        <div class="pulse-notes">
          ${channel.pulseNotes.length ? channel.pulseNotes.map((note) => `
            <div class="pulse-note">
              <strong>${escapeHtml(note.author.name ?? note.authorSlackUserId)}</strong>
              <p>${escapeHtml(note.body)}</p>
              <small>${formatDate(note.createdAt)}</small>
            </div>
          `).join("") : `<p class="muted">No notes yet.</p>`}
        </div>
      </div>
    </section>
  `;
}

function pulseMessage(insight: Awaited<ReturnType<typeof loadPulseChannels>>[number]["messageInsights"][number]) {
  return `
    <div class="pulse-message ${riskClass(insight.riskScore)}">
      <div class="pulse-message-head">
        <strong>${insight.riskScore} risk</strong>
        <span>${escapeHtml(insight.churnRisk)} | ${escapeHtml(insight.sentiment)} | ${formatDate(insight.createdAt)}</span>
      </div>
      <p>${escapeHtml(insight.text)}</p>
      ${insight.blockerSummary ? `<small><strong>Blocker:</strong> ${escapeHtml(insight.blockerSummary)}</small>` : ""}
      ${insight.suggestedCsmAction ? `<small><strong>Move:</strong> ${escapeHtml(insight.suggestedCsmAction)}</small>` : ""}
    </div>
  `;
}

function riskClass(score: number) {
  if (score >= 85) return "critical";
  if (score >= 65) return "high";
  if (score >= 35) return "medium";
  return "low";
}

function whopRouteRow(route: Awaited<ReturnType<typeof loadWhopWebhookRoutes>>[number]) {
  const channel = route.channel?.name ? `#${route.channel.name}` : route.slackChannelId;
  return `
    <tr>
      <td><strong>${escapeHtml(route.eventType)}</strong></td>
      <td>${escapeHtml(channel)}<br /><code>${escapeHtml(route.slackChannelId)}</code></td>
      <td>${route.businessId ? `<code>${escapeHtml(route.businessId)}</code>` : `<span class="muted">Any business</span>`}</td>
      <td><span class="pill ${route.enabled ? "ok" : ""}">${route.enabled ? "Enabled" : "Paused"}</span></td>
      <td>
        <div class="table-actions">
          <form method="post" action="/dashboard/whop-events/routes/toggle">
            <input type="hidden" name="routeId" value="${escapeHtml(route.id)}" />
            <input type="hidden" name="enabled" value="${route.enabled ? "false" : "true"}" />
            <button type="submit" class="secondary-button small">${route.enabled ? "Pause" : "Enable"}</button>
          </form>
          <form method="post" action="/dashboard/whop-events/routes/delete">
            <input type="hidden" name="routeId" value="${escapeHtml(route.id)}" />
            <button type="submit" class="danger-button small">Delete</button>
          </form>
        </div>
      </td>
    </tr>
  `;
}

function whopDeliveryRow(delivery: Awaited<ReturnType<typeof loadWhopWebhookDeliveries>>[number]) {
  return `
    <tr>
      <td>${formatDate(delivery.createdAt)}</td>
      <td><strong>${escapeHtml(delivery.eventType)}</strong></td>
      <td>${delivery.businessId ? `<code>${escapeHtml(delivery.businessId)}</code>` : `<span class="muted">Unknown</span>`}</td>
      <td>${delivery.slackChannelId ? `<code>${escapeHtml(delivery.slackChannelId)}</code>` : `<span class="muted">None</span>`}</td>
      <td><span class="pill ${delivery.status === "ROUTED" ? "ok" : ""}">${escapeHtml(delivery.status)}</span></td>
    </tr>
  `;
}

function splititJobCard(job: Awaited<ReturnType<typeof loadSplititJobs>>[number], selectedJobId: string) {
  const live = isLiveSplititJob(job.status);
  const company = job.request.channel?.companyName ?? job.request.channel?.name ?? job.request.channelId;
  return `
    <a class="splitit-job ${job.id === selectedJobId ? "active" : ""}" href="/dashboard/splitit?job=${encodeURIComponent(job.id)}">
      <span class="agent-light ${live ? "live" : "off"}"></span>
      <span>
        <strong>${escapeHtml(job.targetEmail)}</strong>
        <small>${escapeHtml(company)} | ${escapeHtml(splititStatusLabel(job.status))}</small>
      </span>
    </a>
  `;
}

function splititJobDetail(job: Awaited<ReturnType<typeof loadSplititJobs>>[number], browserViewUrl: string) {
  const live = isLiveSplititJob(job.status);
  const company = job.request.channel?.companyName ?? job.request.channel?.name ?? job.request.channelId;
  return `
    <div class="panel-head">
      <div>
        <h2>${escapeHtml(job.targetEmail)}</h2>
        <span class="muted">${escapeHtml(company)} | Request ${job.requestId}</span>
      </div>
      <div class="detail-actions">
        ${live && browserViewUrl ? `<a class="button-link small" target="_blank" rel="noreferrer" href="${escapeHtml(browserViewUrl)}">Open live browser</a>` : ""}
        <form method="post" action="/dashboard/splitit/delete">
          <input type="hidden" name="jobId" value="${escapeHtml(job.id)}" />
          <button type="submit" class="danger-button small">Delete</button>
        </form>
        <span class="agent-state ${live ? "live" : "off"}"><span class="agent-light ${live ? "live" : "off"}"></span>${live ? "Live agent" : "Agent off"}</span>
      </div>
    </div>
    <div class="splitit-meta">
      <span><strong>Status</strong>${escapeHtml(splititStatusLabel(job.status))}</span>
      <span><strong>Step</strong>${escapeHtml(splititStatusLabel(job.step))}</span>
      <span><strong>Attempts</strong>${job.attempts}</span>
      <span><strong>Updated</strong>${formatDate(job.updatedAt)}</span>
    </div>
    ${job.error ? `<div class="notice danger">${escapeHtml(job.error)}</div>` : ""}
    <div class="splitit-transcript">
      ${job.messages.length ? job.messages.map(splititMessageBubble).join("") : `<p class="muted">No messages recorded yet.</p>`}
    </div>
    <form class="manual-message" method="post" action="/dashboard/splitit/manual-message">
      <input type="hidden" name="jobId" value="${escapeHtml(job.id)}" />
      <label>Manual message
        <textarea name="message" rows="3" placeholder="Type a message to send into the Splitit chat" ${live ? "" : "disabled"}></textarea>
      </label>
      <label>Slack user ID for audit
        <input name="actorSlackUserId" placeholder="${escapeHtml(config.adminSlackUserIds[0] ?? "dashboard")}" ${live ? "" : "disabled"} />
      </label>
      <button type="submit" ${live ? "" : "disabled"}>Send message</button>
    </form>
  `;
}

function splititBrowserViewUrl(webhookUrl: string, webhookSecret: string, jobId: string) {
  if (!webhookUrl) return "";
  try {
    const url = new URL(webhookUrl);
    url.pathname = `/sessions/${encodeURIComponent(jobId)}`;
    url.search = "";
    if (webhookSecret) url.searchParams.set("secret", webhookSecret);
    return url.toString();
  } catch {
    return "";
  }
}

function splititMessageBubble(message: Awaited<ReturnType<typeof loadSplititJobs>>[number]["messages"][number]) {
  return `
    <div class="splitit-message ${message.sender.toLowerCase()}">
      <div class="bubble">
        <strong>${escapeHtml(splititSenderLabel(message.sender))}</strong>
        <p>${escapeHtml(message.body)}</p>
        <small>${formatDate(message.createdAt)}${message.createdBySlackUserId ? ` | ${escapeHtml(message.createdBySlackUserId)}` : ""}</small>
      </div>
    </div>
  `;
}

function splititStatusLabel(value: string) {
  return value.toLowerCase().replace(/_/g, " ");
}

function splititSenderLabel(value: string) {
  if (value === "CSM") return "CSM";
  if (value === "SYSTEM") return "System / plan";
  return splititStatusLabel(value);
}

function channelRow(channel: DashboardChannel) {
  const displayName = channel.companyName ?? channel.name ?? channel.slackChannelId;
  const owner = channel.members.find((user) => user.slackUserId === channel.ownerSlackUserId);
  return `
    <tr>
      <td><strong>${escapeHtml(displayName)}</strong></td>
      <td><code>${escapeHtml(channel.slackChannelId)}</code></td>
      <td><span class="pill ${channel.botMode === "KYC_ONLY" ? "warning" : "ok"}">${channelModeLabel(channel.botMode)}</span></td>
      <td>${owner ? `${escapeHtml(userLabel(owner))}<br /><span class="role-chip">${roleLabel(owner.channelRole)}</span>` : channel.ownerSlackUserId ? `<code>${escapeHtml(channel.ownerSlackUserId)}</code>` : `<span class="muted">Unassigned</span>`}</td>
      <td>${memberPreview(channel.members)}</td>
      <td>${whopBusinessPreview(channel.whopBusinesses)}</td>
      <td>${channel.openRequests}</td>
      <td>${channel.totalRequests}</td>
      <td><a class="button-link small" href="/dashboard/channels?channel=${encodeURIComponent(channel.slackChannelId)}">Open</a></td>
    </tr>
  `;
}

function channelMemberPanel(channel: DashboardChannel) {
  const displayName = channel.companyName ?? channel.name ?? channel.slackChannelId;
  return `
    <section class="panel focus-panel">
      <div class="panel-head">
        <div>
          <h2>${escapeHtml(displayName)}</h2>
          <span class="muted"><code>${escapeHtml(channel.slackChannelId)}</code> | ${channel.members.length} member${channel.members.length === 1 ? "" : "s"}</span>
        </div>
        <a class="button-link secondary" href="/dashboard/channels">Close</a>
      </div>
      <div class="grid">
        <div class="panel subtle-panel">
          <h3>Owner CSM</h3>
          <form class="stack" method="post" action="/dashboard/channel-owner">
            <input type="hidden" name="channelId" value="${escapeHtml(channel.slackChannelId)}" />
            <label>Select from this channel
              <select name="ownerSlackUserId" required>
                <option value="">Select CSM</option>
                ${channel.members.map((member) => `<option value="${escapeHtml(member.slackUserId)}" ${member.slackUserId === channel.ownerSlackUserId ? "selected" : ""}>${escapeHtml(userLabel(member))}</option>`).join("")}
              </select>
            </label>
            <button type="submit">Save owner</button>
          </form>
        </div>
        <div class="panel subtle-panel">
          <h3>Role model</h3>
          <p class="muted">Roles here apply only inside this channel. Use CSM/admin for people who should manage requests. Sales reps and requesters cannot update tickets.</p>
        </div>
        <div class="panel subtle-panel">
          <h3>Bot mode</h3>
          <p class="muted">Full mode enables every workflow. KYC-only mode turns this channel into a dedicated KYC/KYB issue intake and hides general request flows.</p>
          <form class="stack" method="post" action="/dashboard/channel-bot-mode">
            <input type="hidden" name="channelId" value="${escapeHtml(channel.slackChannelId)}" />
            <input type="hidden" name="botMode" value="${channel.botMode === "KYC_ONLY" ? "FULL" : "KYC_ONLY"}" />
            <button type="submit" class="${channel.botMode === "KYC_ONLY" ? "secondary-button" : ""}">
              ${channel.botMode === "KYC_ONLY" ? "Switch to full functionality" : "Enable KYC only"}
            </button>
          </form>
          <p><span class="pill ${channel.botMode === "KYC_ONLY" ? "warning" : "ok"}">${channelModeLabel(channel.botMode)}</span></p>
        </div>
      </div>
      <div class="grid">
        <div class="panel subtle-panel">
          <h3>Whop businesses</h3>
          <p class="muted">Map one or more Whop businesses to this Slack channel. Checkout-link flows will use these names when a CSM needs to pick a business.</p>
          <form class="stack" method="post" action="/dashboard/channel-whop-business">
            <input type="hidden" name="channelId" value="${escapeHtml(channel.slackChannelId)}" />
            <label>Business name
              <input name="businessName" placeholder="Acme Studios" required />
            </label>
            <label>Business ID
              <input name="businessId" placeholder="biz_..." required />
            </label>
            <label>Business API key
              <input name="apiKey" type="password" placeholder="Paste API key for this business" required />
            </label>
            <button type="submit">Add business</button>
          </form>
        </div>
        <div class="panel subtle-panel">
          <h3>Mapped businesses</h3>
          ${channel.whopBusinesses.length ? whopBusinessTable(channel) : `<p class="muted">No Whop businesses mapped yet.</p>`}
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th>Slack ID</th>
              <th>Channel role</th>
              <th>Update</th>
            </tr>
          </thead>
          <tbody>${channel.members.map((member) => channelMemberRow(channel.slackChannelId, member)).join("")}</tbody>
        </table>
      </div>
    </section>
  `;
}

function channelMemberRow(channelId: string, member: DashboardChannelMember) {
  return `
    <tr>
      <td><strong>${escapeHtml(member.name ?? "Unknown")}</strong></td>
      <td><code>${escapeHtml(member.slackUserId)}</code></td>
      <td><span class="role-chip">${roleLabel(member.channelRole)}</span></td>
      <td>
        <form class="inline" method="post" action="/dashboard/channel-member-role">
          <input type="hidden" name="channelId" value="${escapeHtml(channelId)}" />
          <input type="hidden" name="slackUserId" value="${escapeHtml(member.slackUserId)}" />
          ${roleSelect("role", member.channelRole)}
          <button type="submit">Save</button>
        </form>
      </td>
    </tr>
  `;
}

function userLabel(user: DashboardUser) {
  return user.name ? `${user.name} (${user.slackUserId})` : user.slackUserId;
}

function memberPreview(members: DashboardChannelMember[]) {
  if (!members.length) return `<span class="muted">Not synced</span>`;
  const operators = members.filter(isChannelOperator).length;
  const preview = members.slice(0, 3).map((member) => escapeHtml(member.name ?? member.slackUserId)).join(", ");
  const extra = members.length > 3 ? ` +${members.length - 3}` : "";
  return `${preview}${extra}<br /><span class="muted">${members.length} member${members.length === 1 ? "" : "s"} | ${operators} operator${operators === 1 ? "" : "s"}</span>`;
}

function whopBusinessPreview(businesses: DashboardChannelWhopBusiness[]) {
  if (!businesses.length) return `<span class="muted">None</span>`;
  const preview = businesses.slice(0, 2).map((business) => escapeHtml(business.businessName)).join(", ");
  const extra = businesses.length > 2 ? ` +${businesses.length - 2}` : "";
  return `${preview}${extra}<br /><span class="muted">${businesses.length} mapped</span>`;
}

function whopBusinessTable(channel: DashboardChannel) {
  return `
    <div class="table-wrap compact-table">
      <table>
        <thead>
          <tr>
            <th>Business</th>
            <th>Biz ID</th>
            <th>API key</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${channel.whopBusinesses.map((business) => `
            <tr>
              <td><strong>${escapeHtml(business.businessName)}</strong></td>
              <td><code>${escapeHtml(business.businessId)}</code></td>
              <td><span class="pill ${business.apiKeyConfigured ? "ok" : ""}">${business.apiKeyConfigured ? "Configured" : "Missing"}</span></td>
              <td>
                <form method="post" action="/dashboard/channel-whop-business/delete">
                  <input type="hidden" name="channelId" value="${escapeHtml(channel.slackChannelId)}" />
                  <input type="hidden" name="businessMappingId" value="${escapeHtml(business.id)}" />
                  <button class="danger-button small" type="submit">Remove</button>
                </form>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function whopChannelRow(channel: DashboardChannel) {
  const displayName = channel.companyName ?? channel.name ?? channel.slackChannelId;
  return `
    <tr>
      <td>
        <strong>${escapeHtml(displayName)}</strong><br />
        <code>${escapeHtml(channel.slackChannelId)}</code>
      </td>
      <td>${channel.whopBusinesses.length ? whopBusinessList(channel) : `<span class="muted">No businesses mapped yet.</span>`}</td>
      <td>
        <form class="business-inline" method="post" action="/dashboard/channel-whop-business">
          <input type="hidden" name="channelId" value="${escapeHtml(channel.slackChannelId)}" />
          <input type="hidden" name="returnTo" value="/dashboard/whop?notice=Whop business mapping saved" />
          <input name="businessName" placeholder="Business name" required />
          <input name="businessId" placeholder="biz_..." required />
          <input name="apiKey" type="password" placeholder="Business API key" required />
          <button type="submit">Add</button>
        </form>
      </td>
    </tr>
  `;
}

function whopBusinessList(channel: DashboardChannel) {
  return `
    <div class="business-list">
      ${channel.whopBusinesses.map((business) => `
        <div class="business-pill">
          <span>
            <strong>${escapeHtml(business.businessName)}</strong>
            <code>${escapeHtml(business.businessId)}</code>
            <small class="${business.apiKeyConfigured ? "ok-text" : "danger-text"}">${business.apiKeyConfigured ? "API key configured" : "API key missing"}</small>
          </span>
          <form method="post" action="/dashboard/channel-whop-business/delete">
            <input type="hidden" name="channelId" value="${escapeHtml(channel.slackChannelId)}" />
            <input type="hidden" name="businessMappingId" value="${escapeHtml(business.id)}" />
            <input type="hidden" name="returnTo" value="/dashboard/whop?notice=Whop business mapping removed" />
            <button class="danger-button small" type="submit">Remove</button>
          </form>
        </div>
      `).join("")}
    </div>
  `;
}

function channelOperatorCount(channels: DashboardChannel[]) {
  const operators = new Set<string>();
  channels.forEach((channel) => channel.members.forEach((member) => {
    if (isChannelOperator(member)) operators.add(member.slackUserId);
  }));
  return operators.size;
}

function isChannelOperator(member: DashboardChannelMember) {
  return member.channelRole === "CSM" || member.channelRole === "ADMIN";
}

function roleSelect(name: string, selected: UserRole) {
  const roles: UserRole[] = ["ADMIN", "CSM", "SALES_REP", "REQUESTER"];
  return `<select name="${name}" required>${roles.map((role) => `<option value="${role}" ${role === selected ? "selected" : ""}>${roleLabel(role)}</option>`).join("")}</select>`;
}

function normalizeChannelBotMode(value: unknown): ChannelBotMode | null {
  return value === "FULL" || value === "KYC_ONLY" ? value : null;
}

function channelModeLabel(mode: ChannelBotMode) {
  return mode === "KYC_ONLY" ? "KYC only" : "Full";
}

function roleLabel(role: UserRole) {
  return role.toLowerCase().replace(/_/g, " ");
}

async function loadChannels(): Promise<DashboardChannel[]> {
  const channels = await prisma.channel.findMany({
    include: {
      ownerMapping: true,
      members: {
        include: { user: true },
        orderBy: { slackUserId: "asc" }
      },
      whopBusinesses: {
        orderBy: [{ businessName: "asc" }, { businessId: "asc" }]
      }
    },
    orderBy: [{ companyName: "asc" }, { name: "asc" }, { slackChannelId: "asc" }]
  });

  return Promise.all(
    channels.map(async (channel) => {
      const [openRequests, totalRequests] = await Promise.all([
        prisma.request.count({ where: { channelId: channel.slackChannelId, status: { not: "DONE" } } }),
        prisma.request.count({ where: { channelId: channel.slackChannelId } })
      ]);

      return {
        slackChannelId: channel.slackChannelId,
        name: channel.name,
        companyName: channel.companyName,
        botMode: channel.botMode,
        ownerSlackUserId: channel.ownerMapping?.ownerSlackUserId ?? null,
        members: channel.members.map((member) => ({
          slackUserId: member.user.slackUserId,
          name: member.user.name,
          role: member.user.role,
          channelRole: member.role
        })),
        whopBusinesses: channel.whopBusinesses.map((business) => ({
          id: business.id,
          businessId: business.businessId,
          businessName: business.businessName,
          apiKeyConfigured: Boolean(business.apiKey)
        })),
        openRequests,
        totalRequests
      };
    })
  );
}

async function loadRequestStats() {
  const [openRequests, doneRequests, waitingOnCustomer, statusGroups, typeGroups, recentRequests] = await Promise.all([
    prisma.request.count({ where: { status: { not: "DONE" } } }),
    prisma.request.count({ where: { status: "DONE" } }),
    prisma.request.count({ where: { customStatus: "Waiting on customer" } }),
    prisma.request.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.request.groupBy({ by: ["type"], _count: { _all: true } }),
    prisma.request.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { channel: true }
    })
  ]);

  return {
    openRequests,
    doneRequests,
    waitingOnCustomer,
    statusCounts: statusGroups.map((group) => ({
      label: statusLabel({ status: group.status, customStatus: null }),
      value: group._count._all
    })),
    typeCounts: typeGroups.map((group) => ({
      label: typeLabel(group.type),
      value: group._count._all
    })),
    recentRequests
  };
}

async function loadPulseChannels() {
  return prisma.channel.findMany({
    where: {
      OR: [
        { pulse: { isNot: null } },
        { messageInsights: { some: {} } }
      ]
    },
    include: {
      pulse: true,
      ownerMapping: true,
      whopBusinesses: { orderBy: { businessName: "asc" } },
      messageInsights: {
        orderBy: { createdAt: "desc" },
        take: 50
      },
      pulseNotes: {
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { author: true }
      }
    },
    orderBy: [{ companyName: "asc" }, { name: "asc" }, { slackChannelId: "asc" }]
  }).then((channels) => channels.sort((a, b) => (b.pulse?.riskScore ?? 0) - (a.pulse?.riskScore ?? 0)));
}

async function loadSplititJobs() {
  return prisma.splititAutomationJob.findMany({
    include: {
      request: {
        include: { channel: true }
      },
      messages: {
        orderBy: { createdAt: "asc" }
      }
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    take: 250
  });
}

async function loadWhopWebhookRoutes() {
  return prisma.whopWebhookRoute.findMany({
    include: { channel: true },
    orderBy: [{ enabled: "desc" }, { eventType: "asc" }, { createdAt: "desc" }]
  });
}

async function loadWhopWebhookDeliveries() {
  return prisma.whopWebhookDelivery.findMany({
    orderBy: { createdAt: "desc" },
    take: 50
  });
}

async function syncSlackChannels() {
  let cursor: string | undefined;
  do {
    const response = await slack.conversations.list({
      exclude_archived: true,
      limit: 200,
      types: "public_channel,private_channel",
      cursor
    });

    for (const channel of response.channels ?? []) {
      if (!channel.id) continue;
      await ensureChannel(channel.id, channel.name ?? undefined);
      await syncSlackChannelMembers(channel.id);
    }

    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

function dashboardBaseUrl(req: IncomingMessage) {
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
  const proto = req.headers["x-forwarded-proto"] ?? (String(host).includes("localhost") ? "http" : "https");
  return `${Array.isArray(proto) ? proto[0] : proto}://${Array.isArray(host) ? host[0] : host}`;
}

async function syncSlackChannelMembers(slackChannelId: string) {
  const memberIds: string[] = [];
  let cursor: string | undefined;

  try {
    do {
      const response = await slack.conversations.members({
        channel: slackChannelId,
        limit: 200,
        cursor
      });

      memberIds.push(...(response.members ?? []));
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch (error) {
    logger.warn({ error, slackChannelId }, "Could not sync Slack channel members");
    return;
  }

  for (const slackUserId of memberIds) {
    if (!slackUserId) continue;
    await ensureNamedUser(slackUserId);
    await prisma.channelMember.upsert({
      where: { slackChannelId_slackUserId: { slackChannelId, slackUserId } },
      update: {},
      create: { slackChannelId, slackUserId }
    });
  }

  await prisma.channelMember.deleteMany({
    where: {
      slackChannelId,
      slackUserId: { notIn: memberIds }
    }
  });
}

async function ensureNamedUser(slackUserId: string) {
  if (!slackUserId) return;
  const existing = await prisma.user.findUnique({ where: { slackUserId }, select: { name: true } });
  if (existing?.name) return;
  await ensureUser(slackUserId, await fetchSlackUserName(slackUserId) ?? undefined);
}

async function fetchSlackUserName(slackUserId: string) {
  if (!slackUserId) return null;
  try {
    const response = await slack.users.info({ user: slackUserId });
    const user = response.user;
    return user?.profile?.real_name || user?.profile?.display_name || user?.real_name || user?.name || null;
  } catch (error) {
    logger.warn({ error, slackUserId }, "Could not fetch Slack user name");
    return null;
  }
}

function page(title: string, body: string) {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${escapeHtml(title)}</title>
      ${title === "Radar Splitit" ? `<meta http-equiv="refresh" content="15" />` : ""}
      <style>${css()}</style>
    </head>
    <body>
      <main>${body}</main>
    </body>
  </html>`;
}

function renderLogin(res: ServerResponse, token: string) {
  const setup = token
    ? `<form class="login" method="get" action="/dashboard"><label>Dashboard token<input name="token" type="password" autofocus /></label><button type="submit">Open dashboard</button></form>`
    : `<p class="muted">Set <code>DASHBOARD_ADMIN_TOKEN</code> or <code>ADMIN_SLACK_USER_IDS</code> to enable the dashboard.</p>`;
  sendHtml(res, 401, page("Dashboard login", `<section class="panel login-panel"><h1>Radar Dashboard</h1>${setup}</section>`));
}

function dashboardToken() {
  return config.DASHBOARD_ADMIN_TOKEN || config.adminSlackUserIds[0] || "";
}

function isAuthorized(req: IncomingMessage, url: URL, token: string) {
  if (!token) return false;
  if (url.searchParams.get("token") === token) return true;
  return parseCookies(req.headers.cookie ?? "").dashboard_token === token;
}

function parseCookies(cookieHeader: string) {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [key, ...value] = part.split("=");
        return [key, decodeURIComponent(value.join("="))];
      })
  );
}

async function readForm(req: IncomingMessage) {
  return new URLSearchParams(await readBody(req));
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isValidSlackSignature(req: IncomingMessage, rawBody: string) {
  const signature = req.headers["x-slack-signature"];
  const timestamp = req.headers["x-slack-request-timestamp"];

  if (typeof signature !== "string" || typeof timestamp !== "string") return false;

  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) return false;

  const fiveMinutesInSeconds = 60 * 5;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > fiveMinutesInSeconds) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const digest = `v0=${createHmac("sha256", config.SLACK_SIGNING_SECRET).update(base).digest("hex")}`;

  const signatureBuffer = Buffer.from(signature);
  const digestBuffer = Buffer.from(digest);
  return signatureBuffer.length === digestBuffer.length && timingSafeEqual(signatureBuffer, digestBuffer);
}

function normalizeSlackUserId(value: string) {
  return value.trim().match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/)?.[1] ?? value.trim();
}

function extractEmail(value: string) {
  return value.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0] ?? "";
}

function normalizeUserRole(value: string): UserRole | null {
  const role = value.trim().toUpperCase();
  switch (role) {
    case "ADMIN":
    case "CSM":
    case "SALES_REP":
    case "REQUESTER":
      return role;
    default:
      return null;
  }
}

function isStatusActionId(actionId: string) {
  return actionId === "request_set_submitted" || actionId === "request_set_in_progress" || actionId === "request_set_done";
}

function modalValue(view: any, blockId: string): string {
  return view.state.values[blockId]?.value?.value ?? "";
}

function modalSelectedValue(view: any, blockId: string): string {
  return view.state.values[blockId]?.value?.selected_option?.value ?? "";
}

function redirect(res: ServerResponse, location: string) {
  if (res.writableEnded) return;
  res.writeHead(303, { Location: location });
  res.end();
}

function safeReturnPath(value: string | undefined, fallback: string) {
  if (!value?.startsWith("/dashboard")) return fallback;
  if (value.startsWith("//")) return fallback;
  return value;
}

function sendText(res: ServerResponse, status: number, text: string) {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendSlackJson(res: ServerResponse, payload: unknown) {
  if (res.writableEnded) return;
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, status: number, html: string) {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function css() {
  return `
    :root { color-scheme: light; --bg:#f6f8fb; --text:#202124; --muted:#5f6368; --line:#dfe3e8; --panel:#ffffff; --blue:#1a73e8; --blue-dark:#185abc; --green:#188038; --yellow:#f9ab00; --red:#d93025; --orange:#fa7b17; --shadow:0 1px 2px rgba(60,64,67,.12), 0 8px 28px rgba(60,64,67,.08); }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: radial-gradient(circle at 20% -10%, #eaf2ff 0, transparent 34%), var(--bg); color: var(--text); }
    main { width: min(1320px, calc(100vw - 32px)); margin: 0 auto; padding: 24px 0 56px; }
    .hero { display: flex; align-items: end; justify-content: space-between; gap: 24px; padding: 8px 0 24px; }
    .top-nav { display: flex; gap: 6px; margin-bottom: 24px; padding: 6px; border: 1px solid var(--line); background: rgba(255,255,255,.86); backdrop-filter: blur(10px); border-radius: 14px; box-shadow: 0 1px 2px rgba(60,64,67,.08); overflow-x: auto; }
    .top-nav a { color: var(--muted); text-decoration: none; padding: 10px 13px; font-weight: 700; border-radius: 10px; white-space: nowrap; }
    .top-nav a:hover { background: #eef4ff; color: var(--blue-dark); }
    .top-nav a.active { color: var(--blue); background: #e8f0fe; }
    .button-link { display: inline-flex; align-items: center; min-height: 38px; border-radius: 8px; padding: 8px 14px; background: var(--blue); color: white; text-decoration: none; font-weight: 700; }
    .button-link.small { min-height: 32px; padding: 6px 11px; font-size: 13px; }
    .button-link.secondary { background: #f1f3f4; color: #3c4043; }
    .hero-actions, .detail-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
    .eyebrow { color: var(--blue); font-weight: 700; margin: 0 0 8px; text-transform: uppercase; font-size: 12px; letter-spacing: 0; }
    h1, h2, h3 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 38px; line-height: 1.08; font-weight: 760; }
    h2 { font-size: 18px; }
    h3 { font-size: 15px; margin-bottom: 10px; }
    .muted { color: var(--muted); }
    .notice { background: #e8f0fe; border: 1px solid #d2e3fc; padding: 12px 14px; border-radius: 8px; margin-bottom: 16px; color: #174ea6; }
    .notice.danger { background: #fce8e6; border-color: #fad2cf; color: var(--red); }
    .grid { display: grid; grid-template-columns: 380px 1fr; gap: 18px; margin-bottom: 18px; }
    .single-grid { grid-template-columns: 1fr; }
    .panel { background: rgba(255,255,255,.96); border: 1px solid var(--line); border-radius: 14px; padding: 20px; box-shadow: var(--shadow); }
    .focus-panel { margin-bottom: 16px; border-color: #c2d7ff; box-shadow: 0 2px 8px rgba(26, 115, 232, .12); }
    .subtle-panel { box-shadow: none; background: #fbfdff; }
    .settings-note { display: grid; align-content: start; gap: 12px; }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
    .stack { display: grid; gap: 12px; margin-top: 14px; }
    .inline { display: grid; grid-template-columns: minmax(150px, 1fr) auto; gap: 8px; align-items: center; }
    .check-row { display: flex; grid-template-columns: none; align-items: center; gap: 8px; }
    .check-row input { width: auto; min-height: auto; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; }
    input, select, textarea { width: 100%; min-height: 40px; border: 1px solid var(--line); border-radius: 10px; padding: 9px 11px; background: #fff; color: var(--text); font: inherit; outline-color: var(--blue); }
    textarea { resize: vertical; line-height: 1.45; }
    button { min-height: 40px; border: 0; border-radius: 10px; padding: 8px 14px; background: var(--blue); color: white; font-weight: 700; cursor: pointer; box-shadow: 0 1px 1px rgba(60, 64, 67, .18); }
    button:hover { background: var(--blue-dark); }
    button.secondary-button { background: #f1f3f4; color: #3c4043; }
    button.secondary-button:hover { background: #e8eaed; }
    button.danger-button { background: #fce8e6; color: var(--red); }
    button.danger-button:hover { background: #fad2cf; }
    button.small { min-height: 32px; padding: 6px 11px; font-size: 13px; }
    button:disabled, textarea:disabled, input:disabled { opacity: .55; cursor: not-allowed; }
    .stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; align-items: center; }
    .stat-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 16px; margin-bottom: 16px; }
    .stat-card { min-height: 106px; display: flex; flex-direction: column; justify-content: center; }
    .stat { display: block; font-size: 32px; font-weight: 750; margin-bottom: 4px; }
    .metric-list, .recent-list { display: grid; gap: 12px; }
    .metric-row { display: grid; gap: 7px; }
    .metric-label { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
    .bar { height: 8px; border-radius: 999px; background: #edf2fa; overflow: hidden; }
    .bar span { display: block; height: 100%; border-radius: inherit; background: var(--blue); }
    .recent-item { display: grid; gap: 4px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
    .recent-item:last-child { border-bottom: 0; padding-bottom: 0; }
    .recent-item span { color: var(--muted); font-size: 13px; }
    .pulse-layout { display: grid; grid-template-columns: 380px minmax(0, 1fr); gap: 18px; align-items: start; }
    .pulse-sidebar { position: sticky; top: 16px; }
    .pulse-account-list, .pulse-message-list, .pulse-notes { display: grid; gap: 10px; }
    .pulse-account { display: grid; grid-template-columns: 12px 1fr; gap: 12px; align-items: center; padding: 13px; border: 1px solid var(--line); border-radius: 12px; background: #fff; color: var(--text); text-decoration: none; }
    .pulse-account:hover, .pulse-account.active { border-color: #c2d7ff; background: #f8fbff; }
    .pulse-account small { display: block; margin-top: 4px; color: var(--muted); line-height: 1.35; }
    .risk-dot { width: 10px; height: 10px; border-radius: 999px; box-shadow: 0 0 0 4px rgba(95,99,104,.12); }
    .risk-dot.low, .risk-meter.low { background: #e6f4ea; color: var(--green); }
    .risk-dot.medium, .risk-meter.medium { background: #fef7e0; color: #b06000; }
    .risk-dot.high, .risk-meter.high { background: #feefc3; color: var(--orange); }
    .risk-dot.critical, .risk-meter.critical { background: #fce8e6; color: var(--red); }
    .risk-dot.low { background: var(--green); }
    .risk-dot.medium { background: var(--yellow); }
    .risk-dot.high { background: var(--orange); }
    .risk-dot.critical { background: var(--red); }
    .pulse-hero-card { display: flex; justify-content: space-between; align-items: center; gap: 18px; margin-bottom: 18px; }
    .risk-meter { min-width: 132px; padding: 16px; border-radius: 14px; display: grid; justify-items: center; gap: 3px; }
    .risk-meter strong { font-size: 38px; line-height: 1; }
    .risk-meter span { font-size: 12px; font-weight: 800; text-transform: uppercase; }
    .action-copy { font-size: 18px; line-height: 1.45; margin: 0; }
    .signal-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .signal-row span { border-radius: 999px; padding: 5px 10px; background: #eef4ff; color: #174ea6; font-size: 12px; font-weight: 700; }
    .pulse-message { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--line); border-left: 4px solid var(--green); border-radius: 12px; background: #fff; }
    .pulse-message.medium { border-left-color: var(--yellow); }
    .pulse-message.high { border-left-color: var(--orange); }
    .pulse-message.critical { border-left-color: var(--red); }
    .pulse-message p { margin: 0; line-height: 1.45; }
    .pulse-message small { color: var(--muted); line-height: 1.4; }
    .pulse-message-head { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 12px; }
    .pulse-message-head strong { color: var(--text); }
    .pulse-note { padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: #fbfdff; }
    .pulse-note p { margin: 6px 0; line-height: 1.45; }
    .pulse-note small { color: var(--muted); }
    .splitit-layout { display: grid; grid-template-columns: 360px minmax(0, 1fr); gap: 16px; align-items: start; }
    .splitit-stats { grid-template-columns: repeat(3, 1fr); }
    .splitit-chat-list { display: grid; gap: 8px; }
    .splitit-job { display: grid; grid-template-columns: 12px 1fr; gap: 10px; align-items: center; padding: 12px; border: 1px solid var(--line); border-radius: 8px; color: var(--text); text-decoration: none; background: #fff; }
    .splitit-job:hover, .splitit-job.active { border-color: #c2d7ff; background: #f8fbff; }
    .splitit-job small { display: block; margin-top: 3px; color: var(--muted); text-transform: capitalize; }
    .agent-light { width: 10px; height: 10px; border-radius: 999px; display: inline-block; box-shadow: 0 0 0 3px rgba(95, 99, 104, .12); }
    .agent-light.live { background: var(--green); box-shadow: 0 0 0 3px rgba(24, 128, 56, .14); }
    .agent-light.off { background: var(--red); box-shadow: 0 0 0 3px rgba(217, 48, 37, .14); }
    .agent-state { display: inline-flex; align-items: center; gap: 8px; border-radius: 999px; padding: 6px 10px; font-size: 12px; font-weight: 700; background: #f1f3f4; color: #3c4043; }
    .agent-state.live { background: #e6f4ea; color: var(--green); }
    .agent-state.off { background: #fce8e6; color: var(--red); }
    .splitit-meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 14px; }
    .splitit-meta span { display: grid; gap: 4px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); text-transform: capitalize; }
    .splitit-meta strong { color: var(--text); font-size: 12px; text-transform: uppercase; }
    .splitit-transcript { display: grid; gap: 10px; max-height: 560px; overflow: auto; padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: #f8fafd; margin-bottom: 14px; }
    .splitit-message { display: flex; }
    .splitit-message.agent, .splitit-message.csm { justify-content: flex-end; }
    .splitit-message.splitit, .splitit-message.system { justify-content: flex-start; }
    .bubble { max-width: min(680px, 88%); padding: 10px 12px; border-radius: 8px; background: #fff; border: 1px solid var(--line); }
    .splitit-message.agent .bubble { background: #e8f0fe; border-color: #d2e3fc; }
    .splitit-message.csm .bubble { background: #e6f4ea; border-color: #ceead6; }
    .splitit-message.splitit .bubble { background: #fff; }
    .splitit-message.system .bubble { background: #f1f3f4; }
    .bubble strong { display: block; margin-bottom: 5px; font-size: 12px; text-transform: capitalize; color: var(--muted); }
    .bubble p { margin: 0; white-space: pre-wrap; }
    .bubble small { display: block; margin-top: 7px; color: var(--muted); font-size: 11px; }
    .manual-message { display: grid; gap: 10px; }
    .business-inline { display: grid; grid-template-columns: minmax(140px, 1fr) minmax(130px, 1fr) minmax(180px, 1fr) auto; gap: 8px; align-items: center; min-width: 720px; }
    .business-list { display: grid; gap: 8px; min-width: 260px; }
    .business-pill { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: #fbfdff; }
    .business-pill span { display: grid; gap: 4px; }
    .ok-text { color: var(--green); }
    .danger-text { color: var(--red); }
    .table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
    .compact-table { margin-top: 6px; }
    .compact-table table { min-width: 0; }
    table { width: 100%; border-collapse: collapse; min-width: 980px; }
    th, td { padding: 12px 14px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
    th { background: #f8fafd; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0; font-weight: 700; }
    tr:hover td { background: #fbfdff; }
    tr:last-child td { border-bottom: 0; }
    .table-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    code { background: #f1f3f4; border-radius: 6px; padding: 2px 6px; font-size: 12px; color: #3c4043; }
    .pill, .role-chip { display: inline-flex; align-items: center; border-radius: 999px; padding: 3px 9px; background: #f1f3f4; color: #3c4043; font-size: 12px; font-weight: 700; text-transform: capitalize; }
    .pill.ok { background: #e6f4ea; color: var(--green); }
    .pill.warning { background: #fef7e0; color: #b06000; }
    .role-chip { background: #e8f0fe; color: #174ea6; }
    .login-panel { max-width: 440px; margin: 15vh auto 0; }
    .login { display: grid; gap: 14px; margin-top: 18px; }
    @media (max-width: 1000px) { .stat-grid { grid-template-columns: repeat(3, 1fr); } }
    @media (max-width: 820px) { main { width: min(100vw - 24px, 1180px); padding-top: 20px; } .hero, .panel-head, .pulse-hero-card { align-items: stretch; flex-direction: column; } .grid, .splitit-layout, .pulse-layout { grid-template-columns: 1fr; } .pulse-sidebar { position: static; } .stat-row, .stat-grid, .splitit-meta, .business-inline { grid-template-columns: 1fr; min-width: 0; } }
  `;
}
