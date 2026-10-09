import type { Plugin } from "@opencode/plugin";
import { buildCheckpoint, completeSummary } from "./checkpoint.ts";
import { getGitEngineeringState } from "./git-state.ts";
import { readSessionFacts } from "./session.ts";

const PLUGIN_ID = "opencode-smart-compaction";

/**
 * OpenCode plugin. The session `compaction` hook writes the checkpoint itself:
 * it builds the Smart Compaction prompt from the messages being summarized,
 * generates the summary with the session's model, completes it, and returns it
 * as the hook result so OpenCode skips its own summary request. Any failure
 * leaves the result unset, and OpenCode compacts with its built-in prompt.
 */
export default {
  id: PLUGIN_ID,
  async setup(ctx) {
    await ctx.session.hook("compaction", async (event) => {
      if (event.result) return;
      try {
        const facts = readSessionFacts(event.messages);
        if (!facts.transcript.trim()) return;
        const session = await ctx.session.get({ sessionID: event.sessionID });
        const git = await getGitEngineeringState(session.location.directory || ctx.location.directory);
        const checkpoint = buildCheckpoint(facts, git);
        const generated = await ctx.generate.text({ prompt: checkpoint.prompt, model: event.model });
        if (!generated.text.trim()) return;
        event.result = { summary: completeSummary(generated.text, checkpoint) };
      } catch (error) {
        console.warn(`[${PLUGIN_ID}] using OpenCode's compaction: ${String(error)}`);
      }
    });
  },
} satisfies Plugin.Plugin;