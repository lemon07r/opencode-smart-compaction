import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildCheckpoint, completeSummary, RETAINED_IDENTIFIERS_HEADING, semanticSummary } from "../src/checkpoint.ts";
import { getGitEngineeringState } from "../src/git-state.ts";
import { readSessionFacts, TOOL_OUTPUT_MAX_CHARS } from "../src/session.ts";
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
const checkpointMessage = (summary: string) =>
  user(
    [
      open("conversation-checkpoint"),
      "The following is a summary and serialized record of earlier conversation.",
      "",
      `${open("summary")}\n${summary}\n${close("summary")}`,
      close("conversation-checkpoint"),
    ].join("\n"),
  );

test("session facts keep user words, the previous checkpoint, files touched by tools, and a bounded transcript", () => {
  const facts = readSessionFacts([
    checkpointMessage("latest checkpoint"),
    user(`Deploy ${SHA} to https://example.com/api`),
    call("1", "read", { path: "/repo/src/a.ts" }),
    result("1", "read", "x".repeat(TOOL_OUTPUT_MAX_CHARS + 10)),
    call("2", "read", { path: "/repo/src/b.ts" }),
    call("3", "edit", { path: "/repo/src/b.ts" }),
    call("4", "write", { path: "/repo/src/c.ts" }),
    result("4", "write", "denied", "error"),
    call("5", "patch", { patchText: "*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** Update File: src/old.ts\n*** Move to: src/moved.ts\n*** End Patch" }),
  ] as unknown as Messages);
  assert.deepEqual(facts.userTexts, [`Deploy ${SHA} to https://example.com/api`]);
  assert.equal(facts.previousSummary, "latest checkpoint");
  assert.deepEqual(facts.readFiles, ["/repo/src/a.ts"]);
  assert.deepEqual(facts.modifiedFiles, ["/repo/src/b.ts", "src/moved.ts", "src/new.ts", "src/old.ts"]);
  assert.match(facts.transcript, /\[User\]: Deploy/);
  assert.match(facts.transcript, /\[Assistant tool call\]: read\(\{"path":"\/repo\/src\/a\.ts"\}\)/);
  assert.match(facts.transcript, /\n\[truncated\]/);
  assert.match(facts.transcript, /\[Tool error\]: denied/);
  assert.ok(!facts.transcript.includes("latest checkpoint"), "the previous checkpoint is carried separately");
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

async function load(generate: (input: { prompt: string; model: unknown }) => Promise<{ text: string }>) {
  let hook: CompactionHook | undefined;
  const ctx = {
    location: { directory: os.tmpdir() },
    session: {
      hook: async (name: string, callback: CompactionHook) => {
        assert.equal(name, "compaction");
        hook = callback;
        return { dispose: async () => {} };
      },
      get: async () => ({ location: { directory: os.tmpdir() } }),
    },
    generate: { text: generate },
  };
  await plugin.setup(ctx as never);
  assert.ok(hook, "the plugin registers a compaction hook");
  return hook;
}

const compactionEvent = () => ({
  sessionID: "ses_1",
  model: { providerID: "cliproxy", id: "factory/claude-opus-5-5" },
  messages: [user(`Ship ${SHA}`), call("1", "edit", { path: "src/app.ts" })],
  result: undefined as { summary: string } | undefined,
});

test("the compaction hook writes the checkpoint with the session's model and completes it", async () => {
  let request: { prompt: string; model: unknown } | undefined;
  const hook = await load(async (input) => {
    request = input;
    return { text: "## 1. Primary Goal\nship it" };
  });
  assert.equal(plugin.id, "opencode-smart-compaction");

  const event = compactionEvent();
  await hook(event);
  assert.deepEqual(request?.model, event.model);
  assert.match(request?.prompt ?? "", /## 6\. Resume Anchor/);
  assert.ok(request?.prompt.includes(`[User]: Ship ${SHA}`));
  assert.ok(event.result?.summary.startsWith("## 1. Primary Goal\nship it"));
  assert.ok(event.result?.summary.includes(`- ${SHA}`));
  assert.ok(event.result?.summary.includes(`${open(TOUCHED)}\nsrc/app.ts\n${close(TOUCHED)}`));
});

test("a failed or empty generation leaves OpenCode's own compaction in place", async () => {
  const failing = await load(async () => {
    throw new Error("offline");
  });
  const failed = compactionEvent();
  await failing(failed);
  assert.equal(failed.result, undefined);

  const empty = await load(async () => ({ text: "  " }));
  const blank = compactionEvent();
  await empty(blank);
  assert.equal(blank.result, undefined);
});