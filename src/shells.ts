import type { ServerEvent } from "./events.ts";

interface RunningShell {
  sessionID?: string;
  label: string;
}

/**
 * Tracks running shells from the event stream, so a checkpoint can list the background processes a session started
 * and the next turn does not start a duplicate dev server. OpenCode's shell tool tags each shell with its session.
 */
export function createShellTracker() {
  const shells = new Map<string, RunningShell>();
  return {
    handle(event: ServerEvent) {
      if (event.type === "shell.created") {
        const { info } = event.data;
        if (info.status !== "running") return;
        const sessionID = typeof info.metadata.sessionID === "string" ? info.metadata.sessionID : undefined;
        const pid = info.pid === undefined ? "" : `, pid ${info.pid}`;
        shells.set(info.id, { sessionID, label: `${info.command} (shell ${info.id}${pid}, cwd ${info.cwd}, output ${info.file})` });
      } else if (event.type === "shell.exited" || event.type === "shell.deleted") {
        shells.delete(event.data.id);
      }
    },
    running(sessionID: string): string[] {
      return [...shells.values()].filter((shell) => shell.sessionID === sessionID).map((shell) => shell.label);
    },
  };
}