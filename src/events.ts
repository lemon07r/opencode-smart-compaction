import type { Plugin } from "@opencode/plugin";

export type ServerEvent = ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<infer Event> ? Event : never;

/** Feeds every server event to the handlers until the returned function is called. */
export function subscribe(
  ctx: Pick<Plugin.Context, "event">,
  handlers: ReadonlyArray<(event: ServerEvent) => void>,
  warn: (message: string) => void,
): () => void {
  const controller = new AbortController();
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      for (const handle of handlers) handle(event);
    }
  })().catch((error) => {
    if (!controller.signal.aborted) warn(`event stream stopped: ${String(error)}`);
  });
  return () => controller.abort();
}