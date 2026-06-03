import { createServer, IncomingMessage, ServerResponse } from "http";
import { createHmac, timingSafeEqual } from "crypto";
import { WebClient } from "@slack/web-api";
import type { RequestStatus, RequestType, UserRole } from "@prisma/client";
import { config } from "../lib/config";
import { parseDueDate } from "../lib/dates";
import { logger } from "../lib/logger";
import { canManageRequest, isAdmin } from "../lib/permissions";
import { prisma } from "../lib/prisma";
import { getOpenAiSettingsStatus, saveOpenAiSettings } from "../services/appSettingsService";
import { mapChannelOwner } from "../services/channelOwnerService";
import {
  addInternalNote,
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
import { ensureChannel, ensureUser, setUserRole } from "../services/userService";
import { helpBlocks, inputModal, requestCreateModal, requestDetailModal, requestListBlocks } from "../slack/blocks";
import { statusLabel, typeLabel } from "../slack/format";
import {
  notifyOwnerRequestCreated,
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
  ownerSlackUserId: string | null;
  members: DashboardUser[];
  openRequests: number;
  totalRequests: number;
};

type DashboardUser = {
  slackUserId: string;
  name: string | null;
  role: UserRole;
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
    redirect(res, `/dashboard/metrics${url.search ? url.search : ""}`);
    return;
  }

  if (req.method === "GET" && url.pathname === "/dashboard/metrics") {
    await renderMetrics(res, url.searchParams.get("notice") ?? "");
    return;
  }

  if (req.method === "GET" && url.pathname === "/dashboard/channels") {
    await renderChannels(res, url.searchParams.get("notice") ?? "");
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

  if (req.method === "POST" && url.pathname === "/dashboard/csms") {
    const body = await readForm(req);
    const slackUserId = normalizeSlackUserId(body.get("slackUserId") ?? "");
    const name = (body.get("name") ?? "").trim() || (await fetchSlackUserName(slackUserId)) || undefined;
    if (slackUserId) await ensureUser(slackUserId, name, false, "CSM");
    redirect(res, "/dashboard/channels?notice=CSM added");
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

  if (req.method === "POST" && url.pathname === "/dashboard/users/role") {
    const body = await readForm(req);
    const slackUserId = normalizeSlackUserId(body.get("slackUserId") ?? "");
    const role = normalizeUserRole(body.get("role") ?? "");
    if (slackUserId && role) await setUserRole(slackUserId, role, await fetchSlackUserName(slackUserId) ?? undefined);
    redirect(res, "/dashboard/settings?notice=User role updated");
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/channel-owner") {
    const body = await readForm(req);
    const channelId = (body.get("channelId") ?? "").trim();
    const ownerSlackUserId = normalizeSlackUserId(body.get("ownerSlackUserId") ?? "");
    await ensureNamedUser(ownerSlackUserId);
    if (channelId && ownerSlackUserId) await mapChannelOwner(channelId, ownerSlackUserId);
    redirect(res, "/dashboard/channels?notice=Channel owner updated");
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
        await slack.views.open({
          trigger_id: body.get("trigger_id") ?? "",
          view: requestCreateModal({ channelId, initialDescription: text }) as any
        });
        sendText(res, 200, "");
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
    const dueDateInput = modalValue(view, "dueDate").trim();
    const blocker = modalValue(view, "blocker").trim();
    const dueDate = dueDateInput ? parseDueDate(dueDateInput) : null;

    const errors: Record<string, string> = {};
    if (!title) errors.title = "Add a short title.";
    if (!description) errors.description = "Add request details.";
    if (dueDateInput && !dueDate) errors.dueDate = "Use yyyy-mm-dd or mm/dd/yyyy.";

    if (Object.keys(errors).length) {
      sendSlackJson(res, { response_action: "errors", errors });
      return;
    }

    sendText(res, 200, "");

    const metadata = JSON.parse(view.private_metadata || "{}");
    const channelId = metadata.channelId;
    if (!channelId) throw new Error("Missing channel ID in request_create metadata");

    const request = await createRequestFromManualInput({
      title,
      description,
      type: type || "OTHER",
      requesterSlackUserId: actorSlackUserId,
      channelId,
      dueDate,
      blocker
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
  const [channels, csms, requestStats] = await Promise.all([loadChannels(), loadCsms(), loadRequestStats()]);

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
        ${statCard("CSMs", csms.length)}
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

async function renderChannels(res: ServerResponse, notice: string) {
  const [channels, users] = await Promise.all([loadChannels(), loadUsers()]);

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
          <p class="muted">Sync Slack channels, see who is inside each channel, and assign a CSM owner from the channel member list.</p>
        </div>
        <form method="post" action="/dashboard/sync">
          <button type="submit">Sync Slack channels</button>
        </form>
      </section>
      ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
      <section class="grid">
        <div class="panel">
          <h2>Add CSM</h2>
          <form class="stack" method="post" action="/dashboard/csms">
            <label>Slack user ID
              <input name="slackUserId" placeholder="U123ABC" required />
            </label>
            <label>Name
              <input name="name" placeholder="Optional, auto-filled from Slack when possible" />
            </label>
            <button type="submit">Whitelist CSM</button>
          </form>
        </div>
        <div class="panel stat-row">
          <div>
            <span class="stat">${channels.length}</span>
            <span class="muted">channels</span>
          </div>
          <div>
            <span class="stat">${users.filter((user) => user.role === "CSM" || user.role === "ADMIN").length}</span>
            <span class="muted">CSMs/admins</span>
          </div>
          <div>
            <span class="stat">${channels.reduce((sum, channel) => sum + channel.openRequests, 0)}</span>
            <span class="muted">open requests</span>
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head">
          <h2>Channels</h2>
          <span class="muted">Assign ownership directly from the table.</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Slack ID</th>
                <th>Owner</th>
                <th>Members</th>
                <th>Open</th>
                <th>Total</th>
                <th>Assign</th>
              </tr>
            </thead>
            <tbody>
              ${channels.map((channel) => channelRow(channel, users)).join("")}
            </tbody>
          </table>
        </div>
      </section>
      `
    )
  );
}

async function renderSettings(res: ServerResponse, notice: string) {
  const [openAi, users] = await Promise.all([getOpenAiSettingsStatus(), loadUsers()]);

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
          <p class="muted">Manage AI enrichment and assign lightweight roles for people in customer channels.</p>
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
        <div class="panel">
          <div class="panel-head">
            <h2>Add person</h2>
            <span class="muted">Create or update role</span>
          </div>
          <form class="stack" method="post" action="/dashboard/users/role">
            <label>Slack user ID
              <input name="slackUserId" placeholder="U123ABC" required />
            </label>
            <label>Role
              ${roleSelect("role", "REQUESTER")}
            </label>
            <button type="submit">Save role</button>
          </form>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head">
          <h2>People</h2>
          <span class="muted">Roles are intentionally simple for now.</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Slack ID</th>
                <th>Role</th>
                <th>Update</th>
              </tr>
            </thead>
            <tbody>${users.map(userRow).join("")}</tbody>
          </table>
        </div>
      </section>
      `
    )
  );
}

function nav(active: "metrics" | "channels" | "settings") {
  return `
    <nav class="top-nav">
      <a class="${active === "metrics" ? "active" : ""}" href="/dashboard/metrics">Metrics</a>
      <a class="${active === "channels" ? "active" : ""}" href="/dashboard/channels">Channels</a>
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

function channelRow(channel: DashboardChannel, users: DashboardUser[]) {
  const displayName = channel.companyName ?? channel.name ?? channel.slackChannelId;
  const owner = users.find((user) => user.slackUserId === channel.ownerSlackUserId);
  const assignable = channel.members.length ? channel.members : users.filter((user) => user.role === "CSM" || user.role === "ADMIN");
  return `
    <tr>
      <td><strong>${escapeHtml(displayName)}</strong></td>
      <td><code>${escapeHtml(channel.slackChannelId)}</code></td>
      <td>${owner ? `${escapeHtml(userLabel(owner))}<br /><span class="role-chip">${roleLabel(owner.role)}</span>` : channel.ownerSlackUserId ? `<code>${escapeHtml(channel.ownerSlackUserId)}</code>` : `<span class="muted">Unassigned</span>`}</td>
      <td>${memberPreview(channel.members)}</td>
      <td>${channel.openRequests}</td>
      <td>${channel.totalRequests}</td>
      <td>
        <form class="inline" method="post" action="/dashboard/channel-owner">
          <input type="hidden" name="channelId" value="${escapeHtml(channel.slackChannelId)}" />
          <select name="ownerSlackUserId" required>
            <option value="">Select CSM</option>
            ${assignable.map((user) => `<option value="${escapeHtml(user.slackUserId)}" ${user.slackUserId === channel.ownerSlackUserId ? "selected" : ""}>${escapeHtml(userLabel(user))}</option>`).join("")}
          </select>
          <button type="submit">Save</button>
        </form>
      </td>
    </tr>
  `;
}

function userRow(user: DashboardUser) {
  return `
    <tr>
      <td><strong>${escapeHtml(user.name ?? "Unknown")}</strong></td>
      <td><code>${escapeHtml(user.slackUserId)}</code></td>
      <td><span class="role-chip">${roleLabel(user.role)}</span></td>
      <td>
        <form class="inline" method="post" action="/dashboard/users/role">
          <input type="hidden" name="slackUserId" value="${escapeHtml(user.slackUserId)}" />
          ${roleSelect("role", user.role)}
          <button type="submit">Save</button>
        </form>
      </td>
    </tr>
  `;
}

function userLabel(user: DashboardUser) {
  return user.name ? `${user.name} (${user.slackUserId})` : user.slackUserId;
}

function memberPreview(members: DashboardUser[]) {
  if (!members.length) return `<span class="muted">Not synced</span>`;
  const preview = members.slice(0, 3).map((member) => escapeHtml(member.name ?? member.slackUserId)).join(", ");
  const extra = members.length > 3 ? ` +${members.length - 3}` : "";
  return `${preview}${extra}<br /><span class="muted">${members.length} member${members.length === 1 ? "" : "s"}</span>`;
}

function roleSelect(name: string, selected: UserRole) {
  const roles: UserRole[] = ["ADMIN", "CSM", "SALES_REP", "REQUESTER"];
  return `<select name="${name}" required>${roles.map((role) => `<option value="${role}" ${role === selected ? "selected" : ""}>${roleLabel(role)}</option>`).join("")}</select>`;
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
        ownerSlackUserId: channel.ownerMapping?.ownerSlackUserId ?? null,
        members: channel.members.map((member) => ({
          slackUserId: member.user.slackUserId,
          name: member.user.name,
          role: member.user.role
        })),
        openRequests,
        totalRequests
      };
    })
  );
}

async function loadCsms() {
  return prisma.user.findMany({
    where: { OR: [{ role: "CSM" }, { role: "ADMIN" }, { isAdmin: true }] },
    orderBy: [{ name: "asc" }, { slackUserId: "asc" }],
    select: { slackUserId: true, name: true, role: true }
  });
}

async function loadUsers() {
  return prisma.user.findMany({
    orderBy: [{ role: "asc" }, { name: "asc" }, { slackUserId: "asc" }],
    select: { slackUserId: true, name: true, role: true }
  });
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

  await prisma.channelMember.deleteMany({ where: { slackChannelId } });

  for (const slackUserId of memberIds) {
    if (!slackUserId) continue;
    await ensureNamedUser(slackUserId);
    await prisma.channelMember.upsert({
      where: { slackChannelId_slackUserId: { slackChannelId, slackUserId } },
      update: {},
      create: { slackChannelId, slackUserId }
    });
  }
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
    :root { color-scheme: light; --bg:#f8fafd; --text:#202124; --muted:#5f6368; --line:#dadce0; --panel:#ffffff; --blue:#1a73e8; --blue-dark:#185abc; --green:#188038; --yellow:#fbbc04; --red:#d93025; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { width: min(1240px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0 56px; }
    .hero { display: flex; align-items: end; justify-content: space-between; gap: 24px; padding: 4px 0 22px; }
    .top-nav { display: flex; gap: 4px; margin-bottom: 22px; border-bottom: 1px solid var(--line); }
    .top-nav a { color: var(--muted); text-decoration: none; padding: 12px 14px; border-bottom: 3px solid transparent; font-weight: 600; border-radius: 8px 8px 0 0; }
    .top-nav a:hover { background: #eef4ff; color: var(--blue-dark); }
    .top-nav a.active { color: var(--blue); border-bottom-color: var(--blue); }
    .button-link { display: inline-flex; align-items: center; min-height: 38px; border-radius: 8px; padding: 8px 14px; background: var(--blue); color: white; text-decoration: none; font-weight: 700; }
    .eyebrow { color: var(--blue); font-weight: 700; margin: 0 0 8px; text-transform: uppercase; font-size: 12px; letter-spacing: 0; }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 34px; line-height: 1.12; font-weight: 750; }
    h2 { font-size: 18px; }
    .muted { color: var(--muted); }
    .notice { background: #e8f0fe; border: 1px solid #d2e3fc; padding: 12px 14px; border-radius: 8px; margin-bottom: 16px; color: #174ea6; }
    .grid { display: grid; grid-template-columns: 360px 1fr; gap: 16px; margin-bottom: 16px; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; box-shadow: 0 1px 2px rgba(60, 64, 67, .12); }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
    .stack { display: grid; gap: 12px; margin-top: 14px; }
    .inline { display: grid; grid-template-columns: minmax(150px, 1fr) auto; gap: 8px; align-items: center; }
    .check-row { display: flex; grid-template-columns: none; align-items: center; gap: 8px; }
    .check-row input { width: auto; min-height: auto; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; }
    input, select { width: 100%; min-height: 38px; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: #fff; color: var(--text); font: inherit; outline-color: var(--blue); }
    button { min-height: 38px; border: 0; border-radius: 8px; padding: 8px 14px; background: var(--blue); color: white; font-weight: 700; cursor: pointer; box-shadow: 0 1px 1px rgba(60, 64, 67, .18); }
    button:hover { background: var(--blue-dark); }
    .stat-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; align-items: center; }
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
    .table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; min-width: 980px; }
    th, td { padding: 12px 14px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
    th { background: #f8fafd; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0; font-weight: 700; }
    tr:hover td { background: #fbfdff; }
    tr:last-child td { border-bottom: 0; }
    code { background: #f1f3f4; border-radius: 6px; padding: 2px 6px; font-size: 12px; color: #3c4043; }
    .pill, .role-chip { display: inline-flex; align-items: center; border-radius: 999px; padding: 3px 9px; background: #f1f3f4; color: #3c4043; font-size: 12px; font-weight: 700; text-transform: capitalize; }
    .pill.ok { background: #e6f4ea; color: var(--green); }
    .role-chip { background: #e8f0fe; color: #174ea6; }
    .login-panel { max-width: 440px; margin: 15vh auto 0; }
    .login { display: grid; gap: 14px; margin-top: 18px; }
    @media (max-width: 1000px) { .stat-grid { grid-template-columns: repeat(3, 1fr); } }
    @media (max-width: 820px) { main { width: min(100vw - 24px, 1180px); padding-top: 20px; } .hero, .panel-head { align-items: stretch; flex-direction: column; } .grid { grid-template-columns: 1fr; } .stat-row, .stat-grid { grid-template-columns: 1fr; } }
  `;
}
