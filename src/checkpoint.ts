/**
 * Builds the compaction prompt and completes the model's summary.
 *
 * OpenCode appends the conversation after the prompt this module builds, so the
 * prompt carries everything else: the directives, the previous checkpoint (the
 * built-in prompt that normally carries it is replaced), and the protected
 * facts. After the model writes the summary, completeSummary restores any
 * protected identifier the model dropped and appends the exact file and
 * worktree state, as the Pi extension does.
 */

import {
  extractProtectedFacts,
  formatFileOperationsXml,
  sanitizeTagContent,
  SMART_COMPACTION_INITIAL_PROMPT,
  SMART_COMPACTION_SYSTEM_PROMPT,
  SMART_COMPACTION_UPDATE_PROMPT,
} from "./prompt.ts";
import type { GitEngineeringState } from "./git-state.ts";
import type { SessionFacts } from "./session.ts";

export const RETAINED_IDENTIFIERS_HEADING = "### Retained Identifiers";

// Everything from the first appended state block on is regenerated each time,
// so it is not fed back to the model as part of the previous checkpoint.
const APPENDED_STATE = /\n\n<(?:read-files|touched-files|uncommitted-dirty-files|modified-lockfiles-and-assets|active-background-processes|uncommitted-diff|uncommitted-state-unavailable)\b/i;

export function semanticSummary(summary: string): string {
  return summary.split(APPENDED_STATE)[0]!.trim();
}

export interface Checkpoint {
  prompt: string;
  protectedFacts: string[];
  appendix: string;
}

export function buildCheckpoint(facts: SessionFacts, git: GitEngineeringState): Checkpoint {
  const previousSummary = facts.previousSummary ? semanticSummary(facts.previousSummary) : undefined;
  const protectedFacts = extractProtectedFacts(facts.userTexts, previousSummary);

  const sections = [SMART_COMPACTION_SYSTEM_PROMPT];
  if (previousSummary) {
    sections.push(`<previous-summary>\n${sanitizeTagContent(previousSummary)}\n</previous-summary>`);
  }
  if (protectedFacts.length > 0) {
    sections.push(`<protected-facts>\n${protectedFacts.map(sanitizeTagContent).join("\n")}\n</protected-facts>`);
  }
  sections.push(previousSummary ? SMART_COMPACTION_UPDATE_PROMPT : SMART_COMPACTION_INITIAL_PROMPT);

  const appendix = formatFileOperationsXml({
    readFiles: facts.readFiles,
    touchedModifiedFiles: facts.modifiedFiles,
    activeDirtyFiles: git.files.map((file) => file.path),
    dirtyPatch: git.patch,
    dirtyStateAvailable: git.available,
    lockfilesAndGeneratedAssets: git.lockfilesAndGeneratedAssets,
  });

  return { prompt: sections.join("\n\n"), protectedFacts, appendix };
}

/** Restore dropped protected identifiers verbatim, then append the file and worktree state. */
export function completeSummary(text: string, checkpoint: Pick<Checkpoint, "protectedFacts" | "appendix">): string {
  let summary = text.trimEnd();
  const dropped = checkpoint.protectedFacts.filter((fact) => fact && !summary.includes(fact));
  if (dropped.length > 0) {
    summary = [summary, "", RETAINED_IDENTIFIERS_HEADING, ...dropped.map((fact) => `- ${fact}`)].join("\n");
  }
  return `${summary}${checkpoint.appendix}`;
}