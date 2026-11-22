import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { makePilot, sandbox, makeRepo, fixtureGit, runCli, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { loadPilot } from "../src/config/pilot.mjs";
import { adapter, actorOf } from "../src/agents/adapters/index.mjs";
import { DENY_REASON, ownerAction } from "../src/hooks/owner-block.mjs";
import { callerActor } from "../src/policy/actor.mjs";

const KIT = realpathSync(join(import.meta.dirname, ".."));
const BIN = join(KIT, "bin/devtwin.mjs");
const WS = "/w/example", SESSION = "agy-conversation-0001";
// Payloads as Antigravity CLI 1.5 sends them: camelCase keys, the tool call under toolCall with PascalCase args.
// event null gives a payload from before 1.5.4, which had no hookEventName.
const base = (event, extra = {}) => ({ conversationId: SESSION, cwd: WS, ...(event ? { hookEventName: event } : {}), modelName: "example-model", workspacePaths: [WS], ...extra });
const call = (event, name, args, extra = {}) => base(event, { stepIdx: 3, toolCall: { id: "call-0001", name, args }, ...extra });
const shell = (event, commandLine, extra) => call(event, "run_command", { CommandLine: commandLine, WaitMsBeforeAsync: 5000, toolSummary: "run a command" }, extra);
const OWNER_COMMAND = 'node "/opt/example-kit/bin/devtwin.mjs" live set-kit --pilot /x/live.json --kit /x/kit --apply --plan-fingerprint sha256:00';
const KEYS = ["event", "sessionId", "cwd", "source", "prompt", "toolName", "toolKind", "command", "paths", "edit"];
const NONE = { source: undefined, prompt: undefined, toolName: undefined, toolKind: null, command: undefined, paths: [], edit: false };

test("antigravity parse normalizes SessionStart, PreInvocation, PreToolUse, PostToolUse and Stop camelCase payloads", () => {
  const { parse, eventNames } = adapter("antigravity").hooks;
  // The same keys, in the same order, as the other adapters give.
  assert.deepEqual(Object.keys(parse(base("Stop"))), KEYS);
  assert.deepEqual(Object.keys(adapter("gemini").hooks.parse({})), KEYS);
  // There is no compaction event; PreInvocation stands for a user prompt.
  assert.deepEqual(eventNames, { SessionStart: "SessionStart", UserPromptSubmit: "PreInvocation", PreToolUse: "PreToolUse", PostToolUse: "PostToolUse", Stop: "Stop" });
  assert.deepEqual(parse(base("SessionStart", { lastUserInput: "fix the migrations" })), { ...NONE, event: "SessionStart", sessionId: SESSION, cwd: WS, prompt: "fix the migrations" });
  assert.deepEqual(parse(base("PreInvocation", { invocationNum: 0, lastUserInput: "fix the migrations" })), { ...NONE, event: "UserPromptSubmit", sessionId: SESSION, cwd: WS, prompt: "fix the migrations" });
  assert.deepEqual(parse(shell("PreToolUse", "npm test -- db/seed.sql")),
    { ...NONE, event: "PreToolUse", sessionId: SESSION, cwd: WS, toolName: "run_command", toolKind: "shell", command: "npm test -- db/seed.sql", paths: ["db/seed.sql"] });
  assert.deepEqual(parse(call("PreToolUse", "read_file", { Path: WS + "/db/migrations/002_users.sql" })),
    { ...NONE, event: "PreToolUse", sessionId: SESSION, cwd: WS, toolName: "read_file", toolKind: "read", paths: [WS + "/db/migrations/002_users.sql"] });
  // PostToolUse carries an error field and no tool output.
  assert.deepEqual(parse(call("PostToolUse", "write_file", { Path: "db/x.sql", Content: "x" }, { error: "" })),
    { ...NONE, event: "PostToolUse", sessionId: SESSION, cwd: WS, toolName: "write_file", toolKind: "edit", paths: ["db/x.sql"], edit: true });
  assert.deepEqual(parse(shell("PostToolUse", "npm run seed", { error: "exit status 1" })),
    { ...NONE, event: "PostToolUse", sessionId: SESSION, cwd: WS, toolName: "run_command", toolKind: "shell", command: "npm run seed" });
  assert.deepEqual(parse(base("Stop")), { ...NONE, event: "Stop", sessionId: SESSION, cwd: WS });
  // An event devtwin has no name for stays as sent, so it never matches an installed event.
  for (const name of ["PostInvocation", "SessionEnd", "BeforeTool", "constructor", "__proto__"]) assert.equal(parse(base(name)).event, name);
  // The snake_case keys of the other agents are not read.
  assert.deepEqual(parse({ session_id: "s", hook_event_name: "PreToolUse", prompt: "p", tool_name: "run_command", tool_input: { command: OWNER_COMMAND } }), { ...NONE, event: undefined, sessionId: undefined, cwd: undefined });
  // Gemini CLI and Claude Code tool names keep their meaning in their own adapters only.
  for (const name of ["run_shell_command", "Bash", "replace", "Read"]) assert.equal(parse(call("PreToolUse", name, { CommandLine: "ls", Path: "a.txt" })).toolKind, null, name);
  assert.equal(adapter("gemini").hooks.parse({ hook_event_name: "BeforeTool", tool_name: "run_command", tool_input: { command: "ls" } }).toolKind, null);
});

test("antigravity parse accepts both tool name sets and payloads without cwd or hookEventName, and never throws", () => {
  const { parse, tools, events, entry } = adapter("antigravity").hooks;
  // The names a real CLI sends (read_file, write_file, edit_file with Path) and the names its docs list.
  assert.deepEqual(tools, { shell: ["run_command", "manage_task"], read: ["read_file", "view_file"], edit: ["write_file", "edit_file", "write_to_file", "replace_file_content", "multi_replace_file_content"], search: ["list_dir", "find_by_name", "grep_search"] });
  const all = "run_command|manage_task|read_file|view_file|write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|list_dir|find_by_name|grep_search";
  assert.deepEqual(events, [["SessionStart", "session-start", null], ["PreInvocation", "user-prompt", null], ["PreToolUse", "pre-tool", "run_command|manage_task"], ["PostToolUse", "post-tool", all], ["Stop", "stop", null]]);
  // A matcher gives the grouped shape; a lifecycle event gives the flat handler. The timeout is in seconds.
  assert.deepEqual(entry({ command: "node x", matcher: "run_command|manage_task", event: "pre-tool" }), { matcher: "run_command|manage_task", hooks: [{ type: "command", command: "node x", timeout: 10 }] });
  assert.deepEqual(entry({ command: "node x", matcher: null, event: "stop" }), { type: "command", command: "node x", timeout: 10 });
  const file = WS + "/db/x.sql";
  for (const [name, args, kind, edit] of [["read_file", { Path: file }, "read", false], ["view_file", { AbsolutePath: file }, "read", false], ["write_file", { Path: file, Content: "x" }, "edit", true],
    ["edit_file", { Path: file, OldText: "a", NewText: "b" }, "edit", true], ["write_to_file", { TargetFile: file, CodeContent: "x" }, "edit", true], ["replace_file_content", { TargetFile: file }, "edit", true],
    ["multi_replace_file_content", { TargetFile: file, ReplacementChunks: [] }, "edit", true]]) {
    const n = parse(call("PostToolUse", name, args, { error: "" }));
    assert.deepEqual([n.toolName, n.toolKind, n.command, n.paths, n.edit], [name, kind, undefined, [file], edit], name);
  }
  for (const [name, args] of [["list_dir", { DirectoryPath: WS + "/db" }], ["find_by_name", { SearchDirectory: WS + "/db", Pattern: "*.sql" }], ["grep_search", { SearchPath: WS + "/db", Query: "users" }]]) {
    const n = parse(call("PostToolUse", name, args));
    assert.deepEqual([n.toolKind, n.paths, n.edit], ["search", [WS + "/db"], false], name);
  }
  // Either key of a kind is read whatever the tool name; a path longer than 4096 characters is dropped.
  assert.deepEqual(parse(call("PreToolUse", "view_file", { Path: "a.txt", AbsolutePath: "b.txt" })).paths, ["a.txt"]);
  assert.deepEqual(parse(call("PreToolUse", "read_file", { TargetFile: "c.txt" })).paths, ["c.txt"]);
  assert.deepEqual(parse(call("PreToolUse", "list_dir", { SearchPath: "src" })).paths, ["src"]);
  assert.deepEqual(parse(call("PreToolUse", "read_file", { Path: "/" + "a".repeat(4096) })).paths, []);
  assert.deepEqual(parse(call("PreToolUse", "read_file", { Path: "", AbsolutePath: 7 })).paths, []);
  assert.deepEqual(parse(shell("PreToolUse", "cat " + "a".repeat(4097) + "/x.sql db/seed.sql")).paths, ["db/seed.sql"]);
  // The matchers are plain alternations, so parse checks each name exactly.
  for (const name of ["run_command_extra", "my_run_command", "Run_Command", "read_file2", "manage_task ", "constructor", "__proto__", "toString"]) {
    const n = parse(call("PreToolUse", name, { CommandLine: OWNER_COMMAND, Path: "a.txt" }));
    assert.deepEqual([n.toolKind, n.command, n.paths, n.edit], [null, undefined, [], false], name);
    assert.equal(ownerAction("antigravity", call("PreToolUse", name, { CommandLine: OWNER_COMMAND })), null, name);
  }
  // manage_task is a shell tool; only its send_input action carries shell text. Another action gives no command.
  const send = parse(call("PreToolUse", "manage_task", { Action: "send_input", Input: "npm run seed\n", TaskId: "task-1" }));
  assert.deepEqual([send.toolKind, send.command, send.paths], ["shell", "npm run seed\n", []]);
  for (const args of [{ Action: "kill", Input: OWNER_COMMAND }, { Action: "status", CommandLine: OWNER_COMMAND }, { Input: OWNER_COMMAND }, { Action: "send_input", Input: 7 }, { Action: "send_input" }]) {
    const n = parse(call("PreToolUse", "manage_task", args));
    assert.deepEqual([n.toolKind, n.command, n.paths], ["shell", undefined, []], JSON.stringify(args));
    assert.equal(ownerAction("antigravity", call("PreToolUse", "manage_task", args)), null, JSON.stringify(args));
  }
  assert.equal(parse(shell("PreToolUse", 7)).command, undefined);
  // The owner-action block reads the command of both shell shapes.
  assert.equal(ownerAction("antigravity", shell("PreToolUse", OWNER_COMMAND)), "live set-kit --apply");
  assert.equal(ownerAction("antigravity", call("PreToolUse", "manage_task", { Action: "send_input", Input: OWNER_COMMAND + "\n" })), "live set-kit --apply");
  assert.equal(ownerAction("antigravity", shell("PreToolUse", OWNER_COMMAND.replace(" --apply", ""))), null);
  assert.equal(ownerAction("antigravity", call("PreToolUse", "write_file", { Path: "x.sh", Content: OWNER_COMMAND })), null);
  // Before 1.5.4 a payload had no cwd and no hookEventName: the first absolute workspace path stands for the cwd.
  const old = { conversationId: SESSION, toolCall: { id: "call-0001", name: "run_command", args: { CommandLine: "npm run seed" } }, workspacePaths: [WS, "/w/other"] };
  assert.deepEqual(parse(old), { ...NONE, event: undefined, sessionId: SESSION, cwd: WS, toolName: "run_command", toolKind: "shell", command: "npm run seed" });
  const long = "/" + "a".repeat(4095);
  for (const [payload, cwd] of [[{ workspacePaths: [WS] }, WS], [{ cwd: "relative/dir", workspacePaths: ["also/relative", null, 7, "", WS, "/w/other"] }, WS], [{ cwd: "", workspacePaths: [WS] }, WS],
    [{ cwd: long + "a", workspacePaths: [long + "b", WS] }, WS], [{ cwd: long }, long], [{ cwd: 7, workspacePaths: WS }, undefined], [{ cwd: "relative/dir" }, undefined], [{ workspacePaths: [] }, undefined], [{}, undefined]]) {
    assert.equal(parse(payload).cwd, cwd, JSON.stringify(payload).slice(0, 80));
  }
  // parse is total: any JSON value, and any value in any field, gives the same shape.
  const odd = [null, undefined, "text", 7, true, [], [null], {}, { toolCall: null }, { toolCall: "run_command" }, { toolCall: [] }, { toolCall: { name: null } }, { toolCall: { name: ["run_command"] } }, { toolCall: { name: "run_command" } },
    { toolCall: { name: "run_command", args: null } }, { toolCall: { name: "run_command", args: "ls" } }, { toolCall: { name: "run_command", args: ["ls"] } }, { toolCall: { name: "run_command", args: { CommandLine: { text: "ls" } } } },
    { toolCall: { name: "manage_task", args: { Action: "send_input", Input: null } } }, { toolCall: { name: "read_file", args: { Path: { path: "a" } } } }, { toolCall: { name: "grep_search", args: { SearchPath: ["a"] } } },
    { hookEventName: 7, conversationId: { id: 1 }, cwd: [WS], workspacePaths: { 0: WS }, lastUserInput: 7 }];
  for (const payload of odd) {
    let n;
    assert.doesNotThrow(() => { n = parse(payload); }, JSON.stringify(payload));
    assert.deepEqual(Object.keys(n), KEYS, JSON.stringify(payload));
    assert.ok(Array.isArray(n.paths) && n.paths.length === 0 && n.edit === false && n.cwd === undefined && n.command === undefined, JSON.stringify(payload));
    assert.equal(ownerAction("antigravity", payload), null, JSON.stringify(payload));
  }
});

test("antigravity format prints injectSteps for context, a decision deny, and neutral replies of ask before a tool, an empty decision on Stop and an empty object otherwise", async (t) => {
  const hooks = adapter("antigravity").hooks, { format, neutral } = hooks;
  assert.deepEqual(format({ kind: "deny", reason: DENY_REASON }), { stdout: { decision: "deny", reason: DENY_REASON }, exitCode: 0 });
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse"]) {
    assert.deepEqual(format({ kind: "context", event, text: "line one\nline two" }), { stdout: { injectSteps: [{ systemMessage: { systemMessage: "line one\nline two" } }] }, exitCode: 0 }, event);
  }
  // neutral takes devtwin's internal event name. An empty reply denies a tool, so the reply before a tool is "ask".
  assert.deepEqual(neutral("PreToolUse"), { decision: "ask" });
  assert.deepEqual(neutral("Stop"), { decision: "" });
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "PreCompact", "PreInvocation", undefined]) assert.deepEqual(neutral(event), {}, String(event));
  // Each call gives a new object, so a caller that changes one reply cannot change the next.
  assert.notEqual(neutral("PreToolUse"), neutral("PreToolUse"));
  // devtwin never prints "allow": the docs disagree on whether it approves the tool.
  for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) assert.notEqual(neutral(event).decision, "allow", event);
  // Lessons arrive after the tool, held until the next PreInvocation; no event stands for a compaction.
  assert.deepEqual([hooks.file, hooks.display, hooks.container, hooks.lessonEvent, hooks.deferToolContext], ["config/hooks.json", "~/.gemini/config/hooks.json", "devtwin", "PostToolUse", true]);
  for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "Stop"]) assert.equal(hooks.compacted(event, { source: "compact" }), false, event);
  // The deny through the real hook entry point, in process and from the bin script, for both shell shapes.
  const p = await makePilot(t);
  for (const payload of [shell("PreToolUse", OWNER_COMMAND), call("PreToolUse", "manage_task", { Action: "send_input", Input: OWNER_COMMAND + "\n" })]) {
    const chunks = [];
    const code = await main(["hook", "--event", "pre-tool", "--agent", "antigravity", "--pilot", p.path], { stdout: { write: (v) => { chunks.push(v); return true; } }, stdin: JSON.stringify(payload), now });
    assert.equal(code, 0);
    assert.equal(chunks.join(""), JSON.stringify({ decision: "deny", reason: DENY_REASON }) + "\n");
    const run = spawnSync(process.execPath, [BIN, "hook", "--event", "pre-tool", "--agent", "antigravity", "--pilot", p.path], { input: JSON.stringify(payload), env: { PATH: process.env.PATH, HOME: p.fakeHome }, encoding: "utf8" });
    assert.deepEqual([run.status, JSON.parse(run.stdout)], [0, { decision: "deny", reason: DENY_REASON }]);
  }
});

test("antigravity detect reads ANTIGRAVITY_AGENT and ANTIGRAVITY_CONVERSATION_ID, and a Gemini CLI shell stays gemini", () => {
  const { detect } = adapter("antigravity");
  // A real agy shell sets both variables and does not set GEMINI_CLI.
  assert.deepEqual([detect({ ANTIGRAVITY_AGENT: "1" }), detect({ ANTIGRAVITY_CONVERSATION_ID: SESSION }), detect({ ANTIGRAVITY_AGENT: "1", ANTIGRAVITY_CONVERSATION_ID: SESSION })], [true, true, true]);
  assert.deepEqual([detect({}), detect({ ANTIGRAVITY_AGENT: "", ANTIGRAVITY_CONVERSATION_ID: "" }), detect({ GEMINI_CLI: "1" }), detect({ ANTIGRAVITY_HOME: "/h/example" })], [false, false, false, false]);
  assert.deepEqual([actorOf({ ANTIGRAVITY_AGENT: "1", ANTIGRAVITY_CONVERSATION_ID: SESSION }), actorOf({ ANTIGRAVITY_CONVERSATION_ID: SESSION }), callerActor({ ANTIGRAVITY_AGENT: "1" })], ["antigravity", "antigravity", "antigravity"]);
  assert.deepEqual([actorOf({ GEMINI_CLI: "1" }), callerActor({ GEMINI_CLI: "1" }), adapter("gemini").detect({ ANTIGRAVITY_AGENT: "1" }), actorOf({})], ["gemini", "gemini", false, "human"]);
  // Registry order decides when a shell shows more than one agent: the earlier adapters win.
  assert.deepEqual([actorOf({ ANTIGRAVITY_AGENT: "1", GEMINI_CLI: "1" }), actorOf({ ANTIGRAVITY_AGENT: "1", CODEX_SANDBOX: "x" }), actorOf({ ANTIGRAVITY_AGENT: "1", CLAUDECODE: "1" })], ["gemini", "codex", "claude"]);
});

// A fixture home with a pinned kit and every folder the test names as a real directory.
async function liveHome(t) {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin");
  for (const rel of [".claude/skills", ".agents/skills", ".gemini/config/skills", ".gemini/config/plugins", ".gemini/skills"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(devtwin);
  await chmod(devtwin, 0o700);
  const kit = await makeRepo(join(devtwin, "kit"), { "README.md": "kit\n" });
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  const repo = await makeRepo(join(sb, "work/atlas"), { "README.md": "# Atlas\n" });
  const liveConfig = join(devtwin, "live.json"), context = { home, env: {}, kitRoot: kit };
  const cli = (args) => runCli(args, { ...context, ownerDialog: () => "approved" });
  let n = 0;
  // A candidate config beside the real one: the applied config with other skill folders or repositories.
  const variant = async (skillDirs, patch = {}) => {
    const config = JSON.parse(await readFile(liveConfig, "utf8")), path = join(devtwin, "live-" + ++n + ".json");
    await writeFile(path, JSON.stringify({ ...config, ...patch, live: { ...config.live, skillDirs } }), { mode: 0o600 });
    return path;
  };
  return { home, repo, liveConfig, context, cli, variant, gemini: join(home, ".gemini") };
}
const refused = (field, label) => (e) => e.code === "DEVTWIN_GATE_REQUIRED" && e.details.field === field && (label === undefined || e.details.protected === label);

test("a live config accepts exactly the Antigravity skills folder under .gemini/config and refuses its parents and siblings", async (t) => {
  const h = await liveHome(t), skills = join(h.gemini, "config/skills"), shared = join(h.home, ".agents/skills");
  assert.deepEqual([adapter("antigravity").skills.folder, adapter("antigravity").skills.dir({ home: h.home, env: {} }), adapter("antigravity").skills.legacy], [".gemini/config/skills", skills, []]);
  // Through the real CLI: live init names the folder, and the config it writes loads.
  const init = ["live", "init", "--pilot", h.liveConfig, "--agent", "antigravity", "--agent", "gemini", "--repo", h.repo];
  const preview = await h.cli(init);
  assert.equal(preview.json.ok, true, JSON.stringify(preview.json.error));
  assert.deepEqual(preview.json.result.config.live.skillDirs, { antigravity: skills, gemini: shared });
  const applied = await h.cli([...init, "--apply", "--plan-fingerprint", preview.json.result.fingerprint]);
  assert.equal(applied.json.ok, true, JSON.stringify(applied.json.error));
  const pilot = await loadPilot(h.liveConfig, h.context);
  assert.deepEqual(pilot.live.skillDirs, { antigravity: skills, gemini: shared });
  const candidate = (path, env = {}) => loadPilot(path, { ...h.context, env, liveGate: { approval: false } });
  assert.deepEqual((await candidate(await h.variant({ antigravity: skills }))).live.skillDirs, { antigravity: skills });
  // Its parents, the folder Gemini CLI once used and a sibling are each a real directory, and each is refused.
  // A child of the folder, the folder with a trailing slash and another agent's folder are refused too.
  for (const path of [h.gemini, join(h.gemini, "config"), join(h.gemini, "skills"), join(h.gemini, "config/plugins"), join(skills, "devtwin-record"), skills + "/", shared, join(h.home, ".claude/skills"), h.home]) {
    await assert.rejects(candidate(await h.variant({ antigravity: path })), refused("live.skillDirs.antigravity"), path);
  }
  // The carve-out is for this one agent: no other agent may name the folder, and no repository may sit under ~/.gemini.
  for (const agent of ["gemini", "codex", "claude"]) await assert.rejects(candidate(await h.variant({ [agent]: skills })), refused("live.skillDirs." + agent), agent);
  // CLAUDE_CONFIG_DIR moves Claude Code's folder. Inside ~/.gemini that folder stays refused, also where it is the
  // folder Gemini CLI reads or the Antigravity CLI folder itself.
  await mkdir(join(h.gemini, "x/skills"), { recursive: true });
  for (const dir of [h.gemini, join(h.gemini, "x"), join(h.gemini, "config")]) {
    await assert.rejects(candidate(await h.variant({ claude: join(dir, "skills") }), { CLAUDE_CONFIG_DIR: dir }), refused("live.skillDirs.claude", "real-gemini-home"), dir);
    await assert.rejects(candidate(await h.variant({ antigravity: skills, claude: join(dir, "skills") }), { CLAUDE_CONFIG_DIR: dir }), refused("live.skillDirs.claude"), dir);
  }
  // The variable does not move the Antigravity CLI folder, and outside ~/.gemini it still moves Claude Code's.
  assert.deepEqual((await candidate(await h.variant({ antigravity: skills }), { CLAUDE_CONFIG_DIR: join(h.gemini, "config") })).live.skillDirs, { antigravity: skills });
  await mkdir(join(h.home, "moved/skills"), { recursive: true });
  assert.deepEqual((await candidate(await h.variant({ antigravity: skills, claude: join(h.home, "moved/skills") }), { CLAUDE_CONFIG_DIR: join(h.home, "moved") })).live.skillDirs, { antigravity: skills, claude: join(h.home, "moved/skills") });
  for (const repo of [skills, join(skills, "example"), join(h.gemini, "config"), h.gemini]) {
    await assert.rejects(candidate(await h.variant({ antigravity: skills }, { repos: [repo] })), refused("repos", "real-gemini-home"), repo);
  }
  // A folder that is missing is refused, as for every agent.
  await rm(skills, { recursive: true });
  await assert.rejects(loadPilot(h.liveConfig, h.context), refused("live.skillDirs.antigravity"));
});
