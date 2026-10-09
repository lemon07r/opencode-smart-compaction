import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildCheckpoint, completeSummary, RETAINED_IDENTIFIERS_HEADING, semanticSummary } from "../src/checkpoint.ts";
import { getGitEngineeringState } from "../src/git-state.ts";
import { readSessionFacts, type SessionEntry } from "../src/session.ts";
import plugin from "../src/index.ts";

const SHA = "1234567890abcdef1234567890abcdef12345678";
const noGit = { available: false, files: [], patch: "", lockfilesAndGeneratedAssets: [] };

const user = (text: string, synthetic = false): SessionEntry => ({ info: { role: "user" }, parts: [{ type: "text", text, synthetic }] });
const tool = (name: string, input: Record<string, unknown>, status = "completed"): SessionEntry => ({
  info: { role: "assistant" },
  parts: [{ type: "tool", tool: name, state: { status, input } }],
});
const summary = (text: string): SessionEntry => ({ info: { role: "assistant", summary: true }, parts: [{ type: "text", text }] });

test("session facts keep user words, the latest checkpoint, and files touched by tools", () => {
  const facts = readSessionFacts([
    user(`Deploy ${SHA} to https://example.com/api`),
    user("Continue if you have next steps", true),
    tool("read", { filePath: "/repo/src/a.ts" }),
    tool("read", { filePath: "/repo/src/b.ts" }),
    tool("edit", { filePath: "/repo/src/b.ts" }),
    tool("write", { filePath: "/repo/src/c.ts" }, "error"),
    tool("apply_patch", { patchText: "*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** Update File: src/old.ts\n*** Move to: src/moved.ts\n*** End Patch" }),
    summary("first checkpoint"),
    summary("latest checkpoint"),
  ]);
  assert.deepEqual(facts.userTexts, [`Deploy ${SHA} to https://example.com/api`]);
  assert.equal(facts.previousSummary, "latest checkpoint");
  assert.deepEqual(facts.readFiles, ["/repo/src/a.ts"]);
  assert.deepEqual(facts.modifiedFiles, ["/repo/src/b.ts", "src/moved.ts", "src/new.ts", "src/old.ts"]);
});

test("the prompt carries the previous checkpoint and protected facts, without regenerated state", () => {
  const previous = `## 1. Primary Goal & Nuanced Intent\n- keep ${SHA}\n\n<touched-files>\nold.ts\n</touched-files>`;
  const checkpoint = buildCheckpoint(
    { userTexts: ["Use https://example.com/v1 and 10.0.0.5"], previousSummary: previous, readFiles: [], modifiedFiles: ["src/x.ts"] },
    noGit,
  );
  assert.match(checkpoint.prompt, /high-fidelity context continuity synthesizer/);
  assert.match(checkpoint.prompt, /<previous-summary>\n## 1\. Primary Goal/);
  assert.doesNotMatch(checkpoint.prompt, /old\.ts/, "regenerated state is not fed back");
  assert.match(checkpoint.prompt, /The conversation history below contains NEW conversation turns/);
  assert.deepEqual(checkpoint.protectedFacts.sort(), ["10.0.0.5", SHA, "https://example.com/v1"].sort());
  assert.match(checkpoint.appendix, /<touched-files>\nsrc\/x\.ts\n<\/touched-files>/);
  assert.match(checkpoint.appendix, /<uncommitted-state-unavailable/);

  const first = buildCheckpoint({ userTexts: ["start"], readFiles: [], modifiedFiles: [] }, noGit);
  assert.match(first.prompt, /in the conversation history below/);
  assert.doesNotMatch(first.prompt, /<previous-summary>/);
});

test("a finished summary gets dropped identifiers back verbatim and the exact file state", () => {
  const done = completeSummary("## 1. Primary Goal\nwork on kept\n", { protectedFacts: [SHA, "kept"], appendix: "\n\n<touched-files>\na.ts\n</touched-files>" });
  assert.match(done, new RegExp(`${RETAINED_IDENTIFIERS_HEADING}\n- ${SHA}\n\n<touched-files>`));
  assert.ok(!done.includes("- kept"), "facts already present are not repeated");
  assert.equal(semanticSummary(done).includes("<touched-files>"), false);
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

test("the plugin replaces the prompt and completes only the compaction summary", async () => {
  const messages: SessionEntry[] = [user(`Ship ${SHA}`), tool("edit", { filePath: "src/app.ts" })];
  const client = {
    session: {
      messages: async () => ({ data: messages }),
      message: async ({ path: p }: { path: { messageID: string } }) => ({ data: { info: { summary: p.messageID === "summary-1" } } }),
    },
    app: { log: async () => ({}) },
  };
  assert.equal(plugin.id, "opencode-smart-compaction");
  const hooks = await plugin.server({ client, directory: os.tmpdir(), worktree: os.tmpdir() } as never);

  const output = { context: [] as string[], prompt: undefined as string | undefined };
  await hooks["experimental.session.compacting"]!({ sessionID: "s1" }, output);
  assert.match(output.prompt ?? "", /## 6\. Resume Anchor/);

  const other = { text: "regular reply" };
  await hooks["experimental.text.complete"]!({ sessionID: "s1", messageID: "reply-1", partID: "p" }, other);
  assert.equal(other.text, "regular reply", "non-summary text is untouched");

  const written = { text: "## 1. Primary Goal\nship it" };
  await hooks["experimental.text.complete"]!({ sessionID: "s1", messageID: "summary-1", partID: "p" }, written);
  assert.match(written.text, new RegExp(`- ${SHA}`));
  assert.match(written.text, /<touched-files>\nsrc\/app\.ts\n<\/touched-files>/);

  const again = { text: "later summary" };
  await hooks["experimental.text.complete"]!({ sessionID: "s1", messageID: "summary-1", partID: "p" }, again);
  assert.equal(again.text, "later summary", "a checkpoint completes one summary only");
});

test("a failing session read leaves OpenCode's own prompt in place", async () => {
  const client = {
    session: { messages: async () => { throw new Error("offline"); }, message: async () => ({ data: undefined }) },
    app: { log: async () => ({}) },
  };
  const hooks = await plugin.server({ client, directory: os.tmpdir(), worktree: os.tmpdir() } as never);
  const output = { context: [] as string[], prompt: undefined as string | undefined };
  await hooks["experimental.session.compacting"]!({ sessionID: "s1" }, output);
  assert.equal(output.prompt, undefined);
});