import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { ContextSource } from "./context-types.js";
import type { RetrievalIndexRequest } from "./retrieval-types.js";
import type { ExecutionContext } from "./types.js";
import { DriverError } from "./errors.js";

export interface TextSegment {
  text: string;
  location?: ContextSource["location"];
  startLine?: number;
}

/** Conservative Markdown section boundaries: ATX/setext headings outside fenced code. No links, HTML or code execute. */
export function markdownSegments(text: string): TextSegment[] {
  const lines = text.split("\n"),
    headings: { line: number; title: string }[] = [];
  let fence: { character: string; length: number } | undefined;
  let previousWasContent = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence)
        fence = { character: marker[1]![0]!, length: marker[1]!.length };
      else if (
        marker[1]![0] === fence.character &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = undefined;
      previousWasContent = false;
      continue;
    }
    if (fence) {
      previousWasContent = false;
      continue;
    }
    const atx = /^ {0,3}#{1,6}(?:[ \t]+(.*)|$)/.exec(line);
    if (atx) {
      headings.push({
        line: i,
        title: (atx[1] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim(),
      });
      previousWasContent = false;
    } else if (previousWasContent && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) {
      headings.push({ line: i - 1, title: lines[i - 1]!.trim() });
      previousWasContent = false;
    } else previousWasContent = Boolean(line.trim());
  }
  const starts = [
    { line: 0, title: "" },
    ...headings.filter((heading) => heading.line > 0),
  ];
  if (headings[0]?.line === 0) starts[0] = headings[0];
  return starts.map((start, i) => ({
    text:
      lines.slice(start.line, starts[i + 1]?.line).join("\n") +
      (i < starts.length - 1 ? "\n" : ""),
    startLine: start.line + 1,
    ...(start.title
      ? {
          location: {
            section: start.title.slice(0, 256).replace(/[\uD800-\uDBFF]$/, ""),
          },
        }
      : {}),
  }));
}

/** Bounded UTF-8 chunks. A passage never crosses an extraction segment (page, section or message). */
export async function chunkSegments(
  source: ContextSource,
  segments: TextSegment[],
  maxBytes: number,
  maxChunks: number,
  context: ExecutionContext,
): Promise<RetrievalIndexRequest["chunks"]> {
  const chunks: RetrievalIndexRequest["chunks"] = [];
  let ordinal = 0,
    visited = 0;
  for (const segment of segments) {
    const lines = segment.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    let parts: Buffer[] = [],
      bytes = 0,
      first = segment.startLine ?? 1,
      last = first;
    const flush = () => {
      if (!parts.length) return;
      const text = Buffer.concat(parts).toString("utf8");
      parts = [];
      bytes = 0;
      if (!text.trim()) return;
      const location = { ...segment.location, startLine: first, endLine: last };
      if (first < 1 || last > 1_000_000)
        throw new DriverError(
          "DOCUMENT_LIMIT",
          "The document exceeds supported citation line ranges.",
        );
      const id =
        "p-" +
        createHash("sha256")
          .update(JSON.stringify([source.id, location, text, ordinal++]))
          .digest("hex");
      chunks.push({ id, text, location });
      if (chunks.length > maxChunks)
        throw new DriverError(
          "DOCUMENT_LIMIT",
          "The document exceeds the host's chunk limit; no partial index was written.",
        );
    };
    for (let i = 0; i < lines.length; i++) {
      context.signal.throwIfAborted();
      const line = Buffer.from(lines[i]!),
        number = (segment.startLine ?? 1) + i;
      if (bytes + line.length > maxBytes) flush();
      if (!parts.length) first = number;
      last = number;
      if (line.length <= maxBytes) {
        parts.push(line);
        bytes += line.length;
      } else {
        for (let offset = 0; offset < line.length;) {
          let end = Math.min(line.length, offset + maxBytes);
          while (end < line.length && (line[end]! & 0xc0) === 0x80) end--;
          parts.push(line.subarray(offset, end));
          bytes += end - offset;
          flush();
          offset = end;
        }
      }
      if (++visited % 256 === 0) {
        context.reportProgress();
        await setImmediate();
      }
    }
    flush();
  }
  context.signal.throwIfAborted();
  context.reportProgress();
  return chunks;
}
