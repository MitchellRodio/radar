import { App } from "@slack/bolt";
import { RequestStatus, RequestType } from "@prisma/client";
import { parseDueDate } from "../lib/dates";
import { logger } from "../lib/logger";
import { canManageRequest } from "../lib/permissions";
import { checkoutLinkModal, inputModal, requesterReplyModal, requestDetailModal } from "../slack/blocks";
import {
  notifyOwnerRequestCreated,
  notifyOwnerRequesterReply,
  postRequesterNeedsInfo,
  postRequesterUpdate,
  sendRequesterEphemeralStatusMessage,
  sendRequesterStatusMessage,
  updateRequesterStatusMessage
} from "../slack/notifications";
import {
  addInternalNote,
  addRequesterReply,
  createRequestFromManualInput,
  extractSlackUserId,
  getRequest,
  parseRequestId,
  recordRequesterNotification,
  reassignRequest,
  setBlocker,
  setDueDate,
  setStatus,
  updateRequesterMessageReference
} from "../services/requestService";
import { queueSplititAutomation } from "../services/splititAutomationService";
import { createCheckoutLink, listCheckoutProductOptionsForRequest } from "../services/checkoutLinkService";
import { lookupPaymentsForChannel, paymentLookupBlocks } from "../services/paymentLookupService";
import { isKycOnlyChannel } from "../services/channelModeService";
import { enrichSlackFileAttachments, extractModalFileAttachments } from "../services/slackFileService";

export function registerActions(app: App) {
  app.action("request_view", async ({ ack, body, client, action }: any) => {
    await ack();
    await openRequestDetailFromAction(client, body, action);
  });

  app.action("owner_request_view", async ({ ack, body, client, action }: any) => {
    await ack();
    await openRequestDetailFromAction(client, body, action);
  });

  app.action(/^request_set_(submitted|in_progress|done)$/, async ({ ack, body, client, action }: any) => {
    await ack();
    const [idPart, statusPart] = action.value.split(":");
    const requestId = parseRequestId(idPart);
    const actorSlackUserId = body.user.id;
    if (!requestId || !(await canManageRequest(actorSlackUserId, requestId))) return;

    const request = await setStatus(requestId, actorSlackUserId, statusPart as RequestStatus);
    await updateRequesterStatusMessage(client, request);
    if (statusPart === "DONE") {
      await postRequesterUpdate(client, request, actorSlackUserId);
    }

    await updateCurrentModal(client, body, request);
  });

  app.action("request_custom_status_open", async ({ ack, body, client, action }: any) => {
    await ack();
    await openInput(client, body.trigger_id, `request_custom_status:${action.value}`, "Custom status", "Status", "", false);
  });

  app.action("request_due_date_open", async ({ ack, body, client, action }: any) => {
    await ack();
    await openInput(client, body.trigger_id, `request_due_date:${action.value}`, "Due date", "Date, yyyy-mm-dd", "", false);
  });

  app.action("request_blocker_open", async ({ ack, body, client, action }: any) => {
    await ack();
    const request = await getRequest(Number(action.value));
    await openInput(client, body.trigger_id, `request_blocker:${action.value}`, "Blocker", "Blocker, blank to clear", request?.blocker ?? "", true);
  });

  app.action("request_note_open", async ({ ack, body, client, action }: any) => {
    await ack();
    await openInput(client, body.trigger_id, `request_note:${action.value}`, "Internal note", "Note", "", true);
  });

  app.action("request_reassign_open", async ({ ack, body, client, action }: any) => {
    await ack();
    await openInput(client, body.trigger_id, `request_reassign:${action.value}`, "Reassign CSM", "CSM Slack user ID or mention", "", false);
  });

  app.action("request_notify_requester", async ({ ack, body, client, action }: any) => {
    await ack();
    const requestId = parseRequestId(action.value);
    const actorSlackUserId = body.user.id;
    if (!requestId || !(await canManageRequest(actorSlackUserId, requestId))) return;

    const request = await getRequest(requestId);
    if (!request) return;

    await updateRequesterStatusMessage(client, request);
    await postRequesterUpdate(client, request, actorSlackUserId);
    await updateCurrentModal(client, body, request);
  });

  app.action("request_needs_info_open", async ({ ack, body, client, action }: any) => {
    await ack();
    await openInput(client, body.trigger_id, `request_needs_info:${action.value}`, "Need info", "Message to requester", "", true);
  });

  app.action("requester_add_info_open", async ({ ack, body, client, action }: any) => {
    await ack();
    const requestId = parseRequestId(action.value);
    const actorSlackUserId = body.user.id;
    const request = requestId ? await getRequest(requestId) : null;
    if (!request || request.requesterSlackUserId !== actorSlackUserId) return;

    await client.views.open({
      trigger_id: body.trigger_id,
      view: requesterReplyModal(request.id)
    });
  });

  app.action("request_splitit_agent_queue", async ({ ack, body, client, action }: any) => {
    await ack();
    const requestId = parseRequestId(action.value);
    const actorSlackUserId = body.user.id;
    if (!requestId || !(await canManageRequest(actorSlackUserId, requestId))) return;

    const result = await queueSplititAutomation(client, requestId, actorSlackUserId);
    const refreshedRequest = result.request ? await getRequest(requestId) : null;
    if (refreshedRequest) await updateCurrentModal(client, body, refreshedRequest);
    if (result.error) {
      await notifyActionFailure(client, actorSlackUserId, result.error);
    }
  });

  app.action("request_checkout_link_open", async ({ ack, body, client, action }: any) => {
    await ack();
    const requestId = parseRequestId(action.value);
    const actorSlackUserId = body.user.id;
    if (!requestId || !(await canManageRequest(actorSlackUserId, requestId))) return;

    const [request, productResult] = await Promise.all([
      getRequest(requestId),
      listCheckoutProductOptionsForRequest(requestId)
    ]);

    if (!request) return;
    if (!productResult.options.length) {
      const errorText = productResult.errors.length
        ? productResult.errors.join("\n")
        : "No Whop products were found for the businesses mapped to this Slack channel.";
      await notifyActionFailure(client, actorSlackUserId, `${errorText}\n\nAdd/check business API keys in /dashboard/whop.`);
      return;
    }

    await client.views.push({
      trigger_id: body.trigger_id,
      view: checkoutLinkModal(request, productResult.options)
    });
  });

  app.action("request_close_view", async ({ ack }: any) => {
    await ack({ response_action: "clear" });
  });

  app.view("request_create", async ({ ack, body, view, client }: any) => {
    const title = modalValue(view, "title").trim();
    const description = modalValue(view, "description").trim();
    const customerEmail = modalValue(view, "customerEmail").trim();
    const selectedType = modalSelectedValue(view, "type");
    const type = selectedType as RequestType;
    const metadata = JSON.parse(view.private_metadata || "{}");
    const channelId = metadata.channelId;
    const kycOnly = channelId ? await isKycOnlyChannel(channelId) : false;

    const errors: Record<string, string> = {};
    if (selectedType !== "VIEW_PAYMENTS" || kycOnly) {
      if (!title) errors.title = "Add a short title.";
      if (!description) errors.description = "Add request details.";
    } else if (!extractEmail(`${customerEmail} ${title} ${description}`)) {
      errors.customerEmail = "Add the customer email.";
    }

    if (Object.keys(errors).length) {
      await ack({ response_action: "errors", errors });
      return;
    }

    await ack();

    try {
      if (!channelId) throw new Error("Missing channel ID in request_create metadata");
      const attachments = await enrichSlackFileAttachments(client, extractModalFileAttachments(view, "screenshots"));

      if (selectedType === "VIEW_PAYMENTS" && !kycOnly) {
        const email = extractEmail(`${customerEmail} ${title} ${description}`);
        if (!email) return;
        const lookup = await lookupPaymentsForChannel({ channelId, email });
        await postPaymentLookup(client, channelId, body.user.id, lookup);
        return;
      }

      const request = await createRequestFromManualInput({
        title,
        description,
        type: kycOnly ? "KYC_KYB" : type || "OTHER",
        requesterSlackUserId: body.user.id,
        channelId,
        dueDate: null,
        blocker: null,
        attachments
      });

      const result = await sendRequesterStatusMessage(client, request);

      if (result.channel && result.ts) {
        const updatedRequest = await updateRequesterMessageReference(request.id, result.channel, result.ts);
        await sendRequesterEphemeralStatusMessage(client, updatedRequest);
        await notifyOwnerRequestCreated(client, updatedRequest);
      } else {
        await sendRequesterEphemeralStatusMessage(client, request);
        await notifyOwnerRequestCreated(client, request);
      }
    } catch (error) {
      logger.error(error, "Failed to create request from modal");
      try {
        await client.chat.postEphemeral({
          channel: JSON.parse(view.private_metadata || "{}").channelId,
          user: body.user.id,
          text: "Sorry, I could not complete that lookup."
        });
      } catch {}
    }
  });

  app.view(/^request_custom_status:/, async ({ ack, body, view, client }: any) => {
    await handleModalSubmit(
      ack,
      body,
      view,
      async (requestId, actorSlackUserId, value) => setStatus(requestId, actorSlackUserId, "CUSTOM", value.trim()),
      async (request) => updateRequesterStatusMessage(client, request)
    );
  });

  app.view(/^request_due_date:/, async ({ ack, body, view, client }: any) => {
    await handleModalSubmit(
      ack,
      body,
      view,
      async (requestId, actorSlackUserId, value) => {
        const dueDate = value.trim() ? parseDueDate(value) : null;
        if (value.trim() && !dueDate) {
          await ack({
            response_action: "errors",
            errors: { input: "Use yyyy-mm-dd or mm/dd/yyyy." }
          });
          return null;
        }

        return setDueDate(requestId, actorSlackUserId, dueDate);
      },
      async (request) => updateRequesterStatusMessage(client, request)
    );
  });

  app.view(/^request_blocker:/, async ({ ack, body, view }: any) => {
    await handleModalSubmit(ack, body, view, async (requestId, actorSlackUserId, value) =>
      setBlocker(requestId, actorSlackUserId, value.trim() || null)
    );
  });

  app.view(/^request_note:/, async ({ ack, body, view }: any) => {
    await handleModalSubmit(ack, body, view, async (requestId, actorSlackUserId, value) =>
      addInternalNote(requestId, actorSlackUserId, value.trim())
    );
  });

  app.view(/^request_reassign:/, async ({ ack, body, view }: any) => {
    await handleModalSubmit(ack, body, view, async (requestId, actorSlackUserId, value) => {
      const ownerSlackUserId = extractSlackUserId(value);
      if (!ownerSlackUserId) {
        await ack({
          response_action: "errors",
          errors: { input: "Enter a Slack user mention or user ID." }
        });
        return null;
      }

      return reassignRequest(requestId, actorSlackUserId, ownerSlackUserId);
    });
  });

  app.view(/^request_needs_info:/, async ({ ack, body, view, client }: any) => {
    await handleModalSubmit(ack, body, view, async (requestId, actorSlackUserId, value) => {
      const request = await setStatus(requestId, actorSlackUserId, "CUSTOM", "Waiting on customer");
      await updateRequesterStatusMessage(client, request);
      await postRequesterNeedsInfo(client, request, actorSlackUserId, value.trim());
      return request;
    });
  });

  app.view(/^requester_add_info:/, async ({ ack, body, view, client }: any) => {
    const requestId = parseRequestId(view.callback_id.split(":")[1]);
    const actorSlackUserId = body.user.id;
    const value = modalValue(view, "input").trim();
    if (!value) {
      await ack({ response_action: "errors", errors: { input: "Add a short update." } });
      return;
    }

    const request = requestId ? await getRequest(requestId) : null;
    if (!request || request.requesterSlackUserId !== actorSlackUserId) {
      await ack();
      return;
    }

    await ack();
    const updatedRequest = await addRequesterReply(request.id, actorSlackUserId, value);
    await notifyOwnerRequesterReply(client, updatedRequest, value);
  });

  app.view(/^checkout_link_create:/, async ({ ack, body, view, client }: any) => {
    const requestId = parseRequestId(view.callback_id.split(":")[1]);
    const actorSlackUserId = body.user.id;
    const productSelection = modalSelectedValue(view, "product");
    const amount = parseCheckoutAmount(modalValue(view, "amount"));
    const title = modalValue(view, "title").trim();
    const description = modalValue(view, "description").trim();
    const splititOnly = modalCheckboxSelected(view, "splititOnly", "splitit_only");

    const errors: Record<string, string> = {};
    if (!productSelection) errors.product = "Choose the Whop product.";
    if (!amount) errors.amount = "Enter a valid amount, like 2100 or 2.1k.";
    if (!title) errors.title = "Add a checkout title.";

    if (Object.keys(errors).length) {
      await ack({ response_action: "errors", errors });
      return;
    }

    if (!requestId || !(await canManageRequest(actorSlackUserId, requestId))) {
      await ack();
      return;
    }

    await ack({
      response_action: "update",
      view: processingModal("Creating checkout link")
    });

    const result = await createCheckoutLink({
      requestId,
      actorSlackUserId,
      productSelection,
      amount,
      title,
      description,
      splititOnly
    });

    if (result.error || !result.request) {
      await notifyActionFailure(client, actorSlackUserId, result.error || "Could not create checkout link.");
      const request = requestId ? await getRequest(requestId) : null;
      if (request) await updateModalById(client, body.view?.id, request);
      return;
    }

    await updateRequesterStatusMessage(client, result.request);
    await postCheckoutLinkToRequester(client, result.request, actorSlackUserId, result.checkoutUrl, splititOnly);
    await updateModalById(client, body.view?.id, result.request);
  });
}

async function openRequestDetailFromAction(client: any, body: any, action: any) {
  const requestId = parseRequestId(action.value);
  if (!requestId) return;

  try {
    const request = await getRequest(requestId);
    if (!request) {
      await notifyActionFailure(client, body.user?.id, `I couldn't find request ${requestId}.`);
      return;
    }

    await client.views.open({
      trigger_id: body.trigger_id,
      view: requestDetailModal(request)
    });
  } catch (error) {
    logger.error({ error, requestId, userId: body.user?.id }, "Failed to open request detail view");
    await notifyActionFailure(client, body.user?.id, "I couldn't open that request. Try `/my-requests` and use View/update from there.");
  }
}

async function notifyActionFailure(client: any, slackUserId: string | undefined, text: string) {
  if (!slackUserId) return;
  try {
    await client.chat.postMessage({ channel: slackUserId, text });
  } catch (error) {
    logger.error(error, "Failed to notify user about request action failure");
  }
}

async function openInput(client: any, triggerId: string, callbackId: string, title: string, label: string, initialValue: string, multiline: boolean) {
  await client.views.push({
    trigger_id: triggerId,
    view: inputModal(callbackId, title, label, initialValue, multiline)
  });
}

async function handleModalSubmit(
  ack: any,
  body: any,
  view: any,
  update: (requestId: number, actorSlackUserId: string, value: string) => Promise<any | null>,
  afterUpdate?: (request: any) => Promise<void>
) {
  const requestId = parseRequestId(view.callback_id.split(":")[1]);
  const actorSlackUserId = body.user.id;
  const value = view.state.values.input.value.value ?? "";

  if (!requestId || !(await canManageRequest(actorSlackUserId, requestId))) {
    await ack();
    return;
  }

  try {
    const request = await update(requestId, actorSlackUserId, value);
    if (!request) return;
    if (afterUpdate) await afterUpdate(request);

    await ack({
      response_action: "update",
      view: requestDetailModal(request)
    });
  } catch (error) {
    logger.error(error, "Failed to submit request modal");
    await ack({
      response_action: "errors",
      errors: { input: "Could not save this update." }
    });
  }
}

async function updateCurrentModal(client: any, body: any, request: any) {
  if (!body.view?.id) return;

  await client.views.update({
    view_id: body.view.id,
    view: requestDetailModal(request)
  });
}

async function updateModalById(client: any, viewId: string | undefined, request: any) {
  if (!viewId) return;

  await client.views.update({
    view_id: viewId,
    view: requestDetailModal(request)
  });
}

function modalValue(view: any, blockId: string): string {
  return view.state.values[blockId]?.value?.value ?? "";
}

function modalSelectedValue(view: any, blockId: string): string {
  return view.state.values[blockId]?.value?.selected_option?.value ?? "";
}

function modalCheckboxSelected(view: any, blockId: string, value: string): boolean {
  const selected = view.state.values[blockId]?.value?.selected_options ?? [];
  return selected.some((option: any) => option.value === value);
}

function parseCheckoutAmount(value: string): number {
  const match = value.trim().match(/^\$?\s*([0-9][0-9,]*(?:\.\d{1,2})?)\s*([kK])?$/);
  if (!match) return 0;
  const amount = Number(match[1].replace(/,/g, "")) * (match[2] ? 1000 : 1);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0;
}

function processingModal(title: string) {
  return {
    type: "modal",
    title: { type: "plain_text", text: title.slice(0, 24) },
    close: { type: "plain_text", text: "Close" },
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "Working on it..." }
      }
    ]
  };
}

async function postPaymentLookup(client: any, channelId: string, userId: string, lookup: Awaited<ReturnType<typeof lookupPaymentsForChannel>>) {
  try {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: `Payments for ${lookup.email}`,
      blocks: paymentLookupBlocks(lookup)
    });
  } catch (error) {
    logger.error(error, "Failed to post payment lookup ephemerally; sending DM fallback");
    await client.chat.postMessage({
      channel: userId,
      text: `Payments for ${lookup.email}`,
      blocks: paymentLookupBlocks(lookup)
    });
  }
}

function extractEmail(value: string) {
  return value.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0] ?? "";
}

async function postCheckoutLinkToRequester(client: any, request: any, actorSlackUserId: string, checkoutUrl: string, splititOnly: boolean) {
  const text = `Checkout link created for ${request.title}: ${checkoutUrl}`;
  const message =
    `<@${request.requesterSlackUserId}> Checkout link ready${splititOnly ? " (Splitit only)" : ""}: <${checkoutUrl}|Open checkout link>`;

  if (request.threadTs.startsWith("manual-")) {
    await client.chat.postMessage({
      channel: request.requesterSlackUserId,
      text: message
    });
  } else {
    await client.chat.postMessage({
      channel: request.channelId,
      thread_ts: request.threadTs,
      text: message
    });
  }

  await recordRequesterNotification(request.id, actorSlackUserId, text);
}
