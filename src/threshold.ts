/**
 * Hybrid compaction threshold. OpenCode compacts automatically only when the
 * context reaches its model window minus `compaction.buffer`, so this watcher
 * adds an earlier trigger: after each model step, if the measured prompt has
 * reached a percentage of the window or an absolute token count, it requests a
 * compaction, which OpenCode runs at the next step boundary.
 */

import type { Plugin } from "@opencode/plugin";
import type { ServerEvent } from "./events.ts";

export type ThresholdMode = "percent" | "hard" | "hybrid";

export interface ThresholdConfig {
  mode: ThresholdMode;
  percent: number;
  hardLimitTokens: number;
}

export const DEFAULT_THRESHOLD: ThresholdConfig = { mode: "hybrid", percent: 95, hardLimitTokens: 600_000 };

/** Plugin options `thresholdMode`, `thresholdPercent`, and `hardLimitTokens`; undefined when the mode is `"off"`. */
export function readThresholdConfig(options: Readonly<Record<string, unknown>>): ThresholdConfig | undefined {
  const { thresholdMode: mode, thresholdPercent: percent, hardLimitTokens: hard } = options;
  if (mode === "off") return undefined;
  return {
    mode: mode === "percent" || mode === "hard" || mode === "hybrid" ? mode : DEFAULT_THRESHOLD.mode,
    percent: typeof percent === "number" && percent > 0 && percent <= 100 ? percent : DEFAULT_THRESHOLD.percent,
    hardLimitTokens: typeof hard === "number" && hard > 0 ? Math.floor(hard) : DEFAULT_THRESHOLD.hardLimitTokens,
  };
}

/** The prompt size that triggers compaction for a model window, or undefined when there is none. */
export function thresholdTokens(config: ThresholdConfig, window: number): number | undefined {
  const percentLimit = window > 0 ? Math.floor(window * (config.percent / 100)) : undefined;
  if (config.mode === "percent") return percentLimit;
  if (config.mode === "hard") return config.hardLimitTokens;
  return percentLimit === undefined ? config.hardLimitTokens : Math.min(percentLimit, config.hardLimitTokens);
}

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

/** The context a step used, counted the way OpenCode measures it for automatic compaction. */
export function contextTokens(tokens: TokenUsage): number {
  return tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + tokens.reasoning;
}

type Context = Pick<Plugin.Context, "model" | "session">;

/** Returns an event handler that requests compaction when a session step reaches the threshold. */
export function createThresholdWatcher(ctx: Context, config: ThresholdConfig, warn: (message: string) => void) {
  const models = new Map<string, string>();
  // Sessions with a compaction requested or running, and sessions whose last compaction failed. A failed session is
  // left to OpenCode's own threshold until a compaction succeeds, so a failing compaction is not retried every step.
  const pending = new Set<string>();
  const failed = new Set<string>();
  let windows: Promise<Map<string, number>> | undefined;

  const windowOf = async (model: string) => {
    windows ??= ctx.model
      .list()
      .then((result) => new Map(result.data.map((item) => [`${item.providerID}/${item.id}`, item.limit.input || item.limit.context])));
    try {
      return (await windows).get(model) ?? 0;
    } catch (error) {
      windows = undefined;
      throw error;
    }
  };

  const check = async (sessionID: string, tokens: TokenUsage) => {
    const model = models.get(sessionID);
    if (!model || pending.has(sessionID) || failed.has(sessionID)) return;
    const limit = thresholdTokens(config, await windowOf(model));
    const used = contextTokens(tokens);
    if (limit === undefined || used < limit || pending.has(sessionID)) return;
    pending.add(sessionID);
    try {
      await ctx.session.compact({ sessionID });
    } catch (error) {
      pending.delete(sessionID);
      throw error;
    }
  };

  return (event: ServerEvent) => {
    switch (event.type) {
      case "session.step.started":
        models.set(event.data.sessionID, `${event.data.model.providerID}/${event.data.model.id}`);
        break;
      case "session.step.ended":
        check(event.data.sessionID, event.data.tokens).catch((error) => warn(`threshold check failed: ${String(error)}`));
        break;
      case "session.compaction.started":
        pending.add(event.data.sessionID);
        break;
      case "session.compaction.ended":
        pending.delete(event.data.sessionID);
        failed.delete(event.data.sessionID);
        break;
      case "session.compaction.failed":
        if (pending.delete(event.data.sessionID)) failed.add(event.data.sessionID);
        break;
      case "session.deleted":
        models.delete(event.data.sessionID);
        pending.delete(event.data.sessionID);
        failed.delete(event.data.sessionID);
        break;
      case "model.updated":
      case "provider.updated":
        windows = undefined;
        break;
    }
  };
}
