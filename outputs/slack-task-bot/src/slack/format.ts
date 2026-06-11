import { Request, RequestStatus, RequestType } from "@prisma/client";
import { formatDate } from "../lib/dates";

export function typeLabel(type: RequestType): string {
  const labels: Record<RequestType, string> = {
    CHECKOUT_LINK: "Checkout link",
    SPLITIT_WHITELIST: "Splitit whitelist",
    REFUND_PAYMENT: "Refund payment",
    BUG_REPORT: "Bug report",
    ENHANCEMENT_REQUEST: "Enhancement request",
    KYC_KYB: "KYC",
    PAYMENT_ISSUE: "Payment issue",
    ACCOUNT_SETTINGS: "Account settings",
    OTHER: "Other"
  };

  return labels[type];
}

export function statusLabel(request: Pick<Request, "status" | "customStatus">): string {
  if (request.status === "CUSTOM") return request.customStatus ?? "Custom";

  const labels: Record<RequestStatus, string> = {
    SUBMITTED: "Submitted",
    IN_PROGRESS: "In Progress",
    DONE: "Done",
    CUSTOM: "Custom"
  };

  return labels[request.status];
}

export function threadLink(channelId: string, threadTs: string): string {
  return `https://slack.com/app_redirect?channel=${channelId}&message_ts=${threadTs}`;
}

export function requestSummaryLine(request: Request & { channel?: { name: string | null; companyName: string | null } }) {
  const company = request.channel?.companyName ?? request.channel?.name ?? request.channelId;
  return `${request.title} | ID ${request.id} | ${company} | ${typeLabel(request.type)} | ${statusLabel(request)} | due ${formatDate(request.dueDate)}`;
}
