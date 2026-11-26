import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { readFile, writeFile, readdir, chmod, mkdir, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { onboardFixture, draftFor, fixtureGit, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { applyOnboard } from "../src/onboarding/onboard.mjs";
import { addRecord } from "../src/records/store.mjs";
import { rebuildIndex, readIndex, indexPath } from "../src/lessons/index.mjs";
import { indexLine } from "../src/lessons/match.mjs";
import { canonicalJson, digest } from "../src/storage/canonical.mjs";
import { writeKitReceipt } from "../src/hooks/receipt.mjs";
import { sessionKey, sessionsDir, hookLogPath, budgetLogPath, readSession } from "../src/hooks/session.mjs";
import { DENY_REASON } from "../src/hooks/owner-block.mjs";
import { NOTICE, sessionTag, runHook } from "../src/hooks/commands.mjs";

// The hook runtime for Antigravity CLI: one JSON object from every run (the adapter's neutral reply when devtwin has
// nothing to say), and lessons for a tool call held in the session file until the next PreInvocation. The first test
// pins the stdout of the other three agents, so both changes stay invisible to them.
const SCOPE = "example", PROJECT = "example.atlas";
const KIT = realpathSync(join(import.meta.dirname, "..")), BIN = join(KIT, "bin/devtwin.mjs");
const OWNER_COMMAND = 'node "/opt/example-kit/bin/devtwin.mjs" live set-kit --pilot /x/live.json --kit /x/kit --apply --plan-fingerprint sha256:00';
const FILE = "db/migrations/002_users.sql", OTHER = "src/ui/button.tsx";
const ALL = { paths: ["db/migrations/**"], commands: ["npm run seed"], topics: ["migrations"] };
const HEAD = NOTICE + " Load one with `devtwin lesson show --scope " + SCOPE + " --id <id>` (command form: your devtwin instruction block).";
const more = (n) => n + (n === 1 ? " more lesson matches" : " more lessons match") + "; run `devtwin lesson match` (command form: your devtwin instruction block).";
// A bound project with one lesson per [title, match] pair, built as test/agent-adapters.test.mjs builds its Gemini
// lesson fixture. line(id) is the index line the hook prints for a lesson.
async function store(t, { receipt = true, lessons = [["Migrations before seeds", ALL]] } = {}) {
  const s = await onboardFixture(t, { scope: SCOPE, project: PROJECT });
  await applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now });
  const ids = [];
  for (const [i, [title, match]] of lessons.entries()) {
    const input = draftFor(SCOPE, PROJECT, { requestId: "req_agyrun" + String(i).padStart(2, "0"), kind: "lesson", body: "Do run migrations before seeding the test database.\n" });
    input.draft = { ...input.draft, title, class: "lesson", reach: "project", match };
    ids.push((await addRecord(s.roots, input, { now })).recordId);
  }
  await rebuildIndex(s.roots, SCOPE);
  if (receipt) await writeKitReceipt(s.roots, { pilotPath: s.path, now: now() });
  const index = await readIndex(s.roots, SCOPE);
  return { ...s, ids, index, line: (id) => "- " + indexLine(index.entries.find((e) => e.id === id)) };
}
// One in-process hook call through the CLI entry point. The output is the exact stdout text.
async function run(s, agent, event, body, { pilot = s.path, stdin } = {}) {
  const chunks = [];
  const code = await main(["hook", "--event", event, "--agent", agent, "--pilot", pilot], { stdout: { write: (v) => { chunks.push(v); return true; } }, stdin: stdin ?? (typeof body === "string" ? body : JSON.stringify(body)), now });
  return { code, out: chunks.join("") };
}
// The same call through the real binary, at the real time.
function bin(s, agent, event, body, { pilot = s.path } = {}) {
  const r = spawnSync(process.execPath, [BIN, "hook", "--event", event, "--agent", agent, "--pilot", pilot], { input: typeof body === "string" ? body : JSON.stringify(body), env: { PATH: process.env.PATH, HOME: s.fakeHome }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const jsonLines = async (path) => { try { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch (error) { if (error.code === "ENOENT") return []; throw error; } };
// The Kit part repeats the kit path of the verify command, so it goes when the line passes 400 bytes (fitLine).
const fitKit = (line) => Buffer.byteLength(line + " Kit: `" + KIT + "`.") <= 400 ? line + " Kit: `" + KIT + "`." : line;
const notVerified = (s, problem) => fitKit("devtwin hook: kit not verified (" + problem + "); run `node '" + KIT + "/bin/devtwin.mjs' hook verify --pilot '" + realpathSync(s.path) + "'`. Lessons are off.");
const liveLine = (agent, session, count = 1) => "devtwin hook live: " + count + " lesson" + (count === 1 ? "" : "s") + " for " + PROJECT + ". Scope: " + SCOPE + ". Index lines arrive when work matches. Kit: `" + KIT + "`. Session ID for lesson propose: " + sessionTag(sessionKey(agent, session)) + ".";

// What Claude Code, Codex and Gemini CLI send and read. The stdout strings are written out here, not built by the
// adapters, so a change to any byte fails.
const SHAPES = {
  claude: { events: { "session-start": "SessionStart", "user-prompt": "UserPromptSubmit", "pre-tool": "PreToolUse", "post-tool": "PostToolUse", "pre-compact": "PreCompact", stop: "Stop" }, preToolContext: true, postToolCommands: false,
    edit: (cwd, rel) => ({ tool_name: "Edit", tool_input: { file_path: join(cwd, rel), old_string: "a", new_string: "b" } }), shell: (command) => ({ tool_name: "Bash", tool_input: { command } }) },
  codex: { events: { "session-start": "SessionStart", "user-prompt": "UserPromptSubmit", "pre-tool": "PreToolUse", "post-tool": "PostToolUse", "pre-compact": "PreCompact", "post-compact": "PostCompact", stop: "Stop" }, preToolContext: true, postToolCommands: false,
    edit: (cwd, rel) => ({ tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Update File: " + rel + "\n@@\n-a\n+b\n*** End Patch\n" } }), shell: (command) => ({ tool_name: "Bash", tool_input: { command } }) },
  gemini: { events: { "session-start": "SessionStart", "user-prompt": "BeforeAgent", "pre-tool": "BeforeTool", "post-tool": "AfterTool", "pre-compact": "PreCompress", stop: "AfterAgent" }, preToolContext: false, postToolCommands: true,
    edit: (cwd, rel) => ({ tool_name: "replace", tool_input: { file_path: join(cwd, rel), old_string: "a", new_string: "b" } }), shell: (command) => ({ tool_name: "run_shell_command", tool_input: { command } }) }
};
const contextOut = (agent, cli, text) => '{"hookSpecificOutput":{"hookEventName":"' + SHAPES[agent].events[cli] + '","additionalContext":' + JSON.stringify(text) + "}}\n";
const denyOut = (agent) => agent === "gemini" ? '{"decision":"deny","reason":' + JSON.stringify(DENY_REASON) + "}\n"
  : '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":' + JSON.stringify(DENY_REASON) + "}}\n";

test("Claude Code, Codex and Gemini CLI hook stdout is byte-identical for every event", async (t) => {
  const s = await store(t, { receipt: false });
  const block = HEAD + "\n" + s.line(s.ids[0]);
  const body = (agent, cli, session, extra = {}) => ({ session_id: session, transcript_path: "/workspace/example/session.jsonl", cwd: s.repo, hook_event_name: SHAPES[agent].events[cli], ...extra });
  const check = async (agent, label, cli, payload, expected, options) => {
    const r = await run(s, agent, cli, payload, options);
    assert.deepEqual([r.code, r.out], [0, expected], agent + " " + cli + ": " + label);
  };
  const agents = Object.keys(SHAPES);
  // No receipt: only session start speaks, and the owner-action deny still prints.
  for (const agent of agents) {
    const shape = SHAPES[agent];
    await check(agent, "no receipt", "session-start", body(agent, "session-start", "nr-1", { source: "startup" }), contextOut(agent, "session-start", notVerified(s, "missing")));
    await check(agent, "no receipt", "user-prompt", body(agent, "user-prompt", "nr-1", { prompt: "fix the migrations" }), "");
    await check(agent, "no receipt", "pre-tool", body(agent, "pre-tool", "nr-1", shape.edit(s.repo, FILE)), "");
    await check(agent, "no receipt, owner action", "pre-tool", body(agent, "pre-tool", "nr-1", shape.shell(OWNER_COMMAND)), denyOut(agent));
    await check(agent, "no receipt", "post-tool", body(agent, "post-tool", "nr-1", shape.edit(s.repo, FILE)), "");
    await check(agent, "no receipt", "pre-compact", body(agent, "pre-compact", "nr-1", { trigger: "auto" }), "");
    await check(agent, "no receipt", "stop", body(agent, "stop", "nr-1", { stop_hook_active: false }), "");
  }
  await assert.rejects(readdir(join(s.stateRoot, "hooks")), { code: "ENOENT" });
  await writeKitReceipt(s.roots, { pilotPath: s.path, now: now() });
  // Session starts come first: a later Stop leaves a stub that adds a line to the next session start.
  for (const agent of agents) await check(agent, "live line", "session-start", body(agent, "session-start", "s-start", { source: "startup" }), contextOut(agent, "session-start", liveLine(agent, "s-start")));
  for (const agent of agents) {
    const shape = SHAPES[agent], context = (cli) => contextOut(agent, cli, block);
    const prompt = body(agent, "user-prompt", "s-prompt", { prompt: "fix the migrations" });
    await check(agent, "a prompt lesson", "user-prompt", prompt, context("user-prompt"));
    await check(agent, "the same prompt again", "user-prompt", prompt, "");
    await check(agent, "an unrelated prompt", "user-prompt", body(agent, "user-prompt", "s-quiet", { prompt: "Rename the button component." }), "");
    await check(agent, "an empty prompt", "user-prompt", body(agent, "user-prompt", "s-quiet", { prompt: "" }), "");
    await check(agent, "no prompt", "user-prompt", body(agent, "user-prompt", "s-quiet"), "");
    const before = body(agent, "pre-tool", "s-before", shape.edit(s.repo, FILE));
    await check(agent, "a file lesson before the tool", "pre-tool", before, shape.preToolContext ? context("pre-tool") : "");
    await check(agent, "the same file again", "pre-tool", before, "");
    await check(agent, "an unrelated file", "pre-tool", body(agent, "pre-tool", "s-quiet", shape.edit(s.repo, OTHER)), "");
    await check(agent, "a command lesson before the tool", "pre-tool", body(agent, "pre-tool", "s-command", shape.shell("npm run seed")), shape.preToolContext ? context("pre-tool") : "");
    await check(agent, "an owner action", "pre-tool", body(agent, "pre-tool", "s-owner", shape.shell(OWNER_COMMAND)), denyOut(agent));
    await check(agent, "an owner action preview", "pre-tool", body(agent, "pre-tool", "s-owner", shape.shell(OWNER_COMMAND.replace(" --apply", ""))), "");
    const after = body(agent, "post-tool", "s-after", shape.edit(s.repo, FILE));
    await check(agent, "a file lesson after the tool", "post-tool", after, context("post-tool"));
    await check(agent, "the same file again", "post-tool", after, "");
    await check(agent, "a command lesson after the tool", "post-tool", body(agent, "post-tool", "s-after-command", shape.shell("npm run seed")), shape.postToolCommands ? context("post-tool") : "");
    await check(agent, "an unrelated file", "post-tool", body(agent, "post-tool", "s-quiet", shape.edit(s.repo, OTHER)), "");
    await check(agent, "compaction", "pre-compact", body(agent, "pre-compact", "s-prompt", { trigger: "auto" }), "");
    if (shape.events["post-compact"]) await check(agent, "after compaction", "post-compact", body(agent, "post-compact", "s-prompt"), "");
    await check(agent, "the end of a turn", "stop", body(agent, "stop", "s-prompt", { stop_hook_active: false }), "");
    // After the compaction the prompt lesson arrives again: the session file was removed.
    await check(agent, "the prompt after compaction", "user-prompt", prompt, context("user-prompt"));
    for (const cli of Object.keys(shape.events)) {
      await check(agent, "a bad payload", cli, "not json", "");
      await check(agent, "an empty payload", cli, "", "");
      await check(agent, "an array payload", cli, "[]", "");
      await check(agent, "a payload for another event", cli, { ...body(agent, cli, "s-quiet", { prompt: "fix the migrations" }), hook_event_name: "Notification" }, "");
      await check(agent, "no session", cli, { cwd: s.repo, hook_event_name: shape.events[cli], prompt: "fix the migrations" }, "");
      await check(agent, "no cwd", cli, { session_id: "s-quiet", hook_event_name: shape.events[cli], prompt: "fix the migrations" }, "");
      await check(agent, "a missing pilot", cli, body(agent, cli, "s-quiet", { prompt: "fix the migrations" }), "", { pilot: join(s.sandbox, "missing.json") });
    }
    await check(agent, "an owner action with a missing pilot", "pre-tool", body(agent, "pre-tool", "s-owner", shape.shell(OWNER_COMMAND)), denyOut(agent), { pilot: join(s.sandbox, "missing.json") });
  }
  // No session file of these agents holds a deferred lesson field.
  for (const name of (await readdir(sessionsDir(s.stateRoot))).filter((n) => /^[a-f0-9]{64}\.json$/.test(n))) {
    assert.deepEqual(Object.keys(JSON.parse(await readFile(join(sessionsDir(s.stateRoot), name), "utf8"))), ["schemaVersion", "agent", "delivered", "lines", "overflowed", "updatedAt"], name);
  }
  // The real binary, at the real time: silence, a context delivery and a deny.
  await writeKitReceipt(s.roots, { pilotPath: s.path, now: new Date() });
  for (const agent of agents) {
    const shape = SHAPES[agent];
    assert.deepEqual(bin(s, agent, "pre-tool", body(agent, "pre-tool", "b-quiet", shape.edit(s.repo, OTHER))), { code: 0, out: "", err: "" }, agent);
    assert.deepEqual(bin(s, agent, "stop", "not json"), { code: 0, out: "", err: "" }, agent);
    assert.deepEqual(bin(s, agent, "user-prompt", body(agent, "user-prompt", "b-prompt", { prompt: "fix the migrations" })), { code: 0, out: contextOut(agent, "user-prompt", block), err: "" }, agent);
    assert.deepEqual(bin(s, agent, "pre-tool", body(agent, "pre-tool", "b-owner", shape.shell(OWNER_COMMAND))), { code: 0, out: denyOut(agent), err: "" }, agent);
  }
});

// Payloads as Antigravity CLI 1.5 sends them: camelCase keys, the tool call under toolCall with PascalCase args.
const SESSION = "agy-conversation-0001";
const base = (cwd, event, extra = {}) => ({ conversationId: SESSION, cwd, hookEventName: event, modelName: "example-model", workspacePaths: [cwd], ...extra });
const call = (cwd, event, name, args, extra = {}) => base(cwd, event, { stepIdx: 3, toolCall: { id: "call-0001", name, args }, ...extra });
const shell = (cwd, event, commandLine, extra) => call(cwd, event, "run_command", { CommandLine: commandLine, WaitMsBeforeAsync: 5000, toolSummary: "run a command" }, extra);
const edited = (cwd, rel, extra = {}) => call(cwd, "PostToolUse", "edit_file", { Path: join(cwd, rel), toolSummary: "edit a file" }, { error: "", ...extra });
const ran = (cwd, commandLine, extra = {}) => shell(cwd, "PostToolUse", commandLine, { error: "", ...extra });
// PreInvocation fires before every model call. prompt undefined gives a payload with no lastUserInput.
const invocation = (cwd, prompt, extra = {}) => base(cwd, "PreInvocation", { invocationNum: 0, ...(prompt === undefined ? {} : { lastUserInput: prompt }), ...extra });
const EMPTY = "{}\n", ASK = '{"decision":"ask"}\n', STOP = '{"decision":""}\n';
const DENY = '{"decision":"deny","reason":' + JSON.stringify(DENY_REASON) + "}\n";
const inject = (text) => '{"injectSteps":[{"systemMessage":{"systemMessage":' + JSON.stringify(text) + "}}]}\n";
const NEUTRAL = { "session-start": EMPTY, "user-prompt": EMPTY, "pre-tool": ASK, "post-tool": EMPTY, stop: STOP };
const NAMES = { "session-start": "SessionStart", "user-prompt": "PreInvocation", "pre-tool": "PreToolUse", "post-tool": "PostToolUse", stop: "Stop" };
async function agy(s, event, body, options) {
  const r = await run(s, "antigravity", event, body, options);
  assert.equal(r.code, 0);
  return r.out;
}
const sessionFile = (s, id = SESSION) => join(sessionsDir(s.stateRoot), sessionKey("antigravity", id) + ".json");
const state = async (s, id) => { const { updatedAt, ...rest } = JSON.parse(await readFile(sessionFile(s, id), "utf8")); return rest; };
const fresh = (extra = {}) => ({ schemaVersion: 1, agent: "antigravity", delivered: [], lines: 0, overflowed: false, ...extra });
const indexLines = (out) => out === EMPTY ? [] : JSON.parse(out).injectSteps[0].systemMessage.systemMessage.split("\n").filter((l) => l.startsWith("- "));
// The stored index with other entries, written as the index writer does.
async function writeIndex(s, index) {
  const { fingerprint, ...body } = index;
  await writeFile(indexPath(s.roots, index.scope), canonicalJson({ ...body, fingerprint: digest(body) }) + "\n", { mode: 0o600 });
}

test("antigravity hook always prints one JSON object and exits 0, with no receipt, a bad payload, an unreadable pilot or nothing to say", async (t) => {
  const bare = await store(t, { receipt: false }), s = await store(t);
  const events = Object.keys(NEUTRAL);
  // A payload with nothing in it for devtwin: a harmless command, an unrelated file, an unrelated prompt.
  const quiet = (repo, cli, extra = {}) => cli === "pre-tool" ? shell(repo, "PreToolUse", "ls -la", extra) : cli === "post-tool" ? edited(repo, OTHER, extra) : base(repo, NAMES[cli], { lastUserInput: "Rename the button component.", ...extra });
  // Exactly one JSON object and a newline, never an empty stdout and never two objects.
  const one = (out, expected, label) => { assert.match(out, /^\{[^\n]*\}\n$/, label); assert.equal(out, expected, label); };
  // No receipt: session start names the missing receipt, every other event gets its neutral reply.
  for (const cli of events) {
    const expected = cli === "session-start" ? inject(notVerified(bare, "missing")) : NEUTRAL[cli];
    one(await agy(bare, cli, quiet(bare.repo, cli)), expected, "no receipt, " + cli);
    assert.deepEqual(bin(bare, "antigravity", cli, quiet(bare.repo, cli)), { code: 0, out: expected, err: "" }, "no receipt, binary, " + cli);
  }
  await assert.rejects(readdir(join(bare.stateRoot, "hooks")), { code: "ENOENT" });
  // An unreadable pilot: a missing file, a file that is not JSON and one with no absolute stateRoot.
  const pilots = [join(s.sandbox, "missing.json"), join(s.sandbox, "not-json.json"), join(s.sandbox, "relative.json")];
  await writeFile(pilots[1], "{\"stateRoot\":");
  await writeFile(pilots[2], JSON.stringify({ stateRoot: "relative/state" }));
  for (const cli of events) {
    for (const pilot of pilots) one(await agy(s, cli, quiet(s.repo, cli), { pilot }), NEUTRAL[cli], "unreadable pilot, " + cli);
    assert.deepEqual(bin(s, "antigravity", cli, quiet(s.repo, cli), { pilot: pilots[0] }), { code: 0, out: NEUTRAL[cli], err: "" }, "missing pilot, binary, " + cli);
    // A bad or empty payload, a payload for another event, and one with no conversation or no folder.
    for (const text of ["not json", "", "[]", "null", "7", "{\"conversationId\":"]) one(await agy(s, cli, text), NEUTRAL[cli], "bad payload " + JSON.stringify(text) + ", " + cli);
    assert.deepEqual(bin(s, "antigravity", cli, "not json"), { code: 0, out: NEUTRAL[cli], err: "" }, "bad payload, binary, " + cli);
    one(await agy(s, cli, quiet(s.repo, cli, { hookEventName: "PostInvocation" })), NEUTRAL[cli], "another event, " + cli);
    one(await agy(s, cli, quiet(s.repo, cli, { conversationId: undefined })), NEUTRAL[cli], "no conversation, " + cli);
    one(await agy(s, cli, quiet(s.repo, cli, { cwd: undefined, workspacePaths: [] })), NEUTRAL[cli], "no folder, " + cli);
    // No payload at all: a terminal on stdin.
    one(await agy(s, cli, null, { stdin: { isTTY: true } }), NEUTRAL[cli], "a terminal on stdin, " + cli);
  }
  // Nothing to say, with a valid receipt.
  // Session start has its line to say. It comes before the Stop call, whose stub adds a line to a later session start.
  one(await agy(s, "session-start", quiet(s.repo, "session-start")), inject(liveLine("antigravity", SESSION)), "session start");
  for (const cli of events.filter((e) => e !== "session-start")) one(await agy(s, cli, quiet(s.repo, cli)), NEUTRAL[cli], "nothing to say, " + cli);
  // Antigravity has no compaction event; the route still answers with one object.
  one(await agy(s, "pre-compact", base(s.repo, "PreCompact")), EMPTY, "pre-compact");
  // stdin that never ends: the read times out, and the reply still arrives.
  const stream = new PassThrough(), keep = setTimeout(() => null, 10000);
  try { one(await agy(s, "pre-tool", null, { stdin: stream }), ASK, "stdin timeout"); } finally { clearTimeout(keep); stream.destroy(); }
  // A damaged session file and a damaged index are thrown errors inside the hook.
  await mkdir(sessionsDir(s.stateRoot), { recursive: true, mode: 0o700 });
  for (const [cli, body] of [["post-tool", edited(s.repo, FILE, { conversationId: "agy-cut-short" })], ["user-prompt", invocation(s.repo, "fix the migrations", { conversationId: "agy-cut-short" })]]) {
    await writeFile(sessionFile(s, "agy-cut-short"), "{\"schemaVersion\":1,\"agent\":\"anti", { mode: 0o600 });
    one(await agy(s, cli, body), EMPTY, "damaged session file, " + cli);
    await assert.rejects(readFile(sessionFile(s, "agy-cut-short")), { code: "ENOENT" });
  }
  assert.ok((await jsonLines(hookLogPath(s.stateRoot))).some((e) => e.agent === "antigravity" && e.code === "session-corrupt"));
  // The real binary, at the real time, with a valid receipt.
  await writeKitReceipt(s.roots, { pilotPath: s.path, now: new Date() });
  for (const cli of events) {
    const r = bin(s, "antigravity", cli, quiet(s.repo, cli, { conversationId: "agy-binary" }));
    assert.deepEqual([r.code, r.err], [0, ""], cli);
    assert.match(r.out, /^\{[^\n]*\}\n$/, cli);
    // The Stop call above left a stub, so this session start has a stub line after its live line.
    if (cli === "session-start") assert.ok(JSON.parse(r.out).injectSteps[0].systemMessage.systemMessage.startsWith(liveLine("antigravity", "agy-binary")), r.out);
    else assert.equal(r.out, NEUTRAL[cli], "nothing to say, binary, " + cli);
  }
  await writeFile(indexPath(s.roots, SCOPE), "{\"schemaVersion\":1,\"scope\":\"example\",\"entries\":[", { mode: 0o600 });
  for (const cli of events) {
    const r = bin(s, "antigravity", cli, quiet(s.repo, cli, { conversationId: "agy-damaged-index" }));
    assert.deepEqual([r.code, r.err, r.out], [0, "", NEUTRAL[cli]], "damaged index, binary, " + cli);
  }
  assert.ok((await jsonLines(hookLogPath(s.stateRoot))).some((e) => e.agent === "antigravity" && e.code === "DEVTWIN_INTEGRITY"));
  // Bad arguments stay silent, for Antigravity too: an unknown event, an unknown agent, an extra flag, and a known agent
  // and event with an empty --pilot value. The last one returns before the neutral reply, so its stdout is empty.
  for (const args of [["hook", "--event", "nope", "--agent", "antigravity", "--pilot", s.path], ["hook", "--event", "pre-tool", "--agent", "other", "--pilot", s.path], ["hook", "--event", "pre-tool", "--agent", "antigravity", "--pilot", s.path, "--extra"],
    ["hook", "--event", "pre-tool", "--agent", "antigravity", "--pilot", ""]]) {
    const chunks = [];
    assert.equal(await main(args, { stdout: { write: (v) => { chunks.push(v); return true; } }, stdin: "{}", now }), 0);
    assert.equal(chunks.join(""), "", args.join(" "));
  }
  // No --pilot flag at all: the hook route is silent in the same way. Through the CLI the call does not reach the hook
  // route, because the pilot gate answers first, with the CLI error object and exit code 1, as for every agent.
  const chunks = [], stdout = { write: (v) => { chunks.push(v); return true; } };
  assert.equal(await runHook(["--event", "pre-tool", "--agent", "antigravity"], { stdout, stdin: "{}", now }), 0);
  assert.equal(chunks.join(""), "", "the hook route with no --pilot flag");
  assert.equal(await main(["hook", "--event", "pre-tool", "--agent", "antigravity"], { stdout, stdin: "{}", now }), 1);
  assert.equal(JSON.parse(chunks.join("")).error.code, "DEVTWIN_GATE_REQUIRED");
});

test("antigravity PreToolUse prints the ask decision without an owner action and only the deny with one", async (t) => {
  const s = await store(t);
  const pre = (name, args, extra) => call(s.repo, "PreToolUse", name, args, extra);
  // No owner action: "ask" hands the call back to Antigravity's own permission flow. No lesson arrives before a tool.
  const harmless = [shell(s.repo, "PreToolUse", "ls -la"), shell(s.repo, "PreToolUse", "npm run seed"), pre("manage_task", { Action: "send_input", Input: "y\n" }), pre("manage_task", { Action: "list" }),
    pre("read_file", { Path: join(s.repo, FILE) }), pre("write_file", { Path: join(s.repo, "notes.sh"), Content: OWNER_COMMAND }), shell(s.repo, "PreToolUse", OWNER_COMMAND.replace(" --apply", ""))];
  for (const body of harmless) assert.equal(await agy(s, "pre-tool", body), ASK, JSON.stringify(body.toolCall));
  await assert.rejects(readFile(sessionFile(s)), { code: "ENOENT" });
  // An owner action: the deny alone, for both shell shapes, with and without a readable pilot.
  const owner = [shell(s.repo, "PreToolUse", OWNER_COMMAND), pre("manage_task", { Action: "send_input", Input: OWNER_COMMAND + "\n" })];
  for (const body of owner) {
    for (const pilot of [s.path, join(s.sandbox, "missing.json")]) assert.equal(await agy(s, "pre-tool", body, { pilot }), DENY, JSON.stringify(body.toolCall));
  }
  assert.equal(await agy(s, "pre-tool", harmless[0], { pilot: join(s.sandbox, "missing.json") }), ASK);
  assert.equal((await jsonLines(hookLogPath(s.stateRoot))).filter((e) => e.code === "owner-block" && e.agent === "antigravity").length, 2);
  // A payload for another event is not a pre-tool call: no deny, and the reply for the installed event.
  assert.equal(await agy(s, "pre-tool", { ...owner[0], hookEventName: "PostToolUse" }), ASK);
  // The real binary.
  assert.deepEqual(bin(s, "antigravity", "pre-tool", harmless[0]), { code: 0, out: ASK, err: "" });
  assert.deepEqual(bin(s, "antigravity", "pre-tool", owner[0]), { code: 0, out: DENY, err: "" });
  assert.deepEqual(bin(s, "antigravity", "pre-tool", owner[1], { pilot: join(s.sandbox, "missing.json") }), { code: 0, out: DENY, err: "" });
});

test("antigravity session start and prompt lessons arrive as injectSteps, and a repeated PreInvocation prints an empty object", async (t) => {
  const s = await store(t), [id] = s.ids, block = HEAD + "\n" + s.line(id);
  // SessionStart fires with the first prompt and prints the live line only.
  assert.equal(await agy(s, "session-start", base(s.repo, "SessionStart", { lastUserInput: "fix the migrations" })), inject(liveLine("antigravity", SESSION)));
  assert.equal(await agy(s, "user-prompt", invocation(s.repo, "fix the migrations")), inject(block));
  assert.deepEqual(await state(s), fresh({ delivered: [id], lines: 1 }));
  // PreInvocation fires again before each later model call, with the same prompt.
  for (const invocationNum of [1, 2]) assert.equal(await agy(s, "user-prompt", invocation(s.repo, "fix the migrations", { invocationNum })), EMPTY);
  assert.equal(await agy(s, "user-prompt", invocation(s.repo, "Rename the button component.")), EMPTY);
  assert.deepEqual(await state(s), fresh({ delivered: [id], lines: 1 }));
  const rows = await jsonLines(budgetLogPath(s.stateRoot));
  assert.deepEqual(rows.map((r) => [r.agent, r.event, r.lines, r.overflow, r.lessons ?? null]), [["antigravity", "SessionStart", 0, 0, null], ["antigravity", "UserPromptSubmit", 1, 0, [id]]]);
  assert.equal(rows[1].bytes, Buffer.byteLength(block));
});

test("antigravity holds file and command lessons on PostToolUse and delivers them once on the next PreInvocation", async (t) => {
  const s = await store(t, { lessons: [["Migrations before seeds", { paths: ["db/migrations/**"] }], ["Seed with care", { commands: ["npm run seed"] }], ["Billing totals", { topics: ["billing"] }]] });
  const [file, command, topic] = s.ids, held = (id) => ({ id, scope: SCOPE, root: s.repo });
  // A hold prints the neutral object, writes the session file and logs no budget row.
  assert.equal(await agy(s, "post-tool", edited(s.repo, FILE)), EMPTY);
  assert.deepEqual(await state(s), fresh({ pending: [held(file)] }));
  assert.equal(await agy(s, "post-tool", ran(s.repo, "npm run seed")), EMPTY);
  assert.deepEqual(await state(s), fresh({ pending: [held(file), held(command)] }));
  // The same calls again hold nothing more, and a call before the tool holds nothing.
  assert.equal(await agy(s, "post-tool", edited(s.repo, FILE)), EMPTY);
  assert.equal(await agy(s, "post-tool", call(s.repo, "PostToolUse", "write_file", { Path: "db/migrations/003_orders.sql", Content: "x" }, { error: "" })), EMPTY);
  assert.equal(await agy(s, "post-tool", ran(s.repo, "cd app && npm run seed")), EMPTY);
  assert.equal(await agy(s, "pre-tool", shell(s.repo, "PreToolUse", "npm run seed")), ASK);
  assert.deepEqual(await state(s), fresh({ pending: [held(file), held(command)] }));
  assert.deepEqual(await jsonLines(budgetLogPath(s.stateRoot)), []);
  // The next PreInvocation prints the held lessons and the prompt's own match in one block, held lessons first.
  const block = [HEAD, s.line(file), s.line(command), s.line(topic)].join("\n");
  assert.equal(await agy(s, "user-prompt", invocation(s.repo, "update the billing page", { invocationNum: 1 })), inject(block));
  assert.deepEqual(await state(s), fresh({ delivered: [file, command, topic], lines: 3 }));
  const rows = await jsonLines(budgetLogPath(s.stateRoot));
  assert.deepEqual(rows.map((r) => [r.agent, r.session, r.event, r.bytes, r.lines, r.overflow, r.lessons]), [["antigravity", sessionKey("antigravity", SESSION), "UserPromptSubmit", Buffer.byteLength(block), 3, 0, [file, command, topic]]]);
  // Once: the next PreInvocation is empty, and a delivered lesson is not held again.
  assert.equal(await agy(s, "user-prompt", invocation(s.repo, "update the billing page", { invocationNum: 2 })), EMPTY);
  assert.equal(await agy(s, "post-tool", edited(s.repo, FILE)), EMPTY);
  assert.equal(await agy(s, "post-tool", ran(s.repo, "npm run seed")), EMPTY);
  assert.equal(await agy(s, "user-prompt", invocation(s.repo, "update the billing page", { invocationNum: 3 })), EMPTY);
  assert.deepEqual(await state(s), fresh({ delivered: [file, command, topic], lines: 3 }));
  assert.equal((await jsonLines(budgetLogPath(s.stateRoot))).length, 1);
});

test("antigravity flushes held lessons on a PreInvocation with an empty prompt and never passes four lines across holds and flushes", async (t) => {
  const s = await store(t, { lessons: [["Migrations before seeds", { paths: ["db/migrations/**"] }], ...[1, 2, 3, 4, 5, 6].map((n) => ["Feature lesson " + n, { paths: ["src/feature/**"] }])] });
  const [file, ...features] = s.ids, held = (id) => ({ id, scope: SCOPE, root: s.repo }), sorted = [...features].sort();
  const outputs = [];
  const step = async (event, body) => { const out = await agy(s, event, body); outputs.push(out); return out; };
  // Nothing held: an empty prompt and a missing prompt print the neutral object and write no file.
  assert.equal(await step("user-prompt", invocation(s.repo, "")), EMPTY);
  assert.equal(await step("user-prompt", invocation(s.repo)), EMPTY);
  await assert.rejects(readFile(sessionFile(s)), { code: "ENOENT" });
  assert.equal(await step("post-tool", edited(s.repo, FILE)), EMPTY);
  assert.equal(await step("user-prompt", invocation(s.repo, "")), inject(HEAD + "\n" + s.line(file)));
  assert.deepEqual(await state(s), fresh({ delivered: [file], lines: 1 }));
  // Six lessons match the next file. One line is used, so three are held and three are counted for the overflow line.
  assert.equal(await step("post-tool", edited(s.repo, "src/feature/a.mjs")), EMPTY);
  const waiting = fresh({ delivered: [file], lines: 1, pending: sorted.slice(0, 3).map(held), pendingMore: [{ scope: SCOPE, root: s.repo, count: 3 }] });
  assert.deepEqual(await state(s), waiting);
  // Every slot is reserved: a second hold keeps nothing more.
  assert.equal(await step("post-tool", edited(s.repo, "src/feature/b.mjs")), EMPTY);
  assert.deepEqual(await state(s), waiting);
  // A PreInvocation with no lastUserInput flushes the three lines and the overflow line.
  assert.equal(await step("user-prompt", invocation(s.repo)), inject([HEAD, ...sorted.slice(0, 3).map(s.line), more(3)].join("\n")));
  const full = fresh({ delivered: [file, ...sorted.slice(0, 3)], lines: 4, overflowed: true });
  assert.deepEqual(await state(s), full);
  // At the cap nothing is held and nothing is printed.
  assert.equal(await step("post-tool", edited(s.repo, "src/feature/c.mjs")), EMPTY);
  assert.equal(await step("user-prompt", invocation(s.repo, "")), EMPTY);
  assert.deepEqual(await state(s), full);
  assert.equal(outputs.flatMap(indexLines).length, 4);
  const rows = await jsonLines(budgetLogPath(s.stateRoot));
  assert.deepEqual(rows.map((r) => [r.event, r.lines, r.overflow]), [["UserPromptSubmit", 1, 0], ["UserPromptSubmit", 3, 1]]);
});

test("antigravity drops a held lesson that left the index and does not print a lesson held for another worktree root", async (t) => {
  const s = await store(t, { lessons: [["Migrations before seeds", { paths: ["db/migrations/**"] }], ...[1, 2, 3, 4, 5].map((n) => ["Billing lesson " + n, { topics: ["billing"] }])] });
  const [file, ...topics] = s.ids, sorted = [...topics].sort();
  await fixtureGit(s.repo, ["worktree", "add", "-q", "-b", "child", join(s.reposDir, "atlas-linked")]);
  const linked = await realpath(join(s.reposDir, "atlas-linked")), held = { id: file, scope: SCOPE, root: s.repo };
  // Held in the first worktree. A PreInvocation from the linked worktree of the same project does not print it.
  assert.equal(await agy(s, "post-tool", edited(s.repo, FILE)), EMPTY);
  assert.equal(await agy(s, "user-prompt", invocation(linked, "")), EMPTY);
  assert.deepEqual(await state(s), fresh({ pending: [held] }));
  // The held lesson keeps its slot: five prompt matches in the other worktree get three lines and the overflow line.
  const other = await agy(s, "user-prompt", invocation(linked, "update the billing page"));
  assert.equal(other, inject([HEAD, ...sorted.slice(0, 3).map(s.line), more(2)].join("\n")));
  assert.deepEqual(await state(s), fresh({ delivered: sorted.slice(0, 3), lines: 3, overflowed: true, pending: [held] }));
  // Back in the first worktree it prints, as the fourth and last line.
  const back = await agy(s, "user-prompt", invocation(s.repo, ""));
  assert.equal(back, inject(HEAD + "\n" + s.line(file)));
  assert.deepEqual(await state(s), fresh({ delivered: [...sorted.slice(0, 3), file], lines: 4, overflowed: true }));
  assert.equal([other, back].flatMap(indexLines).length, 4);
  // A held lesson that left the index is dropped, not printed, and frees its slot.
  const gone = { conversationId: "agy-conversation-0002" }, without = { ...s.index, entries: s.index.entries.filter((e) => e.id !== file) };
  assert.equal(await agy(s, "post-tool", edited(s.repo, FILE, gone)), EMPTY);
  assert.deepEqual(await state(s, gone.conversationId), fresh({ pending: [held] }));
  await writeIndex(s, without);
  assert.equal(await agy(s, "user-prompt", invocation(s.repo, "", gone)), EMPTY);
  assert.deepEqual(await state(s, gone.conversationId), fresh());
  // Back in the index, it is not printed until a tool call matches it again.
  await writeIndex(s, s.index);
  assert.equal(await agy(s, "user-prompt", invocation(s.repo, "", gone)), EMPTY);
  assert.equal(await agy(s, "post-tool", edited(s.repo, FILE, gone)), EMPTY);
  assert.equal(await agy(s, "user-prompt", invocation(s.repo, "", gone)), inject(HEAD + "\n" + s.line(file)));
  // A held lesson that now belongs to another project is dropped by the project filter.
  const moved = { conversationId: "agy-conversation-0003" };
  assert.equal(await agy(s, "post-tool", edited(s.repo, FILE, moved)), EMPTY);
  await writeIndex(s, { ...s.index, entries: s.index.entries.map((e) => e.id === file ? { ...e, project: "example.beacon" } : e) });
  assert.equal(await agy(s, "user-prompt", invocation(s.repo, "", moved)), EMPTY);
  assert.deepEqual(await state(s, moved.conversationId), fresh());
});

test("antigravity does not print a held lesson again after a prompt in another worktree delivered it", async (t) => {
  // One lesson that a file matches and a prompt matches.
  const s = await store(t, { lessons: [["Migrations before seeds", { paths: ["db/migrations/**"], topics: ["migrations"] }]] });
  const [id] = s.ids, block = inject(HEAD + "\n" + s.line(id)), held = { id, scope: SCOPE, root: s.repo };
  await fixtureGit(s.repo, ["worktree", "add", "-q", "-b", "child", join(s.reposDir, "atlas-linked")]);
  const linked = await realpath(join(s.reposDir, "atlas-linked"));
  // Held for the first worktree by its file match.
  assert.equal(await agy(s, "post-tool", edited(s.repo, FILE)), EMPTY);
  assert.deepEqual(await state(s), fresh({ pending: [held] }));
  // A prompt in the linked worktree matches its topic and delivers it. The entry for the first worktree stays held.
  assert.equal(await agy(s, "user-prompt", invocation(linked, "fix the migrations")), block);
  assert.deepEqual(await state(s), fresh({ delivered: [id], lines: 1, pending: [held] }));
  // The flush in the first worktree drops the held entry and prints nothing: the lesson was delivered once.
  assert.equal(await agy(s, "user-prompt", invocation(s.repo, "", { invocationNum: 1 })), EMPTY);
  assert.deepEqual(await state(s), fresh({ delivered: [id], lines: 1 }));
  assert.equal(await agy(s, "user-prompt", invocation(s.repo, "fix the migrations", { invocationNum: 2 })), EMPTY);
  assert.deepEqual(await state(s), fresh({ delivered: [id], lines: 1 }));
  assert.deepEqual((await jsonLines(budgetLogPath(s.stateRoot))).map((r) => [r.event, r.lines, r.lessons]), [["UserPromptSubmit", 1, [id]]]);
});

test("antigravity keeps one overflow count for each worktree root", async (t) => {
  const s = await store(t, { lessons: [1, 2, 3, 4, 5, 6].map((n) => ["Feature lesson " + n, { paths: ["src/feature/**"] }]) });
  const sorted = [...s.ids].sort(), kept = sorted.slice(0, 4);
  await fixtureGit(s.repo, ["worktree", "add", "-q", "-b", "child", join(s.reposDir, "atlas-linked")]);
  const linked = await realpath(join(s.reposDir, "atlas-linked")), count = (root, n) => ({ scope: SCOPE, root, count: n });
  // Six lessons match one file. The hold in the first root keeps four and counts two for the overflow line.
  assert.equal(await agy(s, "post-tool", edited(s.repo, "src/feature/a.mjs")), EMPTY);
  const waiting = fresh({ pending: kept.map((id) => ({ id, scope: SCOPE, root: s.repo })), pendingMore: [count(s.repo, 2)] });
  assert.deepEqual(await state(s), waiting);
  // The same call from the linked root finds the other two, keeps none (no slot is free) and counts them for its own
  // root. The count of the first root stays.
  assert.equal(await agy(s, "post-tool", edited(linked, "src/feature/a.mjs")), EMPTY);
  assert.deepEqual(await state(s), { ...waiting, pendingMore: [count(s.repo, 2), count(linked, 2)] });
  // The same two holds again change nothing.
  assert.equal(await agy(s, "post-tool", edited(s.repo, "src/feature/a.mjs")), EMPTY);
  assert.equal(await agy(s, "post-tool", edited(linked, "src/feature/a.mjs")), EMPTY);
  assert.deepEqual(await state(s), { ...waiting, pendingMore: [count(s.repo, 2), count(linked, 2)] });
  // The flush in the first root prints its four lines and its overflow line, and leaves the count of the linked root.
  const first = await agy(s, "user-prompt", invocation(s.repo, ""));
  assert.equal(first, inject([HEAD, ...kept.map(s.line), more(2)].join("\n")));
  assert.equal(indexLines(first).length, 4);
  const full = fresh({ delivered: kept, lines: 4, overflowed: true });
  assert.deepEqual(await state(s), { ...full, pendingMore: [count(linked, 2)] });
  // The flush in the linked root prints nothing: the cap is full and the one overflow line was printed. Its count goes.
  assert.equal(await agy(s, "user-prompt", invocation(linked, "", { invocationNum: 1 })), EMPTY);
  assert.deepEqual(await state(s), full);
  assert.deepEqual((await jsonLines(budgetLogPath(s.stateRoot))).map((r) => [r.event, r.lines, r.overflow, r.lessons]), [["UserPromptSubmit", 4, 1, kept]]);
});

test("antigravity keeps at most four overflow counts and drops the count of the oldest place", async (t) => {
  const s = await store(t, { lessons: [["Migrations before seeds", { paths: ["db/migrations/**"] }], ...[1, 2, 3, 4, 5, 6].map((n) => ["Feature lesson " + n, { paths: ["src/feature/**"] }])] });
  const [file, ...features] = s.ids, kept = [...features].sort().slice(0, 4), held = (id) => ({ id, scope: SCOPE, root: s.repo });
  // Counts for four other places, oldest first. Their roots are folders under the sandbox that no call comes from.
  const count = (root, n) => ({ scope: SCOPE, root, count: n }), others = [1, 2, 3, 4].map((n) => count(join(s.sandbox, "other-root-" + n), n + 4));
  await mkdir(sessionsDir(s.stateRoot), { recursive: true, mode: 0o700 });
  const put = (conversationId, extra) => writeFile(sessionFile(s, conversationId), JSON.stringify({ ...fresh(extra), updatedAt: "2026-10-01T00:00:00.000Z" }) + "\n", { mode: 0o600 });
  const hold = async (conversationId, rel) => assert.equal(await agy(s, "post-tool", edited(s.repo, rel, { conversationId })), EMPTY);
  // A hold in a fifth place: its count goes last, and the first entry, the oldest, is dropped.
  await put("agy-fifth-place", { pendingMore: others });
  await hold("agy-fifth-place", "src/feature/a.mjs");
  const five = fresh({ pending: kept.map(held), pendingMore: [...others.slice(1), count(s.repo, 2)] });
  assert.deepEqual(await state(s, "agy-fifth-place"), five);
  // The same hold again drops no other entry.
  await hold("agy-fifth-place", "src/feature/a.mjs");
  assert.deepEqual(await state(s, "agy-fifth-place"), five);
  // The flush there uses and removes its own count, and the other three stay.
  assert.equal(await agy(s, "user-prompt", invocation(s.repo, "", { conversationId: "agy-fifth-place" })), inject([HEAD, ...kept.map(s.line), more(2)].join("\n")));
  assert.deepEqual(await state(s, "agy-fifth-place"), fresh({ delivered: kept, lines: 4, overflowed: true, pendingMore: others.slice(1) }));
  // A place that has one of the four entries: the hold raises its count where it is and drops nothing.
  await put("agy-own-place", { pendingMore: [count(s.repo, 1), ...others.slice(0, 3)] });
  await hold("agy-own-place", "src/feature/a.mjs");
  assert.deepEqual(await state(s, "agy-own-place"), fresh({ pending: kept.map(held), pendingMore: [count(s.repo, 2), ...others.slice(0, 3)] }));
  // A stored count that is larger stays.
  await put("agy-larger-count", { pendingMore: [...others.slice(0, 3), count(s.repo, 5)] });
  await hold("agy-larger-count", "src/feature/a.mjs");
  assert.deepEqual(await state(s, "agy-larger-count"), fresh({ pending: kept.map(held), pendingMore: [...others.slice(0, 3), count(s.repo, 5)] }));
  // A hold with no overflow adds no count, so the four entries of the other places stay.
  await put("agy-no-overflow", { pendingMore: others });
  await hold("agy-no-overflow", FILE);
  assert.deepEqual(await state(s, "agy-no-overflow"), fresh({ pending: [held(file)], pendingMore: others }));
});

test("antigravity marks a stale held lesson on the flush", async (t) => {
  const s = await store(t, { lessons: [["Migrations before seeds", { paths: ["db/migrations/**"] }], ["Migrations stay small", { paths: ["db/migrations/**"] }]] });
  const [due, later] = s.ids;
  // The index with one lesson past its revisit date and one before it. The clock of these tests is 2026-10-07.
  const dated = { ...s.index, entries: s.index.entries.map((e) => ({ ...e, revisitAfter: e.id === due ? "2026-01-01" : "2027-01-01" })) };
  await writeIndex(s, dated);
  const entry = (id) => dated.entries.find((e) => e.id === id), lineOf = (lines, id) => lines.filter((l) => l.endsWith("[" + id + "]"));
  // Gemini CLI gets the same two lessons right after the tool call, with the stale mark on the first.
  const gemini = await run(s, "gemini", "post-tool", { session_id: "gemini-stale", cwd: s.repo, hook_event_name: "AfterTool", ...SHAPES.gemini.edit(s.repo, FILE) });
  const expected = JSON.parse(gemini.out).hookSpecificOutput.additionalContext.split("\n").filter((l) => l.startsWith("- "));
  assert.deepEqual(lineOf(expected, due), ["- " + indexLine(entry(due), { stale: true })]);
  // Antigravity holds them, and the flush renders each held lesson with the same mark.
  assert.equal(await agy(s, "post-tool", edited(s.repo, FILE)), EMPTY);
  const lines = indexLines(await agy(s, "user-prompt", invocation(s.repo, "")));
  assert.equal(lines.length, 2);
  assert.ok(lineOf(lines, due)[0].startsWith("- stale, revisit: Migrations before seeds"), lines.join("\n"));
  assert.deepEqual(lineOf(lines, later), ["- " + indexLine(entry(later))]);
  assert.ok(lineOf(lines, later)[0].startsWith("- Migrations stay small"), lines.join("\n"));
  assert.deepEqual(lines, expected);
});

test("an older session file still loads, and out-of-bounds pending fields make the session file corrupt", async (t) => {
  const s = await store(t), [id] = s.ids, dir = sessionsDir(s.stateRoot);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const put = async (agent, session, value) => { const key = sessionKey(agent, session); await writeFile(join(dir, key + ".json"), JSON.stringify(value) + "\n", { mode: 0o600 }); return key; };
  // A file as a kit before deferred lessons wrote it: no pending and no pendingMore.
  const older = (agent) => ({ schemaVersion: 1, agent, delivered: ["rec_" + "0".repeat(24)], lines: 1, overflowed: false, updatedAt: "2026-10-01T00:00:00.000Z" });
  for (const agent of ["antigravity", "claude"]) assert.deepEqual(await readSession(s.stateRoot, agent, await put(agent, "older-session", older(agent))), older(agent));
  // The hook builds on it: Antigravity holds a lesson next to the delivered one, and Claude Code adds no new field.
  assert.equal(await agy(s, "post-tool", edited(s.repo, FILE, { conversationId: "older-session" })), EMPTY);
  assert.deepEqual(await state(s, "older-session"), fresh({ delivered: ["rec_" + "0".repeat(24)], lines: 1, pending: [{ id, scope: SCOPE, root: s.repo }] }));
  const claude = await run(s, "claude", "pre-tool", { session_id: "older-session", cwd: s.repo, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(s.repo, FILE), old_string: "a", new_string: "b" } });
  assert.equal(claude.out, contextOut("claude", "pre-tool", HEAD + "\n" + s.line(id)));
  assert.deepEqual(JSON.parse(await readFile(join(dir, sessionKey("claude", "older-session") + ".json"), "utf8")), { ...older("claude"), delivered: ["rec_" + "0".repeat(24), id], lines: 2, updatedAt: now().toISOString() });
  // Within bounds: up to four held entries, and up to four overflow counts with one for each place (a scope and a
  // root). The same root in two scopes is two places.
  const entry = { id: "rec_" + "a".repeat(24), scope: SCOPE, root: "/w/example" }, count = { scope: SCOPE, root: "/w/example", count: 2 };
  const places = [1, 2, 3, 4, 5].map((n) => withField(count, "root", "/w/example-" + n));
  for (const extra of [{ pending: [] }, { pending: [entry] }, { pending: [entry, entry, entry, entry], pendingMore: [count] }, { pendingMore: [count] }, { pendingMore: [] }, { pendingMore: places.slice(0, 4) },
    { pendingMore: [count, withField(count, "scope", "sample")] }, { pendingMore: [withField(count, "count", 1)] }, { pendingMore: [withField(count, "count", Number.MAX_SAFE_INTEGER)] }]) {
    const value = { ...fresh(extra), updatedAt: "2026-10-01T00:00:00.000Z" };
    assert.deepEqual(await readSession(s.stateRoot, "antigravity", await put("antigravity", "in-bounds", value)), value, JSON.stringify(extra));
  }
  // Out of bounds: the whole file is corrupt, as a file cut short is.
  const bad = [{ pending: null }, { pending: {} }, { pending: "rec" }, { pending: [entry, entry, entry, entry, entry] }, { pending: [null] }, { pending: [[]] }, { pending: [withField(entry, "id", 7)] }, { pending: [withField(entry, "id", "")] },
    { pending: [withField(entry, "id", "r".repeat(129))] }, { pending: [{ scope: SCOPE, root: "/w/example" }] }, { pending: [withField(entry, "scope", "Not A Scope")] }, { pending: [withField(entry, "scope", 7)] }, { pending: [withField(entry, "root", "relative/root")] },
    { pending: [withField(entry, "root", "/" + "r".repeat(4096))] }, { pending: [withField(entry, "root", null)] }, { pendingMore: null }, { pendingMore: "3" }, { pendingMore: {} },
    // The single-object form of pendingMore, which no released kit wrote, is not a list.
    { pendingMore: count }, { pendingMore: { 0: count, length: 1 } },
    // More than four entries, and two entries for one place (with the same count or another one).
    { pendingMore: places }, { pendingMore: [count, count] }, { pendingMore: [count, withField(count, "count", 3)] }, { pendingMore: [places[0], count, places[1], count] },
    { pendingMore: [null] }, { pendingMore: [[]] }, { pendingMore: [count, "3"] }, { pendingMore: [withField(count, "count", 0)] }, { pendingMore: [places[0], withField(count, "count", 0)] }, { pendingMore: [withField(count, "count", -1)] },
    { pendingMore: [withField(count, "count", 1.5)] }, { pendingMore: [withField(count, "count", "2")] }, { pendingMore: [withField(count, "count", Number.MAX_SAFE_INTEGER + 1)] }, { pendingMore: [{ scope: SCOPE, root: "/w/example" }] },
    { pendingMore: [withField(count, "root", "relative")] }, { pendingMore: [withField(count, "root", "/" + "r".repeat(4096))] }, { pendingMore: [withField(count, "scope", "")] }, { pendingMore: [withField(count, "scope", "Not A Scope")] }, { pendingMore: [{ root: "/w/example", count: 1 }] }];
  for (const extra of bad) assert.deepEqual(await readSession(s.stateRoot, "antigravity", await put("antigravity", "out-of-bounds", fresh(extra))), { corrupt: true }, JSON.stringify(extra));
  // Through the hook: the corrupt file is removed, the call prints the neutral object, and the next call starts fresh.
  await put("antigravity", "out-of-bounds", fresh({ pending: [entry, entry, entry, entry, entry] }));
  assert.equal(await agy(s, "user-prompt", invocation(s.repo, "fix the migrations", { conversationId: "out-of-bounds" })), EMPTY);
  await assert.rejects(readFile(sessionFile(s, "out-of-bounds")), { code: "ENOENT" });
  assert.ok((await jsonLines(hookLogPath(s.stateRoot))).some((e) => e.agent === "antigravity" && e.event === "UserPromptSubmit" && e.code === "session-corrupt"));
  assert.equal(await agy(s, "user-prompt", invocation(s.repo, "fix the migrations", { conversationId: "out-of-bounds" })), inject(HEAD + "\n" + s.line(id)));
});
// One field of a held entry replaced.
function withField(entry, key, value) { return { ...entry, [key]: value }; }

test("a failed hold write delays an Antigravity lesson and a failed flush write repeats it once", async (t) => {
  const s = await store(t), [id] = s.ids, dir = sessionsDir(s.stateRoot), block = inject(HEAD + "\n" + s.line(id));
  // The fault: a sessions folder that cannot take a new file, so the atomic write of the session file fails.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // failing restores the mode itself, so the sandbox can be removed whatever a call does.
  const failing = async (fn) => { await chmod(dir, 0o500); try { return await fn(); } finally { await chmod(dir, 0o700); } };
  const failures = async () => (await jsonLines(hookLogPath(s.stateRoot))).filter((e) => e.agent === "antigravity" && e.code === "EACCES").map((e) => e.event);
  // A failed hold write: the call still prints one object, nothing is held, and the next PreInvocation has nothing.
  assert.equal(await failing(() => agy(s, "post-tool", edited(s.repo, FILE))), EMPTY);
  await assert.rejects(readFile(sessionFile(s)), { code: "ENOENT" });
  assert.deepEqual(await failures(), ["PostToolUse"]);
  assert.equal(await agy(s, "user-prompt", invocation(s.repo, "")), EMPTY);
  // The next matching tool call holds it, and the lesson arrives one call late.
  assert.equal(await agy(s, "post-tool", edited(s.repo, FILE)), EMPTY);
  assert.deepEqual(await state(s), fresh({ pending: [{ id, scope: SCOPE, root: s.repo }] }));
  // A failed flush write: the block is printed, alone, and the lesson stays held.
  assert.equal(await failing(() => agy(s, "user-prompt", invocation(s.repo, "", { invocationNum: 1 }))), block);
  assert.deepEqual(await failures(), ["PostToolUse", "UserPromptSubmit"]);
  assert.deepEqual(await state(s), fresh({ pending: [{ id, scope: SCOPE, root: s.repo }] }));
  assert.deepEqual(await jsonLines(budgetLogPath(s.stateRoot)), []);
  // So the block repeats once, and then never again.
  assert.equal(await agy(s, "user-prompt", invocation(s.repo, "", { invocationNum: 2 })), block);
  assert.deepEqual(await state(s), fresh({ delivered: [id], lines: 1 }));
  assert.equal(await agy(s, "user-prompt", invocation(s.repo, "", { invocationNum: 3 })), EMPTY);
  assert.equal(await agy(s, "post-tool", edited(s.repo, FILE)), EMPTY);
  assert.equal(await agy(s, "user-prompt", invocation(s.repo, "", { invocationNum: 4 })), EMPTY);
  assert.deepEqual((await jsonLines(budgetLogPath(s.stateRoot))).map((r) => [r.event, r.lines, r.lessons]), [["UserPromptSubmit", 1, [id]]]);
});

test("overlapping Antigravity holds in one conversation keep every held lesson", async (t) => {
  const s = await store(t, { lessons: [1, 2, 3].map((n) => ["Area lesson " + n, { paths: ["src/area" + n + "/**"] }]) });
  const held = (id) => ({ id, scope: SCOPE, root: s.repo }), byId = (a, b) => a.id < b.id ? -1 : 1;
  // Hook calls of one conversation that start together all read the session file before any of them writes it, so
  // each write replaces the one before it. Every call then reads the file again and holds its lesson once more: one
  // more write is enough for two calls, and three calls need the second one.
  for (const [conversationId, count] of [["agy-overlap-two", 2], ["agy-overlap-three", 3]]) {
    const ids = s.ids.slice(0, count);
    const outs = await Promise.all(ids.map((_, i) => agy(s, "post-tool", edited(s.repo, "src/area" + (i + 1) + "/a.mjs", { conversationId }))));
    assert.deepEqual(outs, ids.map(() => EMPTY));
    const after = await state(s, conversationId);
    assert.deepEqual({ ...after, pending: [...after.pending].sort(byId) }, fresh({ pending: ids.map(held).sort(byId) }), conversationId);
  }
  assert.deepEqual(await jsonLines(budgetLogPath(s.stateRoot)), []);
  // The next PreInvocation prints each held lesson once.
  const out = await agy(s, "user-prompt", invocation(s.repo, "", { conversationId: "agy-overlap-three" }));
  assert.deepEqual(indexLines(out).sort(), s.ids.map(s.line).sort());
  const flushed = await state(s, "agy-overlap-three");
  assert.deepEqual({ ...flushed, delivered: [...flushed.delivered].sort() }, fresh({ delivered: [...s.ids].sort(), lines: 3 }));
  assert.equal(await agy(s, "user-prompt", invocation(s.repo, "", { conversationId: "agy-overlap-three", invocationNum: 1 })), EMPTY);
});

test("overlapping Antigravity holds from two worktree roots keep the overflow count of each root", async (t) => {
  const s = await store(t, { lessons: [1, 2, 3, 4, 5, 6].map((n) => ["Feature lesson " + n, { paths: ["src/feature/**"] }]) });
  const kept = [...s.ids].sort().slice(0, 4), byRoot = (a, b) => a.root < b.root ? -1 : 1;
  await fixtureGit(s.repo, ["worktree", "add", "-q", "-b", "child", join(s.reposDir, "atlas-linked")]);
  const linked = await realpath(join(s.reposDir, "atlas-linked")), roots = [s.repo, linked];
  // Both calls read the session file before either writes it, and each one writes four held lessons and the count of
  // its own root. The later write replaces the earlier one. The call that lost reads the file again and adds its count
  // next to the other root's count. Whichever write is the last one, the four lessons are held for one root.
  assert.deepEqual(await Promise.all(roots.map((root) => agy(s, "post-tool", edited(root, "src/feature/a.mjs")))), [EMPTY, EMPTY]);
  const after = await state(s);
  assert.deepEqual([...after.pendingMore].sort(byRoot), roots.map((root) => ({ scope: SCOPE, root, count: 2 })).sort(byRoot));
  assert.deepEqual(after.pending.map((e) => e.id), kept);
  assert.equal(new Set(after.pending.map((e) => e.root)).size, 1);
  // The root that holds the lessons prints them with its overflow line. The other root then has nothing to print.
  const [holder] = roots.filter((root) => root === after.pending[0].root), [other] = roots.filter((root) => root !== holder);
  assert.equal(await agy(s, "user-prompt", invocation(holder, "")), inject([HEAD, ...kept.map(s.line), more(2)].join("\n")));
  assert.equal(await agy(s, "user-prompt", invocation(other, "", { invocationNum: 1 })), EMPTY);
  assert.deepEqual(await state(s), fresh({ delivered: kept, lines: 4, overflowed: true }));
});
