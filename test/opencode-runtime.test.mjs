import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile, readdir, mkdir, symlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { onboardFixture, draftFor, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { applyOnboard } from "../src/onboarding/onboard.mjs";
import { addRecord } from "../src/records/store.mjs";
import { rebuildIndex, readIndex } from "../src/lessons/index.mjs";
import { indexLine } from "../src/lessons/match.mjs";
import { writeKitReceipt } from "../src/hooks/receipt.mjs";
import { sessionKey, sessionsDir, hookLogPath, budgetLogPath } from "../src/hooks/session.mjs";
import { stubPath } from "../src/hooks/stub.mjs";
import { DENY_REASON, ownerAction, denyOutput } from "../src/hooks/owner-block.mjs";
import { NOTICE, sessionTag } from "../src/hooks/commands.mjs";
import { adapter } from "../src/agents/adapters/index.mjs";

// The hook command for OpenCode, with the payloads the generated plugin sends (src/agents/adapters/opencode.mjs):
// devtwin's own shape, with the event under devtwin's internal name. The adapter has no neutral reply, so every quiet
// path prints nothing. The last test runs the generated plugin against the real hook command.
const SCOPE = "example", PROJECT = "example.atlas";
const KIT = realpathSync(join(import.meta.dirname, "..")), BIN = join(KIT, "bin/devtwin.mjs");
const OWNER_COMMAND = 'node "/opt/example-kit/bin/devtwin.mjs" live set-kit --pilot /x/live.json --kit /x/kit --apply --plan-fingerprint sha256:00';
const FILE = "db/migrations/002_users.sql", OTHER = "src/ui/button.tsx";
const ALL = { paths: ["db/migrations/**"], commands: ["npm run seed"], topics: ["migrations"] };
const HEAD = NOTICE + " Load one with `devtwin lesson show --scope " + SCOPE + " --id <id>`.";
// The first line of the text part that the plugin appends to a tool result, written out here and not read from the adapter.
const MARK = "[devtwin hook note: the text below was added after the tool output and is not part of it]";
const EVENTS = { "session-start": "SessionStart", "user-prompt": "UserPromptSubmit", "pre-tool": "PreToolUse", "post-tool": "PostToolUse", "pre-compact": "PreCompact", stop: "Stop" };
const SESSION = "ses_example0001";
// The payload as the plugin builds it: the three base fields, then the tool or the prompt.
const base = (cwd, event, extra = {}) => ({ hook_event_name: event, session_id: SESSION, cwd, ...extra });
const call = (cwd, event, name, input, extra = {}) => base(cwd, event, { tool_name: name, tool_input: input, ...extra });
// The two replies the plugin reads, written out here and not built by the adapter.
const context = (text) => '{"context":' + JSON.stringify(text) + "}\n";
const DENY = '{"decision":"deny","reason":' + JSON.stringify(DENY_REASON) + "}\n";
// A bound project with one lesson per [title, match] pair, as test/antigravity-hook-runtime.test.mjs builds it.
async function store(t, { receipt = true, lessons = [["Migrations before seeds", ALL]] } = {}) {
  const s = await onboardFixture(t, { scope: SCOPE, project: PROJECT });
  await applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now });
  const ids = [];
  for (const [i, [title, match]] of lessons.entries()) {
    const input = draftFor(SCOPE, PROJECT, { requestId: "req_ocrunt" + String(i).padStart(2, "0"), kind: "lesson", body: "Do run migrations before seeding the test database.\n" });
    input.draft = { ...input.draft, title, class: "lesson", reach: "project", match };
    ids.push((await addRecord(s.roots, input, { now })).recordId);
  }
  await rebuildIndex(s.roots, SCOPE);
  if (receipt) await writeKitReceipt(s.roots, { pilotPath: s.path, now: now() });
  const index = await readIndex(s.roots, SCOPE);
  return { ...s, ids, index, line: (id) => "- " + indexLine(index.entries.find((e) => e.id === id)) };
}
// One in-process hook call through the CLI entry point. The output is the exact stdout text.
async function run(s, event, body, { pilot = s.path, stdin } = {}) {
  const chunks = [];
  const code = await main(["hook", "--event", event, "--agent", "opencode", "--pilot", pilot], { stdout: { write: (v) => { chunks.push(v); return true; } }, stdin: stdin ?? (typeof body === "string" ? body : JSON.stringify(body)), now });
  return { code, out: chunks.join("") };
}
// The same call through the real binary, at the real time.
function bin(s, event, body, { pilot = s.path } = {}) {
  const r = spawnSync(process.execPath, [BIN, "hook", "--event", event, "--agent", "opencode", "--pilot", pilot], { input: typeof body === "string" ? body : JSON.stringify(body), env: { PATH: process.env.PATH, HOME: s.fakeHome }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
// The stdout of one in-process call, which always exits 0.
async function oc(s, event, body, options) {
  const r = await run(s, event, body, options);
  assert.equal(r.code, 0, event);
  return r.out;
}
const jsonLines = async (path) => { try { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch (error) { if (error.code === "ENOENT") return []; throw error; } };
const notVerified = (s, problem) => "devtwin hook: kit not verified (" + problem + "); run `node '" + KIT + "/bin/devtwin.mjs' hook verify --pilot '" + realpathSync(s.path) + "'`. Lessons are off. Kit: `" + KIT + "`.";
const liveLine = (session, count = 1) => "devtwin hook live: " + count + " lesson" + (count === 1 ? "" : "s") + " for " + PROJECT + ". Index lines arrive when work matches. Kit: `" + KIT + "`. Session ID for lesson propose: " + sessionTag(sessionKey("opencode", session)) + ".";
const sessionFile = (s, id = SESSION) => join(sessionsDir(s.stateRoot), sessionKey("opencode", id) + ".json");
const state = async (s, id) => { const { updatedAt, ...rest } = JSON.parse(await readFile(sessionFile(s, id), "utf8")); return rest; };

test("opencode hook: session start and prompt lessons print the context reply, and a repeated prompt prints nothing", async (t) => {
  const s = await store(t), block = HEAD + "\n" + s.line(s.ids[0]);
  // The adapter prints context as { context } and has no neutral reply.
  assert.deepEqual([adapter("opencode").hooks.neutral, adapter("opencode").hooks.deferToolContext, adapter("opencode").hooks.lessonEvent], [undefined, undefined, "PostToolUse"]);
  // Session start: the live line, in the context reply.
  assert.equal(await oc(s, "session-start", base(s.repo, "SessionStart")), context(liveLine(SESSION)));
  // A prompt that matches a lesson gets its index line once.
  const prompt = base(s.repo, "UserPromptSubmit", { prompt: "fix the migrations" });
  assert.equal(await oc(s, "user-prompt", prompt), context(block));
  assert.equal(await oc(s, "user-prompt", prompt), "", "the same prompt again");
  assert.deepEqual(await state(s), { schemaVersion: 1, agent: "opencode", delivered: [s.ids[0]], lines: 1, overflowed: false });
  // A prompt with no match, an empty prompt and no prompt print nothing.
  for (const extra of [{ prompt: "Rename the button component." }, { prompt: "" }, {}, { prompt: 7 }]) assert.equal(await oc(s, "user-prompt", base(s.repo, "UserPromptSubmit", { session_id: "ses_quiet0001", ...extra })), "", JSON.stringify(extra));
  // Stop writes the stop stub and prints nothing, as for the other agents. So does a compaction, which also removes
  // the session file: the prompt lesson arrives again after it.
  const stub = stubPath(s.stateRoot, SCOPE, PROJECT, s.repo);
  assert.equal(existsSync(stub), false);
  assert.equal(await oc(s, "stop", base(s.repo, "Stop")), "");
  assert.deepEqual([JSON.parse(await readFile(stub, "utf8")).session, existsSync(sessionFile(s))], [sessionKey("opencode", SESSION), true]);
  assert.equal(await oc(s, "pre-compact", base(s.repo, "PreCompact")), "");
  assert.equal(existsSync(sessionFile(s)), false, "the compaction removed the session file");
  assert.equal(await oc(s, "user-prompt", prompt), context(block), "the prompt after compaction");
  // OpenCode has no event after a compaction; the route still prints nothing.
  assert.equal(await oc(s, "post-compact", base(s.repo, "PostCompact")), "");
  // The budget log names the agent, the events and the delivered lesson IDs, never the text.
  const rows = (await jsonLines(budgetLogPath(s.stateRoot))).filter((e) => e.agent === "opencode" && e.event !== "compact");
  assert.deepEqual(rows.map((e) => [e.event, e.lines, e.lessons ?? null]), [["SessionStart", 0, null], ["UserPromptSubmit", 1, [s.ids[0]]], ["UserPromptSubmit", 1, [s.ids[0]]]]);
  // The real binary, at the real time: the same reply.
  await writeKitReceipt(s.roots, { pilotPath: s.path, now: new Date() });
  assert.deepEqual(bin(s, "user-prompt", { ...prompt, session_id: "ses_binary0001" }), { code: 0, out: context(block), err: "" });
  assert.deepEqual(bin(s, "user-prompt", { ...prompt, session_id: "ses_binary0001" }), { code: 0, out: "", err: "" });
});

test("opencode pre-tool denies an owner-only shell command and prints nothing for any other call", async (t) => {
  const s = await store(t), bare = await store(t, { receipt: false });
  assert.equal(JSON.stringify(denyOutput("opencode")) + "\n", DENY);
  // The shell tool is "shell" on OpenCode 2.x and "bash" on 1.x: the command is read from both.
  for (const name of ["shell", "bash"]) {
    const payload = call(s.repo, "PreToolUse", name, { command: OWNER_COMMAND });
    assert.equal(ownerAction("opencode", payload), "live set-kit --apply", name);
    assert.deepEqual(await run(s, "pre-tool", payload), { code: 0, out: DENY }, name);
    assert.deepEqual(bin(s, "pre-tool", payload), { code: 0, out: DENY, err: "" }, name + ", binary");
    // The deny needs no receipt and no readable pilot.
    assert.deepEqual(await run(bare, "pre-tool", call(bare.repo, "PreToolUse", name, { command: OWNER_COMMAND })), { code: 0, out: DENY }, name + ", no receipt");
    assert.deepEqual(bin(bare, "pre-tool", call(bare.repo, "PreToolUse", name, { command: OWNER_COMMAND })), { code: 0, out: DENY, err: "" }, name + ", no receipt, binary");
    assert.deepEqual(await run(s, "pre-tool", payload, { pilot: join(s.sandbox, "missing.json") }), { code: 0, out: DENY }, name + ", missing pilot");
    // A payload with no event name, no session and no folder is still denied: the block reads only the command.
    assert.deepEqual(await run(s, "pre-tool", { tool_name: name, tool_input: { command: OWNER_COMMAND } }), { code: 0, out: DENY }, name + ", a bare payload");
  }
  assert.equal((await jsonLines(hookLogPath(s.stateRoot))).filter((e) => e.agent === "opencode" && e.code === "owner-block" && e.event === "PreToolUse").length, 6);
  // Any other call prints nothing: a preview, a harmless command, a tool that is not the shell even when its input
  // names the command, a tool devtwin does not know and a payload for another event.
  const quiet = [call(s.repo, "PreToolUse", "shell", { command: OWNER_COMMAND.replace(" --apply", "") }), call(s.repo, "PreToolUse", "shell", { command: "ls -la" }), call(s.repo, "PreToolUse", "bash", { command: "git status" }),
    call(s.repo, "PreToolUse", "read", { path: "notes.txt", command: OWNER_COMMAND }), call(s.repo, "PreToolUse", "write", { path: "run.sh", command: OWNER_COMMAND }), call(s.repo, "PreToolUse", "subagent", { command: OWNER_COMMAND }),
    call(s.repo, "PreToolUse", "shell", {}), call(s.repo, "PreToolUse", "shell", { command: 7 })];
  for (const payload of quiet) {
    assert.equal(ownerAction("opencode", payload), null, JSON.stringify(payload.tool_input));
    assert.deepEqual(await run(s, "pre-tool", payload), { code: 0, out: "" }, payload.tool_name + " " + JSON.stringify(payload.tool_input));
  }
  // A payload that names another event is not a pre-tool call: the route prints nothing for it.
  assert.deepEqual(await run(s, "pre-tool", call(s.repo, "PostToolUse", "shell", { command: OWNER_COMMAND })), { code: 0, out: "" });
  assert.deepEqual(bin(s, "pre-tool", quiet[1]), { code: 0, out: "", err: "" });
  // No lessons before a tool runs: a file and a command that match a lesson print nothing, and the lesson is still
  // undelivered, so the post-tool call of the same session prints it.
  for (const payload of [call(s.repo, "PreToolUse", "edit", { path: FILE }), call(s.repo, "PreToolUse", "read", { path: join(s.repo, FILE) }), call(s.repo, "PreToolUse", "shell", { command: "npm run seed" }), call(s.repo, "PreToolUse", "bash", { command: "npm run seed" })]) {
    assert.deepEqual(await run(s, "pre-tool", payload), { code: 0, out: "" }, payload.tool_name);
  }
  assert.equal(existsSync(sessionFile(s)), false, "a pre-tool call reads and writes no session file");
  assert.equal(await oc(s, "post-tool", call(s.repo, "PostToolUse", "shell", { command: "npm run seed" })), context(HEAD + "\n" + s.line(s.ids[0])));
});

test("opencode post-tool prints file and command lessons once, under the four-line cap", async (t) => {
  const s = await store(t, { lessons: [["Migrations before seeds", ALL], ...[1, 2, 3, 4, 5].map((n) => ["API lesson " + n, { paths: ["src/api/**"] }])] });
  const block = context(HEAD + "\n" + s.line(s.ids[0]));
  const after = (session, name, input) => oc(s, "post-tool", call(s.repo, "PostToolUse", name, input, { session_id: session }));
  // An edit with a path relative to the session folder, as OpenCode sends it: the lesson line, once.
  assert.equal(await after("ses_edit0001", "edit", { path: FILE }), block);
  assert.equal(await after("ses_edit0001", "edit", { path: FILE }), "", "the same file again");
  assert.equal(await after("ses_edit0001", "read", { path: FILE }), "", "the same lesson through another tool");
  assert.deepEqual(await state(s, "ses_edit0001"), { schemaVersion: 1, agent: "opencode", delivered: [s.ids[0]], lines: 1, overflowed: false }, "delivered, not held: no pending field");
  // A read with a relative path, a write with an absolute one and the 1.x field name.
  assert.equal(await after("ses_read0001", "read", { path: FILE }), block);
  assert.equal(await after("ses_write0001", "write", { path: join(s.repo, FILE) }), block);
  assert.equal(await after("ses_field0001", "read", { filePath: FILE }), block);
  // A shell command that matches a command lesson: the lesson arrives after the command, for both tool names.
  assert.equal(await after("ses_shell0001", "shell", { command: "npm run seed" }), block);
  assert.equal(await after("ses_shell0001", "shell", { command: "npm run seed" }), "");
  assert.equal(await after("ses_bash0001", "bash", { command: "npm run seed" }), block);
  // A patch names its files in patchText.
  const patch = "*** Begin Patch\n*** Update File: " + FILE + "\n@@\n-a\n+b\n*** End Patch";
  assert.equal(await after("ses_patch0001", "patch", { patchText: patch }), block);
  assert.equal(await after("ses_patch0002", "apply_patch", { patchText: patch }), block);
  // The session folder reached through a symbolic link, and a patch that deletes a file whose folder is gone. parse
  // leaves the path relative, so the hook resolves it against the canonical session folder and the lesson arrives, as
  // it does for the same patch from Codex. A path resolved against the link first would name no folder to look up.
  const link = join(s.sandbox, "atlas-link"), gone = "*** Begin Patch\n*** Delete File: db/migrations/gone/003_old.sql\n*** End Patch";
  await symlink(s.repo, link);
  assert.deepEqual([realpathSync(link), existsSync(join(s.repo, "db/migrations/gone"))], [s.repo, false]);
  assert.equal(await oc(s, "post-tool", call(link, "PostToolUse", "patch", { patchText: gone }, { session_id: "ses_link0001" })), block);
  assert.equal(await oc(s, "post-tool", call(link, "PostToolUse", "patch", { patchText: gone }, { session_id: "ses_link0001" })), "", "the same patch again");
  const codex = [];
  assert.equal(await main(["hook", "--event", "pre-tool", "--agent", "codex", "--pilot", s.path], { stdout: { write: (v) => { codex.push(v); return true; } }, now,
    stdin: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "ses_codexlink01", cwd: link, tool_name: "apply_patch", tool_input: { command: gone } }) }), 0);
  assert.equal(codex.join(""), JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: HEAD + "\n" + s.line(s.ids[0]) } }) + "\n");
  // An edit and a shell word with a relative path reach the lesson through the link too, with no folder on disk. An
  // absolute path through the link does when its folder exists, as before and as for every agent.
  assert.equal(await oc(s, "post-tool", call(link, "PostToolUse", "edit", { path: FILE }, { session_id: "ses_link0002" })), block);
  assert.equal(await oc(s, "post-tool", call(link, "PostToolUse", "shell", { command: "cat ./" + FILE }, { session_id: "ses_link0003" })), block);
  await mkdir(join(s.repo, "db/migrations"), { recursive: true });
  assert.equal(await oc(s, "post-tool", call(link, "PostToolUse", "write", { path: join(link, FILE) }, { session_id: "ses_link0004" })), block);
  // Nothing to say: an unrelated file, a harmless command, a search with no path, a tool devtwin does not know and a
  // path outside the session folder.
  for (const [name, input] of [["edit", { path: OTHER }], ["shell", { command: "ls -la" }], ["glob", {}], ["subagent", { path: FILE }], ["read", { path: "~/" + FILE }], ["patch", { patchText: "no headers" }], ["read", {}]]) {
    assert.equal(await after("ses_quiet0001", name, input), "", name + " " + JSON.stringify(input));
  }
  // The cap: five lessons match one file. Four lines and one overflow line arrive, and the session then gets no more.
  const capped = await after("ses_cap0001", "edit", { path: "src/api/users.ts" });
  const lines = JSON.parse(capped).context.split("\n"), api = s.ids.slice(1).map((id) => s.line(id));
  assert.deepEqual([lines.length, lines[0], lines.at(-1)], [6, HEAD, "1 more lesson matches; run `devtwin lesson match`"]);
  assert.ok(lines.slice(1, 5).every((line) => api.includes(line)) && new Set(lines.slice(1, 5)).size === 4, capped);
  assert.deepEqual(Object.keys(JSON.parse(capped)), ["context"]);
  assert.equal(await after("ses_cap0001", "edit", { path: "src/api/users.ts" }), "", "the fifth lesson is behind the overflow line");
  assert.equal(await after("ses_cap0001", "edit", { path: FILE }), "", "at the cap, another lesson prints nothing");
  const { delivered, ...rest } = await state(s, "ses_cap0001");
  assert.deepEqual([delivered.length, rest], [4, { schemaVersion: 1, agent: "opencode", lines: 4, overflowed: true }]);
  // The budget log holds one row for each delivery, with the lesson IDs.
  const rows = (await jsonLines(budgetLogPath(s.stateRoot))).filter((e) => e.agent === "opencode");
  assert.ok(rows.every((e) => e.event === "PostToolUse") && rows.length === 13, JSON.stringify(rows.map((e) => e.event)));
  assert.deepEqual(rows.at(-1).lessons, delivered);
  // The real binary, at the real time.
  await writeKitReceipt(s.roots, { pilotPath: s.path, now: new Date() });
  assert.deepEqual(bin(s, "post-tool", call(s.repo, "PostToolUse", "edit", { path: FILE }, { session_id: "ses_binary0001" })), { code: 0, out: block, err: "" });
  assert.deepEqual(bin(s, "post-tool", call(s.repo, "PostToolUse", "edit", { path: OTHER }, { session_id: "ses_binary0001" })), { code: 0, out: "", err: "" });
  assert.deepEqual(bin(s, "post-tool", call(link, "PostToolUse", "patch", { patchText: gone }, { session_id: "ses_binary0002" })), { code: 0, out: block, err: "" });
});

test("opencode hook prints nothing on a bad payload, an unreadable pilot, no receipt or nothing to say, and always exits 0", async (t) => {
  const bare = await store(t, { receipt: false }), s = await store(t);
  const events = Object.keys(EVENTS);
  // A payload that would speak with a good receipt: a matching prompt, a matching file.
  const loud = (repo, cli, extra = {}) => cli === "pre-tool" || cli === "post-tool" ? call(repo, EVENTS[cli], "edit", { path: FILE }, extra) : base(repo, EVENTS[cli], { prompt: "fix the migrations", ...extra });
  // A payload with nothing in it for devtwin: a harmless command, an unrelated file, an unrelated prompt.
  const quiet = (repo, cli, extra = {}) => cli === "pre-tool" ? call(repo, "PreToolUse", "shell", { command: "ls -la" }, extra) : cli === "post-tool" ? call(repo, "PostToolUse", "edit", { path: OTHER }, extra) : base(repo, EVENTS[cli], { prompt: "Rename the button component.", ...extra });
  // No receipt: session start names the missing receipt, as for every agent, and every other event prints nothing.
  for (const cli of events) {
    const expected = cli === "session-start" ? context(notVerified(bare, "missing")) : "";
    assert.deepEqual(await run(bare, cli, loud(bare.repo, cli)), { code: 0, out: expected }, "no receipt, " + cli);
    assert.deepEqual(bin(bare, cli, loud(bare.repo, cli)), { code: 0, out: expected, err: "" }, "no receipt, binary, " + cli);
  }
  await assert.rejects(readdir(join(bare.stateRoot, "hooks")), { code: "ENOENT" });
  // An unreadable pilot: a missing file, a file that is not JSON and one with no absolute stateRoot.
  const pilots = [join(s.sandbox, "missing.json"), join(s.sandbox, "not-json.json"), join(s.sandbox, "relative.json")];
  await writeFile(pilots[1], "{\"stateRoot\":");
  await writeFile(pilots[2], JSON.stringify({ stateRoot: "relative/state" }));
  for (const cli of events) {
    for (const pilot of pilots) assert.deepEqual(await run(s, cli, loud(s.repo, cli), { pilot }), { code: 0, out: "" }, "unreadable pilot, " + cli);
    assert.deepEqual(bin(s, cli, loud(s.repo, cli), { pilot: pilots[0] }), { code: 0, out: "", err: "" }, "missing pilot, binary, " + cli);
    // A bad or empty payload, a payload for another event, and one with no session or no absolute folder.
    for (const [label, body] of [["not JSON", "not json"], ["empty", ""], ["an array", "[]"], ["null", "null"], ["a string", "\"x\""], ["another event", loud(s.repo, cli, { hook_event_name: "Notification" })],
      ["the plugin hook name", loud(s.repo, cli, { hook_event_name: "execute.after" })], ["no session", loud(s.repo, cli, { session_id: undefined })], ["a long session", loud(s.repo, cli, { session_id: "s".repeat(257) })],
      ["no folder", loud(s.repo, cli, { cwd: undefined })], ["a relative folder", loud(s.repo, cli, { cwd: "work/atlas" })]]) {
      assert.deepEqual(await run(s, cli, body), { code: 0, out: "" }, label + ", " + cli);
    }
    assert.deepEqual(bin(s, cli, "not json"), { code: 0, out: "", err: "" }, "not JSON, binary, " + cli);
    // No payload at all: a terminal on stdin.
    assert.deepEqual(await run(s, cli, null, { stdin: { isTTY: true } }), { code: 0, out: "" }, "a terminal on stdin, " + cli);
  }
  // Nothing to say, with a valid receipt. Session start has its line; every other event is silent.
  assert.equal(await oc(s, "session-start", quiet(s.repo, "session-start")), context(liveLine(SESSION)));
  for (const cli of events.filter((e) => e !== "session-start")) assert.deepEqual(await run(s, cli, quiet(s.repo, cli)), { code: 0, out: "" }, "nothing to say, " + cli);
  // A folder that is no bound project has no lessons.
  for (const cli of ["user-prompt", "post-tool"]) assert.deepEqual(await run(s, cli, loud(s.sandbox, cli)), { code: 0, out: "" }, "unbound folder, " + cli);
  // A damaged session file is a thrown error inside the hook: nothing is printed, and the file is removed.
  await mkdir(sessionsDir(s.stateRoot), { recursive: true, mode: 0o700 });
  await writeFile(sessionFile(s, "ses_damaged0001"), "{\"schemaVersion\":1,\"agent\":\"open", { mode: 0o600 });
  assert.deepEqual(await run(s, "post-tool", loud(s.repo, "post-tool", { session_id: "ses_damaged0001" })), { code: 0, out: "" });
  assert.equal(existsSync(sessionFile(s, "ses_damaged0001")), false);
  assert.ok((await jsonLines(hookLogPath(s.stateRoot))).some((e) => e.agent === "opencode" && e.code === "session-corrupt"));
  // An event or an agent name that the hook command does not know prints nothing and exits 0 too.
  for (const args of [["hook", "--event", "prompt", "--agent", "opencode", "--pilot", s.path], ["hook", "--event", "execute.after", "--agent", "opencode", "--pilot", s.path], ["hook", "--event", "post-tool", "--agent", "OpenCode", "--pilot", s.path]]) {
    const r = spawnSync(process.execPath, [BIN, ...args], { input: JSON.stringify(loud(s.repo, "post-tool")), env: { PATH: process.env.PATH, HOME: s.fakeHome }, encoding: "utf8" });
    assert.deepEqual([r.status, r.stdout], [0, ""], args.join(" "));
  }
});

// A fake OpenCode plugin context: it records each hook that setup registers.
function fakeCtx(directory) {
  const hooks = {};
  const group = () => ({ hook: async (name, fn) => { hooks[name] = fn; } });
  return { ctx: { location: { directory }, tool: group(), session: group() }, hooks };
}
// The events as OpenCode 2.x sends them to a plugin hook.
const toolEvent = (tool, input, extra = {}) => ({ tool, sessionID: SESSION, agent: "build", messageID: "msg_example0001", id: "call_example0001", input, ...extra });
const done = (tool, input, result) => toolEvent(tool, input, { status: "completed", result });
const promptEvent = (text) => ({ sessionID: SESSION, messageID: "msg_example0001", prompt: { text }, metadata: {}, delivery: "immediate" });

test("the generated plugin and the hook command agree end to end", async (t) => {
  // The plugin text for this worktree as the kit and a disposable pilot with one lesson. Each hook spawns the real
  // bin/devtwin.mjs, at the real time, so the receipt is written at the real time too.
  const s = await store(t, { receipt: false });
  await writeKitReceipt(s.roots, { pilotPath: s.path, now: new Date() });
  const config = join(s.sandbox, "opencode-config"), file = join(config, "plugins/devtwin.mjs");
  await mkdir(join(config, "plugins"), { recursive: true });
  const text = adapter("opencode").hooks.content({ kitRoot: KIT, pilotPath: s.path });
  assert.ok(text.includes("KIT = " + JSON.stringify(KIT)) && text.includes("PILOT = " + JSON.stringify(s.path)));
  await writeFile(file, text);
  const plugin = (await import(pathToFileURL(file).href)).default, { ctx, hooks } = fakeCtx(s.repo);
  assert.equal(await plugin.setup(ctx), undefined);
  assert.deepEqual(Object.keys(hooks).sort(), ["compaction", "context", "execute.after", "execute.before", "experimental.idle", "prompt"]);
  // The child process takes the environment of this process. HOME is a fake home while the hooks run.
  const home = process.env.HOME;
  try {
    process.env.HOME = s.fakeHome;
    // execute.before: an owner-only command throws devtwin's deny reason; its preview and another command run.
    await assert.rejects(hooks["execute.before"](toolEvent("shell", { command: OWNER_COMMAND })), (e) => e instanceof Error && e.message === DENY_REASON);
    assert.equal(await hooks["execute.before"](toolEvent("shell", { command: OWNER_COMMAND.replace(" --apply", "") })), undefined);
    assert.equal(await hooks["execute.before"](toolEvent("shell", { command: "npm run seed" })), undefined, "no lesson before a tool");
    assert.ok((await jsonLines(hookLogPath(s.stateRoot))).some((e) => e.agent === "opencode" && e.code === "owner-block"));
    // prompt: the session-start line is appended once for the session.
    const first = promptEvent("Rename the button component.");
    await hooks.prompt(first);
    assert.equal(first.prompt.text, "Rename the button component.\n\n" + liveLine(SESSION));
    const second = promptEvent("Rename the button component.");
    await hooks.prompt(second);
    assert.equal(second.prompt.text, "Rename the button component.", "no second session-start line");
    // execute.after: the lesson for the edited file is appended to the tool result, once, as one text part that starts
    // with the marker line.
    const result = { content: [{ type: "text", text: "tool output" }] }, edit = done("edit", { path: FILE, oldString: "a", newString: "b" }, result);
    await hooks["execute.after"](edit);
    assert.deepEqual(edit.result.content, [{ type: "text", text: "tool output" }, { type: "text", text: MARK + "\n" + HEAD + "\n" + s.line(s.ids[0]) }]);
    const again = done("edit", { path: FILE }, result);
    await hooks["execute.after"](again);
    assert.equal(again.result, result, "the same file again adds nothing");
    // The two halves share the session: the lesson the tool call delivered is not repeated on a matching prompt.
    const third = promptEvent("fix the migrations");
    await hooks.prompt(third);
    assert.equal(third.prompt.text, "fix the migrations");
    assert.deepEqual(await state(s), { schemaVersion: 1, agent: "opencode", delivered: [s.ids[0]], lines: 1, overflowed: false });
    // The idle hook sends stop, which writes the stop stub; the compaction hook removes the session file, so the
    // prompt lesson arrives again.
    await hooks["experimental.idle"]({ sessionID: SESSION });
    assert.equal(JSON.parse(await readFile(stubPath(s.stateRoot, SCOPE, PROJECT, s.repo), "utf8")).session, sessionKey("opencode", SESSION));
    await hooks.compaction({ sessionID: SESSION });
    assert.equal(existsSync(sessionFile(s)), false);
    const fourth = promptEvent("fix the migrations");
    await hooks.prompt(fourth);
    assert.equal(fourth.prompt.text, "fix the migrations\n\n" + HEAD + "\n" + s.line(s.ids[0]));
    // The marker line belongs to a tool result only: the prompt text with the session-start line and the one with the
    // lesson do not have it.
    for (const event of [first, fourth]) assert.ok(!event.prompt.text.includes("devtwin hook note"), event.prompt.text);
    // Nor does the system text: the context hook adds the text of <config folder>/devtwin.md as it is in the file.
    await writeFile(join(config, "devtwin.md"), "## devtwin\n\nBLOCK A\n");
    const system = [{ type: "text", text: "existing" }];
    await hooks.context({ sessionID: SESSION, system, messages: [] });
    assert.deepEqual(system, [{ type: "text", text: "existing" }, { type: "text", text: "## devtwin\n\nBLOCK A\n" }]);
    assert.ok(system.every((part) => !part.text.includes("devtwin hook note")), "the system text has no marker line");
    // A patch: the plugin sends its header lines only, and the hook still finds the file they name.
    await hooks.compaction({ sessionID: SESSION });
    const patched = done("patch", { patchText: "*** Begin Patch\n*** Update File: " + FILE + "\n@@\n-create table a;\n+create table b;\n*** End Patch" }, result);
    await hooks["execute.after"](patched);
    assert.deepEqual(patched.result.content, [{ type: "text", text: "tool output" }, { type: "text", text: MARK + "\n" + HEAD + "\n" + s.line(s.ids[0]) }]);
  } finally { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; }
});
