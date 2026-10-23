import type { ServerEvent } from "./events.ts";
import { modelKey, type ModelLimits, type ModelRef } from "./model-limits.ts";
import type { ContextMessage } from "./subagents.ts";
import { contextTokens, type TokenUsage } from "./threshold.ts";

export interface CachedStep {
  model: string;
  /** When the step's request was sent, which is when the provider last used the cache. */
  startedAt: number;
  tokens: TokenUsage;
}

/** The most recent ended step, not an older warm step hidden by a newer cold one. */
export function createCacheTracker() {
  const started = new Map<string, { model: string; startedAt: number }>();
  const steps = new Map<string, CachedStep>();
  return {
    get: (sessionID: string) => steps.get(sessionID),
    handle(event: ServerEvent) {
      switch (event.type) {
        case "session.step.started":
          started.set(event.data.sessionID, { model: modelKey(event.data.model), startedAt: Date.now() });
          break;
        case "session.step.ended": {
          const step = started.get(event.data.sessionID);
          if (step) steps.set(event.data.sessionID, { ...step, tokens: event.data.tokens });
          else steps.delete(event.data.sessionID);
          break;
        }
        case "session.compaction.ended":
          steps.delete(event.data.sessionID);
          break;
        case "session.deleted":
          steps.delete(event.data.sessionID);
          started.delete(event.data.sessionID);
          break;
      }
    },
  };
}

/** Pure guard: a full-history request is worthwhile only with a warm, matching prefix and output room. */
export function cacheReusePlan(input: {
  enabled: boolean;
  model: ModelRef;
  sessionModel?: ModelRef;
  context: readonly ContextMessage[] | undefined;
  step?: CachedStep;
  limits?: ModelLimits;
  prompt: string;
  now: number;
}): { maxTokens: number } | string {
  const { enabled, model, sessionModel, context, step, limits, prompt, now } = input;
  if (!enabled) return "disabled";
  if (!sessionModel || modelLabelMismatch(model, sessionModel)) return "model-mismatch";
  if (!context) return "context-unavailable";
  if (context.some((message) => message.type === "assistant" && message.time?.completed === undefined)) return "incomplete-assistant";
  if (!step) return "no-recent-step";
  if (step.model !== modelKey(model)) return "step-model-mismatch";
  if (now - step.startedAt >= 270_000) return "cache-expired";
  if (step.tokens.cache.read + step.tokens.cache.write <= 0) return "cache-cold";
  const window = limits?.context || limits?.input || 0;
  if (window <= 0) return "unknown-model-window";
  const room = window - contextTokens(step.tokens) - Math.ceil(prompt.length / 4) - 8_000;
  if (room < 4_096) return "insufficient-room";
  return { maxTokens: Math.min(32_000, limits?.output && limits.output > 0 ? limits.output : 32_000, room) };
}

function modelLabelMismatch(a: ModelRef, b: ModelRef): boolean {
  return a.providerID !== b.providerID || a.id !== b.id || a.variant !== b.variant;
}
