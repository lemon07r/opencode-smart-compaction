/**
 * Reads what compaction needs from an OpenCode session: the user's own words
 * (for protected facts), the previous checkpoint, and the files the session
 * read or changed through tools.
 */

export type SessionPart = {
  type: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  state?: { status?: string; input?: Record<string, unknown> };
};

export type SessionEntry = {
  info: { id?: string; role: string; summary?: boolean };
  parts: SessionPart[];
};

export interface SessionFacts {
  userTexts: string[];
  previousSummary?: string;
  readFiles: string[];
  modifiedFiles: string[];
}

const READ_TOOLS = new Set(["read"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const PATCH_FILE_LINE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

function textOf(entry: SessionEntry): string {
  return entry.parts
    .filter((part) => part.type === "text" && typeof part.text === "string" && !part.synthetic)
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join("\n");
}

function stringInput(part: SessionPart, key: string): string | undefined {
  const value = part.state?.input?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readSessionFacts(entries: readonly SessionEntry[]): SessionFacts {
  const userTexts: string[] = [];
  const read = new Set<string>();
  const modified = new Set<string>();
  let previousSummary: string | undefined;

  for (const entry of entries) {
    if (entry.info.role === "user") {
      const text = textOf(entry);
      if (text) userTexts.push(text);
      continue;
    }
    if (entry.info.role !== "assistant") continue;
    if (entry.info.summary) {
      const text = textOf(entry);
      if (text) previousSummary = text;
      continue;
    }
    for (const part of entry.parts) {
      if (part.type !== "tool" || part.state?.status !== "completed" || !part.tool) continue;
      if (READ_TOOLS.has(part.tool)) {
        const file = stringInput(part, "filePath");
        if (file) read.add(file);
      } else if (WRITE_TOOLS.has(part.tool)) {
        const file = stringInput(part, "filePath");
        if (file) modified.add(file);
      } else if (part.tool === "apply_patch") {
        const patch = stringInput(part, "patchText") ?? "";
        for (const match of patch.matchAll(PATCH_FILE_LINE)) {
          const file = (match[1] ?? match[2])?.trim();
          if (file) modified.add(file);
        }
      }
    }
  }

  return {
    userTexts,
    previousSummary,
    readFiles: [...read].filter((file) => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}