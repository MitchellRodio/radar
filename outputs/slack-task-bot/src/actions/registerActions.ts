import { App } from "@slack/bolt";
import { RequestStatus, RequestType } from "@prisma/client";
import { parseDueDate } from "../lib/dates";
import { logger } from "../lib/logger";
import { canManageRequest } from "../lib/permissions";
import { inputModal, requestDetailModal } from "../slack/blocks";
import { typeLabel } from "../slack/format";
import { notifyOwnerRequestCreated, postRequesterUpdate } from "../slack/notifications";
import {
  addInternalNote,
  createRequestFromManualInput,
  extractSlackUserId,
  getRequest,
  parseRequestId,
  reassignRequest,
  setBlocker,
  setDueDate,
  setStatus,
  updateRequestSlackReference
} from "../services/requestService";

export function registerActions(app: App) {
  app.action("request_view", async ({ ack, body, client, action }: any) => {
    await ack();
    const requestId = parseRequestId(action.value);
    if (!requestId) return;

    const request = await getRequest(requestId);
    if (!request) return;

    await client.views.open({
      trigger_id: body.trigger_id,
      view: requestDetailModal(request)
    });
  });

  app.action("request_set_status", async ({ ack, body, client, action }: any) => {
    await ack();
    const [idPart, statusPart] = action.value.split(":");
    const requestId = parseRequestId(idPart);
    const actorSlackUserId = body.user.id;
    if (!requestId || !(await canManageRequest(actorSlackUserId, requestId))) return;

    const request = await setStatus(requestId, actorSlackUserId, statusPart as RequestStatus);
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

    await postRequesterUpdate(client, request, actorSlackUserId);
    await updateCurrentModal(client, body, request);
  });

  app.action("request_close_view", async ({ ack }: any) => {
    await ack({ response_action: "clear" });
  });

  app.view("request_create", async ({ ack, body, view, client }: any) => {
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
      await ack({ response_action: "errors", errors });
      return;
    }

    await ack();

    try {
      const metadata = JSON.parse(view.private_metadata || "{}");
      const channelId = metadata.channelId;
      if (!channelId) throw new Error("Missing channel ID in request_create metadata");

      const request = await createRequestFromManualInput({
        title,
        description,
        type: type || "OTHER",
        requesterSlackUserId: body.user.id,
        channelId,
        dueDate,
        blocker
      });

      const result = await client.chat.postMessage({
        channel: channelId,
        text: `Request created: #${request.id}`,
        unfurl_links: false,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                `Request created: *#${request.id}*\n` +
                `*Title:* ${request.title}\n` +
                `*Type:* ${typeLabel(request.type)}\n` +
                `*Status:* Submitted\n` +
                `*Owner:* <@${request.ownerSlackUserId}>`
            }
          }
        ]
      });

      if (result.ts) {
        const updatedRequest = await updateRequestSlackReference(request.id, result.ts);
        await notifyOwnerRequestCreated(client, updatedRequest);
      } else {
        await notifyOwnerRequestCreated(client, request);
      }
    } catch (error) {
      logger.error(error, "Failed to create request from modal");
    }
  });

  app.view(/^request_custom_status:/, async ({ ack, body, view }: any) => {
    await handleModalSubmit(ack, body, view, async (requestId, actorSlackUserId, value) =>
      setStatus(requestId, actorSlackUserId, "CUSTOM", value.trim())
    );
  });

  app.view(/^request_due_date:/, async ({ ack, body, view }: any) => {
    await handleModalSubmit(ack, body, view, async (requestId, actorSlackUserId, value) => {
      const dueDate = value.trim() ? parseDueDate(value) : null;
      if (value.trim() && !dueDate) {
        await ack({
          response_action: "errors",
          errors: { input: "Use yyyy-mm-dd or mm/dd/yyyy." }
        });
        return null;
      }

      return setDueDate(requestId, actorSlackUserId, dueDate);
    });
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
  update: (requestId: number, actorSlackUserId: string, value: string) => Promise<any | null>
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

function modalValue(view: any, blockId: string): string {
  return view.state.values[blockId]?.value?.value ?? "";
}

function modalSelectedValue(view: any, blockId: string): string {
  return view.state.values[blockId]?.value?.selected_option?.value ?? "";
}
