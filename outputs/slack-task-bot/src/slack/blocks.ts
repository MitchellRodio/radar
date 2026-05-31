import { InternalNote, Request, RequestUpdate, User, Channel } from "@prisma/client";
import { formatDate } from "../lib/dates";
import { statusLabel, threadLink, typeLabel } from "./format";

type RequestWithRelations = Request & {
  requester?: User;
  owner?: User;
  channel?: Channel;
  notes?: InternalNote[];
  updates?: RequestUpdate[];
};

export function requestListBlocks(requests: RequestWithRelations[], heading: string) {
  if (requests.length === 0) {
    return [
      section(`*${heading}*`),
      section("No open requests found.")
    ];
  }

  return [
    section(`*${heading}*`),
    divider(),
    ...requests.flatMap((request) => [
      section(
        `*#${request.id} ${escapeMrkdwn(request.title)}*\n` +
          `*Company/channel:* ${escapeMrkdwn(request.channel?.companyName ?? request.channel?.name ?? request.channelId)}\n` +
          `*Type:* ${typeLabel(request.type)}  *Status:* ${statusLabel(request)}\n` +
          `*Due:* ${formatDate(request.dueDate)}  *Blocker:* ${escapeMrkdwn(request.blocker ?? "None")}\n` +
          `*Created:* ${formatDate(request.createdAt)}`,
        [
          {
            type: "button",
            text: { type: "plain_text", text: "View/update" },
            action_id: "request_view",
            value: String(request.id)
          }
        ]
      ),
      divider()
    ])
  ];
}

export function requestDetailBlocks(request: RequestWithRelations) {
  const notes = request.notes?.length
    ? request.notes
        .slice(0, 8)
        .map((note) => `- <@${note.authorSlackUserId}> ${formatDate(note.createdAt)}: ${escapeMrkdwn(note.body)}`)
        .join("\n")
    : "None";

  return [
    section(`*Request #${request.id}: ${escapeMrkdwn(request.title)}*`),
    section(
      `*Original message:*\n${escapeMrkdwn(request.description)}\n\n` +
        `*Requester:* <@${request.requesterSlackUserId}>\n` +
        `*Slack channel:* <#${request.channelId}>\n` +
        `*Thread:* <${threadLink(request.channelId, request.threadTs)}|Open thread>\n` +
        `*Type:* ${typeLabel(request.type)}\n` +
        `*Status:* ${statusLabel(request)}\n` +
        `*Owner CSM:* <@${request.ownerSlackUserId}>\n` +
        `*Due date:* ${formatDate(request.dueDate)}\n` +
        `*Blocker:* ${escapeMrkdwn(request.blocker ?? "None")}\n` +
        `*Created:* ${formatDate(request.createdAt)}\n` +
        `*Updated:* ${formatDate(request.updatedAt)}`
    ),
    divider(),
    section(`*Internal notes*\n${notes}`),
    actions([
      button("Set Submitted", "request_set_status", `${request.id}:SUBMITTED`),
      button("Set In Progress", "request_set_status", `${request.id}:IN_PROGRESS`),
      button("Set Done", "request_set_status", `${request.id}:DONE`, "primary")
    ]),
    actions([
      button("Set Custom Status", "request_custom_status_open", String(request.id)),
      button("Add/Edit Due Date", "request_due_date_open", String(request.id)),
      button("Add/Edit Blocker", "request_blocker_open", String(request.id))
    ]),
    actions([
      button("Add Internal Note", "request_note_open", String(request.id)),
      button("Reassign CSM", "request_reassign_open", String(request.id)),
      button("Notify requester", "request_notify_requester", String(request.id)),
      button("Close", "request_close_view", String(request.id), "danger")
    ])
  ];
}

export function requestDetailModal(request: RequestWithRelations) {
  return {
    type: "modal",
    callback_id: `request_detail:${request.id}`,
    title: { type: "plain_text", text: `Request #${request.id}` },
    close: { type: "plain_text", text: "Close" },
    blocks: requestDetailBlocks(request)
  };
}

export function inputModal(callbackId: string, title: string, fieldLabel: string, initialValue = "", multiline = false) {
  return {
    type: "modal",
    callback_id: callbackId,
    title: { type: "plain_text", text: title.slice(0, 24) },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "input",
        element: {
          type: "plain_text_input",
          action_id: "value",
          initial_value: initialValue,
          multiline
        },
        label: { type: "plain_text", text: fieldLabel }
      }
    ]
  };
}

export function helpBlocks() {
  return [
    section("*CSM request bot commands*"),
    section(
      "`/my-requests` - view requests assigned to you\n" +
        "`/all-requests` - admin view of all open requests\n" +
        "`/request-create <request>` - create a request in the current channel\n" +
        "`/request-map-channel <channel_id> <@csm|user_id>` - admin maps channel ownership\n" +
        "`/request-reassign <request_id> <@csm|user_id>` - reassign a request\n" +
        "`/request-help` - show this help"
    )
  ];
}

function section(text: string, accessory?: unknown[]) {
  return {
    type: "section",
    text: { type: "mrkdwn", text },
    ...(accessory?.length ? { accessory: accessory[0] } : {})
  };
}

function actions(elements: unknown[]) {
  return { type: "actions", elements };
}

function button(text: string, actionId: string, value: string, style?: "primary" | "danger") {
  return {
    type: "button",
    text: { type: "plain_text", text },
    action_id: actionId,
    value,
    ...(style ? { style } : {})
  };
}

function divider() {
  return { type: "divider" };
}

function escapeMrkdwn(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
