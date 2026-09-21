import { DriverError } from "../errors.js";
import type { ContextAttachment } from "../context-types.js";

type Binary = Exclude<ContextAttachment, { type: "text" }>;
const label = (attachment: Binary) =>
  `Attached source (data): ${JSON.stringify(attachment.source)}`;
const dataUrl = (attachment: Binary) =>
  `data:${attachment.mediaType};base64,${attachment.data}`;

/** Native inline payloads; no uploads, local paths or provider-side URL fetching. */
export function openaiMedia(attachments: Binary[] = []): unknown[] {
  return attachments.flatMap((attachment) => [
    { type: "input_text", text: label(attachment) },
    attachment.type === "pdf"
      ? {
          type: "input_file",
          filename: `${attachment.source.id}.pdf`,
          file_data: dataUrl(attachment),
        }
      : { type: "input_image", image_url: dataUrl(attachment), detail: "auto" },
  ]);
}
export function anthropicMedia(attachments: Binary[] = []): unknown[] {
  return attachments.flatMap((attachment) => [
    { type: "text", text: label(attachment) },
    {
      type: attachment.type === "pdf" ? "document" : "image",
      source: {
        type: "base64",
        media_type: attachment.mediaType,
        data: attachment.data,
      },
    },
  ]);
}
export function geminiMedia(attachments: Binary[] = []): unknown[] {
  return attachments.flatMap((attachment) => [
    { text: label(attachment) },
    { inlineData: { mimeType: attachment.mediaType, data: attachment.data } },
  ]);
}
export function chatMedia(attachments: Binary[] = []): unknown[] {
  if (attachments.some((attachment) => attachment.type === "pdf"))
    throw new DriverError(
      "UNSUPPORTED_MODALITY",
      "This compatible adapter supports image inputs only; supply extracted PDF text explicitly.",
    );
  return attachments.flatMap((attachment) => [
    { type: "text", text: label(attachment) },
    { type: "image_url", image_url: { url: dataUrl(attachment) } },
  ]);
}
