import { createServer, IncomingMessage, ServerResponse } from "http";
import { chromium, BrowserContext, Page } from "playwright";
import { z } from "zod";

const config = {
  port: Number(process.env.PORT ?? 3000),
  secret: process.env.SPLITIT_AGENT_SECRET ?? "",
  userDataDir: process.env.SPLITIT_AGENT_USER_DATA_DIR ?? "/data/splitit-browser",
  headless: (process.env.SPLITIT_AGENT_HEADLESS ?? "true") !== "false",
  minActionDelayMs: Number(process.env.SPLITIT_AGENT_MIN_ACTION_DELAY_MS ?? 3500),
  maxActionDelayMs: Number(process.env.SPLITIT_AGENT_MAX_ACTION_DELAY_MS ?? 7000)
};

const executeSchema = z.object({
  jobId: z.string().min(1),
  requestId: z.number().optional(),
  targetEmail: z.string().optional(),
  splititUrl: z.string().default("https://www.splitit.com/contact/"),
  action: z.enum(["run_script", "manual_message"]).default("run_script"),
  message: z.string().optional(),
  conversationPlan: z.array(z.object({
    step: z.string(),
    waitFor: z.string(),
    send: z.string()
  })).default([]),
  messages: z.array(z.string()).default([])
});

type ExecutePayload = z.infer<typeof executeSchema>;

type Session = {
  jobId: string;
  context: BrowserContext;
  page: Page;
  status: "live" | "done" | "blocked";
  lastResponse: string;
  sentMessages: string[];
  events: string[];
  updatedAt: Date;
};

const sessions = new Map<string, Session>();

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    sendJson(res, 500, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(config.port, () => {
  console.log(`Splitit browser agent listening on ${config.port}`);
});

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    sendText(res, 200, "ok");
    return;
  }

  if (url.pathname === "/splitit/execute" && req.method === "POST") {
    requireSecret(req, url);
    const payload = executeSchema.parse(JSON.parse(await readBody(req) || "{}"));
    const result = await executeSafely(payload);
    sendJson(res, 200, result);
    return;
  }

  const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
  if (sessionMatch && req.method === "GET") {
    requireSecret(req, url);
    renderSession(res, decodeURIComponent(sessionMatch[1]));
    return;
  }

  const screenshotMatch = url.pathname.match(/^\/sessions\/([^/]+)\/screenshot$/);
  if (screenshotMatch && req.method === "GET") {
    requireSecret(req, url);
    await renderScreenshot(res, decodeURIComponent(screenshotMatch[1]));
    return;
  }

  sendText(res, 404, "Not found");
}

async function execute(payload: ExecutePayload) {
  const session = await getOrCreateSession(payload);

  if (payload.action === "manual_message") {
    if (!payload.message?.trim()) return { status: "blocked", error: "Manual message is blank." };
    await sendChatMessage(session, payload.message.trim());
    const response = await waitForLatestSplititResponse(session);
    return {
      status: "waiting",
      sentMessages: [payload.message.trim()],
      response
    };
  }

  const plan = payload.conversationPlan.length
    ? payload.conversationPlan
    : payload.messages.map((message, index) => ({ step: `STEP_${index + 1}`, waitFor: "next Splitit prompt", send: message }));

  if (!plan.length) {
    await waitForChatReady(session);
    return {
      status: "waiting",
      sentMessages: [],
      response: "Chat opened."
    };
  }

  const sentMessages = await answerSplititPrompts(session, plan);
  const response = await waitForLatestSplititResponse(session);
  return {
    status: responseLooksDone(response) ? "done" : "waiting",
    sentMessages,
    response
  };
}

async function answerSplititPrompts(session: Session, plan: ExecutePayload["conversationPlan"]) {
  const sentMessages: string[] = [];
  const maxTurns = Math.max(plan.length + 2, 6);

  for (let turn = 0; turn < maxTurns; turn += 1) {
    await waitForChatReady(session);
    const prompt = await waitForLatestSplititResponse(session);
    const next = chooseSplititResponse(prompt, plan, sentMessages);

    if (!next) {
      log(session, `No scripted answer matched prompt: ${prompt}`);
      break;
    }

    await humanDelay(session, `Preparing to send ${next.step}`);
    await sendChatMessage(session, next.send);
    sentMessages.push(next.send);
    log(session, `Sent ${next.step}: ${next.send}`);

    const response = await waitForLatestSplititResponse(session);
    if (responseLooksDone(response)) break;
  }

  return sentMessages;
}

function chooseSplititResponse(prompt: string, plan: ExecutePayload["conversationPlan"], sentMessages: string[]) {
  const normalizedPrompt = prompt.toLowerCase();
  const byStep = Object.fromEntries(plan.map((step) => [step.step, step]));
  const name = byStep.SENT_NAME;
  const role = byStep.SENT_ROLE;
  const storeAndEmail = byStep.SENT_STORE_AND_EMAIL;
  const whitelist = byStep.SENT_WHITELIST_REQUEST;
  const wasSent = (step?: { send: string }) => Boolean(step && sentMessages.some((message) => message.includes(step.send)));

  if (/(merchant|shopper|customer).{0,80}(confirm|whether|are you|you're|you are)|confirm.{0,80}(merchant|shopper|customer)/i.test(prompt)) {
    if (role && !wasSent(role)) return role;
  }

  const asksName = /\b(name|speaking with|who am i|who are we chatting|who is chatting)\b/i.test(prompt);
  const asksStore = /\b(store|business|company)\b/i.test(prompt);
  const asksMerchantEmail = /\b(email|merchant account)\b/i.test(prompt);

  if ((asksStore || asksMerchantEmail) && storeAndEmail && !wasSent(storeAndEmail)) {
    if (asksName && name && !wasSent(name)) {
      return {
        step: "SENT_NAME_STORE_AND_EMAIL",
        waitFor: "Splitit asks for name, store name, and merchant email",
        send: `${name.send} ${storeAndEmail.send}`
      };
    }
    return storeAndEmail;
  }

  if (asksName && name && !wasSent(name)) return name;

  if (/(how can i assist|how can i help|what can i help|what do you need|assist you with|account today|support question)/i.test(prompt)) {
    return wasSent(whitelist) ? undefined : whitelist;
  }

  if (/whitelist|risk|email to whitelist/i.test(prompt)) return wasSent(whitelist) ? undefined : whitelist;

  if (!sentMessages.length && normalizedPrompt.includes("splitit support")) return name;

  return undefined;
}

async function executeSafely(payload: ExecutePayload) {
  try {
    return await execute(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const session = sessions.get(payload.jobId);
    if (session) {
      session.status = "live";
      session.updatedAt = new Date();
      log(session, `Paused: ${message}`);
    }
    console.error(JSON.stringify({ jobId: payload.jobId, error: message }));
    return {
      status: "waiting",
      sentMessages: [],
      response: `Executor paused: ${message}`,
      error: message
    };
  }
}

async function getOrCreateSession(payload: ExecutePayload) {
  const existing = sessions.get(payload.jobId);
  if (existing && existing.status === "live" && !existing.page.isClosed()) {
    existing.updatedAt = new Date();
    return existing;
  }

  const context = await chromium.launchPersistentContext(`${config.userDataDir}/${payload.jobId}`, {
    headless: config.headless,
    viewport: { width: 1440, height: 1000 }
  });
  const page = context.pages()[0] ?? await context.newPage();
  const session: Session = {
    jobId: payload.jobId,
    context,
    page,
    status: "live",
    lastResponse: "",
    sentMessages: [],
    events: [],
    updatedAt: new Date()
  };
  sessions.set(payload.jobId, session);

  log(session, `Opening ${payload.splititUrl}`);
  await page.goto(payload.splititUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  await acceptCookieBanner(session);
  await humanDelay(session, "Waiting before opening chat");
  await clickChatLauncher(session);
  return session;
}

async function acceptCookieBanner(session: Session) {
  await session.page.waitForTimeout(2500);

  if (!(await cookieBannerVisible(session.page))) {
    log(session, "Cookie banner not visible");
    return;
  }

  const selectors = [
    "button:has-text('Accept all')",
    "button:has-text('Accept All')",
    "[role='button']:has-text('Accept all')",
    "#onetrust-accept-btn-handler",
    "[id*='accept'][id*='cookie' i]",
    "[class*='accept'][class*='cookie' i]"
  ];

  for (const selector of selectors) {
    const locator = session.page.locator(selector).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 1500 });
      await humanDelay(session, `Accepting cookie banner with ${selector}`);
      await locator.click({ timeout: 3000 });
      log(session, `Accepted cookie banner: ${selector}`);
      await session.page.waitForTimeout(2500);
      if (!(await cookieBannerVisible(session.page))) return;
    } catch {
      // Try the next common cookie accept selector.
    }
  }

  for (const frame of session.page.frames()) {
    try {
      const clicked = await frame.evaluate(() => {
        const elements = Array.from(document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']"));
        const target = elements.find((element) => /accept all/i.test((element.textContent || (element as HTMLInputElement).value || "").trim()));
        if (!target) return false;
        (target as HTMLElement).click();
        return true;
      });
      if (clicked) {
        log(session, "Accepted cookie banner inside frame");
        await session.page.waitForTimeout(3000);
        if (!(await cookieBannerVisible(session.page))) return;
      }
    } catch {
      // Try the next frame.
    }
  }

  const visibleText = await collectVisibleText(session.page).catch(() => "");
  if (/our cookies|accept all/i.test(visibleText)) {
    await clickCookieAcceptByGeometry(session);
    if (!(await cookieBannerVisible(session.page))) return;
  }

  if (await cookieBannerVisible(session.page)) {
    await removeCookieBanner(session);
  }

  if (await cookieBannerVisible(session.page)) {
    throw new Error("Cookie banner is still visible; cannot open Splitit chat yet.");
  }
}

async function removeCookieBanner(session: Session) {
  log(session, "Removing cookie banner overlay fallback");
  for (const frame of session.page.frames()) {
    try {
      await frame.evaluate(() => {
        const elements = Array.from(document.querySelectorAll("body *"));
        const candidates = elements
          .map((element) => ({ element, rect: element.getBoundingClientRect(), text: element.textContent || "" }))
          .filter(({ rect, text }) => (
            /our cookies|manage cookies|accept all/i.test(text) &&
            rect.width > window.innerWidth * 0.45 &&
            rect.height > 60 &&
            rect.bottom > window.innerHeight * 0.65
          ))
          .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));

        if (candidates[0]) {
          candidates[0].element.remove();
          return;
        }
      });
    } catch {
      // Try the next frame.
    }
  }
  await session.page.waitForTimeout(1000);
}

async function clearBottomCookieBlocker(session: Session) {
  const viewport = session.page.viewportSize() ?? { width: 1440, height: 1000 };
  await session.page.waitForTimeout(1000);
  await humanDelay(session, "Clicking visible bottom cookie accept");
  await session.page.mouse.click(Math.round(viewport.width * 0.82), viewport.height - 52);
  await session.page.waitForTimeout(2500);
  await removeBottomOverlayByGeometry(session);
}

async function removeBottomOverlayByGeometry(session: Session) {
  log(session, "Removing bottom overlay by geometry fallback");
  for (const frame of session.page.frames()) {
    try {
      await frame.evaluate(() => {
        const removeBottomOverlays = (root: Document | ShadowRoot) => {
          const elements = Array.from(root.querySelectorAll("*"));
          for (const element of elements) {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            const zIndex = Number.parseInt(style.zIndex || "0", 10);
            const looksLikeBottomOverlay = (
              rect.width > window.innerWidth * 0.75 &&
              rect.height > 70 &&
              rect.height < window.innerHeight * 0.35 &&
              rect.bottom > window.innerHeight - 5 &&
              (style.position === "fixed" || style.position === "sticky" || zIndex > 10 || /cookie|consent|privacy/i.test(element.textContent || ""))
            );
            if (looksLikeBottomOverlay) {
              (element as HTMLElement).style.display = "none";
              (element as HTMLElement).style.pointerEvents = "none";
            }
            const shadowRoot = (element as HTMLElement).shadowRoot;
            if (shadowRoot) removeBottomOverlays(shadowRoot);
          }
        };
        removeBottomOverlays(document);
      });
    } catch {
      // Try the next frame.
    }
  }
  await session.page.waitForTimeout(1000);
}

async function clickCookieAcceptByGeometry(session: Session) {
  await humanDelay(session, "Accepting cookie banner by geometry");
  for (const frame of session.page.frames()) {
    try {
      const box = await frame.evaluate(() => {
        const elements = Array.from(document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit'], span, div"));
        const candidates = elements
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const text = ((element.textContent || (element as HTMLInputElement).value || "").trim()).replace(/\s+/g, " ");
            return { text, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          })
          .filter(({ text, width, height }) => /^accept all$/i.test(text) && width > 20 && height > 10);
        return candidates[candidates.length - 1] ?? null;
      });
      if (!box) continue;

      await session.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      log(session, `Clicked cookie accept geometry at ${Math.round(box.x + box.width / 2)},${Math.round(box.y + box.height / 2)}`);
      await session.page.waitForTimeout(3000);
      return;
    } catch {
      // Try the next frame.
    }
  }
}

async function clickChatLauncher(session: Session) {
  const page = session.page;
  await clickChatWithUsButton(session);
  if (await waitUntilChatInputVisible(page, 10_000)) return;

  const selectors = [
    "button[aria-label*='chat' i]",
    "button[aria-label*='message' i]",
    "[role='button'][aria-label*='chat' i]",
    "button:has-text('Chat with us')",
    "a:has-text('Chat with us')",
    "iframe[title*='chat' i]",
    ".intercom-launcher",
    "#intercom-container button",
    "[class*='chat'] button",
    "[class*='launcher']"
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 4000 });
      await humanDelay(session, `Clicking launcher selector ${selector}`);
      await locator.click({ timeout: 4000 });
      log(session, `Clicked chat launcher: ${selector}`);
      await page.waitForTimeout(4000);
      if (await waitUntilChatInputVisible(page, 7000)) return;
      log(session, `Launcher selector did not open an input: ${selector}`);
    } catch {
      // Try the next common chat selector.
    }
  }

  await clickBottomRightLauncher(session, "bottom-right launcher fallback");
  if (await waitUntilChatInputVisible(page, 7000)) return;

  const frames = page.frames();
  for (const frame of frames) {
    try {
      const button = frame.locator("button, [role='button']").first();
      await humanDelay(session, "Clicking iframe launcher fallback");
      await button.click({ timeout: 3000 });
      log(session, "Clicked chat launcher inside iframe");
      await page.waitForTimeout(4000);
      return;
    } catch {
      // Try the next frame.
    }
  }

  throw new Error("Could not find Splitit chat launcher.");
}

async function clickChatWithUsButton(session: Session) {
  await session.page.locator("text=Live chat").first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);
  await clearBottomCookieBlocker(session);
  await humanDelay(session, "Clicking Chat with us button");
  if (await clickElementByText(session, /^chat with us$/i, "Chat with us button")) return;

  const viewport = session.page.viewportSize() ?? { width: 1440, height: 1000 };
  await session.page.mouse.click(Math.floor(viewport.width * 0.75), Math.floor(viewport.height * 0.89));
  log(session, "Clicked Chat with us coordinate fallback");
  await session.page.waitForTimeout(5000);
}

async function clickBottomRightLauncher(session: Session, label: string) {
  const viewport = session.page.viewportSize() ?? { width: 1440, height: 1000 };
  await humanDelay(session, `Clicking ${label}`);
  await session.page.mouse.click(viewport.width - 28, viewport.height - 28);
  log(session, `Clicked ${label}`);
  await session.page.waitForTimeout(5000);
}

async function waitForChatReady(session: Session) {
  if (await waitUntilChatInputVisible(session.page, 20_000)) return;
  if (await cookieBannerVisible(session.page)) {
    await clearBottomCookieBlocker(session);
    await clickChatWithUsButton(session);
    if (await waitUntilChatInputVisible(session.page, 20_000)) return;
  }
  throw new Error("Chat is not open yet; no Splitit chat input is visible.");
}

async function sendChatMessage(session: Session, message: string) {
  const target = await findChatInput(session.page);
  await humanDelay(session, "Typing chat message");
  await target.fill(message);
  await session.page.waitForTimeout(1200);
  await target.press("Enter");
  session.sentMessages.push(message);
  session.updatedAt = new Date();
}

async function chatInputExists(page: Page) {
  const chatFrameSelectors = [
    "textarea",
    "textarea[placeholder*='message' i]",
    "input[type='text']",
    "input[placeholder*='message' i]",
    "[contenteditable='true']",
    "[role='textbox']",
    "div[contenteditable='true']"
  ];

  try {
    for (const frame of page.frames()) {
      const isMainFrame = frame === page.mainFrame();
      const frameUrl = frame.url();
      const isChatFrame = !isMainFrame && /chat|intercom|drift|zendesk|hubspot|salesiq|messenger|bot/i.test(frameUrl);
      const selectors = isChatFrame
        ? chatFrameSelectors
        : [
            "textarea[placeholder*='message' i]",
            "input[placeholder*='message' i]",
            "[role='textbox'][aria-label*='message' i]",
            "[contenteditable='true'][aria-label*='message' i]"
          ];
      for (const selector of selectors) {
        if (await frame.locator(selector).last().isVisible({ timeout: 250 }).catch(() => false)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function chatInputRequired(page: Page, timeoutMs: number) {
  const startedAt = Date.now();
  do {
    try {
      return await findChatInputWithTimeout(page, 700);
    } catch {
      await page.waitForTimeout(700);
    }
  } while (Date.now() - startedAt < timeoutMs);

  throw new Error("Could not find Splitit chat input.");
}

async function waitUntilChatInputVisible(page: Page, timeoutMs: number) {
  const startedAt = Date.now();
  do {
    if (await chatInputExists(page)) return true;
    await page.waitForTimeout(1000);
  } while (Date.now() - startedAt < timeoutMs);

  return false;
}

async function findChatInput(page: Page) {
  return chatInputRequired(page, 20_000);
}

async function findChatInputWithTimeout(page: Page, timeoutMs: number) {
  const chatFrameSelectors = [
    "textarea",
    "textarea[placeholder*='message' i]",
    "input[type='text']",
    "input[placeholder*='message' i]",
    "[contenteditable='true']",
    "[role='textbox']",
    "div[contenteditable='true']"
  ];

  for (const frame of page.frames()) {
    const isMainFrame = frame === page.mainFrame();
    const frameUrl = frame.url();
    const isChatFrame = !isMainFrame && /chat|intercom|drift|zendesk|hubspot|salesiq|messenger|bot/i.test(frameUrl);
    const selectors = isChatFrame
      ? chatFrameSelectors
      : [
          "textarea[placeholder*='message' i]",
          "input[placeholder*='message' i]",
          "[role='textbox'][aria-label*='message' i]",
          "[contenteditable='true'][aria-label*='message' i]"
        ];
    for (const selector of selectors) {
      const locator = frame.locator(selector).last();
      try {
        await locator.waitFor({ state: "visible", timeout: timeoutMs });
        return locator;
      } catch {
        // Keep searching.
      }
    }
  }

  throw new Error("Could not find Splitit chat input.");
}

async function cookieBannerVisible(page: Page) {
  try {
    const text = await collectVisibleText(page);
    return /our cookies|manage cookies|accept all/i.test(text);
  } catch {
    return false;
  }
}

async function waitForLatestSplititResponse(session: Session, timeoutMs = 30_000) {
  const startedAt = Date.now();
  const before = session.lastResponse;
  let latest = before;

  do {
    await session.page.waitForTimeout(3000);
    const text = await collectChatText(session.page) || await collectVisibleText(session.page);
    latest = text.split("\n").map((line) => line.trim()).filter(Boolean).slice(-10).join(" | ");
    if (latest && latest !== before) break;
  } while (Date.now() - startedAt < timeoutMs);

  session.lastResponse = latest || session.lastResponse;
  session.updatedAt = new Date();
  log(session, `Latest response: ${session.lastResponse || "none"}`);
  return session.lastResponse || "Waiting for Splitit response.";
}

async function collectVisibleText(page: Page) {
  const chunks: string[] = [];
  for (const frame of page.frames()) {
    try {
      const text = await frame.evaluate(() => {
        const uniqueLines = (lines: string[]) => {
          const seen = new Set<string>();
          const values: string[] = [];
          for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
            const key = line.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            values.push(line);
          }
          return values;
        };
        const collectNodes = (root: Element | ShadowRoot | null) => {
          const results: string[] = [];
          const visit = (node: Element | ShadowRoot) => {
            const elements = Array.from(node.children);
            for (const element of elements) {
              const htmlElement = element as HTMLElement;
              const rect = htmlElement.getBoundingClientRect();
              const style = window.getComputedStyle(htmlElement);
              const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
              if (!visible) continue;
              const directText = Array.from(htmlElement.childNodes)
                .filter((child) => child.nodeType === Node.TEXT_NODE)
                .map((child) => child.textContent?.trim() ?? "")
                .filter(Boolean)
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();
              if (directText) results.push(directText);
              if (htmlElement.shadowRoot) visit(htmlElement.shadowRoot);
              visit(htmlElement);
            }
          };
          if (root) visit(root);
          return results;
        };
        return uniqueLines(collectNodes(document.body)).join("\n");
      });
      if (text) chunks.push(text);
    } catch {
      // Some frames are not readable.
    }
  }
  return chunks.join("\n");
}

async function collectChatText(page: Page) {
  const chunks: string[] = [];
  for (const frame of page.frames()) {
    try {
      const frameText = await frame.evaluate(() => {
        const uniqueLines = (lines: string[]) => {
          const seen = new Set<string>();
          const values: string[] = [];
          for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
            const key = line.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            values.push(line);
          }
          return values;
        };
        const collectNodes = (root: Element | ShadowRoot | null) => {
          const results: Array<{ text: string; rect: { left: number; top: number } }> = [];
          const visit = (node: Element | ShadowRoot) => {
            const elements = Array.from(node.children);
            for (const element of elements) {
              const htmlElement = element as HTMLElement;
              const rect = htmlElement.getBoundingClientRect();
              const style = window.getComputedStyle(htmlElement);
              const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
              if (!visible) continue;
              const directText = Array.from(htmlElement.childNodes)
                .filter((child) => child.nodeType === Node.TEXT_NODE)
                .map((child) => child.textContent?.trim() ?? "")
                .filter(Boolean)
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();
              if (directText) results.push({ text: directText, rect: { left: rect.left, top: rect.top } });
              if (htmlElement.shadowRoot) visit(htmlElement.shadowRoot);
              visit(htmlElement);
            }
          };
          if (root) visit(root);
          return results;
        };
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const nodes = collectNodes(document.body);
        const chatWeighted = nodes
          .filter((node) => {
            const text = node.text.trim();
            const inRightPanel = node.rect.left > viewportWidth * 0.48 && node.rect.top < viewportHeight * 0.98;
            const chatText = /splitit support|finley|type a message|merchant|shopper|store name|merchant account|how can i assist|provide your name|associated with your splitit/i.test(text);
            const notCookie = !/our cookies|manage cookies|accept all|nmls|privacy policy|terms|consumer access/i.test(text);
            return notCookie && (inRightPanel || chatText);
          })
          .sort((a, b) => a.rect.top - b.rect.top)
          .map((node) => node.text);
        return uniqueLines(chatWeighted).join("\n");
      });
      if (frameText) chunks.push(frameText);
    } catch {
      // Some frames are not readable.
    }
  }
  return uniqueLines(chunks.flatMap((chunk) => chunk.split("\n"))).join("\n");
}

function uniqueLines(lines: string[]) {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(line);
  }
  return values;
}

function responseLooksDone(response: string) {
  return /whitelist(ed)?|done|completed|success|approved/i.test(response);
}

async function clickElementByText(session: Session, pattern: RegExp, label: string) {
  await humanDelay(session, `Clicking ${label}`);
  for (const frame of session.page.frames()) {
    try {
      const clicked = await frame.evaluate((source) => {
        const pattern = new RegExp(source, "i");
        const clickableElements = Array.from(document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']"));
        const textElements = Array.from(document.querySelectorAll("span, div"));
        const matches = (element: Element) => {
          const text = ((element.textContent || (element as HTMLInputElement).value || "").trim()).replace(/\s+/g, " ");
          return pattern.test(text);
        };
        const target = clickableElements.find(matches) ?? textElements.find(matches);
        const clickable = target?.closest("button, a, [role='button'], input[type='button'], input[type='submit']") ?? target;
        if (!clickable) return false;
        (clickable as HTMLElement).click();
        return true;
      }, pattern.source);
      if (clicked) {
        log(session, `Clicked ${label}`);
        await session.page.waitForTimeout(5000);
        return true;
      }
    } catch {
      // Try the next frame.
    }
  }
  log(session, `Could not click ${label}`);
  return false;
}

function renderSession(res: ServerResponse, jobId: string) {
  const session = sessions.get(jobId);
  if (!session) {
    sendText(res, 404, "Session not found or no longer live.");
    return;
  }

  sendHtml(res, 200, `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta http-equiv="refresh" content="12" />
        <title>Splitit session ${escapeHtml(jobId)}</title>
        <style>
          body { margin: 0; font-family: Inter, system-ui, sans-serif; background: #f8fafd; color: #202124; }
          main { padding: 16px; display: grid; gap: 12px; }
          img { width: 100%; border: 1px solid #dadce0; border-radius: 8px; background: white; }
          pre { white-space: pre-wrap; background: white; border: 1px solid #dadce0; border-radius: 8px; padding: 12px; }
        </style>
      </head>
      <body>
        <main>
          <h1>Splitit session ${escapeHtml(jobId)}</h1>
          <img src="/sessions/${encodeURIComponent(jobId)}/screenshot?secret=${encodeURIComponent(config.secret)}&t=${Date.now()}" />
          <pre>${escapeHtml(session.events.slice(-25).join("\n"))}</pre>
        </main>
      </body>
    </html>`);
}

async function humanDelay(session: Session, reason: string) {
  const delay = randomBetween(config.minActionDelayMs, config.maxActionDelayMs);
  log(session, `${reason}; waiting ${Math.round(delay / 1000)}s`);
  await session.page.waitForTimeout(delay);
}

function randomBetween(min: number, max: number) {
  const safeMin = Math.max(0, Math.min(min, max));
  const safeMax = Math.max(safeMin, max);
  return Math.floor(safeMin + Math.random() * (safeMax - safeMin + 1));
}

async function renderScreenshot(res: ServerResponse, jobId: string) {
  const session = sessions.get(jobId);
  if (!session || session.page.isClosed()) {
    sendText(res, 404, "Session not found or no longer live.");
    return;
  }

  const image = await session.page.screenshot({ type: "png", fullPage: false });
  res.writeHead(200, { "Content-Type": "image/png" });
  res.end(image);
}

function log(session: Session, event: string) {
  session.events.push(`${new Date().toISOString()} ${event}`);
  session.events = session.events.slice(-100);
}

function requireSecret(req: IncomingMessage, url: URL) {
  if (!config.secret) return;
  const supplied = req.headers["x-splitit-agent-secret"] ?? url.searchParams.get("secret");
  if (supplied !== config.secret) {
    throw new Error("Unauthorized");
  }
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function sendText(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
