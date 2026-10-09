import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildCheckpoint, completeSummary, RETAINED_IDENTIFIERS_HEADING, semanticSummary } from "../src/checkpoint.ts";
import { getGitEngineeringState } from "../src/git-state.ts";
import { readSessionFacts } from "../src/session.ts";
import plugin from "../src/index.ts";

const SHA = "1234567890abcdef1234567890abcdef12345678";
const noGit = { available: false, files: [], patch: "", lockfilesAndGeneratedAssets: [] };
const open = (name: string) => `<${name}>`;
const close = (name: string) => `</${name}>`;
const TOUCHED = "touched-files";

type Messages = Parameters<typeof readSessionFacts>[0];
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const call = (id: string, name: string, input: Record<string, unknown>) => ({
  role: "assistant",
  content: [{ type: "tool-call", id, name, input }],
});
const result = (id: string, name: string, value: string, type = "text") => ({
  role: "tool",
  content: [{ type: "tool-result", id, name, result: { type, value } }],
});
const checkpointMessage = (summary: string, recent?: string) =>
  user(
    [
      open("conversation-checkpoint"),
      "The following is a summary and serialized record of earlier conversation.",
      "",
      `${open("summary")}\n${summary}\n${close("summary")}`,
      ...(recent ? ["", `${open("recent-context")}\n${recent}\n${close("recent-context")}`] : []),
      close("conversation-checkpoint"),
    ].join("\n"),
  );

test("session facts keep user words, the previous checkpoint, files touched by tools, and a bounded transcript", () => {
  const previous = `latest checkpoint\n\n${open("read-files")}\n/repo/old-read.ts\n${close("read-files")}\n\n${open(TOUCHED)}\n/repo/old &amp; edited.ts\n${close(TOUCHED)}`;
  const recent = [
    "[User]: Keep 10.0.0.9 reachable",
    '[Assistant tool call]: edit({"path":"/repo/recent.ts","oldString":"a","newString":"b"})',
    "[Tool result]: ok",
    '[Assistant tool call]: write({"path":"/repo/denied.ts","content":"x"})',
    "[Tool error]: denied",
    "[Assistant]: Checked 10.0.0.10",
  ].join("\n");
  const failure = `${"setup\n".repeat(1_000)}FATAL: the real error`;
  const facts = readSessionFacts([
    checkpointMessage(previous, recent),
    user(`Deploy ${SHA} to https://example.com/api`),
    call("1", "read", { path: "/repo/src/a.ts" }),
    result("1", "read", "x".repeat(5_000)),
    call("2", "read", { path: "/repo/src/b.ts" }),
    call("3", "edit", { path: "/repo/src/b.ts", newString: "y".repeat(5_000) }),
    call("4", "write", { path: "/repo/src/c.ts" }),
    result("4", "write", "denied", "error"),
    call("5", "patch", { patchText: "*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** Update File: src/old.ts\n*** Move to: src/moved.ts\n*** End Patch" }),
    result("6", "shell", `\x1b[31m${failure}\x1b[0m`, "error"),
  ] as unknown as Messages);
  assert.deepEqual(facts.userTexts, ["Keep 10.0.0.9 reachable", `Deploy ${SHA} to https://example.com/api`]);
  assert.ok(facts.previousSummary?.startsWith("latest checkpoint"));
  assert.deepEqual(facts.readFiles, ["/repo/old-read.ts", "/repo/src/a.ts"], "read files accumulate across compactions");
  assert.deepEqual(facts.modifiedFiles, ["/repo/old & edited.ts", "/repo/recent.ts", "/repo/src/b.ts", "src/moved.ts", "src/new.ts", "src/old.ts"]);
  assert.ok(facts.transcript.startsWith("[User]: Keep 10.0.0.9 reachable\n"), "the verbatim recent context is summarized first");
  assert.match(facts.transcript, /\[User\]: Deploy/);
  assert.match(facts.transcript, /\[Assistant tool call\]: read\(path="\/repo\/src\/a\.ts"\)/);
  assert.match(facts.transcript, /\[Tool result: read\]: x+\n\n\[\.\.\. \d+ characters omitted/);
  assert.ok(!facts.transcript.includes("y".repeat(1_000)), "large tool arguments are bounded");
  assert.match(facts.transcript, /\[Tool error: write\]: denied/);
  assert.match(facts.transcript, /FATAL: the real error/, "the end of a failed command survives truncation");
  assert.ok(!facts.transcript.includes("\x1b["), "terminal escape sequences are stripped");
  assert.ok(!facts.transcript.includes("latest checkpoint"), "the previous checkpoint is carried separately");
});

test("carried-over file lists keep only the most recently used paths", () => {
  const oldReads = Array.from({ length: 50 }, (_, i) => `/repo/old-${String(i).padStart(2, "0")}.ts`);
  const previous = `latest checkpoint\n\n${open("read-files")}\n${oldReads.join("\n")}\n${close("read-files")}`;
  const facts = readSessionFacts([
    checkpointMessage(previous),
    call("1", "read", { path: "/repo/new.ts" }),
    call("2", "read", { path: "/repo/old-00.ts" }),
  ] as unknown as Messages);
  assert.equal(facts.readFiles.length, 40);
  assert.ok(facts.readFiles.includes("/repo/new.ts"), "a newly read file is kept");
  assert.ok(facts.readFiles.includes("/repo/old-00.ts"), "re-reading a file makes it recent again");
  assert.ok(!facts.readFiles.includes("/repo/old-01.ts"), "the oldest carried-over paths are dropped");
});

test("the prompt carries the conversation, previous checkpoint, and protected facts, without regenerated state", () => {
  const previous = `## 1. Primary Goal & Nuanced Intent\n- keep ${SHA}\n\n${open(TOUCHED)}\nold.ts\n${close(TOUCHED)}`;
  const checkpoint = buildCheckpoint(
    {
      userTexts: ["Use https://example.com/v1 and 10.0.0.5"],
      previousSummary: previous,
      readFiles: [],
      modifiedFiles: ["src/x.ts"],
      transcript: "[User]: Use https://example.com/v1 and 10.0.0.5",
    },
    noGit,
  );
  assert.match(checkpoint.prompt, /high-fidelity context continuity synthesizer/);
  assert.ok(checkpoint.prompt.includes(`${open("conversation")}\n[User]: Use https://example.com/v1`));
  assert.ok(checkpoint.prompt.includes(`${open("previous-summary")}\n## 1. Primary Goal`));
  assert.doesNotMatch(checkpoint.prompt, /old\.ts/, "regenerated state is not fed back");
  assert.ok(checkpoint.prompt.includes(`The ${open("conversation")} tags above contain NEW conversation turns`));
  assert.deepEqual(checkpoint.protectedFacts.sort(), ["10.0.0.5", SHA, "https://example.com/v1"].sort());
  assert.ok(checkpoint.appendix.includes(`${open(TOUCHED)}\nsrc/x.ts\n${close(TOUCHED)}`));
  assert.ok(checkpoint.appendix.includes("<uncommitted-state-unavailable"));

  const first = buildCheckpoint({ userTexts: ["start"], readFiles: [], modifiedFiles: [], transcript: "[User]: start" }, noGit);
  assert.ok(first.prompt.includes(`in the ${open("conversation")} tags above`));
  assert.ok(!first.prompt.includes(open("previous-summary")));
});

test("a finished summary gets dropped identifiers back verbatim and the exact file state", () => {
  const appendix = `\n\n${open(TOUCHED)}\na.ts\n${close(TOUCHED)}`;
  const done = completeSummary("## 1. Primary Goal\nwork on kept\n", { protectedFacts: [SHA, "kept"], appendix });
  assert.ok(done.includes(`${RETAINED_IDENTIFIERS_HEADING}\n- ${SHA}\n\n${open(TOUCHED)}`));
  assert.ok(!done.includes("- kept"), "facts already present are not repeated");
  assert.equal(semanticSummary(done).includes(open(TOUCHED)), false);
  assert.equal(completeSummary(`has ${SHA}`, { protectedFacts: [SHA], appendix: "" }), `has ${SHA}`);
});

test("git state covers tracked diffs and bounded untracked previews, never following symlinks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "osc-git-"));
  const outside = path.join(os.tmpdir(), `osc-secret-${process.pid}.txt`);
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(root, "tracked.ts"), "export const v = 1;\n");
    git("add", "tracked.ts");
    git("commit", "-qm", "init");
    fs.writeFileSync(path.join(root, "tracked.ts"), "export const v = 2;\n");
    fs.writeFileSync(path.join(root, "fresh.ts"), "export const fresh = true;\n");
    fs.writeFileSync(outside, "OUTSIDE-SECRET\n");
    fs.symlinkSync(outside, path.join(root, "link.txt"));
    const state = await getGitEngineeringState(root);
    assert.equal(state.available, true);
    assert.ok(state.patch.includes("export const v = 2"));
    assert.ok(state.patch.includes("export const fresh = true"));
    assert.ok(!state.patch.includes("OUTSIDE-SECRET"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
  assert.equal((await getGitEngineeringState(os.tmpdir())).available, false);
});

type CompactionHook = (event: Record<string, unknown>) => Promise<void>;
type Generate = (input: { prompt: string; model: unknown }) => Promise<{ text: string }>;

const SIX_SECTIONS = [
  "## 1. Primary Goal & Nuanced Intent\nship it",
  "## 2. Progress Ledger",
  "## 3. Code Changes & In-Progress Snippets",
  "## 4. Errors, Root Causes & Fixes",
  "## 5. Key Decisions & Hypotheses",
  "## 6. Resume Anchor & Immediate Next Action",
].join("\n");

async function load(generate: Generate, events: unknown[] = []) {
  let hook: CompactionHook | undefined;
  const ctx = {
    location: { directory: os.tmpdir() },
    options: { thresholdMode: "off" },
    event: {
      subscribe: async function* () {
        yield* events;
      },
    },
    session: {
      hook: async (name: string, callback: CompactionHook) => {
        assert.equal(name, "compaction");
        hook = callback;
        return { dispose: async () => {} };
      },
      get: async () => ({ location: { directory: os.tmpdir() }, model: { providerID: "cliproxy", id: "factory/claude-sonnet-5-5" } }),
    },
    generate: { text: generate },
  };
  const stop = await plugin.setup(ctx as never);
  await new Promise((resolve) => setImmediate(resolve));
  if (typeof stop === "function") await stop();
  assert.ok(hook, "the plugin registers a compaction hook");
  return hook;
}

const compactionEvent = () => ({
  sessionID: "ses_1",
  model: { providerID: "cliproxy", id: "factory/claude-opus-5-5", variant: "high" },
  messages: [user(`Ship ${SHA}`), call("1", "edit", { path: "src/app.ts" })],
  result: undefined as { summary: string } | undefined,
});

test("the compaction hook writes the checkpoint with the session's model and completes it", async () => {
  let request: { prompt: string; model: unknown } | undefined;
  const shell = (id: string, sessionID: string) => ({
    type: "shell.created",
    data: { info: { id, status: "running", command: `dev ${id}`, cwd: "/repo", file: `/tmp/${id}.log`, pid: 7, metadata: { sessionID } } },
  });
  const hook = await load(
    async (input) => {
      request = input;
      return { text: SIX_SECTIONS };
    },
    [shell("sh_live", "ses_1"), shell("sh_other", "ses_2"), shell("sh_done", "ses_1"), { type: "shell.exited", data: { id: "sh_done", status: "exited" } }],
  );
  assert.equal(plugin.id, "opencode-smart-compaction");

  const event = compactionEvent();
  await hook(event);
  assert.deepEqual(request?.model, event.model, "the session's variant is inherited");
  assert.match(request?.prompt ?? "", /## 6\. Resume Anchor/);
  assert.ok(request?.prompt.includes(`[User]: Ship ${SHA}`));
  assert.ok(event.result?.summary.startsWith("## 1. Primary Goal & Nuanced Intent\nship it"));
  assert.ok(event.result?.summary.includes(`- ${SHA}`));
  assert.ok(event.result?.summary.includes(`${open(TOUCHED)}\nsrc/app.ts\n${close(TOUCHED)}`));
  assert.match(event.result?.summary ?? "", /dev sh_live \(shell sh_live, pid 7/, "running background shells are listed");
  assert.doesNotMatch(event.result?.summary ?? "", /sh_other|sh_done/);
});

test("an incomplete summary is retried with default settings, then the session model", async () => {
  const models: unknown[] = [];
  const hook = await load(async (input) => {
    models.push(input.model);
    return { text: models.length < 3 ? "## 1. Primary Goal\ncut off" : SIX_SECTIONS };
  });
  const event = compactionEvent();
  await hook(event);
  assert.deepEqual(models, [
    event.model,
    { providerID: "cliproxy", id: "factory/claude-opus-5-5" },
    { providerID: "cliproxy", id: "factory/claude-sonnet-5-5" },
  ]);
  assert.ok(event.result?.summary.startsWith(SIX_SECTIONS));
});

test("a failed, empty, or incomplete generation leaves OpenCode's own compaction in place", async () => {
  let attempts = 0;
  const failing = await load(async () => {
    attempts++;
    throw new Error("offline");
  });
  const failed = compactionEvent();
  await failing(failed);
  assert.equal(failed.result, undefined);
  assert.equal(attempts, 3, "retryable errors try every model");

  attempts = 0;
  const fatal = await load(async () => {
    attempts++;
    throw new Error("401 Unauthorized");
  });
  await fatal(compactionEvent());
  assert.equal(attempts, 1, "authentication errors stop the retries");

  const empty = await load(async () => ({ text: "  " }));
  const blank = compactionEvent();
  await empty(blank);
  assert.equal(blank.result, undefined);

  const partial = await load(async () => ({ text: "## 1. Primary Goal\ncut off" }));
  const cut = compactionEvent();
  await partial(cut);
  assert.equal(cut.result, undefined);
});