import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { onboardFixture, draftFor, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { applyOnboard } from "../src/onboarding/onboard.mjs";
import { addRecord } from "../src/records/store.mjs";
import { rebuildIndex } from "../src/lessons/index.mjs";
import { writeKitReceipt } from "../src/hooks/receipt.mjs";
import { ownerAction } from "../src/hooks/owner-block.mjs";
import { adapter, AGENT_IDS } from "../src/agents/adapters/index.mjs";
import { renderBlock, planInstructions, BLOCK_CHARS } from "../src/agents/instructions.mjs";
import { formLine, commandFor, FORM_POINTER, COMPACT_COMMAND, FORM_START } from "../src/agents/command-form.mjs";
import { renderGuide } from "../src/stack/guide.mjs";
import { radarNote } from "../src/stack/digest.mjs";

// K1: every devtwin command that devtwin renders for an agent runs as written. src/cli.mjs refuses a route that is not
// root-free without --pilot, so a command is either the full form `node '<kit>/bin/devtwin.mjs' <command> --pilot
// '<pilot>'`, or the compact `devtwin <command>` in an output that the command-form definition covers: the instruction
// block itself, or a hook hint followed by FORM_POINTER.
const KIT = realpathSync(join(import.meta.dirname, ".."));
const SCOPE = "example", PROJECT = "example.atlas";
const long = (base, n) => base + "/" + "p".repeat(n - base.length - 1);
// The executable commands in a text: every backticked or code-block line that starts with devtwin or node.
const fullForms = (text, context) => text.split(/`|\n/).filter((part) => part.startsWith("node ")).every((part) => part.startsWith("node '" + context.kitRoot + "/bin/devtwin.mjs' ") && part.endsWith(" --pilot '" + context.pilotPath + "'"));
// Every compact command in a hook output is followed by the pointer; no other `devtwin` command appears.
function pointed(text) {
  const bad = [];
  for (const match of text.matchAll(COMPACT_COMMAND)) if (!text.startsWith(" " + FORM_POINTER, match.index + match[0].length)) bad.push(match[0]);
  // "devtwin hook live:" and "devtwin lessons —" are the hook's own labels, not commands.
  if (/(^|[\s(])devtwin (lesson [a-z]|handoff |instructions |paths |radar |record |context |hook verify)/m.test(text.replace(COMPACT_COMMAND, ""))) bad.push("bare devtwin command outside backticks");
  return bad;
}

test("command form: the instruction block defines the form once and stays within the cap with 120-character paths", () => {
  const context = { kitRoot: long("/kits", 120), pilotPath: long("/pilots", 120) };
  assert.equal(context.kitRoot.length, 120);
  const { text, kept, dropped } = renderBlock([], context);
  assert.ok(text.length <= BLOCK_CHARS, String(text.length));
  assert.deepEqual([kept, dropped], [[], []]);
  assert.equal(text.split(FORM_START).length - 1, 1, "one definition");
  assert.ok(text.includes(formLine(context)));
  // The definition names the bin and the pilot; every command after it is the compact form.
  assert.ok(formLine(context).includes(commandFor("<command>", context)));
  const commands = [...text.matchAll(COMPACT_COMMAND)].map((m) => m[0]);
  assert.deepEqual(commands.map((c) => c.split(" ").slice(0, 3).join(" ")), ["`devtwin instructions plan`", "`devtwin handoff write", "`devtwin lesson match"]);
  // The handoff rule lists every flag that handoff write requires.
  for (const flag of ["--scope", "--project", "--session", "--stopped", "--next", "--request-id", "--apply"]) assert.ok(commands[1].includes(flag), flag);
  // A path with a space or a quote is quoted for the shell.
  assert.equal(commandFor("hook verify", { kitRoot: "/a b/it's", pilotPath: "/p q/live.json" }), "node '/a b/it'\\''s/bin/devtwin.mjs' hook verify --pilot '/p q/live.json'");
});

// The session-start and prompt payloads of each agent, in its own shape.
const PAYLOADS = {
  claude: { start: (cwd, s) => ({ session_id: s, cwd, hook_event_name: "SessionStart", source: "startup" }), prompt: (cwd, s, prompt) => ({ session_id: s, cwd, hook_event_name: "UserPromptSubmit", prompt }) },
  codex: { start: (cwd, s) => ({ session_id: s, cwd, hook_event_name: "SessionStart", source: "startup" }), prompt: (cwd, s, prompt) => ({ session_id: s, cwd, hook_event_name: "UserPromptSubmit", prompt }) },
  gemini: { start: (cwd, s) => ({ session_id: s, cwd, hook_event_name: "SessionStart", source: "startup" }), prompt: (cwd, s, prompt) => ({ session_id: s, cwd, hook_event_name: "BeforeAgent", prompt }) },
  antigravity: { start: (cwd, s) => ({ conversationId: s, cwd, hookEventName: "SessionStart", workspacePaths: [cwd] }), prompt: (cwd, s, prompt) => ({ conversationId: s, cwd, hookEventName: "PreInvocation", workspacePaths: [cwd], invocationNum: 0, lastUserInput: prompt }) },
  opencode: { start: (cwd, s) => ({ hook_event_name: "SessionStart", session_id: s, cwd }), prompt: (cwd, s, prompt) => ({ hook_event_name: "UserPromptSubmit", session_id: s, cwd, prompt }) }
};
// All string values of one hook reply, whatever the agent's JSON shape.
const strings = (value) => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
async function hook(s, agent, event, body) {
  const chunks = [];
  await main(["hook", "--event", event, "--agent", agent, "--pilot", s.path], { stdout: { write: (v) => { chunks.push(v); return true; } }, stdin: JSON.stringify(body), now });
  return chunks.join("").trim().split("\n").filter(Boolean).flatMap((line) => strings(JSON.parse(line))).join("\n");
}
async function store(t) {
  const s = await onboardFixture(t, { scope: SCOPE, project: PROJECT });
  await applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now });
  for (let n = 1; n <= 5; n++) {
    const input = draftFor(SCOPE, PROJECT, { requestId: "req_formlsn0" + n, kind: "lesson", body: "Do run migrations before seeding the test database.\n" });
    input.draft = { ...input.draft, title: "Migrations lesson " + n, class: "lesson", reach: "project", match: { topics: ["migrations"] } };
    await addRecord(s.roots, input, { now });
  }
  await rebuildIndex(s.roots, SCOPE);
  // An open replacement notice, so the start line names lesson notices; a receipt two days from expiry, so it names
  // hook verify.
  const hub = join(s.stateRoot, "hubs", "example-hub");
  await mkdir(hub, { recursive: true, mode: 0o700 });
  await writeFile(join(hub, "notices.json"), JSON.stringify({ schemaVersion: 1, scope: SCOPE, notices: [{ id: "ntc_1" }] }), { mode: 0o600 });
  await writeKitReceipt(s.roots, { pilotPath: s.path, now: new Date(now().getTime() - 28 * 86400000) });
  return s;
}

test("command form: for each adapter the block holds the definition and every hook hint points to it", async (t) => {
  const s = await store(t);
  const context = { kitRoot: KIT, pilotPath: await realpath(s.path) };
  // Every adapter installs both hooks and an instruction block, so its hook hints may use the compact form.
  assert.deepEqual(AGENT_IDS.filter((id) => !adapter(id).capabilities.instructions || !adapter(id).hooks), []);
  for (const agent of AGENT_IDS) {
    const plan = await planInstructions(s.roots, s.pilot, { targetHome: s.agentHomes[0], agents: [agent], kitRoot: KIT });
    assert.ok(plan.block.includes(formLine(context)), agent);
    const start = await hook(s, agent, "session-start", PAYLOADS[agent].start(s.repo, "s-form-" + agent));
    assert.match(start, new RegExp("lessons? for example\\.atlas\\. Scope: example\\. "), agent);
    assert.ok(start.includes("run `devtwin lesson notices --scope example` " + FORM_POINTER + "."), agent + ": " + start);
    assert.ok(start.includes("run `devtwin hook verify` " + FORM_POINTER + "."), agent + ": " + start);
    const lessons = await hook(s, agent, "user-prompt", PAYLOADS[agent].prompt(s.repo, "s-form-" + agent, "fix the migrations"));
    assert.ok(lessons.includes("Load one with `devtwin lesson show --scope example --id <id>` " + FORM_POINTER + "."), agent + ": " + lessons);
    assert.ok(lessons.includes("1 more lesson matches; run `devtwin lesson match` " + FORM_POINTER + "."), agent + ": " + lessons);
    for (const text of [start, lessons]) assert.deepEqual(pointed(text), [], agent + ": " + text);
  }
});

test("command form: the not-verified start line gives the full verify command", async (t) => {
  const s = await onboardFixture(t, { scope: SCOPE, project: PROJECT });
  const line = await hook(s, "claude", "session-start", PAYLOADS.claude.start(s.repo, "s-unverified"));
  const context = { kitRoot: KIT, pilotPath: await realpath(s.path) };
  assert.ok(line.includes("`" + commandFor("hook verify", context) + "`"), line);
  assert.deepEqual([...line.matchAll(COMPACT_COMMAND)], []);
});

test("command form: a radar guide and a digest note give the full executable form", () => {
  const context = { kitRoot: long("/kits", 120), pilotPath: long("/pilots", 120) };
  const guide = renderGuide({ id: "0123456789ab", label: "Example tool", kind: "agent-tools", link: "https://example.com/tool", sourceUrl: "https://example.com/feed" }, { scope: SCOPE, digestDate: "2026-10-07", context });
  assert.ok(guide.includes(commandFor("lesson propose --scope example --session <session> --title \"<what you learned>\" --body-file <notes.md>", context)), guide);
  assert.ok(fullForms(guide, context));
  assert.deepEqual([...guide.matchAll(COMPACT_COMMAND)], []);
  for (const [scope, words] of [[SCOPE, "radar guide --scope example --item <item ID>"], [null, "radar guide --item <item ID>"]]) {
    const note = radarNote(scope, context);
    assert.ok(note.includes("`" + commandFor(words, context) + "`"), note);
    assert.deepEqual([...note.matchAll(COMPACT_COMMAND)], []);
  }
});

// The shell payload of each agent's shell tool, as its hook sends it before the tool runs.
const SHELL = {
  claude: (command) => ({ session_id: "s", cwd: "/w", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }),
  codex: (command) => ({ session_id: "s", cwd: "/w", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }),
  gemini: (command) => ({ session_id: "s", cwd: "/w", hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command } }),
  antigravity: (command) => ({ conversationId: "s", cwd: "/w", hookEventName: "PreToolUse", workspacePaths: ["/w"], toolCall: { id: "call-1", name: "run_command", args: { CommandLine: command } } }),
  opencode: (command) => ({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/w", tool_name: "shell", tool_input: { command } })
};
test("command form: the owner-action block denies owner actions in the node form for every adapter and allows agent routes", () => {
  const context = { kitRoot: "/opt/example-kit", pilotPath: "/x/live.json" };
  const denied = [
    ["lesson notices --scope example --ack --apply --plan-fingerprint sha256:00", "lesson notices --apply"],
    ["instructions apply --plan-fingerprint sha256:00", "instructions apply"],
    ["live set-kit --kit 0.1.0+sha256:00 --apply", "live set-kit --apply"],
    ["undo --id aud_000000000000000000000000 --apply", "undo --apply"]
  ];
  const allowed = ["handoff write --scope example --project example.atlas --session ses_one --stopped 'Tests pass' --next 'Open the PR' --request-id req_form0001 --apply",
    "lesson match --scope example --cwd /w --path db/a.sql", "lesson notices --scope example", "instructions plan", "hook verify", "lesson show --scope example --id lsn_x"];
  for (const agent of AGENT_IDS) {
    for (const [words, action] of denied) assert.equal(ownerAction(agent, SHELL[agent](commandFor(words, context))), action, agent + ": " + words);
    for (const words of allowed) assert.equal(ownerAction(agent, SHELL[agent](commandFor(words, context))), null, agent + ": " + words);
  }
});
