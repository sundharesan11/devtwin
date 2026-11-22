import { isAbsolute, join } from "node:path";
import { DevtwinError } from "../../errors.mjs";
import { shellPaths, patchPaths, commandText } from "../../hooks/tool-text.mjs";
import { kindOf, str } from "./claude.mjs";
// The OpenCode adapter (OpenCode 2.x).
//   skills        ~/.agents/skills. By the OpenCode source, OpenCode reads it and it wins there over ~/.claude/skills;
//                 a real session listed the devtwin skills that are installed in it. Codex and Gemini CLI read the
//                 same folder, so one install serves the three agents (src/agents/install.mjs).
//   instructions  ~/.config/opencode/devtwin.md, a devtwin-owned file. devtwin creates no AGENTS.md and no
//                 opencode.json: those files are the developer's. A real OpenCode 2.3.0 session loaded a project
//                 AGENTS.md and the global ~/.config/opencode/AGENTS.md. It did not load ~/.claude/CLAUDE.md. It
//                 loaded that file after ~/.config/opencode/opencode.json named it under "instructions"; that
//                 setting is the developer's to write, and devtwin does not write it. OpenCode expands no "@path"
//                 line (from the source), so no import names devtwin.md: the block reaches OpenCode only through
//                 the plugin below, which reads the file.
//   hooks         ~/.config/opencode/plugins/devtwin.js, one whole file that devtwin generates (content below).
//                 OpenCode loads a single .js file in plugins/ with no approval step. It has no hook settings file.
// Checked against real OpenCode 2.3.0 sessions. No other OpenCode version was run.
// A session with a disposable config folder and a probe plugin showed:
//   plugin        the default export { id, setup(ctx), server() } loads with ESM imports of node:fs and
//                 node:child_process, and a spawned node child returns its output.
//   deny          a throw in ctx.tool.hook("execute.before") blocks the call, and the model reads the message.
//   context       text appended to event.result.content in "execute.after", to event.prompt.text in the "prompt"
//                 hook and to event.system in the "context" hook reaches the model.
//   tools         shell (command), and read and edit (path, which can be relative to the session folder).
//   shells        OPENCODE, OPENCODE_SESSION_ID, OPENCODE_TERMINAL, AGENT and AI_AGENT are set in a tool shell.
// A session with the generated plugin showed the list below. The install routes wrote the plugin and devtwin.md into
// a disposable home, never into the real ~/.config/opencode:
//   start         the session-start text arrived once, appended to the first prompt of the session.
//   deny          an owner-only command through the shell tool was blocked, and the model quoted devtwin's reason.
//                 Another shell command ran and returned its output with no devtwin text.
//   lessons       a lesson came back with the result of a read, and a lesson was appended to a prompt that named a
//                 matching path. The model took the lesson on the read result for content of the file, so the
//                 plugin now puts a marker line before that text. In a second session, with the marker line, the model said
//                 that the lesson text was added after the tool output and is not part of the file.
//   block         the model quoted text that only devtwin.md holds: the "context" hook delivered it as system text.
//   stop          after a session went idle, the start text of the next session said when the last session
//                 stopped: the idle event reached the stop hook, which wrote the stop stub.
//   tools         the model used the tools named shell, read, glob and write. The glob and write calls completed
//                 with the plugin loaded.
// Not seen in a session with the generated plugin: the edit tool (the probe session showed it); a lesson on a write
// or glob result. The record of that session has a lesson on no tool result but the read one.
// From the source and the docs only, not seen in any session: the input fields of write and glob (path); patch
// (patchText, with the "*** Update File:" headers of a Codex apply_patch) and grep (path); the "compaction" hook;
// OpenCode 1.x, which was not run. By the source it calls server() on the same file and names its tools bash, read,
// edit and write (filePath) and apply_patch (patchText).
// parse accepts both name sets, so the payload reader does not depend on the OpenCode line. The plugin acts on 2.x only.
const TOOLS = Object.freeze({ shell: Object.freeze(["shell", "bash"]), read: Object.freeze(["read"]), edit: Object.freeze(["edit", "write", "patch", "apply_patch"]), search: Object.freeze(["grep", "glob"]) });
const PATCH_TOOLS = Object.freeze(["patch", "apply_patch"]);
// The 2.x tools the plugin sends: the shell tool before it runs, and these seven after they completed.
const BEFORE_TOOLS = Object.freeze(["shell"]), AFTER_TOOLS = Object.freeze(["shell", "read", "edit", "write", "patch", "grep", "glob"]);
// The tool input fields the plugin passes on, and the only ones parse reads. The content of a write and the old and
// new strings of an edit are not passed on, and of a patch only its header lines are (the plugin's headers, below).
const INPUT_KEYS = Object.freeze(["command", "path", "filePath", "patchText"]);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
// The payload is devtwin's own, because the plugin is devtwin's: { hook_event_name, session_id, cwd, tool_name,
// tool_input, prompt }, with the event under devtwin's internal name. Total: any JSON value gives the normalized
// shape, and nothing here throws. A relative path stays as sent: the hook runtime resolves it against the canonical
// session folder (toRepoRelative in src/hooks/paths.mjs), as it does for Codex, so a session folder reached through a
// symbolic link still gives the path its place in the repository. OpenCode also takes "~/" paths; parse does not know
// the home folder, so it leaves them out.
function parse(payload) {
  const body = record(payload), input = record(body.tool_input), tool = body.tool_name, kind = kindOf(TOOLS, tool);
  const cwd = str(body.cwd) && isAbsolute(body.cwd) ? body.cwd : undefined;
  const command = kind === "shell" && typeof input.command === "string" ? input.command : undefined;
  let paths = [];
  if (PATCH_TOOLS.includes(tool)) paths = typeof input.patchText === "string" ? patchPaths(input.patchText) : [];
  else if (kind === "shell") paths = shellPaths(commandText({ command }));
  else if (kind) paths = [str(input.path) ?? str(input.filePath)];
  paths = paths.filter((path) => str(path) && path !== "~" && !path.startsWith("~/"));
  return { event: body.hook_event_name, sessionId: body.session_id, cwd, source: body.source, prompt: body.prompt,
    toolName: tool, toolKind: kind, command, paths, edit: kind === "edit" };
}
// What the plugin reads back, as one JSON object: a deny is { decision, reason }; context is { context }. With
// nothing to say the hook prints nothing: there is no neutral reply, and the plugin reads empty output, text that is
// not one JSON object, a non-zero exit, a timeout and too much output all as "nothing to say".
function format(result) {
  if (result.kind === "deny") return { stdout: { decision: "deny", reason: result.reason }, exitCode: 0 };
  return { stdout: { context: result.text }, exitCode: 0 };
}
// The plugin text after its constants. String.raw keeps each backslash as written; the text has no backtick and no
// "${", so nothing in it is read as a template part.
const PLUGIN_BODY = String.raw`const TIMEOUT_MS = 10000, MAX_OUTPUT = 262144, REREAD_MS = 1000, MAX_INSTRUCTIONS = 65536, MAX_SESSIONS = 4096;
const MISSING = Symbol("missing"), BLOCKED = "devtwin blocked this command.";
// The first line of the text part that "execute.after" appends to a tool result. It says that the text is not the
// output of the tool: in a real session without this line, the model took a lesson for content of the file it read.
const NOTE = "[devtwin hook note: the text below was added after the tool output and is not part of it]";
// One run of the hook command, with an argument array and never a command line. It never rejects: a program that
// does not exist gives MISSING, and a non-zero exit, a kill, a timeout, too much output and output that is not JSON
// give null.
function run(program, event, payload) {
  return new Promise((resolve) => {
    const chunks = [];
    let child = null, timer = null, size = 0, settled = false;
    const done = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const stop = () => { try { child.kill("SIGKILL"); } catch { /* The child is gone. */ } done(null); };
    const failed = (error) => done(error && error.code === "ENOENT" ? MISSING : null);
    try {
      child = spawn(program, [KIT + "/bin/devtwin.mjs", "hook", "--event", event, "--agent", "opencode", "--pilot", PILOT], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      timer = setTimeout(stop, TIMEOUT_MS);
      child.on("error", failed);
      child.stdin.on("error", () => null);
      child.stdout.on("error", () => null);
      child.stdout.on("data", (chunk) => { size += chunk.length; if (size > MAX_OUTPUT) stop(); else chunks.push(chunk); });
      child.on("close", (code) => { if (code !== 0) return done(null); try { done(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { done(null); } });
      child.stdin.end(JSON.stringify(payload));
    } catch (error) { if (child) stop(); else failed(error); }
  });
}
// The reply as one object, or null for "nothing to say". node on PATH runs first, as in every other devtwin hook
// line; the Node path that the install baked in runs when PATH has no node.
async function send(event, payload) {
  let reply = await run("node", event, payload);
  if (reply === MISSING) reply = await run(NODE, event, payload);
  return reply !== null && typeof reply === "object" && !Array.isArray(reply) ? reply : null;
}
const textOf = (reply) => reply !== null && typeof reply.context === "string" ? reply.context : "";
// The instruction block: the text of devtwin.md, which is found next to the folder that holds this file. devtwin
// installs this file to ~/.config/opencode/plugins and devtwin.md to ~/.config/opencode, and to no other folder. The
// file is read at most once in REREAD_MS. A missing, unreadable or oversized file adds nothing.
let block = { at: null, text: "" };
function instructions() {
  const at = Date.now();
  if (block.at === null || at - block.at >= REREAD_MS || at < block.at) {
    block = { at, text: "" };
    try { const text = readFileSync(new URL("../devtwin.md", import.meta.url), "utf8"); if (text.length <= MAX_INSTRUCTIONS) block.text = text; } catch { /* No file: nothing to add. */ }
  }
  return block.text;
}
// OpenCode 2.x calls setup once for each open folder. A throw in "execute.before" blocks the tool, so that hook
// throws only for a deny. A throw in any other hook fails the user's turn, so each of them catches its own errors.
async function setup(ctx) {
  const started = new Set();
  const cwd = () => { try { return ctx.location.directory; } catch { return undefined; } };
  const base = (name, event) => ({ hook_event_name: name, session_id: event.sessionID, cwd: cwd() });
  // Of a patch only the header lines are sent: "*** Begin Patch", "*** Add File: <path>" and the like. They name
  // every file, and no added or removed line starts with "*** ", so no file content leaves OpenCode.
  const headers = (text) => text.split("\n").filter((line) => line.startsWith("*** ")).join("\n");
  const tool = (name, event) => {
    const input = {};
    for (const key of INPUT_KEYS) if (event.input && typeof event.input[key] === "string") input[key] = key === "patchText" ? headers(event.input[key]) : event.input[key];
    return { ...base(name, event), tool_name: event.tool, tool_input: input };
  };
  // A hook that this OpenCode does not know must not stop the others.
  const on = async (group, name, fn) => { try { await ctx[group].hook(name, fn); } catch { /* No such hook here. */ } };
  await on("tool", "execute.before", async (event) => {
    let reason = null;
    try {
      if (!BEFORE.includes(event.tool)) return;
      const reply = await send("pre-tool", tool("PreToolUse", event));
      if (reply !== null && reply.decision === "deny") reason = typeof reply.reason === "string" && reply.reason ? reply.reason : BLOCKED;
    } catch { return; }
    if (reason !== null) throw new Error(reason);
  });
  await on("tool", "execute.after", async (event) => {
    try {
      if (event.status !== "completed" || !AFTER.includes(event.tool)) return;
      const text = textOf(await send("post-tool", tool("PostToolUse", event))), content = event.result ? event.result.content : undefined;
      const parts = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : null;
      // The model reads result.content. A new result object, as OpenCode's own examples replace it. The appended
      // text part is the NOTE line, a newline and the reply text.
      if (text && parts) event.result = { ...event.result, content: [...parts, { type: "text", text: NOTE + "\n" + text }] };
    } catch { /* Fail open. */ }
  });
  // session-start once for each session ID, then user-prompt. The reply text is kept in the conversation. It has no
  // NOTE line: that line is for a tool result only. A prompt with no text, such as an attachment alone, has nothing
  // to carry the session-start line, so the session counts as started only at its first prompt with text.
  await on("session", "prompt", async (event) => {
    try {
      const id = event.sessionID, parts = [];
      const prompt = event.prompt && typeof event.prompt.text === "string" ? event.prompt.text : undefined;
      if (prompt !== undefined && !started.has(id)) {
        if (started.size >= MAX_SESSIONS) started.delete(started.values().next().value);
        started.add(id);
        parts.push(textOf(await send("session-start", base("SessionStart", event))));
      }
      parts.push(textOf(await send("user-prompt", { ...base("UserPromptSubmit", event), prompt })));
      const text = parts.filter(Boolean).join("\n\n");
      if (text && prompt !== undefined) event.prompt.text = prompt + "\n\n" + text;
    } catch { /* Fail open. */ }
  });
  // System text for this model call only.
  await on("session", "context", async (event) => {
    try {
      const text = instructions();
      if (text.trim() && Array.isArray(event.system)) event.system.push({ type: "text", text });
    } catch { /* Fail open. */ }
  });
  // A compaction can summarize the session-start line away. The next prompt of the session sends session-start again,
  // as Claude Code and Codex get that context again after a compaction.
  await on("session", "compaction", async (event) => { try { await send("pre-compact", base("PreCompact", event)); started.delete(event.sessionID); } catch { /* Fail open. */ } });
  await on("session", "experimental.idle", async (event) => { try { await send("stop", base("Stop", event)); } catch { /* Fail open. */ } });
}
// OpenCode 1.x calls server() on the same file. devtwin does nothing there: no hooks.
async function server() { return {}; }
export default { id: "devtwin", setup, server };
`;
// The plugin source for a hook context (hookContext in src/agents/hooks-install.mjs), which names the Node path that
// runs when PATH has no node: the stable one, so a Homebrew upgrade keeps the text (stableNodePath in
// src/schedule/launchd.mjs). The Node path has no default, so only the hook context names it. Each path is one JSON
// string, so no character in a path can end the string or add code.
function content({ kitRoot, pilotPath, nodePath } = {}) {
  for (const path of [kitRoot, pilotPath, nodePath]) if (typeof path !== "string" || !path) throw new DevtwinError("INVALID_INPUT", "Plugin needs a kit path, a pilot path and a Node path", { field: "hookContext" });
  return ["// devtwin wrote this file. Do not edit it: `devtwin agents install --hooks` rewrites it.",
    "// It is the OpenCode 2.x plugin that sends each hook event to the devtwin hook command and applies the reply.",
    'import { spawn } from "node:child_process";',
    'import { readFileSync } from "node:fs";',
    "const NODE = " + JSON.stringify(nodePath) + ", KIT = " + JSON.stringify(kitRoot) + ", PILOT = " + JSON.stringify(pilotPath) + ";",
    "const BEFORE = " + JSON.stringify(BEFORE_TOOLS) + ", AFTER = " + JSON.stringify(AFTER_TOOLS) + ", INPUT_KEYS = " + JSON.stringify(INPUT_KEYS) + ";",
    PLUGIN_BODY].join("\n");
}
export default Object.freeze({
  id: "opencode", name: "OpenCode", actor: "opencode", listed: false,
  // A tool shell has OPENCODE=1. OPENCODE_SESSION_ID is set together with it, so it adds nothing, and the other
  // OPENCODE_ variables (OPENCODE_CONFIG_DIR) can be set in a human's shell.
  detect: (env) => Boolean(env.OPENCODE),
  // OPENCODE_CONFIG_DIR moves the folder for OpenCode: a real session loaded the plugin from the folder it named. By
  // the OpenCode source, XDG_CONFIG_HOME moves it too; no session checked that. The adapter ignores both, as the Codex
  // one ignores CODEX_HOME: devtwin installs to this folder only. A set OPENCODE_CONFIG_DIR is a protected folder of
  // the fence (protectedPaths in src/config/pilot.mjs).
  agentDir: ({ home }) => join(home, ".config/opencode"),
  skills: { folder: ".agents/skills", dir: ({ home }) => join(home, ".agents/skills"), legacy: [] },
  // mode "owned-only": the instruction file is the devtwin-owned file itself, with no import line in another file
  // (targetsOf in src/agents/instructions.mjs plans that one file). owned stays false: it means "import the owned
  // file from the instruction file", and nothing imports this one.
  instructions: { file: "devtwin.md", display: "~/.config/opencode/devtwin.md", mode: "owned-only", owned: false, ownedFiles: false },
  hooks: {
    // target "file": the hook target is the whole generated file, not entries in a settings file.
    file: "plugins/devtwin.js", display: "~/.config/opencode/plugins/devtwin.js", target: "file",
    // [OpenCode plugin hook, devtwin hook event, tools], as a description only: no code reads this table. PLUGIN_BODY
    // is the mapping that runs, and a test checks that each name here is a string in the plugin text. The prompt hook
    // sends session-start once for each session, and again after a compaction, and user-prompt every time. The
    // "context" hook runs no hook command: it adds the instruction file.
    events: Object.freeze([["prompt", "session-start", null], ["prompt", "user-prompt", null], ["execute.before", "pre-tool", BEFORE_TOOLS.join("|")], ["execute.after", "post-tool", AFTER_TOOLS.join("|")],
      ["compaction", "pre-compact", null], ["experimental.idle", "stop", null]]),
    // Lessons arrive after the tool, appended to its result under a marker line (NOTE in the plugin text). There is
    // no context before a tool runs.
    tools: TOOLS, parse, format, content, lessonEvent: "PostToolUse",
    compacted: (event) => event === "PreCompact"
  },
  capabilities: Object.freeze({ skills: true, instructions: true, sessionStartContext: true, preToolContext: false, ownerBlock: true, stopHook: true })
});
