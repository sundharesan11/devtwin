import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { realpathSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { onboardFixture, draftFor, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { applyOnboard } from "../src/onboarding/onboard.mjs";
import { addRecord } from "../src/records/store.mjs";
import { rebuildIndex } from "../src/lessons/index.mjs";
import { writeKitReceipt, receiptPath } from "../src/hooks/receipt.mjs";
import { ownerAction } from "../src/hooks/owner-block.mjs";
import { adapter, AGENT_IDS } from "../src/agents/adapters/index.mjs";
import { renderBlock, planInstructions, BLOCK_CHARS, PREFERENCE_ROOM } from "../src/agents/instructions.mjs";
import { formLine, commandFor, FORM_POINTER, COMPACT_COMMAND, FORM_START } from "../src/agents/command-form.mjs";
import { renderGuide, PLACEHOLDER_NOTE } from "../src/stack/guide.mjs";
import { radarNote } from "../src/stack/digest.mjs";
import { fitLine, START_LINE_BYTES, START_BYTES } from "../src/hooks/commands.mjs";
import { summaryPath } from "../src/context/summary.mjs";
import { digest } from "../src/storage/canonical.mjs";

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
  const { text, chars, kept, dropped } = renderBlock([], context);
  assert.ok(chars <= BLOCK_CHARS, String(chars));
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

test("command form: the paths do not count toward the cap, so the rules leave the same room for preferences at any path length", () => {
  const room = (context) => BLOCK_CHARS - renderBlock([], context).chars - "\nPreferences:\n".length;
  const contexts = [{ kitRoot: "/k", pilotPath: "/p" }, { kitRoot: long("/kits", 120), pilotPath: long("/pilots", 120) }, { kitRoot: long("/kits", 400), pilotPath: long("/pilots", 400) }, { kitRoot: "/a b/it's", pilotPath: "/p q/live.json" }];
  for (const context of contexts) {
    assert.ok(room(context) >= PREFERENCE_ROOM, room(context) + " for " + context.kitRoot.length);
    assert.equal(room(context), room(contexts[0]));
  }
  // Preferences that fill PREFERENCE_ROOM are all kept with 400-character paths; with no path discount the block
  // would be far over the cap and would fail with LIMIT.
  const prefs = Array.from({ length: 4 }, (_, n) => ({ id: "rec_" + n, title: "P" + n, text: "x".repeat(PREFERENCE_ROOM / 4 - 7) }));
  assert.ok(prefs.reduce((sum, p) => sum + ("- " + p.title + ": " + p.text).length + 1, 0) <= PREFERENCE_ROOM);
  const rendered = renderBlock(prefs, contexts[2]);
  assert.deepEqual([rendered.kept, rendered.dropped], [prefs.map((p) => p.id), []]);
  assert.ok(rendered.chars <= BLOCK_CHARS && rendered.text.length > BLOCK_CHARS, rendered.chars + " " + rendered.text.length);
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
    // The start line keeps its 400 bytes: with a long checkout path the notices part takes its short form (fitLine).
    const line = start.split("\n").find((l) => l.startsWith("devtwin hook live: "));
    assert.ok(Buffer.byteLength(line) <= START_LINE_BYTES, agent + ": " + line);
    assert.ok(line.includes("run `devtwin lesson notices --scope example` " + FORM_POINTER + ".") || line.includes(" 1 lesson replaced."), agent + ": " + line);
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

test("start line: fitLine shortens, then drops, the optional parts from the highest rank down and keeps rank 0", () => {
  const parts = [{ rank: 0, text: "A".repeat(10) }, { rank: 5, text: " five", short: "" }, { rank: 4, text: " four-long", short: " 4" }, { rank: 1, text: " one" }, { rank: 0, text: " Z" }, { rank: 2, text: " two-long", short: " 2" }];
  assert.equal(fitLine(parts, 1000), "AAAAAAAAAA five four-long one Z two-long");
  // Short forms first, highest rank first: five goes, then four, then two, until the line fits.
  assert.equal(fitLine(parts, 35), "AAAAAAAAAA four-long one Z two-long");
  assert.equal(fitLine(parts, 28), "AAAAAAAAAA 4 one Z two-long");
  assert.equal(fitLine(parts, 21), "AAAAAAAAAA 4 one Z 2");
  // Then whole parts go in the same order; the kit-like rank 1 goes last and rank 0 always stays.
  assert.equal(fitLine(parts, 18), "AAAAAAAAAA one Z 2");
  assert.equal(fitLine(parts, 16), "AAAAAAAAAA one Z");
  assert.equal(fitLine(parts, 3), "AAAAAAAAAA Z");
});

// The worst case of the session-start output: a 120-character kit path, a 32-character scope and a 96-character project
// (the ID limits), open replacement notices, a paths confirmation over 90 days old, a receipt that expires in two
// days, a knowledge server binding with the longest names and a cached summary of 1,200 characters with 3-byte
// characters.
async function worstCase(t) {
  const scope = "s" + "a".repeat(31), project = scope + "." + "p".repeat(96 - scope.length - 1);
  const s = await onboardFixture(t, { scope, project });
  await applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now });
  await rebuildIndex(s.roots, scope);
  const base = await realpath(s.sandbox), kitDir = join(base, "k".repeat(120 - base.length - 1));
  await mkdir(join(kitDir, ".git/refs/heads"), { recursive: true });
  await writeFile(join(kitDir, ".git/HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(kitDir, ".git/refs/heads/main"), "a".repeat(40) + "\n");
  const kitRoot = await realpath(kitDir);
  const hub = join(s.stateRoot, "hubs", "example-hub");
  await mkdir(hub, { recursive: true, mode: 0o700 });
  await writeFile(join(hub, "notices.json"), JSON.stringify({ schemaVersion: 1, scope, notices: Array.from({ length: 12 }, (_, n) => ({ id: "ntc_" + n })) }), { mode: 0o600 });
  await mkdir(join(s.configRoot, "servers"), { recursive: true, mode: 0o700 });
  await writeFile(join(s.configRoot, "servers", scope + ".json"), JSON.stringify({ schemaVersion: 1, scope, server: "k" + "n".repeat(63), client: "c" + "l".repeat(63) }), { mode: 0o600 });
  const body = { schemaVersion: 1, scope, project, lines: Array.from({ length: 6 }, (_, n) => "unreviewed, from you: constraint " + n + ": " + "€".repeat(160)) };
  const cache = summaryPath(s.roots, scope, project);
  await mkdir(join(cache, ".."), { recursive: true, mode: 0o700 });
  await writeFile(cache, JSON.stringify({ ...body, fingerprint: digest(body) }), { mode: 0o600 });
  const day = (n) => new Date(now().getTime() + n * 86400000);
  const run = async (args, at, extra = {}) => {
    const chunks = [];
    await main([...args, "--pilot", s.path], { stdout: { write: (v) => { chunks.push(v); return true; } }, now: () => at, env: {}, kitRoot, ownerDialog: () => "approved", ...extra });
    return chunks.join("");
  };
  const start = async (at) => JSON.parse(await run(["hook", "--event", "session-start", "--agent", "claude"], at, { stdin: JSON.stringify({ session_id: "s-worst", cwd: s.repo, hook_event_name: "SessionStart", source: "startup" }) })).hookSpecificOutput.additionalContext;
  // Confirm the paths on day 0 and renew the receipt up to day 87: on day 115 the confirmation is over 90 days old and
  // the receipt from day 87 expires in two days.
  await writeKitReceipt(s.roots, { pilotPath: s.path, kitRoot, now: day(0) });
  const preview = JSON.parse(await run(["paths", "confirm"], day(0)));
  await run(["paths", "confirm", "--apply", "--plan-fingerprint", preview.result.fingerprint], day(0));
  for (const n of [0, 29, 58, 87]) await start(day(n));
  return { s, scope, project, kitRoot, context: await start(day(115)), run };
}

test("start line: the worst case keeps the start line within 400 bytes and the whole output within 1,600", async (t) => {
  const { scope, project, kitRoot, context } = await worstCase(t);
  assert.equal(kitRoot.length, 120);
  const first = context.split("\n")[0], search = first.indexOf(" Before non-trivial debugging, call ");
  assert.ok(search > 0, first);
  const line = first.slice(0, search);
  assert.ok(Buffer.byteLength(line) <= START_LINE_BYTES, Buffer.byteLength(line) + ": " + line);
  assert.ok(Buffer.byteLength(context) <= START_BYTES, String(Buffer.byteLength(context)));
  // Rank 0 always stays: the project and its lesson count, the scope and the session ID.
  assert.match(line, new RegExp("^devtwin hook live: \\d+ lessons? for " + project.replaceAll(".", "\\.") + "\\. Scope: " + scope + "\\. "));
  assert.match(line, / Session ID for lesson propose: ses_[a-f0-9]{24}\./);
  // At 120 characters the kit path still fits, next to the short paths note.
  assert.ok(line.includes(" Kit: `" + kitRoot + "`."), line);
  assert.ok(line.includes(" Paths confirmed over 90 days ago."), line);
  // The summary is sized to the bytes that remain, so it keeps some of its lines.
  assert.ok(context.includes("\ndevtwin summary for " + project + "."), context);
  assert.ok(context.includes("constraint 0: "), context);
  assert.deepEqual(pointed(context), []);
});

test("start line: the not-verified line with a 120-character kit path keeps its full verify command within 400 bytes", async (t) => {
  const { s, kitRoot, run } = await worstCase(t);
  await rm(receiptPath(s.stateRoot), { force: true });
  const line = JSON.parse(await run(["hook", "--event", "session-start", "--agent", "claude"], now(), { stdin: JSON.stringify({ session_id: "s-unverified", cwd: s.repo, hook_event_name: "SessionStart", source: "startup" }) })).hookSpecificOutput.additionalContext;
  assert.ok(Buffer.byteLength(line) <= START_LINE_BYTES, Buffer.byteLength(line) + ": " + line);
  assert.ok(line.startsWith("devtwin hook: kit not verified ("), line);
  assert.ok(line.includes("`" + commandFor("hook verify", { kitRoot, pilotPath: await realpath(s.path) }) + "`. Lessons are off."), line);
});

test("command form: a radar guide and a digest note give the full executable form", (t) => {
  const context = { kitRoot: long("/kits", 120), pilotPath: long("/pilots", 120) };
  const guide = renderGuide({ id: "0123456789ab", label: "Example tool", kind: "agent-tools", link: "https://example.com/tool", sourceUrl: "https://example.com/feed" }, { scope: SCOPE, digestDate: "2026-10-07", context });
  const propose = commandFor("lesson propose --scope 'example' --session '<session ID>' --title '<what you learned>' --summary '<one do or do not line>' --body-file '<notes.md>' --topic '<tool name>' --apply", context);
  assert.ok(guide.includes("```sh\n" + propose + "\n```\n\n" + PLACEHOLDER_NOTE), guide);
  // The command writes: it has --apply and every flag that lesson propose requires for a write.
  for (const flag of ["--scope", "--session", "--title", "--summary", "--body-file", "--topic", "--apply", "--pilot"]) assert.ok(propose.includes(" " + flag + " "), flag);
  assert.ok(fullForms(guide, context));
  assert.deepEqual([...guide.matchAll(COMPACT_COMMAND)], []);
  assert.ok(renderGuide({ id: "0123456789ab", label: "Example tool", kind: "agent-tools" }, { scope: null, digestDate: "2026-10-07", context }).includes(" lesson propose --scope '<scope>' "));
  const commands = [propose];
  for (const [scope, words] of [[SCOPE, "radar guide --scope example --item '<item ID>'"], [null, "radar guide --item '<item ID>'"]]) {
    const note = radarNote(scope, context);
    assert.ok(note.includes("`" + commandFor(words, context) + "`. Replace `<item ID>` with the item's ID."), note);
    assert.deepEqual([...note.matchAll(COMPACT_COMMAND)], []);
    commands.push(commandFor(words, context));
  }
  // Every angle-bracket placeholder sits inside single quotes, so a copied command that keeps one redirects nothing:
  // the shell runs each command with printf in place of node, in an empty folder, and the folder stays empty.
  const dir = mkdtempSync(join(tmpdir(), "devtwin-form-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const command of commands) {
    assert.doesNotMatch(command.replace(/'[^']*'/g, ""), /[<>]/, command);
    const run = spawnSync("/bin/sh", ["-c", command.replace(/^node /, "printf '%s\\n' ")], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(/^<[a-z ID.]+>$/m.test(run.stdout), run.stdout);
    assert.deepEqual(readdirSync(dir), [], command);
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
