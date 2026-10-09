import type { Plugin } from "@opencode-ai/plugin";
import { buildCheckpoint, completeSummary, type Checkpoint } from "./checkpoint.ts";
import { getGitEngineeringState } from "./git-state.ts";
import { readSessionFacts, type SessionEntry } from "./session.ts";

const PLUGIN_ID = "opencode-smart-compaction";

/**
 * OpenCode 1 server plugin. `experimental.session.compacting` replaces the
 * summary prompt with the Smart Compaction checkpoint prompt;
 * `experimental.text.complete` then finishes the summary the compaction agent
 * wrote. A compaction that fails anywhere falls back to OpenCode's own prompt
 * rather than blocking the session.
 */
// The module exports only the plugin: OpenCode's legacy loader treats every
// exported function as a plugin, so helpers stay in their own files.
export const server: Plugin = async ({ client, directory, worktree }) => {
  // One pending checkpoint per session, between the prompt and the finished summary.
  const pending = new Map<string, Checkpoint>();

  const isSummary = async (sessionID: string, messageID: string) => {
    const response = await client.session.message({ path: { id: sessionID, messageID } });
    return (response.data?.info as { summary?: boolean } | undefined)?.summary === true;
  };

  return {
    "experimental.session.compacting": async (input, output) => {
      pending.delete(input.sessionID);
      try {
        const response = await client.session.messages({ path: { id: input.sessionID } });
        const facts = readSessionFacts((response.data ?? []) as SessionEntry[]);
        const git = await getGitEngineeringState(worktree || directory);
        const checkpoint = buildCheckpoint(facts, git);
        output.prompt = checkpoint.prompt;
        pending.set(input.sessionID, checkpoint);
      } catch (error) {
        await client.app
          .log({ body: { service: PLUGIN_ID, level: "warn", message: `Using OpenCode's compaction prompt: ${String(error)}` } })
          .catch(() => undefined);
      }
    },

    "experimental.text.complete": async (input, output) => {
      const checkpoint = pending.get(input.sessionID);
      if (!checkpoint) return;
      try {
        if (!(await isSummary(input.sessionID, input.messageID))) return;
        pending.delete(input.sessionID);
        output.text = completeSummary(output.text, checkpoint);
      } catch (error) {
        await client.app
          .log({ body: { service: PLUGIN_ID, level: "warn", message: `Summary left as written: ${String(error)}` } })
          .catch(() => undefined);
      }
    },

    event: async ({ event }) => {
      // A failed or abandoned compaction must not attach its state to a later message.
      if (event.type === "session.compacted" || event.type === "session.error" || event.type === "session.deleted") {
        const sessionID = (event.properties as { sessionID?: string; info?: { id?: string } }).sessionID
          ?? (event.properties as { info?: { id?: string } }).info?.id;
        if (sessionID) pending.delete(sessionID);
      }
    },
  };
};

export default { id: PLUGIN_ID, server };