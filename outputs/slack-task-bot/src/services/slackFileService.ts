import type { WebClient } from "@slack/web-api";
import type { RequestAttachmentInput } from "./requestService";
import { logger } from "../lib/logger";

export function extractModalFileAttachments(view: any, blockId: string): RequestAttachmentInput[] {
  const element = view?.state?.values?.[blockId]?.value ?? {};
  return normalizeSlackFiles(element.files ?? element.selected_files ?? []);
}

export function extractMessageFileAttachments(files: unknown): RequestAttachmentInput[] {
  return normalizeSlackFiles(files);
}

export async function enrichSlackFileAttachments(client: WebClient, attachments: RequestAttachmentInput[]) {
  return Promise.all(
    attachments.map(async (attachment) => {
      if (attachment.name || attachment.permalink || attachment.urlPrivate) return attachment;
      try {
        const response = await client.files.info({ file: attachment.slackFileId });
        return normalizeSlackFile(response.file) ?? attachment;
      } catch (error) {
        logger.warn({ error, fileId: attachment.slackFileId }, "Could not enrich Slack file attachment");
        return attachment;
      }
    })
  );
}

function normalizeSlackFiles(files: unknown): RequestAttachmentInput[] {
  if (!Array.isArray(files)) return [];
  return files.flatMap((file) => {
    const normalized = normalizeSlackFile(file);
    return normalized ? [normalized] : [];
  });
}

function normalizeSlackFile(file: any): RequestAttachmentInput | null {
  const slackFileId = String(file?.id ?? file?.file_id ?? "").trim();
  if (!slackFileId) return null;
  return {
    slackFileId,
    name: file.name ?? file.title ?? null,
    mimetype: file.mimetype ?? null,
    filetype: file.filetype ?? null,
    urlPrivate: file.url_private ?? null,
    permalink: file.permalink ?? file.permalink_public ?? null
  };
}
