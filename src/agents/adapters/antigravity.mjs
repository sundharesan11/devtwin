import { isAbsolute, join } from "node:path";
import { shellPaths, commandText } from "../../hooks/tool-text.mjs";
import { kindOf } from "./claude.mjs";
// The Antigravity CLI adapter (agy).
//   skills        ~/.gemini/config/skills, a folder of its own.
//   instructions  a marker block in ~/.gemini/GEMINI.md, the same file the Gemini CLI adapter names.
//   hooks         ~/.gemini/config/hooks.json. The file is keyed by hook name, so devtwin's entries sit under the
//                 top-level key "devtwin". A handler timeout is in seconds.
// Checked against a real Antigravity CLI 1.5 session (1.5.4, then 1.5.10) in a disposable workspace with its own hooks
// file:
//   context       SessionStart and PreInvocation read { injectSteps: [ { systemMessage: { systemMessage } } ] }, and the
//                 model sees the text. PreInvocation fires before every model call, so it stands for a user prompt.
//   deny          PreToolUse { decision: "deny", reason } blocks the call, and the model reads the reason.
//   empty reply   PreToolUse {} and { decision: "" } both deny the tool, and { decision: "ask" } follows Antigravity's
//                 own permission flow. A hook that prints no stdout at all lets the tool run. See neutral below.
//   payload       camelCase keys: hookEventName, conversationId, cwd, workspacePaths, lastUserInput, and toolCall with a
//                 name and PascalCase args. PostToolUse has an error field and no tool output.
//   tools         run_command (CommandLine), and read_file, write_file and edit_file (Path). manage_task sends
//                 { Action: "send_input", Input, TaskId } to type text into a running command; its other actions
//                 (status, kill) carry no text.
//   shells        agy sets ANTIGRAVITY_AGENT and ANTIGRAVITY_CONVERSATION_ID in the shells it starts, not GEMINI_CLI.
//   global hooks  ~/.gemini/config/hooks.json is read with no approval step.
// From the docs only, not seen in a session:
// view_file (AbsolutePath), write_to_file, replace_file_content and multi_replace_file_content (TargetFile), list_dir
// (DirectoryPath), find_by_name (SearchDirectory) and grep_search (SearchPath). parse accepts both name sets. The docs
// do not say how a matcher is anchored, and they disagree on whether "allow" approves a tool or defers, so devtwin
// never prints "allow".
const TOOLS = Object.freeze({ shell: Object.freeze(["run_command", "manage_task"]), read: Object.freeze(["read_file", "view_file"]),
  edit: Object.freeze(["write_file", "edit_file", "write_to_file", "replace_file_content", "multi_replace_file_content"]), search: Object.freeze(["list_dir", "find_by_name", "grep_search"]) });
// devtwin's internal event names (the Claude names) and the Antigravity event that stands for each. No event stands
// for a compaction.
const EVENT_NAMES = Object.freeze({ SessionStart: "SessionStart", UserPromptSubmit: "PreInvocation", PreToolUse: "PreToolUse", PostToolUse: "PostToolUse", Stop: "Stop" });
const INTERNAL = Object.fromEntries(Object.entries(EVENT_NAMES).map(([internal, name]) => [name, internal]));
const str = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : null;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const folder = (value) => str(value) && isAbsolute(value) ? value : null;
// Total: any JSON value gives the normalized shape, and nothing here throws. The tool name is checked exactly, because
// the matchers below are plain alternations. A payload from before 1.5.4 has no cwd and no hookEventName, so the first
// absolute workspace path stands for the cwd.
function parse(payload) {
  const body = record(payload), call = record(body.toolCall), args = record(call.args), tool = call.name, kind = kindOf(TOOLS, tool), event = body.hookEventName;
  const cwd = folder(body.cwd) ?? (Array.isArray(body.workspacePaths) ? body.workspacePaths.slice(0, 64).map(folder).find(Boolean) : null) ?? undefined;
  // Shell text: the command line, or the text send_input sends to a running command. Any other manage_task action
  // keeps the shell kind with no command, so the owner-action block and the command lessons read nothing from it.
  const text = tool === "run_command" ? args.CommandLine : tool === "manage_task" && args.Action === "send_input" ? args.Input : undefined;
  const command = typeof text === "string" ? text : undefined;
  let paths = [];
  if (kind === "read" || kind === "edit") paths = [str(args.Path) ?? str(args.AbsolutePath) ?? str(args.TargetFile)].filter(Boolean);
  else if (kind === "search") paths = [str(args.DirectoryPath) ?? str(args.SearchDirectory) ?? str(args.SearchPath)].filter(Boolean);
  else if (tool === "run_command") paths = shellPaths(commandText({ command })).filter(str);
  return { event: typeof event === "string" && Object.hasOwn(INTERNAL, event) ? INTERNAL[event] : event, sessionId: body.conversationId, cwd, source: body.source, prompt: body.lastUserInput,
    toolName: tool, toolKind: kind, command, paths, edit: kind === "edit" };
}
// Exit 0 with one JSON object: a deny is { decision, reason }; context is one injected system message.
function format(result) {
  if (result.kind === "deny") return { stdout: { decision: "deny", reason: result.reason }, exitCode: 0 };
  return { stdout: { injectSteps: [{ systemMessage: { systemMessage: result.text } }] }, exitCode: 0 };
}
// The reply when devtwin has nothing to say, by devtwin's internal event name. A real Antigravity CLI session denies
// the tool on {} and on an empty decision, while "ask" hands the call back to Antigravity's own permission flow, which
// may run the tool with no prompt. So "ask" is the neutral reply before a tool and never a gate: the only gate is the
// deny above.
const neutral = (event) => event === "PreToolUse" ? { decision: "ask" } : event === "Stop" ? { decision: "" } : {};
// A tool event takes a group { matcher, hooks: [handler] }; a lifecycle event takes the handler itself. The timeout is
// in seconds.
const entry = ({ command, matcher }) => matcher ? { matcher, hooks: [{ type: "command", command, timeout: 10 }] } : { type: "command", command, timeout: 10 };
export default Object.freeze({
  id: "antigravity", name: "Antigravity CLI", actor: "antigravity", listed: false,
  detect: (env) => Boolean(env.ANTIGRAVITY_AGENT || env.ANTIGRAVITY_CONVERSATION_ID),
  // The folder Gemini CLI uses: Antigravity CLI keeps its user files under ~/.gemini too.
  agentDir: ({ home }) => join(home, ".gemini"),
  skills: { folder: ".gemini/config/skills", dir: ({ home }) => join(home, ".gemini/config/skills"), legacy: [] },
  instructions: { file: "GEMINI.md", display: "~/.gemini/GEMINI.md", owned: false, ownedFiles: false },
  hooks: {
    // container: the top-level key of the hooks file that holds devtwin's entries. The other adapters have none and
    // mean "hooks".
    file: "config/hooks.json", display: "~/.gemini/config/hooks.json", container: "devtwin", eventNames: EVENT_NAMES,
    // Plain alternations with no ^ or $, because the docs do not state the anchoring. PostToolUse lists both name sets.
    events: Object.freeze([["SessionStart", "session-start", null], ["PreInvocation", "user-prompt", null], ["PreToolUse", "pre-tool", TOOLS.shell.join("|")],
      ["PostToolUse", "post-tool", Object.values(TOOLS).flat().join("|")], ["Stop", "stop", null]]),
    tools: TOOLS, entry, parse, format, neutral, lessonEvent: "PostToolUse",
    // A post-tool hook cannot print context, so the lessons for a tool call wait for the next PreInvocation.
    deferToolContext: true,
    compacted: () => false
  },
  capabilities: Object.freeze({ skills: true, instructions: true, sessionStartContext: true, preToolContext: false, ownerBlock: true, stopHook: true })
});
