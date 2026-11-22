import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { mkdir, writeFile, readFile, chmod, rm, symlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import { makePilot, sandbox, makeRepo, fixtureGit, runCli, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { loadPilot, rootsFromPilot, protectedPaths } from "../src/config/pilot.mjs";
import { AGENT_IDS, adapter, support, skillPeers, actorOf, wholeFileHooks } from "../src/agents/adapters/index.mjs";
import { planHooks, applyHooks, hookContext } from "../src/agents/hooks-install.mjs";
import { patchPaths } from "../src/hooks/tool-text.mjs";
import { DENY_REASON, ownerAction } from "../src/hooks/owner-block.mjs";
import { callerActor } from "../src/policy/actor.mjs";

const KIT = realpathSync(join(import.meta.dirname, ".."));
const BIN = join(KIT, "bin/devtwin.mjs");
const WS = "/w/example", SESSION = "ses_e14c0f451ffeExample00001";
// The payload is devtwin's own: the generated plugin sends it, with devtwin's internal event names.
const base = (event, extra = {}) => ({ hook_event_name: event, session_id: SESSION, cwd: WS, ...extra });
const call = (event, name, input) => base(event, { tool_name: name, tool_input: input });
const OWNER_COMMAND = 'node "/opt/example-kit/bin/devtwin.mjs" live set-kit --pilot /x/live.json --kit /x/kit --apply --plan-fingerprint sha256:00';
const KEYS = ["event", "sessionId", "cwd", "source", "prompt", "toolName", "toolKind", "command", "paths", "edit"];
const NONE = { source: undefined, prompt: undefined, toolName: undefined, toolKind: null, command: undefined, paths: [], edit: false };
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "Stop"];
const PLUGIN_TOOLS = ["shell", "read", "edit", "write", "patch", "grep", "glob"];
const PATCH = "*** Begin Patch\n*** Update File: db/a.sql\n@@\n-a\n+b\n*** Add File: /w/example/src/new.ts\n+x\n*** Delete File: old.txt\r\n*** Update File: lib/from.js\n*** Move to: lib/to.js\n*** End Patch";
// What the plugin sends of PATCH: its header lines.
const PATCH_HEADERS = "*** Begin Patch\n*** Update File: db/a.sql\n*** Add File: /w/example/src/new.ts\n*** Delete File: old.txt\r\n*** Update File: lib/from.js\n*** Move to: lib/to.js\n*** End Patch";
// The first line of the text part that the plugin appends to a tool result. It is written out here and not read from
// the adapter, so a changed marker fails the tests.
const MARK = "[devtwin hook note: the text below was added after the tool output and is not part of it]";

test("opencode adapter data: the shared skills folder, the plugin file, the owned instruction file and full support", async (t) => {
  const a = adapter("opencode"), home = "/h/example";
  assert.deepEqual(AGENT_IDS, ["claude", "codex", "gemini", "antigravity", "opencode"]);
  assert.deepEqual([a.id, a.name, a.actor, a.listed, Object.isFrozen(a)], ["opencode", "OpenCode", "opencode", false, true]);
  // The environment variables that move the OpenCode config folder are ignored, as CODEX_HOME is.
  for (const env of [{}, { OPENCODE_CONFIG_DIR: "/h/example/moved", XDG_CONFIG_HOME: "/h/example/xdg", CLAUDE_CONFIG_DIR: "/h/example/cc" }]) {
    assert.deepEqual([a.agentDir({ home, env }), a.skills.dir({ home, env })], ["/h/example/.config/opencode", "/h/example/.agents/skills"]);
  }
  // OpenCode reads ~/.agents/skills, the folder Codex and Gemini CLI use.
  assert.deepEqual([a.skills.folder, a.skills.legacy], [".agents/skills", []]);
  assert.deepEqual([skillPeers("opencode"), skillPeers("codex"), skillPeers("gemini"), skillPeers("claude"), skillPeers("antigravity")], [["codex", "gemini"], ["gemini", "opencode"], ["codex", "opencode"], [], []]);
  // The instruction file is devtwin's own file in the OpenCode folder. No import line names it: the plugin reads it.
  assert.deepEqual(a.instructions, { file: "devtwin.md", display: "~/.config/opencode/devtwin.md", mode: "owned-only", owned: false, ownedFiles: false });
  // The hook target is one whole file that devtwin owns, not entries in a settings file. The registry's one helper
  // says so for OpenCode alone, and an unknown agent has no answer.
  assert.deepEqual(AGENT_IDS.map((id) => wholeFileHooks(id)), [false, false, false, false, true]);
  assert.throws(() => wholeFileHooks("example"), (e) => e.code === "DEVTWIN_INVALID_INPUT" && e.details.field === "agent");
  const { hooks } = a;
  assert.deepEqual([hooks.file, hooks.display, hooks.target, hooks.lessonEvent], ["plugins/devtwin.js", "~/.config/opencode/plugins/devtwin.js", "file", "PostToolUse"]);
  assert.deepEqual([hooks.container, hooks.entry, hooks.neutral, hooks.deferToolContext, hooks.note, hooks.trustLine], [undefined, undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual(["parse", "format", "content", "compacted"].map((name) => typeof hooks[name]), ["function", "function", "function", "function"]);
  // [OpenCode hook, devtwin hook event, tools]. The prompt hook sends session-start once and user-prompt every time.
  assert.deepEqual(hooks.events, [["prompt", "session-start", null], ["prompt", "user-prompt", null], ["execute.before", "pre-tool", "shell"], ["execute.after", "post-tool", "shell|read|edit|write|patch|grep|glob"],
    ["compaction", "pre-compact", null], ["experimental.idle", "stop", null]]);
  // No code reads that table: the plugin text is the mapping that runs. Each hook name and each event name in the
  // table is a string literal of that text, so the two cannot drift apart.
  const generated = hooks.content({ kitRoot: "/opt/example-kit", pilotPath: "/x/live.json", nodePath: "/opt/example/bin/node" });
  for (const [hook, event] of hooks.events) for (const name of [hook, event]) assert.ok(generated.includes(JSON.stringify(name)), name);
  // parse reads the tool names of both OpenCode lines; the plugin itself runs on the 2.x names only.
  assert.deepEqual(hooks.tools, { shell: ["shell", "bash"], read: ["read"], edit: ["edit", "write", "patch", "apply_patch"], search: ["grep", "glob"] });
  assert.deepEqual(EVENTS.map((event) => hooks.compacted(event, { source: "compact" })), [false, false, false, false, true, false]);
  assert.deepEqual(support("opencode"), { agent: "opencode", name: "OpenCode", supportLevel: "full", capabilities: { skills: true, instructions: true, sessionStartContext: true, preToolContext: false, ownerBlock: true, stopHook: true } });
  assert.ok(Object.isFrozen(a.capabilities) && Object.isFrozen(hooks.events) && Object.isFrozen(hooks.tools));
  // The hook installer plans the plugin file as one whole file with one pseudo-event, where the path is an approved
  // hook target (test/opencode-plugin-install.test.mjs). An uninstall with no file has nothing to remove.
  const p = await makePilot(t), agentHome = p.agentHomes[0], file = join(agentHome, ".config/opencode/plugins/devtwin.js");
  await mkdir(join(agentHome, ".config/opencode/plugins"), { recursive: true });
  const pilot = await loadPilot(await p.with({ writeClasses: { hookTargets: [file] } }), { home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {} });
  for (const [mode, status] of [["uninstall", "absent"], ["install", "create"]]) {
    const input = { targetHome: agentHome, agents: ["opencode"], mode, kitRoot: KIT }, plan = await planHooks(pilot, input);
    assert.deepEqual(plan.actions.map((a) => [a.agent, a.path, a.status, a.events]), [["opencode", file, status, [{ event: "file", status: "missing" }]]], mode);
    const result = await applyHooks(rootsFromPilot(pilot), pilot, input, { fingerprint: plan.fingerprint, runId: "run_ochook0" + (mode === "install" ? 1 : 2), now: now() });
    assert.deepEqual([result.applied, result.runId], mode === "install" ? [true, "run_ochook01"] : [false, null], mode);
  }
  assert.equal(await readFile(file, "utf8"), hooks.content(hookContext(pilot, KIT)));
});

test("opencode parse reads the plugin payload for every event, accepts both tool name sets and never throws", () => {
  const { parse } = adapter("opencode").hooks;
  // The same keys, in the same order, as the other adapters give.
  assert.deepEqual(Object.keys(parse(base("Stop"))), KEYS);
  assert.deepEqual(Object.keys(adapter("gemini").hooks.parse({})), KEYS);
  // Every event arrives under devtwin's internal name, so no name is mapped.
  for (const event of EVENTS) assert.deepEqual(parse(base(event)), { ...NONE, event, sessionId: SESSION, cwd: WS }, event);
  assert.deepEqual(parse(base("UserPromptSubmit", { prompt: "fix the migrations" })), { ...NONE, event: "UserPromptSubmit", sessionId: SESSION, cwd: WS, prompt: "fix the migrations" });
  assert.equal(parse(base("SessionStart", { source: "startup" })).source, "startup");
  // An event devtwin has no name for stays as sent, so it never matches a hook event.
  for (const name of ["prompt", "execute.before", "BeforeTool", "SessionEnd", "constructor", "__proto__"]) assert.equal(parse(base(name)).event, name);
  // The shell tool is "shell" on OpenCode 2.x and "bash" on 1.x. A relative path stays as sent: the hook runtime
  // resolves it against the canonical session folder (toRepoRelative in src/hooks/paths.mjs).
  for (const name of ["shell", "bash"]) {
    assert.deepEqual(parse(call("PreToolUse", name, { command: "npm test -- db/seed.sql", workdir: "db", timeout: 5000 })),
      { ...NONE, event: "PreToolUse", sessionId: SESSION, cwd: WS, toolName: name, toolKind: "shell", command: "npm test -- db/seed.sql", paths: ["db/seed.sql"] }, name);
    assert.deepEqual(parse(call("PostToolUse", name, { command: "npm run seed" })), { ...NONE, event: "PostToolUse", sessionId: SESSION, cwd: WS, toolName: name, toolKind: "shell", command: "npm run seed" }, name);
  }
  // The file tools name the file under "path" on 2.x and "filePath" on 1.x.
  const row = (n) => [n.toolName, n.toolKind, n.command, n.paths, n.edit];
  for (const [name, kind, edit] of [["read", "read", false], ["edit", "edit", true], ["write", "edit", true], ["grep", "search", false], ["glob", "search", false]]) for (const key of ["path", "filePath"]) {
    assert.deepEqual(row(parse(call("PostToolUse", name, { [key]: "db/x.sql", content: "x", pattern: "users" }))), [name, kind, undefined, ["db/x.sql"], edit], name + " " + key);
    assert.deepEqual(row(parse(call("PreToolUse", name, { [key]: "/w/other/x.sql" }))), [name, kind, undefined, ["/w/other/x.sql"], edit], name + " " + key);
  }
  assert.deepEqual(parse(call("PostToolUse", "read", { path: "a.txt", filePath: "b.txt" })).paths, ["a.txt"]);
  assert.deepEqual(parse(call("PostToolUse", "read", { path: 7, filePath: "b.txt" })).paths, ["b.txt"]);
  assert.deepEqual([parse(call("PostToolUse", "read", { path: "../other/a.txt" })).paths, parse(call("PostToolUse", "read", { path: "./db/../a.txt" })).paths], [["../other/a.txt"], ["./db/../a.txt"]]);
  // grep and glob search the session folder when they name no path: there is no file to match.
  for (const name of ["grep", "glob"]) assert.deepEqual(row(parse(call("PostToolUse", name, { pattern: "**/*.sql", include: "*.sql" }))), [name, "search", undefined, [], false], name);
  // A patch names its files in "*** Update File:" lines, as a Codex apply_patch does.
  for (const name of ["patch", "apply_patch"]) {
    assert.deepEqual(row(parse(call("PostToolUse", name, { patchText: PATCH }))), [name, "edit", undefined, ["db/a.sql", "/w/example/src/new.ts", "old.txt", "lib/from.js", "lib/to.js"], true], name);
    assert.deepEqual(row(parse(call("PostToolUse", name, { patchText: "no header lines" }))), [name, "edit", undefined, [], true], name);
  }
  assert.deepEqual(parse(call("PostToolUse", "read", { patchText: PATCH })).paths, [], "only a patch tool reads patchText");
  // A cwd that is not an absolute path is not passed on. The path stays as sent there too.
  for (const cwd of [undefined, "relative/dir", "", 7, [WS], "/" + "a".repeat(4096)]) {
    const n = parse({ ...call("PostToolUse", "edit", { path: "db/x.sql" }), cwd });
    assert.deepEqual([n.cwd, n.paths, n.edit], [undefined, ["db/x.sql"], true], String(cwd));
  }
  // OpenCode also takes "~/" paths. parse does not know the home folder, so such a path is left out, never guessed.
  assert.deepEqual([parse(call("PostToolUse", "edit", { path: "~/notes/a.md" })).paths, parse(call("PostToolUse", "edit", { path: "~" })).paths, parse(call("PostToolUse", "edit", { path: "~x/a.md" })).paths], [[], [], ["~x/a.md"]]);
  // A path longer than 4096 characters is dropped, also in a patch and in a command.
  assert.deepEqual(parse(call("PostToolUse", "read", { path: "/" + "a".repeat(4096) })).paths, []);
  assert.deepEqual(parse(call("PostToolUse", "patch", { patchText: "*** Update File: " + "a".repeat(4097) + "\n*** Update File: db/a.sql" })).paths, ["db/a.sql"]);
  assert.deepEqual(parse(call("PreToolUse", "shell", { command: "cat " + "a".repeat(4097) + "/x.sql db/seed.sql" })).paths, ["db/seed.sql"]);
  assert.deepEqual(parse(call("PostToolUse", "read", { path: "", filePath: "" })).paths, []);
  // Each tool name is checked exactly. The names of the other agents keep their meaning in their own adapters only.
  for (const name of ["Shell", "shell ", "shell2", "Bash", "run_shell_command", "run_command", "Read", "apply-patch", "subagent", "constructor", "__proto__", "toString"]) {
    const n = parse(call("PreToolUse", name, { command: OWNER_COMMAND, path: "a.txt", patchText: PATCH }));
    assert.deepEqual([n.toolKind, n.command, n.paths, n.edit], [null, undefined, [], false], name);
    assert.equal(ownerAction("opencode", call("PreToolUse", name, { command: OWNER_COMMAND })), null, name);
  }
  assert.equal(adapter("gemini").hooks.parse({ hook_event_name: "BeforeTool", tool_name: "shell", tool_input: { command: "ls" } }).toolKind, null);
  // The owner-action block reads the command of both shell names, and of no other tool.
  for (const name of ["shell", "bash"]) {
    assert.equal(ownerAction("opencode", call("PreToolUse", name, { command: OWNER_COMMAND })), "live set-kit --apply", name);
    assert.equal(ownerAction("opencode", call("PreToolUse", name, { command: OWNER_COMMAND.replace(" --apply", "") })), null, name);
  }
  assert.equal(ownerAction("opencode", call("PreToolUse", "write", { path: "x.sh", content: OWNER_COMMAND })), null);
  // parse is total: any JSON value, and any value in any field, gives the same shape.
  const odd = [null, undefined, "text", 7, true, [], [null], {}, { tool_name: null }, { tool_name: ["shell"] }, { tool_name: "shell" }, { tool_name: "shell", tool_input: null }, { tool_name: "shell", tool_input: "ls" },
    { tool_name: "shell", tool_input: ["ls"] }, { tool_name: "shell", tool_input: { command: { text: "ls" } } }, { tool_name: "shell", tool_input: { command: ["ls", "db/seed.sql"] } }, { tool_name: "bash", tool_input: { command: null } },
    { tool_name: "read", tool_input: { path: { path: "a" } } }, { tool_name: "read", tool_input: { path: ["a"], filePath: 7 } }, { tool_name: "patch", tool_input: { patchText: ["*** Update File: a"] } },
    { tool_name: "patch", tool_input: { patchText: null } }, { tool_name: "apply_patch", tool_input: { patchText: { text: PATCH } } }, { tool_name: "grep", tool_input: { path: "" } }, { tool_name: "glob", tool_input: [] },
    { hook_event_name: 7, session_id: { id: 1 }, cwd: [WS], prompt: 7 }, [{ tool_name: "shell", tool_input: { command: OWNER_COMMAND } }]];
  for (const payload of odd) {
    let n;
    assert.doesNotThrow(() => { n = parse(payload); }, JSON.stringify(payload));
    assert.deepEqual(Object.keys(n), KEYS, JSON.stringify(payload));
    assert.ok(Array.isArray(n.paths) && n.paths.length === 0 && n.cwd === undefined && n.command === undefined && n.edit === (n.toolKind === "edit"), JSON.stringify(payload));
    assert.equal(ownerAction("opencode", payload), null, JSON.stringify(payload));
  }
});

test("opencode format prints a deny and a context reply, and nothing else", async (t) => {
  const hooks = adapter("opencode").hooks, { format } = hooks;
  assert.deepEqual(format({ kind: "deny", reason: DENY_REASON }), { stdout: { decision: "deny", reason: DENY_REASON }, exitCode: 0 });
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse"]) assert.deepEqual(format({ kind: "context", event, text: "line one\nline two" }), { stdout: { context: "line one\nline two" }, exitCode: 0 }, event);
  // There is no neutral reply and no held lesson: with nothing to say the hook prints nothing, and the plugin reads
  // empty output as "nothing to say".
  assert.deepEqual([hooks.neutral, hooks.deferToolContext], [undefined, undefined]);
  // Through the real hook entry point, in process and from the bin script.
  const p = await makePilot(t);
  const hook = async (event, body) => {
    const chunks = [];
    assert.equal(await main(["hook", "--event", event, "--agent", "opencode", "--pilot", p.path], { stdout: { write: (v) => { chunks.push(v); return true; } }, stdin: typeof body === "string" ? body : JSON.stringify(body), now }), 0);
    return chunks.join("");
  };
  for (const name of ["shell", "bash"]) {
    const payload = { ...call("PreToolUse", name, { command: OWNER_COMMAND }), cwd: p.reposDir };
    assert.equal(await hook("pre-tool", payload), JSON.stringify({ decision: "deny", reason: DENY_REASON }) + "\n", name);
    const run = spawnSync(process.execPath, [BIN, "hook", "--event", "pre-tool", "--agent", "opencode", "--pilot", p.path], { input: JSON.stringify(payload), env: { PATH: process.env.PATH, HOME: p.fakeHome }, encoding: "utf8" });
    assert.deepEqual([run.status, JSON.parse(run.stdout)], [0, { decision: "deny", reason: DENY_REASON }], name);
  }
  // The deny needs no cwd: the block runs before the lesson path reads it.
  assert.equal(await hook("pre-tool", { hook_event_name: "PreToolUse", session_id: SESSION, tool_name: "shell", tool_input: { command: OWNER_COMMAND } }), JSON.stringify({ decision: "deny", reason: DENY_REASON }) + "\n");
  // A context reply is one object with the one key. This pilot has no kit receipt, so session start says so.
  const start = JSON.parse(await hook("session-start", { ...base("SessionStart"), cwd: p.reposDir }));
  assert.deepEqual(Object.keys(start), ["context"]);
  assert.match(start.context, /^devtwin hook: kit not verified/);
  // Nothing else is printed: a preview, another tool, a payload for another event, an ordinary command, a lifecycle
  // event with nothing to say and input that is not JSON all give empty output.
  const shell = (command) => ({ ...call("PreToolUse", "shell", { command }), cwd: p.reposDir });
  for (const [event, body] of [["pre-tool", shell(OWNER_COMMAND.replace(" --apply", ""))], ["pre-tool", { ...call("PreToolUse", "write", { path: "x.sh", content: OWNER_COMMAND }), cwd: p.reposDir }],
    ["pre-tool", { ...shell(OWNER_COMMAND), hook_event_name: "PostToolUse" }], ["pre-tool", shell("npm test")], ["post-tool", { ...call("PostToolUse", "shell", { command: OWNER_COMMAND }), cwd: p.reposDir }],
    ["post-tool", { ...call("PostToolUse", "edit", { path: "db/x.sql" }), cwd: p.reposDir }], ["user-prompt", { ...base("UserPromptSubmit", { prompt: "fix the migrations" }), cwd: p.reposDir }],
    ["pre-compact", { ...base("PreCompact"), cwd: p.reposDir }], ["stop", { ...base("Stop"), cwd: p.reposDir }], ["pre-tool", "not json"], ["post-tool", ""]]) {
    assert.equal(await hook(event, body), "", event + " " + JSON.stringify(body).slice(0, 120));
  }
});

test("opencode detect reads OPENCODE, and the other agents' shells keep their actor", () => {
  const { detect } = adapter("opencode");
  // What a real OpenCode 2.3.0 tool shell sets.
  const shell = { OPENCODE: "1", OPENCODE_SESSION_ID: SESSION, OPENCODE_TERMINAL: "1", AGENT: "1", AI_AGENT: "opencode" };
  assert.deepEqual([detect({ OPENCODE: "1" }), detect(shell)], [true, true]);
  // Only OPENCODE counts. The session ID is set together with it, and the other variables can be set in any shell.
  assert.deepEqual([detect({}), detect({ OPENCODE: "" }), detect({ OPENCODE_SESSION_ID: SESSION }), detect({ OPENCODE_CONFIG_DIR: "/h/example/oc" }), detect({ OPENCODE_TERMINAL: "1" }), detect({ AGENT: "1", AI_AGENT: "opencode" }),
    detect({ GEMINI_CLI: "1" }), detect({ CLAUDECODE: "1" })], [false, false, false, false, false, false, false, false]);
  assert.deepEqual([actorOf(shell), actorOf({ OPENCODE: "1" }), callerActor(shell)], ["opencode", "opencode", "opencode"]);
  // An OpenCode shell is no other agent's shell: OPENCODE_SESSION_ID does not start with CODEX_.
  for (const id of ["claude", "codex", "gemini", "antigravity"]) assert.equal(adapter(id).detect(shell), false, id);
  // The other agents' shells keep their actor, and a human shell stays human.
  assert.deepEqual([actorOf({ CLAUDECODE: "1" }), actorOf({ CODEX_SANDBOX: "x" }), actorOf({ GEMINI_CLI: "1" }), actorOf({ ANTIGRAVITY_AGENT: "1" }), actorOf({ OPENCODE_CONFIG_DIR: "/h/example/oc" }), actorOf({})],
    ["claude", "codex", "gemini", "antigravity", "human", "human"]);
  // Registry order decides when a shell shows more than one agent: OpenCode is last, so every earlier adapter wins.
  assert.deepEqual([actorOf({ ...shell, CLAUDECODE: "1" }), actorOf({ ...shell, CODEX_THREAD_ID: "x" }), actorOf({ ...shell, GEMINI_CLI: "1" }), actorOf({ ...shell, ANTIGRAVITY_CONVERSATION_ID: "c" })], ["claude", "codex", "gemini", "antigravity"]);
});

// A stand-in for <kit>/bin/devtwin.mjs. It appends its arguments, its stdin and its process to <kit>/calls.jsonl, then
// follows <kit>/replies.json: { "<hook event>" | "*": { stdout?, exit?, signal?, hang? } }. hang is how long the
// process stays alive, in milliseconds, before it exits with code 0.
const STUB = [
  'import { readFileSync, appendFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'const dir = join(import.meta.dirname, "..");',
  'let input = "";',
  'process.stdin.setEncoding("utf8");',
  "for await (const chunk of process.stdin) input += chunk;",
  'const args = process.argv.slice(2), event = args[args.indexOf("--event") + 1];',
  'appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ script: process.argv[1], args, input, node: process.execPath, pid: process.pid }) + "\\n");',
  "let plan = {};",
  'try { const all = JSON.parse(readFileSync(join(dir, "replies.json"), "utf8")); plan = all[event] ?? all["*"] ?? {}; } catch { plan = {}; }',
  "if (plan.stdout) process.stdout.write(plan.stdout);",
  "if (plan.hang) setTimeout(() => null, plan.hang);",
  'else if (plan.signal) process.stdout.write("", () => process.kill(process.pid, plan.signal));',
  "else process.exitCode = plan.exit ?? 0;",
  ""
].join("\n");
// Replaces the one occurrence of a token in the generated text, and fails when the text does not hold it exactly once.
function swap(text, from, to) {
  assert.equal(text.split(from).length - 1, 1, "the plugin text holds " + from + " once");
  return text.split(from).join(to);
}
// A fake OpenCode plugin context: it records each hook that setup registers, and the group it was registered on.
function fakeCtx(directory, { unknown = [], location = true } = {}) {
  const hooks = {}, groups = {};
  const group = (label) => ({ hook: async (name, fn) => { if (unknown.includes(name)) throw new Error("unknown hook " + name); hooks[name] = fn; groups[name] = label; } });
  return { ctx: { ...(location ? { location: { directory } } : {}), tool: group("tool"), session: group("session") }, hooks, groups };
}
// Writes the generated plugin into a disposable config folder as OpenCode holds it, <config>/plugins/, and imports it.
// The kit is a folder with the stub above, unless the test names a real kit. patch edits the text before the import.
async function loadPlugin(t, { patch = (text) => text, kitName = "kit", pilotName = "pilot.json", stub = true, context = {}, ctxOptions } = {}) {
  const sb = await sandbox(t), config = join(sb, "config"), kit = context.kitRoot ?? join(sb, kitName), pilotPath = context.pilotPath ?? join(sb, pilotName), ws = join(sb, "ws");
  await mkdir(join(config, "plugins"), { recursive: true });
  await mkdir(ws);
  if (!context.kitRoot) { await mkdir(join(kit, "bin"), { recursive: true }); if (stub) await writeFile(join(kit, "bin/devtwin.mjs"), STUB); }
  const text = adapter("opencode").hooks.content({ kitRoot: kit, pilotPath, nodePath: process.execPath, ...context }), file = join(config, "plugins/devtwin.mjs");
  await writeFile(file, patch(text));
  const mod = await import(pathToFileURL(file).href), plugin = mod.default, fake = fakeCtx(ws, ctxOptions);
  assert.equal(await plugin.setup(fake.ctx), undefined);
  const log = join(kit, "calls.jsonl");
  // The recorded calls since the last take, oldest first.
  const take = async (keys = ["script", "args", "input"]) => {
    let lines = [];
    try { lines = (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await rm(log, { force: true });
    return lines.map((line) => Object.fromEntries(keys.map((key) => [key, line[key]])));
  };
  const reply = (plans) => writeFile(join(kit, "replies.json"), JSON.stringify(plans));
  // What one hook run must have recorded: the script, the exact arguments and the exact stdin text.
  const sent = (event, payload) => ({ script: join(kit, "bin/devtwin.mjs"), args: ["hook", "--event", event, "--agent", "opencode", "--pilot", pilotPath], input: JSON.stringify(payload) });
  const body = (name, session = SESSION) => ({ hook_event_name: name, session_id: session, cwd: ws });
  return { sb, config, kit, pilotPath, ws, text, mod, plugin, ...fake, take, reply, sent, body };
}
const said = (value) => ({ stdout: JSON.stringify(value) + "\n" });
// The events as OpenCode 2.3.0 sends them to a plugin hook.
const toolEvent = (tool, input, extra = {}) => ({ tool, sessionID: SESSION, agent: "build", messageID: "msg_example0001", id: "call_example0001", input, ...extra });
const done = (tool, input, result) => toolEvent(tool, input, { status: "completed", result });
const promptEvent = (text, session = SESSION) => ({ sessionID: session, messageID: "msg_example0001", prompt: { text }, metadata: {}, delivery: "immediate" });

test("the generated OpenCode plugin is valid ESM that imports only node:child_process and node:fs and embeds its paths as JSON strings", async (t) => {
  const { content } = adapter("opencode").hooks;
  const plain = { kitRoot: "/opt/example-kit", pilotPath: "/x/live.json", nodePath: "/opt/example/bin/node" }, text = content(plain);
  // The first line says who wrote the file and what rewrites it.
  const first = text.split("\n")[0];
  assert.ok(first.startsWith("// devtwin wrote this file.") && first.includes("agents install --hooks") && text.endsWith("\n"), first);
  // The import list, read from the text: two static imports, and no other way to load code.
  assert.deepEqual([...text.matchAll(/^\s*import\b[^\n]*?["']([^"'\n]+)["'];?\s*$/gm)].map((m) => m[1]).sort(), ["node:child_process", "node:fs"]);
  assert.deepEqual(text.split("\n").filter((line) => /^\s*(import|export)\b/.test(line)), ['import { spawn } from "node:child_process";', 'import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";', "export default { id: \"devtwin\", setup, server };"]);
  for (const banned of [/\bimport\s*\(/, /\brequire\s*\(/, /\beval\s*\(/, /\bFunction\s*\(/, /\bexec(?:Sync|File|FileSync)?\s*\(/, /shell\s*:/, /process\.env/]) assert.doesNotMatch(text, banned);
  // Each path is one JSON string, once. The limits the plan names are in the text as plain numbers.
  for (const [name, value] of [["NODE", plain.nodePath], ["KIT", plain.kitRoot], ["PILOT", plain.pilotPath]]) assert.equal(text.split(name + " = " + JSON.stringify(value)).length - 1, 1, name);
  for (const constant of ["TIMEOUT_MS = 10000", "MAX_OUTPUT = 262144", "REREAD_MS = 1000", "MAX_SESSIONS = 4096"]) assert.equal(text.split(constant).length - 1, 1, constant);
  assert.equal(text.split("Date.now()").length - 1, 1);
  // The same context gives the same bytes.
  assert.equal(content({ ...plain }), text);
  // A path that is not a non-empty string gives no plugin. The Node path has no default: only the hook context names
  // it, so the running Node is never baked in by chance.
  for (const bad of [{ ...plain, kitRoot: undefined }, { ...plain, pilotPath: 7 }, { ...plain, nodePath: "" }, { ...plain, kitRoot: null }, { kitRoot: plain.kitRoot, pilotPath: plain.pilotPath }, undefined]) assert.throws(() => content(bad), (e) => e.code === "DEVTWIN_INVALID_INPUT" && e.details.field === "hookContext");
  // A quote, a backslash, a newline, a dollar sign and a backtick in a path do not change the program: the text is
  // the plain text with the three strings replaced, and the module loads and names the exact paths.
  const odd = "\"i't\\x\n$HOME`id`${0}\";globalThis.devtwinEscaped=1;\"";
  const paths = { kitRoot: "/opt/example-kit" + odd, pilotPath: "/x/live" + odd + ".json", nodePath: "/opt/example/bin/node" + odd }, oddText = content(paths);
  let same = oddText;
  for (const key of ["kitRoot", "pilotPath", "nodePath"]) same = swap(same, JSON.stringify(paths[key]), JSON.stringify(plain[key]));
  assert.equal(same, text);
  assert.equal(oddText.split("\n").length, text.split("\n").length);
  // The kit folder of the loaded plugin has every such character but the backslash: Node itself runs no module
  // whose path has one. The pilot path and the Node path have all five.
  const h = await loadPlugin(t, { kitName: "kit" + odd.replace("\\", ""), pilotName: "pilot" + odd + ".json", context: { nodePath: paths.nodePath } });
  const oddFile = join(h.config, "plugins/devtwin-odd.mjs");
  await writeFile(oddFile, oddText);
  assert.deepEqual(Object.keys((await import(pathToFileURL(oddFile).href)).default), ["id", "setup", "server"]);
  assert.equal(globalThis.devtwinEscaped, undefined);
  // The module has the one default export OpenCode reads, and a hook run reaches the stub in the oddly named kit.
  assert.deepEqual([Object.keys(h.mod), Object.keys(h.plugin), h.plugin.id, typeof h.plugin.setup, typeof h.plugin.server], [["default"], ["id", "setup", "server"], "devtwin", "function", "function"]);
  await h.hooks.compaction({ sessionID: SESSION });
  assert.deepEqual(await h.take(), [h.sent("pre-compact", h.body("PreCompact"))]);
  // The real file name, devtwin.js, loads as ESM too.
  const js = join(h.config, "plugins/devtwin.js");
  await writeFile(js, h.text);
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", "const m = await import(process.argv[1]); process.stdout.write(JSON.stringify([m.default.id, await m.default.server()]));", pathToFileURL(js).href], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.deepEqual([run.status, run.stdout], [0, '["devtwin",{}]'], run.stderr);
});

test("the OpenCode plugin sends each event to the hook command and applies the reply", async (t) => {
  const h = await loadPlugin(t), { hooks, sent, body } = h;
  assert.deepEqual(h.groups, { "execute.before": "tool", "execute.after": "tool", prompt: "session", context: "session", compaction: "session", "experimental.idle": "session" });
  // execute.before: a shell call sends a pre-tool payload with the one input field devtwin reads. A deny reply
  // throws an Error with the reason, which blocks the tool and is what the model reads.
  await h.reply({ "pre-tool": said({ decision: "deny", reason: DENY_REASON }) });
  const seed = toolEvent("shell", { command: "npm run seed", workdir: "db", timeout: 5000, background: false });
  await assert.rejects(hooks["execute.before"](seed), (e) => e instanceof Error && e.message === DENY_REASON);
  assert.deepEqual(await h.take(), [sent("pre-tool", { ...body("PreToolUse"), tool_name: "shell", tool_input: { command: "npm run seed" } })]);
  // A deny with no usable reason still blocks, with a fixed reason.
  for (const value of [{ decision: "deny" }, { decision: "deny", reason: 7 }, { decision: "deny", reason: "" }]) {
    await h.reply({ "pre-tool": said(value) });
    await assert.rejects(hooks["execute.before"](seed), (e) => e instanceof Error && e.message === "devtwin blocked this command.", JSON.stringify(value));
  }
  // Any other reply lets the command run. A pre-tool reply is never context.
  for (const value of [{}, { context: "LESSON" }, { decision: "allow", reason: "x" }, { decision: "ask" }, { decision: "DENY", reason: "x" }, { decision: ["deny"] }]) {
    await h.reply({ "pre-tool": said(value) });
    assert.equal(await hooks["execute.before"](seed), undefined, JSON.stringify(value));
  }
  assert.equal((await h.take()).length, 9);
  // Only the shell tool is sent before it runs: every other tool does nothing, also with a deny waiting.
  await h.reply({ "*": said({ decision: "deny", reason: DENY_REASON, context: "LESSON" }) });
  for (const tool of ["read", "edit", "write", "patch", "grep", "glob", "bash", "subagent", undefined]) assert.equal(await hooks["execute.before"](toolEvent(tool, { command: OWNER_COMMAND, path: "a.txt" })), undefined, String(tool));
  assert.deepEqual(await h.take(), []);

  // execute.after: each of the seven tools sends a post-tool payload when it completed, and the reply text becomes one
  // more text part of a new result object. That part starts with the marker line, so the model can tell the text from
  // the output of the tool. The plugin text holds the marker as one string, once.
  assert.equal(h.text.split(JSON.stringify(MARK)).length - 1, 1);
  assert.equal(h.text.split("devtwin hook note").length - 1, 1);
  await h.reply({ "post-tool": said({ context: "LESSON" }) });
  for (const [tool, input, picked] of [["shell", { command: "npm run seed", timeout: 5000 }, { command: "npm run seed" }], ["read", { path: "notes.txt", offset: 1, limit: 20 }, { path: "notes.txt" }],
    ["edit", { path: "notes.txt", oldString: "hello", newString: "hi" }, { path: "notes.txt" }], ["write", { path: "a.txt", content: "the file body" }, { path: "a.txt" }], ["patch", { patchText: PATCH }, { patchText: PATCH_HEADERS }],
    ["grep", { pattern: "users", path: "db", include: "*.sql" }, { path: "db" }], ["glob", { pattern: "**/*.sql" }, {}], ["read", { filePath: "notes.txt", path: 7 }, { filePath: "notes.txt" }]]) {
    const part = { type: "text", text: "tool output" }, result = { output: "tool output", content: [part], metadata: { truncated: false } }, event = done(tool, input, result);
    assert.equal(await hooks["execute.after"](event), undefined, tool);
    assert.deepEqual(event.result, { output: "tool output", content: [part, { type: "text", text: MARK + "\nLESSON" }], metadata: { truncated: false } }, tool);
    assert.ok(event.result !== result && result.content.length === 1, tool + ": the earlier result object is replaced, not changed");
    assert.deepEqual(await h.take(), [sent("post-tool", { ...body("PostToolUse"), tool_name: tool, tool_input: picked })], tool);
  }
  // Of a patch only the header lines leave OpenCode: the lines that start with "*** ". The added and removed lines stay
  // there, also a content line that holds a header text after its "+". The hook reads the same paths from the header
  // lines as from the whole patch.
  const whole = "*** Begin Patch\n*** Add File: src/new.ts\n+export const SECRET_BODY = 1;\n+*** Update File: src/not-a-file.ts\n*** Update File: lib/from.js\n*** Move to: lib/to.js\n@@ context\n-old SECRET_BODY\n+new SECRET_BODY\n"
    + " *** Delete File: src/not-a-header.ts\n*** Delete File: db/old.sql\r\n*** End Patch\n";
  const headersOnly = "*** Begin Patch\n*** Add File: src/new.ts\n*** Update File: lib/from.js\n*** Move to: lib/to.js\n*** Delete File: db/old.sql\r\n*** End Patch";
  await hooks["execute.after"](done("patch", { patchText: whole }, { content: [] }));
  const [patched] = await h.take();
  assert.deepEqual(patched, sent("post-tool", { ...body("PostToolUse"), tool_name: "patch", tool_input: { patchText: headersOnly } }));
  assert.ok(!patched.input.includes("SECRET_BODY") && !patched.input.includes("not-a-file") && !patched.input.includes("not-a-header"), patched.input);
  assert.deepEqual([patchPaths(headersOnly), patchPaths(whole)], [["src/new.ts", "lib/from.js", "lib/to.js", "db/old.sql"], ["src/new.ts", "lib/from.js", "lib/to.js", "db/old.sql"]]);
  assert.deepEqual(adapter("opencode").hooks.parse(JSON.parse(patched.input)).paths, adapter("opencode").hooks.parse({ ...JSON.parse(patched.input), tool_input: { patchText: whole } }).paths);
  assert.deepEqual([patchPaths(PATCH_HEADERS), PATCH_HEADERS.includes("@@"), PATCH_HEADERS.includes("+x")], [patchPaths(PATCH), false, false]);
  // A patch with no header line sends an empty text, and the other three fields are sent whole.
  await hooks["execute.after"](done("patch", { patchText: "+a\n-b\n" }, { content: [] }));
  await hooks["execute.after"](done("shell", { command: "printf '*** x\\n+y\\n'" }, { content: [] }));
  assert.deepEqual((await h.take(["input"])).map((row) => JSON.parse(row.input).tool_input), [{ patchText: "" }, { command: "printf '*** x\\n+y\\n'" }]);
  // Content that is one string becomes two text parts.
  const text = done("read", { path: "notes.txt" }, { content: "tool output" });
  await hooks["execute.after"](text);
  assert.deepEqual(text.result, { content: [{ type: "text", text: "tool output" }, { type: "text", text: MARK + "\nLESSON" }] });
  assert.equal((await h.take()).length, 1);
  // A tool that failed, a tool devtwin does not read and a status that is not "completed" send nothing and change nothing.
  for (const event of [toolEvent("shell", { command: "npm run seed" }, { status: "error", error: { message: "exit 1" } }), done("subagent", { prompt: "go" }, { content: [] }), done("bash", { command: "ls" }, { content: [] }),
    done("websearch", { query: "x" }, { content: [] }), toolEvent("read", { path: "a.txt" }, { result: { content: [] } }), toolEvent("read", { path: "a.txt" }, { status: "running", result: { content: [] } })]) {
    const before = JSON.stringify(event), result = event.result;
    assert.equal(await hooks["execute.after"](event), undefined);
    assert.ok(JSON.stringify(event) === before && event.result === result, before);
  }
  assert.deepEqual(await h.take(), []);
  // With nothing to say, or a deny where context belongs, the result object stays the one OpenCode gave.
  for (const value of [null, {}, { context: "" }, { context: 7 }, { decision: "deny", reason: DENY_REASON }]) {
    await h.reply({ "post-tool": value === null ? {} : said(value) });
    const result = { content: [{ type: "text", text: "tool output" }] }, event = done("edit", { path: "a.txt" }, result);
    await hooks["execute.after"](event);
    assert.ok(event.result === result && result.content.length === 1, JSON.stringify(value));
  }
  assert.equal((await h.take()).length, 5);

  // prompt: session-start once for each session ID, then user-prompt every time. The reply text is appended.
  await h.reply({ "session-start": said({ context: "START" }), "user-prompt": said({ context: "LESSON" }) });
  const one = promptEvent("fix the migrations");
  assert.equal(await hooks.prompt(one), undefined);
  assert.equal(one.prompt.text, "fix the migrations\n\nSTART\n\nLESSON");
  assert.deepEqual(await h.take(), [sent("session-start", body("SessionStart")), sent("user-prompt", { ...body("UserPromptSubmit"), prompt: "fix the migrations" })]);
  const two = promptEvent("and the seeds");
  await hooks.prompt(two);
  assert.equal(two.prompt.text, "and the seeds\n\nLESSON");
  assert.deepEqual(await h.take(), [sent("user-prompt", { ...body("UserPromptSubmit"), prompt: "and the seeds" })]);
  // Another session starts once too. With nothing to say the prompt keeps its bytes.
  await h.reply({});
  const other = promptEvent("hello", "ses_other0001"), again = promptEvent("hello again", "ses_other0001");
  await hooks.prompt(other);
  await hooks.prompt(again);
  assert.deepEqual([other.prompt.text, again.prompt.text], ["hello", "hello again"]);
  assert.deepEqual(await h.take(), [sent("session-start", body("SessionStart", "ses_other0001")), sent("user-prompt", { ...body("UserPromptSubmit", "ses_other0001"), prompt: "hello" }),
    sent("user-prompt", { ...body("UserPromptSubmit", "ses_other0001"), prompt: "hello again" })]);
  // Only one of the two has text: no empty paragraph is added.
  await h.reply({ "session-start": said({ context: "START" }) });
  const third = promptEvent("go", "ses_third0001");
  await hooks.prompt(third);
  assert.equal(third.prompt.text, "go\n\nSTART");
  assert.equal((await h.take()).length, 2);
  // A first prompt with no text, such as one with an attachment only, sends user-prompt alone: the session-start line
  // has no text to ride on, so it waits for the next prompt that has text.
  await h.reply({ "session-start": said({ context: "START" }), "user-prompt": said({ context: "LESSON" }) });
  for (const [label, empty] of [["no prompt", { sessionID: "ses_notext0001", messageID: "msg_example0001" }], ["no text", { ...promptEvent(undefined, "ses_notext0001"), prompt: { parts: [] } }], ["text 7", { ...promptEvent(7, "ses_notext0001") }]]) {
    const before = JSON.stringify(empty);
    assert.equal(await hooks.prompt(empty), undefined, label);
    assert.equal(JSON.stringify(empty), before, label);
    assert.deepEqual(await h.take(), [sent("user-prompt", body("UserPromptSubmit", "ses_notext0001"))], label);
  }
  const late = promptEvent("now with text", "ses_notext0001"), later = promptEvent("and more", "ses_notext0001");
  await hooks.prompt(late);
  await hooks.prompt(later);
  assert.deepEqual([late.prompt.text, later.prompt.text], ["now with text\n\nSTART\n\nLESSON", "and more\n\nLESSON"]);
  assert.deepEqual(await h.take(), [sent("session-start", body("SessionStart", "ses_notext0001")), sent("user-prompt", { ...body("UserPromptSubmit", "ses_notext0001"), prompt: "now with text" }),
    sent("user-prompt", { ...body("UserPromptSubmit", "ses_notext0001"), prompt: "and more" })]);
  // The marker line belongs to a tool result only: no prompt text has it.
  for (const event of [one, two, other, again, third, late, later]) assert.ok(!event.prompt.text.includes("devtwin hook note"), event.prompt.text);
  // The plugin keeps at most MAX_SESSIONS session IDs and drops the oldest one first. The test loads the same text with
  // that one number set to 2: after A, B and C, A was dropped and gets session-start again, which drops B; C keeps it.
  const few = await loadPlugin(t, { patch: (source) => swap(source, "MAX_SESSIONS = 4096", "MAX_SESSIONS = 2") });
  await few.reply({ "session-start": said({ context: "START" }) });
  const order = [];
  for (const id of ["ses_capa0001", "ses_capb0001", "ses_capc0001", "ses_capa0001", "ses_capc0001", "ses_capb0001"]) {
    const event = promptEvent("go", id);
    await few.hooks.prompt(event);
    order.push([id, event.prompt.text]);
  }
  assert.deepEqual(order, [["ses_capa0001", "go\n\nSTART"], ["ses_capb0001", "go\n\nSTART"], ["ses_capc0001", "go\n\nSTART"], ["ses_capa0001", "go\n\nSTART"], ["ses_capc0001", "go"], ["ses_capb0001", "go\n\nSTART"]]);
  assert.deepEqual((await few.take(["args"])).map((row) => row.args[2]), ["session-start", "user-prompt", "session-start", "user-prompt", "session-start", "user-prompt", "session-start", "user-prompt", "user-prompt", "session-start", "user-prompt"]);

  // compaction and experimental.idle send their events and change nothing.
  await h.reply({ "*": said({ context: "LESSON", decision: "deny", reason: "x" }) });
  const compaction = { sessionID: SESSION, agent: "build", system: [{ type: "text", text: "s" }], messages: [] }, idle = { sessionID: SESSION, background: [] };
  assert.deepEqual([await hooks.compaction(compaction), await hooks["experimental.idle"](idle)], [undefined, undefined]);
  assert.deepEqual([compaction, idle], [{ sessionID: SESSION, agent: "build", system: [{ type: "text", text: "s" }], messages: [] }, { sessionID: SESSION, background: [] }]);
  assert.deepEqual(await h.take(), [sent("pre-compact", body("PreCompact")), sent("stop", body("Stop"))]);
  // After a compaction the next prompt of that session sends session-start again, as Claude Code and Codex get the
  // session-start context again after a compaction. Another session keeps its state.
  await h.reply({ "session-start": said({ context: "START" }), "user-prompt": said({ context: "LESSON" }) });
  const resumed = promptEvent("and the seeds"), next = promptEvent("and the users"), kept = promptEvent("hello", "ses_other0001");
  for (const event of [resumed, next, kept]) await hooks.prompt(event);
  assert.deepEqual([resumed.prompt.text, next.prompt.text, kept.prompt.text], ["and the seeds\n\nSTART\n\nLESSON", "and the users\n\nLESSON", "hello\n\nLESSON"]);
  assert.deepEqual(await h.take(), [sent("session-start", body("SessionStart")), sent("user-prompt", { ...body("UserPromptSubmit"), prompt: "and the seeds" }),
    sent("user-prompt", { ...body("UserPromptSubmit"), prompt: "and the users" }), sent("user-prompt", { ...body("UserPromptSubmit", "ses_other0001"), prompt: "hello" })]);

  // context: the text of <config folder>/devtwin.md becomes one more system part. No hook command runs for it.
  await writeFile(join(h.config, "devtwin.md"), "## devtwin\n\nBLOCK A\n");
  const system = [{ type: "text", text: "existing" }], model = { sessionID: SESSION, system, messages: [] };
  assert.equal(await hooks.context(model), undefined);
  assert.deepEqual(system, [{ type: "text", text: "existing" }, { type: "text", text: "## devtwin\n\nBLOCK A\n" }]);
  assert.ok(system.length === 2 && system.every((part) => !part.text.includes("devtwin hook note")), "the system text has no marker line");
  assert.deepEqual(await h.take(), []);

  // Where PATH has no node, the baked Node path runs the hook.
  await h.reply({});
  const path = process.env.PATH, empty = join(h.sb, "empty-bin");
  await mkdir(empty);
  try {
    process.env.PATH = empty;
    await hooks.compaction({ sessionID: SESSION });
  } finally { process.env.PATH = path; }
  assert.deepEqual(await h.take(["args", "input", "node"]), [{ args: sent("pre-compact", {}).args, input: JSON.stringify(body("PreCompact")), node: process.execPath }]);

  // node on PATH runs first: where PATH has a node and the baked path names another one, only the PATH one runs.
  // Each stand-in is a shell file named node that leaves a mark and then runs the real Node with the same arguments.
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'", shims = join(h.sb, "shims");
  for (const name of ["on-path", "baked"]) {
    await mkdir(join(shims, name), { recursive: true });
    await writeFile(join(shims, name, "node"), "#!/bin/sh\nprintf x >> " + quote(join(shims, name + ".ran")) + "\nexec " + quote(process.execPath) + ' "$@"\n');
    await chmod(join(shims, name, "node"), 0o755);
  }
  const both = await loadPlugin(t, { context: { nodePath: join(shims, "baked/node") } });
  try {
    process.env.PATH = join(shims, "on-path");
    await both.hooks.compaction({ sessionID: SESSION });
  } finally { process.env.PATH = path; }
  assert.deepEqual(await both.take(), [both.sent("pre-compact", both.body("PreCompact"))]);
  assert.equal(await readFile(join(shims, "on-path.ran"), "utf8"), "x");
  await assert.rejects(readFile(join(shims, "baked.ran")), { code: "ENOENT" });

  // The instruction file is read at most once a second, on a clock the test sets in place of Date.now().
  let clock = 0;
  globalThis.devtwinTestClock = () => clock;
  t.after(() => { delete globalThis.devtwinTestClock; });
  const c = await loadPlugin(t, { patch: (source) => swap(source, "Date.now()", "globalThis.devtwinTestClock()") }), file = join(c.config, "devtwin.md");
  const pushed = async (at, start = []) => { clock = at; const list = [...start]; await c.hooks.context({ sessionID: SESSION, system: list }); return list.slice(start.length); };
  // No file: nothing is added, and that answer is kept for one second as well.
  assert.deepEqual(await pushed(5000), []);
  await writeFile(file, "BLOCK A\n");
  assert.deepEqual([await pushed(5999), await pushed(6000)], [[], [{ type: "text", text: "BLOCK A\n" }]]);
  await writeFile(file, "BLOCK B\n");
  assert.deepEqual([await pushed(6001), await pushed(6999), await pushed(7000, [{ type: "text", text: "existing" }])], [[{ type: "text", text: "BLOCK A\n" }], [{ type: "text", text: "BLOCK A\n" }], [{ type: "text", text: "BLOCK B\n" }]]);
  // A removed file, an unreadable one (a folder), a blank one and one that is too large add nothing.
  await rm(file);
  assert.deepEqual(await pushed(8000), []);
  await mkdir(file);
  assert.deepEqual(await pushed(9000), []);
  await rm(file, { recursive: true });
  await writeFile(file, " \n\t\n");
  assert.deepEqual(await pushed(10000), []);
  await writeFile(file, "x".repeat(65537));
  assert.deepEqual(await pushed(11000), []);
  await writeFile(file, "x".repeat(65536));
  assert.equal((await pushed(12000))[0].text.length, 65536);
  // The read follows no link: a link to a file outside the config folder, a link to a file inside it and a FIFO all add
  // nothing, and the FIFO read does not wait for a writer. The cap counts bytes, so 21,846 three-byte characters are
  // over it.
  const outside = join(dirname(c.config), "outside.md");
  await writeFile(outside, "OUTSIDE TEXT\n");
  await rm(file);
  await symlink(outside, file);
  assert.deepEqual(await pushed(13000), []);
  await rm(file);
  await writeFile(join(c.config, "inside.md"), "INSIDE TEXT\n");
  await symlink(join(c.config, "inside.md"), file);
  assert.deepEqual(await pushed(14000), []);
  await rm(file);
  execFileSync("mkfifo", [file]);
  const fifoAt = Date.now();
  assert.deepEqual(await pushed(15000), []);
  assert.ok(Date.now() - fifoAt < 5000, "the FIFO read did not wait");
  await rm(file);
  await writeFile(file, "€".repeat(21846));
  assert.deepEqual(await pushed(16000), []);
  // A clock that went back reads the file again.
  await writeFile(file, "BLOCK C\n");
  assert.deepEqual(await pushed(100), [{ type: "text", text: "BLOCK C\n" }]);
  assert.deepEqual(await c.take(), []);

  // One path through the real hook command: the plugin with this kit and a disposable pilot. An owner-only command is
  // blocked with devtwin's reason, another command runs, and session start reaches the prompt.
  const p = await makePilot(t), real = await loadPlugin(t, { context: { kitRoot: KIT, pilotPath: p.path } }), home = process.env.HOME;
  try {
    process.env.HOME = p.fakeHome;
    await assert.rejects(real.hooks["execute.before"](toolEvent("shell", { command: OWNER_COMMAND })), (e) => e instanceof Error && e.message === DENY_REASON);
    assert.equal(await real.hooks["execute.before"](toolEvent("shell", { command: "npm test" })), undefined);
    const start = promptEvent("fix the migrations");
    await real.hooks.prompt(start);
    assert.match(start.prompt.text, /^fix the migrations\n\ndevtwin hook: kit not verified/);
    assert.ok(!start.prompt.text.includes("devtwin hook note"), start.prompt.text);
    const result = { content: [{ type: "text", text: "tool output" }] }, read = done("read", { path: "notes.txt" }, result);
    await real.hooks["execute.after"](read);
    assert.equal(read.result, result);
  } finally { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; }
});

test("the OpenCode plugin stays quiet when the hook fails, prints junk, is too large or runs too long, and a hook error never fails the turn", async (t) => {
  const h = await loadPlugin(t), { hooks } = h;
  // A reply that would block the command and add text if anything read it.
  const loud = { decision: "deny", reason: "must not block", context: "must not show" }, LOUD = JSON.stringify(loud);
  // Runs the hooks that can change something and checks that nothing changed and nothing was thrown.
  const quiet = async (target, label, session) => {
    const result = { content: [{ type: "text", text: "tool output" }] }, after = done("edit", { path: "a.txt" }, result), prompt = promptEvent("fix the migrations", session);
    assert.equal(await target.hooks["execute.before"](toolEvent("shell", { command: "npm run seed" })), undefined, label);
    await target.hooks["execute.after"](after);
    await target.hooks.prompt(prompt);
    assert.deepEqual([await target.hooks.compaction({ sessionID: session }), await target.hooks["experimental.idle"]({ sessionID: session })], [undefined, undefined], label);
    assert.ok(after.result === result && result.content.length === 1 && prompt.prompt.text === "fix the migrations", label);
  };
  // The reply is read when the hook is healthy: this is the control for every case below.
  await h.reply({ "*": said(loud) });
  await assert.rejects(hooks["execute.before"](toolEvent("shell", { command: "npm run seed" })), { message: "must not block" });
  const control = promptEvent("fix the migrations", "ses_control0001");
  await hooks.prompt(control);
  assert.equal(control.prompt.text, "fix the migrations\n\nmust not show\n\nmust not show");
  assert.equal((await h.take()).length, 3);
  // A non-zero exit, a death by signal, junk, more than one JSON value and JSON that is not one object.
  const cases = [["exit 3", { stdout: LOUD, exit: 3 }], ["exit 1", { stdout: LOUD + "\n", exit: 1 }], ["signal", { stdout: LOUD, signal: "SIGTERM" }], ["empty", {}], ["blank", { stdout: "\n" }], ["text", { stdout: "not json" }],
    ["cut", { stdout: LOUD.slice(0, -1) }], ["two objects", { stdout: LOUD + "\n" + LOUD + "\n" }], ["array", { stdout: "[" + LOUD + "]" }], ["string", { stdout: '"deny"' }], ["null", { stdout: "null" }], ["number", { stdout: "7" }]];
  for (const [index, [label, plan]] of cases.entries()) {
    await h.reply({ "*": plan });
    await quiet(h, label, "ses_quiet" + index);
    assert.deepEqual((await h.take(["args"])).map((row) => row.args[2]), ["pre-tool", "post-tool", "session-start", "user-prompt", "pre-compact", "stop"], label + ": every hook still ran its command");
  }
  // Output up to 256 KiB is read; one byte more is not, although it is valid JSON.
  const fill = (size) => { const empty = JSON.stringify({ ...loud, context: "" }); return JSON.stringify({ ...loud, context: "x".repeat(size - empty.length) }); };
  assert.deepEqual([fill(262144).length, fill(262145).length], [262144, 262145]);
  await h.reply({ "*": { stdout: fill(262144) } });
  const large = promptEvent("go", "ses_large0001");
  await hooks.prompt(large);
  assert.equal(large.prompt.text.length, "go".length + 2 * (2 + 262144 - JSON.stringify({ ...loud, context: "" }).length));
  await assert.rejects(hooks["execute.before"](toolEvent("shell", { command: "npm run seed" })), { message: "must not block" });
  await h.reply({ "*": { stdout: fill(262145) } });
  await quiet(h, "one byte over the cap", "ses_over0001");
  await h.reply({ "*": { stdout: fill(4 << 20) } });
  await quiet(h, "4 MiB", "ses_over0002");
  await h.take();

  // A hook that runs too long is killed, and what it printed is not read. The generated text has the 10 second
  // timer; the test loads the same text with that one number replaced, so the suite does not wait 10 seconds. The
  // stub stays alive for a minute and then exits with code 0, so a plugin with no timer would read the reply and fail
  // the checks below instead of waiting for ever.
  // The same patch records the plugin's own spawn calls. The test reads the child processes from them and not from the
  // stub's record: on a slow machine Node can take longer to start than the short timer, and then the stub writes no
  // record although the plugin did its work.
  const children = [];
  globalThis.devtwinTestChildren = children;
  t.after(() => { delete globalThis.devtwinTestChildren; });
  const recorded = 'import { spawn as realSpawn } from "node:child_process";\nconst spawn = (...args) => { const child = realSpawn(...args); globalThis.devtwinTestChildren.push(child); return child; };';
  const slow = await loadPlugin(t, { patch: (source) => swap(swap(source, "TIMEOUT_MS = 10000", "TIMEOUT_MS = 1200"), 'import { spawn } from "node:child_process";', recorded) });
  await slow.reply({ "*": { stdout: LOUD + "\n", hang: 60000 } });
  const started = Date.now(), result = { content: [{ type: "text", text: "tool output" }] }, after = done("edit", { path: "a.txt" }, result);
  assert.equal(await slow.hooks["execute.before"](toolEvent("shell", { command: "npm run seed" })), undefined);
  await slow.hooks["execute.after"](after);
  const elapsed = Date.now() - started;
  // Timers never fire early, so the two timers take at least 2,400 ms. There is no upper bound: on a loaded machine a
  // timer can fire late. The kill checks below show that the timer, and not a 10 second wait, ended each child.
  assert.ok(after.result === result && elapsed >= 2300, "two timers of 1200 ms: " + elapsed);
  assert.deepEqual(children.map((child) => [child.spawnargs[0], ...child.spawnargs.slice(2, 5)]), [["node", "hook", "--event", "pre-tool"], ["node", "hook", "--event", "post-tool"]]);
  // Both children were killed: each ended by SIGKILL and not by an exit of its own, and signal 0 finds no process.
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    assert.deepEqual([child.exitCode, child.signalCode], [null, "SIGKILL"], "the hook process " + child.pid + " was killed");
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  }

  // A kit with no hook script: node exits with an error.
  const gone = await loadPlugin(t, { stub: false });
  await quiet(gone, "no hook script", "ses_gone0001");
  // No node at all: not on PATH, and the baked path names no file.
  const none = await loadPlugin(t, { context: { nodePath: join(h.sb, "no-node") } }), path = process.env.PATH, empty = join(h.sb, "empty-bin");
  await mkdir(empty);
  try {
    process.env.PATH = empty;
    await quiet(none, "no node", "ses_none0001");
  } finally { process.env.PATH = path; }
  assert.deepEqual(await none.take(), []);

  // An event of any shape, with a reply waiting, never makes a hook throw: a throw in any hook but execute.before
  // fails the user's turn, and a throw in execute.before blocks the tool.
  await h.reply({ "*": said({ context: "LESSON" }) });
  const shapes = [undefined, null, 7, "text", [], {}, { tool: "shell" }, { tool: "shell", sessionID: 7, input: null }, { tool: "shell", input: "ls" }, { tool: "read", status: "completed", input: { path: "a" } },
    { tool: "read", status: "completed", input: { path: "a" }, result: null }, { tool: "read", status: "completed", input: { path: "a" }, result: { content: 7 } }, { tool: "edit", status: "completed", input: [], result: { content: null } },
    { sessionID: SESSION }, { sessionID: SESSION, prompt: null }, { sessionID: SESSION, prompt: { text: 7 } }, { sessionID: { id: 1 }, prompt: { text: "x" } }, { sessionID: SESSION, system: "text" }, { sessionID: SESSION, system: null }];
  for (const name of Object.keys(hooks)) for (const shape of shapes) await assert.doesNotReject(async () => hooks[name](shape), name + " " + JSON.stringify(shape));
  // A result with no content list gets no content, and a prompt that is not text stays as it is.
  const bare = done("read", { path: "a" }, { output: "tool output" }), odd = { sessionID: SESSION, prompt: { text: 7 } };
  await hooks["execute.after"](bare);
  await hooks.prompt(odd);
  assert.deepEqual([bare.result, odd.prompt], [{ output: "tool output" }, { text: 7 }]);
  await h.take();

  // An OpenCode that does not know a hook: the registration error stops nothing, and the other hooks are registered.
  const partial = await loadPlugin(t, { ctxOptions: { unknown: ["compaction", "experimental.idle", "execute.after"] } });
  assert.deepEqual(Object.keys(partial.hooks), ["execute.before", "prompt", "context"]);
  for (const ctx of [undefined, null, {}, { tool: {}, session: null }, { session: { hook: () => { throw new Error("sync"); } } }]) await assert.doesNotReject(async () => partial.plugin.setup(ctx), JSON.stringify(ctx));
  // A context with no location: the payload has no cwd, and the owner-action block still gets the command.
  const bareCtx = await loadPlugin(t, { ctxOptions: { location: false } });
  await bareCtx.reply({ "pre-tool": said({ decision: "deny", reason: DENY_REASON }) });
  await assert.rejects(bareCtx.hooks["execute.before"](toolEvent("shell", { command: OWNER_COMMAND })), { message: DENY_REASON });
  assert.deepEqual(await bareCtx.take(), [bareCtx.sent("pre-tool", { hook_event_name: "PreToolUse", session_id: SESSION, tool_name: "shell", tool_input: { command: OWNER_COMMAND } })]);
  await bareCtx.reply({});
  await quiet(bareCtx, "no location", "ses_bare0001");
  assert.deepEqual((await bareCtx.take(["input"])).map((row) => Object.hasOwn(JSON.parse(row.input), "cwd")), [false, false, false, false, false, false]);
});

test("server() returns no hooks, so an OpenCode 1.x binary loads the plugin and does nothing", async (t) => {
  const h = await loadPlugin(t), { plugin } = h;
  // A 1.x binary reads the same default export, needs id and server, and calls server(input).
  assert.deepEqual([plugin.id, typeof plugin.server], ["devtwin", "function"]);
  const input = { directory: WS, worktree: WS, project: { id: "example" }, client: {}, $: () => null };
  for (const value of [input, undefined, null, {}]) assert.deepEqual(await plugin.server(value), {}, JSON.stringify(value));
  assert.notEqual(await plugin.server(input), await plugin.server(input));
  // No 1.x hook name is in the plugin: tool.execute.before, chat.message and event are never registered.
  for (const name of ["tool.execute.before", "tool.execute.after", "chat.message", "experimental.session.compacting"]) assert.ok(!h.text.includes('"' + name + '"'), name);
  // Nothing ran and nothing was written for it.
  assert.deepEqual(await h.take(), []);
});

// A fixture home with a pinned kit and every folder the test names as a real directory.
async function liveHome(t) {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin");
  for (const rel of [".claude/skills", ".agents/skills", ".config/opencode/skills", ".config/opencode/plugins", ".config/opencode/skill", ".config/example"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(devtwin);
  await chmod(devtwin, 0o700);
  const kit = await makeRepo(join(devtwin, "kit"), { "README.md": "kit\n" });
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  const repo = await makeRepo(join(sb, "work/atlas"), { "README.md": "# Atlas\n" });
  const liveConfig = join(devtwin, "live.json"), context = { home, env: {}, kitRoot: kit };
  const cli = (args) => runCli(args, { ...context, ownerDialog: () => "approved" });
  let n = 0;
  // A candidate config beside the real one: the applied config with other skill folders or other keys.
  const variant = async (skillDirs, patch = {}) => {
    const config = JSON.parse(await readFile(liveConfig, "utf8")), path = join(devtwin, "live-" + ++n + ".json");
    await writeFile(path, JSON.stringify({ ...config, ...patch, live: { ...config.live, skillDirs } }), { mode: 0o600 });
    return path;
  };
  return { sb, home, repo, liveConfig, context, cli, variant, opencode: join(home, ".config/opencode") };
}
const refused = (field, label) => (e) => e.code === "DEVTWIN_GATE_REQUIRED" && e.details.field === field && (label === undefined || e.details.protected === label);

test("a live config never accepts a root or a skills folder inside the real OpenCode config folder", async (t) => {
  const h = await liveHome(t), shared = join(h.home, ".agents/skills");
  // The folder is protected under its own label, next to the other agent homes. No environment variable moves it.
  const moved = join(h.home, "moved"), labels = (env) => protectedPaths({ home: h.home, env, kitRoot: h.context.kitRoot }).map((entry) => entry.label);
  for (const env of [{}, { OPENCODE_CONFIG_DIR: moved, XDG_CONFIG_HOME: join(h.home, "xdg") }]) {
    const entries = protectedPaths({ home: h.home, env, kitRoot: h.context.kitRoot });
    assert.deepEqual(entries.filter((entry) => entry.label === "real-opencode-home"), [{ label: "real-opencode-home", path: h.opencode }]);
    assert.equal(entries.findIndex((entry) => entry.label === "real-opencode-home"), entries.findIndex((entry) => entry.label === "real-gemini-home") + 1);
  }
  // A set OPENCODE_CONFIG_DIR is the folder OpenCode really reads, so it is one more protected folder, under the
  // variable's name and after CLAUDE_CONFIG_DIR and CODEX_HOME. An empty value adds nothing, and XDG_CONFIG_HOME adds nothing.
  const set = protectedPaths({ home: h.home, env: { CLAUDE_CONFIG_DIR: join(h.home, "cc"), CODEX_HOME: join(h.home, "cx"), OPENCODE_CONFIG_DIR: moved, XDG_CONFIG_HOME: join(h.home, "xdg") }, kitRoot: h.context.kitRoot });
  const at = set.findIndex((entry) => entry.label === "OPENCODE_CONFIG_DIR");
  assert.deepEqual([set[at], set.slice(at - 2, at).map((entry) => entry.label), set[at + 1].label, set.length], [{ label: "OPENCODE_CONFIG_DIR", path: moved }, ["CLAUDE_CONFIG_DIR", "CODEX_HOME"], "default-config", labels({}).length + 3]);
  assert.deepEqual([labels({ OPENCODE_CONFIG_DIR: "" }), labels({ XDG_CONFIG_HOME: join(h.home, "xdg") }), labels({ OPENCODE_CONFIG_DIR: moved }).filter((label) => !labels({}).includes(label))], [labels({}), labels({}), ["OPENCODE_CONFIG_DIR"]]);
  // Through the real CLI: live init names the shared skills folder for OpenCode, and the config it writes loads.
  const init = ["live", "init", "--pilot", h.liveConfig, "--agent", "opencode", "--agent", "codex", "--repo", h.repo];
  const preview = await h.cli(init);
  assert.equal(preview.json.ok, true, JSON.stringify(preview.json.error));
  assert.deepEqual(preview.json.result.config.live.skillDirs, { codex: shared, opencode: shared });
  const applied = await h.cli([...init, "--apply", "--plan-fingerprint", preview.json.result.fingerprint]);
  assert.equal(applied.json.ok, true, JSON.stringify(applied.json.error));
  assert.deepEqual((await loadPilot(h.liveConfig, h.context)).live.skillDirs, { codex: shared, opencode: shared });
  const candidate = (path, env = {}) => loadPilot(path, { ...h.context, env, liveGate: { approval: false } });
  assert.deepEqual((await candidate(await h.variant({ opencode: shared }))).live.skillDirs, { opencode: shared });
  // No skills folder: the config folder, its plugins folder, the skills folders OpenCode itself reads there and a
  // child of them are each a real directory, and each is refused for OpenCode and for every other agent.
  const inside = [h.opencode, join(h.opencode, "skills"), join(h.opencode, "skill"), join(h.opencode, "plugins"), join(h.opencode, "skills/devtwin-record")];
  for (const path of inside) for (const agent of AGENT_IDS) await assert.rejects(candidate(await h.variant({ [agent]: path })), refused("live.skillDirs." + agent), agent + " " + path);
  // CLAUDE_CONFIG_DIR moves Claude Code's skills folder. Inside the OpenCode folder that folder is still refused, and
  // the variables that move OpenCode's own folder open nothing.
  for (const dir of [h.opencode, join(h.opencode, "plugins")]) {
    await mkdir(join(dir, "skills"), { recursive: true });
    await assert.rejects(candidate(await h.variant({ claude: join(dir, "skills") }), { CLAUDE_CONFIG_DIR: dir }), refused("live.skillDirs.claude", "real-opencode-home"), dir);
    await assert.rejects(candidate(await h.variant({ opencode: shared, claude: join(dir, "skills") }), { CLAUDE_CONFIG_DIR: dir }), refused("live.skillDirs.claude", "real-opencode-home"), dir);
  }
  await assert.rejects(candidate(await h.variant({ opencode: join(h.opencode, "skills") }), { OPENCODE_CONFIG_DIR: h.opencode, XDG_CONFIG_HOME: join(h.home, ".config") }), refused("live.skillDirs.opencode"));
  // No root: a repository or a folder write class in the folder, at it, or around it is refused under the label.
  for (const repo of [h.opencode, join(h.opencode, "plugins"), join(h.opencode, "example"), join(h.opencode, "skills/example"), join(h.home, ".config")]) {
    await assert.rejects(candidate(await h.variant({ opencode: shared }, { repos: [repo] })), refused("repos", "real-opencode-home"), repo);
  }
  for (const writeClass of ["hubRoot", "backupTargets"]) for (const path of [h.opencode, join(h.opencode, "hub")]) {
    await assert.rejects(candidate(await h.variant({ opencode: shared }, { writeClasses: { [writeClass]: [path] } })), refused("writeClasses." + writeClass, "real-opencode-home"), writeClass + " " + path);
  }
  // A set OPENCODE_CONFIG_DIR: no repository, no folder write class and no skills folder in the moved folder, at it or
  // around it, under the variable's name. Without the variable the same config loads.
  const movedRepo = await makeRepo(join(moved, "example"), { "README.md": "# Example\n" }), movedEnv = { OPENCODE_CONFIG_DIR: moved };
  await mkdir(join(moved, "skills"));
  const inMoved = await h.variant({ opencode: shared }, { repos: [movedRepo] });
  assert.deepEqual((await candidate(inMoved)).repos, [movedRepo]);
  await assert.rejects(candidate(inMoved, movedEnv), refused("repos", "OPENCODE_CONFIG_DIR"));
  await assert.rejects(candidate(inMoved, { OPENCODE_CONFIG_DIR: movedRepo }), refused("repos", "OPENCODE_CONFIG_DIR"));
  await assert.rejects(candidate(inMoved, { OPENCODE_CONFIG_DIR: join(movedRepo, "config") }), refused("repos", "OPENCODE_CONFIG_DIR"));
  for (const writeClass of ["hubRoot", "backupTargets"]) await assert.rejects(candidate(await h.variant({ opencode: shared }, { writeClasses: { [writeClass]: [join(moved, "hub")] } }), movedEnv), refused("writeClasses." + writeClass, "OPENCODE_CONFIG_DIR"), writeClass);
  // CLAUDE_CONFIG_DIR moves Claude Code's skills folder, and that folder loads. Where OPENCODE_CONFIG_DIR names the
  // same folder, it is OpenCode's too, and no skills folder opens in it.
  const movedSkills = await h.variant({ opencode: shared, claude: join(moved, "skills") });
  assert.deepEqual((await candidate(movedSkills, { CLAUDE_CONFIG_DIR: moved })).live.skillDirs, { opencode: shared, claude: join(moved, "skills") });
  await assert.rejects(candidate(movedSkills, { CLAUDE_CONFIG_DIR: moved, OPENCODE_CONFIG_DIR: moved }), refused("live.skillDirs.claude", "OPENCODE_CONFIG_DIR"));
  // A disposable pilot is fenced by the variable too, as it is by CODEX_HOME.
  const q = await makePilot(t), configured = join(q.sandbox, "configured-opencode");
  await mkdir(configured);
  await assert.rejects(loadPilot(await q.with({ pilotRoot: configured }), { home: q.fakeHome, kitRoot: "/nonexistent-kit", env: { OPENCODE_CONFIG_DIR: configured } }), refused("pilotRoot", "OPENCODE_CONFIG_DIR"));
  // The fence is exact: a sibling folder under ~/.config is an ordinary place for a repository.
  const sibling = await makeRepo(join(h.home, ".config/example"), { "README.md": "# Example\n" });
  assert.deepEqual((await candidate(await h.variant({ opencode: shared }, { repos: [sibling] }))).repos, [sibling]);
  // A disposable pilot is fenced the same way: its root, and so every store root in it, may not sit in the folder.
  const p = await makePilot(t), oc = join(p.fakeHome, ".config/opencode");
  for (const root of [oc, join(oc, "pilot"), join(p.fakeHome, ".config")]) {
    const stores = { pilotRoot: root, configRoot: join(root, "config"), dataRoot: join(root, "data"), stateRoot: join(root, "state"), inputsRoot: join(root, "inputs"), agentHomes: [], repos: [] };
    await assert.rejects(loadPilot(await p.with(stores), { home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {} }), refused("pilotRoot", "real-opencode-home"), root);
  }
});
