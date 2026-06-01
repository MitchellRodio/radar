import { createServer, IncomingMessage, ServerResponse } from "http";
import { WebClient } from "@slack/web-api";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { mapChannelOwner } from "../services/channelOwnerService";
import { ensureChannel, ensureUser } from "../services/userService";

const slack = new WebClient(config.SLACK_BOT_TOKEN);

type DashboardChannel = {
  slackChannelId: string;
  name: string | null;
  companyName: string | null;
  ownerSlackUserId: string | null;
  openRequests: number;
  totalRequests: number;
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
    await renderDashboard(res, url.searchParams.get("notice") ?? "");
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/sync") {
    await syncSlackChannels();
    redirect(res, "/dashboard?notice=Channels synced from Slack");
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/csms") {
    const body = await readForm(req);
    const slackUserId = normalizeSlackUserId(body.get("slackUserId") ?? "");
    const name = (body.get("name") ?? "").trim() || undefined;
    if (slackUserId) await ensureUser(slackUserId, name);
    redirect(res, "/dashboard?notice=CSM added");
    return;
  }

  if (req.method === "POST" && url.pathname === "/dashboard/channel-owner") {
    const body = await readForm(req);
    const channelId = (body.get("channelId") ?? "").trim();
    const ownerSlackUserId = normalizeSlackUserId(body.get("ownerSlackUserId") ?? "");
    if (channelId && ownerSlackUserId) await mapChannelOwner(channelId, ownerSlackUserId);
    redirect(res, "/dashboard?notice=Channel owner updated");
    return;
  }

  sendText(res, 404, "Not found");
}

async function renderDashboard(res: ServerResponse, notice: string) {
  const [channels, csms] = await Promise.all([loadChannels(), loadCsms()]);

  sendHtml(
    res,
    200,
    page(
      "Radar Dashboard",
      `
      <section class="hero">
        <div>
          <p class="eyebrow">Whop CSM Slack bot</p>
          <h1>Channel ownership</h1>
          <p class="muted">Manage the channels the bot knows about, whitelist CSM Slack IDs, and assign each channel to a CSM.</p>
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
              <input name="name" placeholder="Mitchell" />
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
            <span class="stat">${csms.length}</span>
            <span class="muted">CSMs</span>
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
                <th>Open</th>
                <th>Total</th>
                <th>Assign</th>
              </tr>
            </thead>
            <tbody>
              ${channels.map((channel) => channelRow(channel, csms)).join("")}
            </tbody>
          </table>
        </div>
      </section>
      `
    )
  );
}

function channelRow(channel: DashboardChannel, csms: Array<{ slackUserId: string; name: string | null }>) {
  const displayName = channel.companyName ?? channel.name ?? channel.slackChannelId;
  return `
    <tr>
      <td><strong>${escapeHtml(displayName)}</strong></td>
      <td><code>${escapeHtml(channel.slackChannelId)}</code></td>
      <td>${channel.ownerSlackUserId ? `<code>${escapeHtml(channel.ownerSlackUserId)}</code>` : `<span class="muted">Unassigned</span>`}</td>
      <td>${channel.openRequests}</td>
      <td>${channel.totalRequests}</td>
      <td>
        <form class="inline" method="post" action="/dashboard/channel-owner">
          <input type="hidden" name="channelId" value="${escapeHtml(channel.slackChannelId)}" />
          <select name="ownerSlackUserId" required>
            <option value="">Select CSM</option>
            ${csms.map((csm) => `<option value="${escapeHtml(csm.slackUserId)}" ${csm.slackUserId === channel.ownerSlackUserId ? "selected" : ""}>${escapeHtml(csm.name ?? csm.slackUserId)}</option>`).join("")}
          </select>
          <button type="submit">Save</button>
        </form>
      </td>
    </tr>
  `;
}

async function loadChannels(): Promise<DashboardChannel[]> {
  const channels = await prisma.channel.findMany({
    include: { ownerMapping: true },
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
        openRequests,
        totalRequests
      };
    })
  );
}

async function loadCsms() {
  return prisma.user.findMany({
    orderBy: [{ name: "asc" }, { slackUserId: "asc" }],
    select: { slackUserId: true, name: true }
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
    }

    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);
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
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function normalizeSlackUserId(value: string) {
  return value.trim().match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/)?.[1] ?? value.trim();
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(303, { Location: location });
  res.end();
}

function sendText(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendHtml(res: ServerResponse, status: number, html: string) {
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
    :root { color-scheme: light; --bg:#f6f7f9; --text:#19202a; --muted:#667085; --line:#d7dde6; --panel:#ffffff; --accent:#256f5c; --accent-strong:#174d40; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; padding: 32px 0 56px; }
    .hero { display: flex; align-items: end; justify-content: space-between; gap: 24px; padding: 10px 0 24px; }
    .eyebrow { color: var(--accent); font-weight: 700; margin: 0 0 8px; text-transform: uppercase; font-size: 12px; letter-spacing: 0; }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 34px; line-height: 1.1; }
    h2 { font-size: 18px; }
    .muted { color: var(--muted); }
    .notice { background: #e8f4ef; border: 1px solid #b8dccf; padding: 12px 14px; border-radius: 8px; margin-bottom: 16px; color: var(--accent-strong); }
    .grid { display: grid; grid-template-columns: 360px 1fr; gap: 16px; margin-bottom: 16px; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; box-shadow: 0 1px 2px rgba(16, 24, 40, .04); }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
    .stack { display: grid; gap: 12px; margin-top: 14px; }
    .inline { display: grid; grid-template-columns: minmax(150px, 1fr) auto; gap: 8px; align-items: center; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; }
    input, select { width: 100%; min-height: 38px; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: #fff; color: var(--text); font: inherit; }
    button { min-height: 38px; border: 0; border-radius: 8px; padding: 8px 13px; background: var(--accent); color: white; font-weight: 700; cursor: pointer; }
    button:hover { background: var(--accent-strong); }
    .stat-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; align-items: center; }
    .stat { display: block; font-size: 32px; font-weight: 800; margin-bottom: 4px; }
    .table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; min-width: 860px; }
    th, td { padding: 12px 14px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
    th { background: #f9fafb; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0; }
    tr:last-child td { border-bottom: 0; }
    code { background: #eef1f5; border-radius: 6px; padding: 2px 6px; font-size: 12px; }
    .login-panel { max-width: 440px; margin: 15vh auto 0; }
    .login { display: grid; gap: 14px; margin-top: 18px; }
    @media (max-width: 820px) { main { width: min(100vw - 24px, 1180px); padding-top: 20px; } .hero, .panel-head { align-items: stretch; flex-direction: column; } .grid { grid-template-columns: 1fr; } .stat-row { grid-template-columns: 1fr; } }
  `;
}
