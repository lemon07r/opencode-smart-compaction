/**
 * Reads what compaction needs from the messages OpenCode is about to summarize:
 * the previous checkpoint, the user's own words (for protected facts), the files
 * the session read or changed through tools, and a flattened transcript.
 */

import type { SessionCompaction } from "@opencode/plugin/promise/session";

type Message = SessionCompaction["messages"][number];

// Tag names are assembled so the literal markup never appears in this source.
const tag = (name: string, close = false) => `<${close ? "/" : ""}${name}>`;
const CHECKPOINT_OPEN = tag("conversation-checkpoint");
const SUMMARY_OPEN = tag("summary");
const SUMMARY_CLOSE = tag("summary", true);

/** Tool results longer than this are cut in the transcript, matching OpenCode's own compaction. */
export const TOOL_OUTPUT_MAX_CHARS = 1_250;

const READ_TOOLS = new Set(["read"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const PATCH_FILE_LINE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

export interface SessionFacts {
  userTexts: string[];
  previousSummary?: string;
  readFiles: string[];
  modifiedFiles: string[];
  /** The conversation since the previous checkpoint, as text. */
  transcript: string;
}

type Part = Message["content"][number];

function textOf(message: Message): string {
  return message.content
    .flatMap((part) => (part.type === "text" && part.text.trim() ? [part.text.trim()] : []))
    .join("\n");
}

/** The summary inside a previous checkpoint message, or undefined when the text is not one. */
export function checkpointSummary(text: string): string | undefined {
  if (!text.trimStart().startsWith(CHECKPOINT_OPEN)) return undefined;
  const start = text.indexOf(SUMMARY_OPEN);
  const end = text.lastIndexOf(SUMMARY_CLOSE);
  if (start === -1 || end <= start) return undefined;
  return text.slice(start + SUMMARY_OPEN.length, end).trim() || undefined;
}

function truncate(value: string): string {
  if (value.length <= TOOL_OUTPUT_MAX_CHARS) return value;
  return `${Array.from(value).slice(0, TOOL_OUTPUT_MAX_CHARS).join("")}\n[truncated]`;
}

function resultText(part: Extract<Part, { type: "tool-result" }>): string {
  const { result } = part;
  if (result.type === "content") {
    return result.value
      .map((item) => (item.type === "text" ? item.text : `[Attached ${item.mime}${item.name ? `: ${item.name}` : ""}]`))
      .join("\n");
  }
  return typeof result.value === "string" ? result.value : (JSON.stringify(result.value) ?? "");
}

function flatten(message: Message): string {
  if (message.role === "system") return "";
  const speaker = message.role === "user" ? "User" : "Assistant";
  return message.content
    .flatMap((part): string[] => {
      switch (part.type) {
        case "text":
          return part.text ? [`[${speaker}]: ${part.text}`] : [];
        case "media":
          return [`[${part.media.mediaType} omitted]`];
        case "tool-call":
          return [`[Assistant tool call]: ${part.name}(${JSON.stringify(part.input) ?? ""})`];
        case "tool-result":
          return [`[${part.result.type === "error" ? "Tool error" : "Tool result"}]: ${truncate(resultText(part))}`];
        default:
          return [];
      }
    })
    .join("\n");
}

function stringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readSessionFacts(messages: readonly Message[]): SessionFacts {
  const userTexts: string[] = [];
  const lines: string[] = [];
  const failed = new Set<string>();
  const calls: Array<Extract<Part, { type: "tool-call" }>> = [];
  let previousSummary: string | undefined;

  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "tool-result" && part.result.type === "error") failed.add(part.id);
      if (part.type === "tool-call") calls.push(part);
    }
    if (message.role === "user") {
      const text = textOf(message);
      const summary = checkpointSummary(text);
      if (summary !== undefined) {
        previousSummary = summary;
        continue;
      }
      if (text) userTexts.push(text);
    }
    const line = flatten(message);
    if (line) lines.push(line);
  }

  const read = new Set<string>();
  const modified = new Set<string>();
  for (const call of calls) {
    if (failed.has(call.id)) continue;
    if (READ_TOOLS.has(call.name)) {
      const file = stringField(call.input, "path");
      if (file) read.add(file);
    } else if (WRITE_TOOLS.has(call.name)) {
      const file = stringField(call.input, "path");
      if (file) modified.add(file);
    } else if (call.name === "patch") {
      for (const match of (stringField(call.input, "patchText") ?? "").matchAll(PATCH_FILE_LINE)) {
        const file = (match[1] ?? match[2])?.trim();
        if (file) modified.add(file);
      }
    }
  }

  return {
    userTexts,
    previousSummary,
    readFiles: [...read].filter((file) => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
    transcript: lines.join("\n\n"),
  };
}
