import type { Plugin } from "@opencode/plugin";
import { buildCheckpoint, completeSummary, isCompleteSummary } from "./checkpoint.ts";
import { subscribe } from "./events.ts";
import { getGitEngineeringState } from "./git-state.ts";
import { readSessionFacts } from "./session.ts";
import { createShellTracker } from "./shells.ts";
import { createThresholdWatcher, readThresholdConfig } from "./threshold.ts";

const PLUGIN_ID = "opencode-smart-compaction";
const warn = (message: string) => console.warn(`[${PLUGIN_ID}] ${message}`);

type ModelRef = NonNullable<Parameters<Plugin.Context["generate"]["text"]>[0]["model"]>;

/**
 * The models to try, in order: the compaction model with its variant, the same model with its default settings,
 * then the session's model with its default settings when it differs.
 */
export function summaryModels(compaction: ModelRef, session?: ModelRef): ModelRef[] {
  const base = ({ providerID, id }: ModelRef): ModelRef => ({ providerID, id });
  const candidates = [compaction, base(compaction), ...(session ? [base(session)] : [])];
  const seen = new Set<string>();
  return candidates.filter((model) => {
    const key = `${model.providerID}/${model.id}#${model.variant ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Errors that another attempt cannot fix: cancellation, authentication, permission, and quota. */
export function isFatalGenerationError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("invalid_request") && /reasoning|effort|budget/.test(message)) return false;
  return /aborted|cancelled|\b40[123]\b|unauthorized|invalid_api_key|authentication|forbidden|insufficient_quota|billing/.test(message);
}

/**
 * OpenCode plugin. The session `compaction` hook writes the checkpoint itself:
 * it builds the Smart Compaction prompt from the messages being summarized,
 * generates the summary with the session's model and variant, checks that it
 * has all six sections, completes it, and returns it as the hook result so
 * OpenCode skips its own summary request. If no attempt yields a complete
 * summary, the result stays unset and OpenCode compacts with its built-in
 * prompt. An event watcher adds the hybrid threshold and tracks running shells.
 */
export default {
  id: PLUGIN_ID,
  async setup(ctx) {
    const shells = createShellTracker();

    await ctx.session.hook("compaction", async (event) => {
      if (event.result) return;
      try {
        const facts = readSessionFacts(event.messages);
        if (!facts.transcript.trim()) return;
        const session = await ctx.session.get({ sessionID: event.sessionID });
        const git = await getGitEngineeringState(session.location.directory || ctx.location.directory);
        const checkpoint = buildCheckpoint(facts, git, shells.running(event.sessionID));
        let problem = "no attempt was made";
        for (const model of summaryModels(event.model, session.model)) {
          try {
            const { text } = await ctx.generate.text({ prompt: checkpoint.prompt, model });
            if (isCompleteSummary(text)) {
              event.result = { summary: completeSummary(text, checkpoint) };
              return;
            }
            problem = text.trim() ? "the summary was missing required sections" : "the summary was empty";
          } catch (error) {
            if (isFatalGenerationError(error)) throw error;
            problem = String(error);
          }
        }
        warn(`using OpenCode's compaction: ${problem}`);
      } catch (error) {
        warn(`using OpenCode's compaction: ${String(error)}`);
      }
    });

    const threshold = readThresholdConfig(ctx.options);
    return subscribe(
      ctx,
      threshold ? [shells.handle, createThresholdWatcher(ctx, threshold, warn)] : [shells.handle],
      warn,
    );
  },
} satisfies Plugin.Plugin;