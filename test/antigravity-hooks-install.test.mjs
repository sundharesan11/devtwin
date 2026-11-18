import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import { makePilot, runCli, now } from "./helpers.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";
import { planHooks, applyHooks, hookStatus, expectedEntries, hookContext, inventoryHookFile } from "../src/agents/hooks-install.mjs";
import { rollbackCheck } from "../src/agents/inventory.mjs";
import { sha256, canonicalJson } from "../src/storage/canonical.mjs";

const KIT = realpathSync(join(import.meta.dirname, ".."));
const EVENTS = ["SessionStart", "PreInvocation", "PreToolUse", "PostToolUse", "Stop"];
// Another tool's named hook, as a real ~/.gemini/config/hooks.json holds it next to devtwin's: flat handlers for the
// lifecycle events and matcher groups for the tool events.
const handler = (word) => ({ type: "command", command: "/bin/sh -c 'example-status " + word + "'", timeout: 10 });
const SAMPLE = { PreInvocation: [handler("busy")], Stop: [handler("idle")], PreToolUse: [{ matcher: "*", hooks: [handler("tool")] }], PostToolUse: [{ matcher: "*", hooks: [handler("done")] }] };
const text = (value, indent = 4) => JSON.stringify(value, null, indent) + "\n";
// A disposable pilot whose first fake agent home has the Antigravity hooks file approved as a hook target. The agent
// folder ~/.gemini/config exists unless folder is false.
async function agyPilot(t, { file, folder = true } = {}) {
  const p = await makePilot(t), home = p.agentHomes[0], path = join(home, ".gemini/config/hooks.json");
  await mkdir(join(home, folder ? ".gemini/config" : ".gemini"), { recursive: true });
  if (file !== undefined) await writeFile(path, file, { mode: 0o644 });
  const pilotPath = await p.with({ writeClasses: { hookTargets: [path] } });
  const pilot = await loadPilot(pilotPath, { home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {} });
  return { ...p, home, file: path, pilotPath, pilot, roots: rootsFromPilot(pilot), expected: expectedEntries("antigravity", hookContext(pilot, KIT)) };
}
const hookInput = (h, mode = "install", kitRoot = KIT) => ({ targetHome: h.home, agents: ["antigravity"], mode, kitRoot });
async function agyHooks(h, mode, runId, kitRoot) {
  const plan = await planHooks(h.pilot, hookInput(h, mode, kitRoot));
  return { plan, result: await applyHooks(h.roots, h.pilot, hookInput(h, mode, kitRoot), { fingerprint: plan.fingerprint, runId, now: now() }) };
}
const cli = async (h, args) => {
  const out = await runCli([...args, "--pilot", h.pilotPath, "--home", h.home]);
  assert.equal(out.code, 0, JSON.stringify(out.json));
  return out.json.result;
};
const agyStatus = async (h) => (await hookStatus(h.pilot, { targetHome: h.home, kitRoot: KIT, now: now() })).agents.find((a) => a.agent === "antigravity");
const read = (h) => readFile(h.file, "utf8");

test("antigravity hook entries are flat handlers for lifecycle events and matcher groups for tool events", async (t) => {
  const h = await agyPilot(t), pilotPath = realpathSync(h.pilotPath);
  const flat = (event) => [{ type: "command", command: 'node "' + KIT + '/bin/devtwin.mjs" hook --event ' + event + ' --agent antigravity --pilot "' + pilotPath + '"', timeout: 10 }];
  const group = (event, matcher) => [{ matcher, hooks: flat(event) }];
  const exact = { SessionStart: flat("session-start"), PreInvocation: flat("user-prompt"), PreToolUse: group("pre-tool", "run_command|manage_task"),
    PostToolUse: group("post-tool", "run_command|manage_task|read_file|view_file|write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|list_dir|find_by_name|grep_search"), Stop: flat("stop") };
  // The same keys in the same order, so the bytes of a new file are fixed.
  assert.equal(JSON.stringify(h.expected), JSON.stringify(exact));
  assert.deepEqual(Object.keys(h.expected), EVENTS);
  // The install plan lists each of them as one added entry.
  const plan = await planHooks(h.pilot, hookInput(h));
  assert.deepEqual(plan.actions.map((a) => [a.agent, a.status, a.path]), [["antigravity", "create", h.file]]);
  assert.deepEqual(plan.actions[0].changes, EVENTS.map((event) => ({ event, op: "add", entry: exact[event][0] })));
});

test("antigravity hooks install under the devtwin name in hooks.json, keep another named hook and its bytes, and are idempotent", async (t) => {
  const original = text({ "sample-status": SAMPLE });
  const h = await agyPilot(t, { file: original });
  // Through the real CLI: a preview, then the apply.
  const args = ["agents", "install", "--hooks", "--agent", "antigravity"];
  const preview = await cli(h, args);
  assert.equal(preview.kind, "hook-install");
  assert.deepEqual(preview.actions.map((a) => [a.agent, a.status, a.path]), [["antigravity", "update", h.file]]);
  assert.deepEqual(preview.actions[0].events, EVENTS.map((event) => ({ event, status: "missing" })), "the other named hook's entries are not devtwin's events");
  assert.deepEqual([preview.actions[0].foreign, preview.notes], [[], []]);
  assert.equal(await read(h), original, "preview writes nothing");
  assert.equal((await cli(h, [...args, "--apply", "--plan-fingerprint", preview.fingerprint])).applied, true);
  const after = await read(h);
  assert.equal(after, text({ "sample-status": SAMPLE, devtwin: h.expected }), "devtwin's entries sit under the devtwin name, after the other hook, with the file's own indent");
  // Every byte of the other named hook is unchanged: the new file starts with the old one up to that hook's closing brace.
  assert.ok(after.startsWith(original.slice(0, -"\n}\n".length) + ',\n    "devtwin": {\n        "SessionStart": [\n'), after);
  assert.deepEqual(Object.keys(JSON.parse(after)), ["sample-status", "devtwin"], "no hooks key");
  assert.equal((await lstat(h.file)).mode & 0o777, 0o644);
  // Idempotent: a second plan reports installed, and its apply writes nothing.
  const again = await cli(h, args);
  assert.deepEqual([again.actions[0].status, again.actions[0].events], ["installed", EVENTS.map((event) => ({ event, status: "installed" }))]);
  assert.equal((await cli(h, [...args, "--apply", "--plan-fingerprint", again.fingerprint])).applied, false);
  assert.equal(await read(h), after);
  const status = (await cli(h, ["agents", "status"])).hooks;
  // Status rows are sorted by agent id. Gemini CLI is not listed: its own file is not an approved hook target.
  assert.deepEqual(status.agents.map((a) => [a.agent, a.status]), [["antigravity", "installed"], ["claude", "not-approved"], ["codex", "not-approved"]]);
  assert.deepEqual([status.receipt, status.notes], ["ok", []]);
  // An absent file is created with the devtwin name only, and the folder is left as it was.
  const c = await agyPilot(t);
  const { plan, result } = await agyHooks(c, "install", "run_agynew001");
  assert.deepEqual([plan.actions[0].status, result.applied], ["create", true]);
  assert.equal(await read(c), text({ devtwin: c.expected }, 2));
  assert.equal((await lstat(c.file)).mode & 0o777, 0o600);
  assert.equal((await planHooks(c.pilot, hookInput(c))).actions[0].status, "installed");
  // A new file that the uninstall empties keeps an empty object, as the other agents' files do.
  await agyHooks(c, "uninstall", "run_agynew002");
  assert.equal(await read(c), "{}\n");
});

test("antigravity hooks uninstall removes only devtwin's handlers, drops the empty devtwin key and keeps an enabled key", async (t) => {
  const original = text({ "sample-status": SAMPLE }, "\t");
  const h = await agyPilot(t, { file: original });
  await agyHooks(h, "install", "run_agyrm0001");
  assert.equal(await read(h), text({ "sample-status": SAMPLE, devtwin: h.expected }, "\t"), "a tab indent stays a tab indent");
  const first = await agyHooks(h, "uninstall", "run_agyrm0002");
  assert.deepEqual([first.plan.actions[0].status, first.result.applied], ["remove", true]);
  assert.deepEqual(first.plan.actions[0].changes, EVENTS.map((event) => ({ event, op: "remove", entry: h.expected[event][0] })));
  assert.equal(await read(h), original, "the emptied event lists and the devtwin key are gone, and the other hook is byte-identical");
  assert.equal((await planHooks(h.pilot, hookInput(h, "uninstall"))).actions[0].status, "absent");
  // The agent's own /hooks screen can write "enabled" inside devtwin. It is not devtwin's, so the object stays.
  await agyHooks(h, "install", "run_agyrm0003");
  const off = JSON.parse(await read(h));
  off.devtwin.enabled = false;
  await writeFile(h.file, text(off, "\t"));
  assert.equal((await agyStatus(h)).status, "installed");
  await agyHooks(h, "uninstall", "run_agyrm0004");
  assert.equal(await read(h), text({ "sample-status": SAMPLE, devtwin: { enabled: false } }, "\t"));
  // An install into that object keeps the key. A handler that devtwin did not write stays after the next uninstall,
  // flat or grouped, and so does its event list.
  await agyHooks(h, "install", "run_agyrm0005");
  const mixed = JSON.parse(await read(h));
  assert.deepEqual(mixed.devtwin, { enabled: false, ...h.expected });
  mixed.devtwin.Stop.unshift(handler("own"));
  mixed.devtwin.PostToolUse.push({ matcher: "*", hooks: [handler("own")] });
  await writeFile(h.file, text(mixed, "\t"));
  assert.equal((await agyStatus(h)).status, "installed");
  await agyHooks(h, "uninstall", "run_agyrm0006");
  assert.equal(await read(h), text({ "sample-status": SAMPLE, devtwin: { enabled: false, PostToolUse: [{ matcher: "*", hooks: [handler("own")] }], Stop: [handler("own")] } }, "\t"));
});

test("antigravity hooks status reports an edited handler as modified, a missing event as partial and an earlier kit path as outdated", async (t) => {
  const h = await agyPilot(t, { file: text({ "sample-status": SAMPLE }) });
  // An install from an earlier kit folder: devtwin wrote the entries, and their lines name the old kit.
  const old = join(h.sandbox, "kit-old");
  await mkdir(old);
  await agyHooks(h, "install", "run_agyst0001", old);
  assert.ok(JSON.parse(await read(h)).devtwin.Stop[0].command.startsWith('node "' + old + '/bin/devtwin.mjs" hook --event stop --agent antigravity '));
  let status = await agyStatus(h);
  assert.deepEqual([status.status, status.events], ["outdated", EVENTS.map((event) => ({ event, status: "outdated" }))]);
  // An edit to an old flat handler is an edit of a line devtwin wrote: modified, not a look-alike of another pilot.
  const stale = await read(h), touched = JSON.parse(stale);
  touched.devtwin.Stop[0].timeout = 99;
  await writeFile(h.file, text(touched));
  status = await agyStatus(h);
  assert.deepEqual([status.status, status.events.find((e) => e.event === "Stop").status, status.foreign], ["modified", "modified", []]);
  await writeFile(h.file, stale);
  // The next install replaces each old entry in place, flat or grouped, and leaves no second copy.
  const { plan } = await agyHooks(h, "install", "run_agyst0002");
  assert.equal(plan.actions[0].status, "update");
  assert.deepEqual(plan.actions[0].changes.map((c) => [c.event, c.op]), EVENTS.flatMap((event) => [[event, "remove"], [event, "add"]]));
  const installed = JSON.parse(await read(h));
  assert.deepEqual(installed, { "sample-status": SAMPLE, devtwin: h.expected });
  assert.equal((await agyStatus(h)).status, "installed");
  // A missing event: partial, and only that event is missing.
  const edited = structuredClone(installed);
  delete edited.devtwin.PreInvocation;
  await writeFile(h.file, text(edited));
  status = (await cli(h, ["agents", "status"])).hooks.agents.find((a) => a.agent === "antigravity");
  assert.equal(status.status, "partial");
  assert.deepEqual(status.events.filter((e) => e.status !== "installed"), [{ event: "PreInvocation", status: "missing" }]);
  // An edited flat handler, then an edited group: modified, and an install refuses to write over either.
  edited.devtwin.Stop[0].timeout = 99;
  await writeFile(h.file, text(edited));
  status = await agyStatus(h);
  assert.deepEqual([status.status, status.events.find((e) => e.event === "Stop").status], ["modified", "modified"]);
  const blocked = await planHooks(h.pilot, hookInput(h));
  assert.deepEqual([blocked.actions[0].status, blocked.actions[0].reason], ["conflict", "modified"]);
  edited.devtwin.Stop[0].timeout = 10;
  edited.devtwin.PreToolUse[0].matcher = "run_command";
  await writeFile(h.file, text(edited));
  status = await agyStatus(h);
  assert.deepEqual(status.events.filter((e) => e.status !== "installed"), [{ event: "PreInvocation", status: "missing" }, { event: "PreToolUse", status: "modified" }]);
  assert.equal(status.status, "modified");
  // Uninstall removes the untouched entries and keeps the edited one.
  await agyHooks(h, "uninstall", "run_agyst0003");
  assert.deepEqual(JSON.parse(await read(h)), { "sample-status": SAMPLE, devtwin: { PreToolUse: edited.devtwin.PreToolUse } });
});

test("antigravity hook inventory and rollback check read the devtwin container", async (t) => {
  const original = text({ "sample-status": SAMPLE });
  const h = await agyPilot(t, { file: original }), pilotPath = realpathSync(h.pilotPath);
  const hash = (value) => sha256(Buffer.from(value));
  // Before the install: the file exists, and the other named hook is in neither list.
  assert.deepEqual(inventoryHookFile("antigravity", h.file, pilotPath), { agent: "antigravity", path: h.file, existed: true, sha256: hash(original), devtwin: [], foreign: [] });
  await agyHooks(h, "install", "run_agyinv001");
  const stored = JSON.parse(await readFile(join(h.stateRoot, "runs/run_agyinv001/inventory.json"), "utf8"));
  assert.deepEqual(stored.files, [{ agent: "antigravity", path: h.file, existed: true, sha256: hash(original), devtwin: [], foreign: [] }]);
  const rows = EVENTS.map((event) => ({ event, entry: h.expected[event][0] }));
  const installed = await read(h);
  assert.deepEqual(inventoryHookFile("antigravity", h.file, pilotPath), { agent: "antigravity", path: h.file, existed: true, sha256: hash(installed), devtwin: rows, foreign: [] });
  // The rollback check sees the five entries the run added, flat and grouped.
  await assert.rejects(rollbackCheck(h.roots, h.pilot, { runId: "run_agyinv001" }), (e) => e.code === "DEVTWIN_ROLLBACK_MISMATCH"
    && JSON.stringify(e.details.files.map((f) => [f.agent, f.devtwin, f.foreign])) === JSON.stringify([["antigravity", rows.map((row) => ({ change: "added", row })), []]]));
  // Inside devtwin, an "enabled" key is no entry and a handler of the developer's own is a foreign row with a hash only.
  const own = handler("own"), mixed = JSON.parse(installed);
  mixed.devtwin.enabled = false;
  mixed.devtwin.Stop.push(own);
  await writeFile(h.file, text(mixed));
  const seen = inventoryHookFile("antigravity", h.file, pilotPath);
  assert.deepEqual([seen.devtwin, seen.foreign], [rows, [{ event: "Stop", sha256: sha256(Buffer.from(canonicalJson(own))) }]]);
  // After the uninstall the check passes through the real CLI, and lists the developer's handler as a foreign change.
  await agyHooks(h, "uninstall", "run_agyinv002");
  const check = await runCli(["agents", "rollback-check", "--pilot", h.pilotPath, "--run-id", "run_agyinv001"]);
  assert.equal(check.code, 0, JSON.stringify(check.json));
  assert.deepEqual([check.json.result.status, check.json.result.files.map((f) => [f.agent, f.existedBefore, f.existsNow, f.devtwin, f.foreign.map((d) => [d.change, d.row.event])])], ["ok", [["antigravity", true, true, [], [["added", "Stop"]]]]]);
  // A devtwin value that is not an object has no entries, and a "hooks" key is another name in this file.
  await writeFile(h.file, text({ devtwin: h.expected.Stop, hooks: h.expected }));
  const none = inventoryHookFile("antigravity", h.file, pilotPath);
  assert.deepEqual([none.existed, none.devtwin, none.foreign], [true, [], []]);
});

test("antigravity hooks refuse a devtwin key that is not an object and a missing agent folder", async (t) => {
  for (const [bad, reason] of [[text({ "sample-status": SAMPLE, devtwin: [] }), "unexpected-shape"], [text({ devtwin: "on" }), "unexpected-shape"], [text({ devtwin: null }), "unexpected-shape"],
    [text({ devtwin: { Stop: { type: "command" } } }), "unexpected-shape"], [text([{ devtwin: {} }]), "unexpected-shape"], ['{ "devtwin": {', "invalid-json"]]) {
    const h = await agyPilot(t, { file: bad });
    for (const mode of ["install", "uninstall"]) {
      const plan = await planHooks(h.pilot, hookInput(h, mode));
      assert.deepEqual(plan.actions.map((a) => [a.agent, a.status, a.reason]), [["antigravity", "conflict", reason]], bad);
      const result = await applyHooks(h.roots, h.pilot, hookInput(h, mode), { fingerprint: plan.fingerprint, runId: "run_agybad0" + mode, now: now() });
      assert.equal(result.applied, false, bad);
    }
    assert.equal(await read(h), bad, "the file is never written");
    assert.equal((await agyStatus(h)).status, reason, bad);
  }
  // A top-level "hooks" key is another hook's name in this file: its shape is not devtwin's concern and it stays.
  const named = text({ hooks: ["example"], "sample-status": SAMPLE });
  const ok = await agyPilot(t, { file: named });
  await agyHooks(ok, "install", "run_agyname01");
  assert.equal(await read(ok), text({ hooks: ["example"], "sample-status": SAMPLE, devtwin: ok.expected }));
  await agyHooks(ok, "uninstall", "run_agyname02");
  assert.equal(await read(ok), named);
  // devtwin creates no agent folder: without ~/.gemini/config the row is blocked and nothing is written.
  const h = await agyPilot(t, { folder: false });
  const args = ["agents", "install", "--hooks", "--agent", "antigravity"];
  const preview = await cli(h, args);
  assert.deepEqual(preview.actions, [{ agent: "antigravity", path: h.file, status: "blocked", reason: "agent-folder-missing" }]);
  assert.equal((await cli(h, [...args, "--apply", "--plan-fingerprint", preview.fingerprint])).applied, false);
  assert.equal(existsSync(join(h.home, ".gemini/config")), false);
  assert.equal((await agyStatus(h)).status, "agent-folder-missing");
  // A folder that is a file is no agent folder either.
  await writeFile(join(h.home, ".gemini/config"), "example\n");
  assert.deepEqual((await planHooks(h.pilot, hookInput(h))).actions.map((a) => [a.status, a.reason]), [["blocked", "agent-folder-missing"]]);
  assert.equal(await readFile(join(h.home, ".gemini/config"), "utf8"), "example\n");
});

// The agents whose hook file keeps its event lists under "hooks", where every entry is a group: the agent, its hook
// file and its name for the event that ends a turn.
const GROUPED = [["claude", ".claude/settings.json", "Stop"], ["codex", ".codex/hooks.json", "Stop"], ["gemini", ".gemini/settings.json", "AfterAgent"]];

test("a top-level command in a Claude Code, Codex or Gemini CLI hook entry is not read as a handler", async (t) => {
  const p = await makePilot(t), home = p.agentHomes[0], hash = (value) => sha256(Buffer.from(canonicalJson(value)));
  for (const [, file] of GROUPED) await mkdir(dirname(join(home, file)), { recursive: true });
  const pilotPath = await p.with({ writeClasses: { hookTargets: GROUPED.map(([, file]) => join(home, file)) } });
  const pilot = await loadPilot(pilotPath, { home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {} }), roots = rootsFromPilot(pilot), context = hookContext(pilot, KIT);
  for (const [agent, file, stop] of GROUPED) {
    const path = join(home, file), expected = expectedEntries(agent, context), names = Object.keys(expected);
    const input = (mode) => ({ targetHome: home, agents: [agent], mode, kitRoot: KIT });
    const run = async (mode, runId) => applyHooks(roots, pilot, input(mode), { fingerprint: (await planHooks(pilot, input(mode))).fingerprint, runId, now: now() });
    const line = 'node "' + KIT + '/bin/devtwin.mjs" hook --event stop --agent ' + agent + ' --pilot "' + realpathSync(pilotPath) + '"';
    assert.equal(expected[stop][0].hooks[0].command, line, "the hand-written command below is devtwin's exact line for this pilot");
    // Other hand-written shapes first: a top-level command never counts, with or without a hooks list, and the
    // handlers in a hooks list always do.
    const lint = { type: "command", command: "example-lint --check" }, away = 'node "/opt/kit/bin/devtwin.mjs" hook --event stop --agent ' + agent + ' --pilot "/other/live.json"';
    for (const [entry, status, reason, mine] of [[{ command: lint.command }, "update", undefined, 0], [{ command: away }, "update", undefined, 0], [{ command: line, hooks: [lint] }, "update", undefined, 0],
      [{ command: lint.command, hooks: expected[stop][0].hooks }, "conflict", "modified", 1]]) {
      await writeFile(path, text({ hooks: { [stop]: [entry] } }, 2));
      const action = (await planHooks(pilot, input("install"))).actions[0], seen = inventoryHookFile(agent, path, context.pilotPath);
      assert.deepEqual([action.status, action.reason, action.foreign, seen.devtwin.length, seen.foreign.length], [status, reason, [], mine, 1 - mine], agent + " " + JSON.stringify(entry));
    }
    // The exact line at the top of an entry, with no hooks list. The agent runs no such entry, so the event is missing.
    const hand = { command: line }, original = text({ hooks: { [stop]: [hand] } }, 2);
    await writeFile(path, original);
    const before = { agent, path, existed: true, sha256: sha256(Buffer.from(original)), devtwin: [], foreign: [{ event: stop, sha256: hash(hand) }] };
    assert.deepEqual(inventoryHookFile(agent, path, context.pilotPath), before, agent);
    const plan = await planHooks(pilot, input("install"));
    assert.deepEqual(plan.actions.map((a) => [a.agent, a.status, a.reason, a.foreign]), [[agent, "update", undefined, []]]);
    assert.deepEqual(plan.actions[0].events, names.map((event) => ({ event, status: "missing" })), agent);
    assert.deepEqual(plan.actions[0].changes, names.map((event) => ({ event, op: "add", entry: expected[event][0] })), agent);
    // The install adds devtwin's own entry after the hand-written one, which keeps its place and its content.
    assert.equal((await run("install", "run_top" + agent + "01")).applied, true);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { hooks: { ...expected, [stop]: [hand, expected[stop][0]] } }, agent);
    assert.deepEqual(JSON.parse(await readFile(join(p.stateRoot, "runs/run_top" + agent + "01/inventory.json"), "utf8")).files, [before], "the stored inventory lists it as foreign");
    // The file's own key order: the stop event was there first, and the install added the other events after it.
    const seen = inventoryHookFile(agent, path, context.pilotPath);
    assert.deepEqual([seen.devtwin, seen.foreign], [[stop, ...names.filter((name) => name !== stop)].map((event) => ({ event, entry: expected[event][0] })), before.foreign], agent);
    const again = (await planHooks(pilot, input("install"))).actions[0];
    assert.deepEqual([again.status, again.events, again.foreign], ["installed", names.map((event) => ({ event, status: "installed" })), []], agent);
    // The uninstall removes devtwin's entries only: the file is the hand-written one again.
    assert.equal((await run("uninstall", "run_top" + agent + "02")).applied, true);
    assert.equal(await readFile(path, "utf8"), original, agent);
  }
});

test("antigravity hooks treat a hand-written copy of devtwin's handler as foreign and keep a devtwin-like handler of another pilot", async (t) => {
  // An exact copy of every entry, written by hand: no journal of this pilot wrote it, so it is not devtwin's.
  const h = await agyPilot(t), copy = text({ "sample-status": SAMPLE, devtwin: h.expected });
  await writeFile(h.file, copy, { mode: 0o644 });
  const marked = EVENTS.map((event) => ({ event, status: "foreign-entry" }));
  for (const [mode, status, reason] of [["install", "conflict", "foreign-entry"], ["uninstall", "absent", undefined]]) {
    const plan = await planHooks(h.pilot, hookInput(h, mode));
    assert.deepEqual(plan.actions.map((a) => [a.agent, a.status, a.reason, a.events, a.foreign]), [["antigravity", status, reason, marked, []]], mode);
    assert.equal((await applyHooks(h.roots, h.pilot, hookInput(h, mode), { fingerprint: plan.fingerprint, runId: "run_agycopy" + mode, now: now() })).applied, false, mode);
  }
  assert.equal(await read(h), copy, "neither mode writes the file");
  assert.equal((await agyStatus(h)).status, "foreign-entry");
  // A near copy, one field away, still carries devtwin's own line for this pilot: modified, not a look-alike.
  const near = JSON.parse(copy);
  near.devtwin.SessionStart[0].timeout = 99;
  near.devtwin.Stop[0].timeout = 99;
  await writeFile(h.file, text(near));
  const edited = await agyStatus(h);
  assert.deepEqual([edited.status, ...["SessionStart", "Stop"].map((name) => edited.events.find((e) => e.event === name).status), edited.foreign], ["modified", "modified", "modified", []]);
  // A flat handler whose line names another pilot: it looks like devtwin's, so the plan lists it, and it is left alone.
  const other = { type: "command", command: 'node "/opt/kit/bin/devtwin.mjs" hook --event stop --agent antigravity --pilot "/other/live.json"', timeout: 10 };
  const original = text({ "sample-status": SAMPLE, devtwin: { Stop: [other] } });
  const o = await agyPilot(t, { file: original }), listed = [{ event: "Stop", index: 0, reason: "devtwin-like-entry" }];
  const preview = await planHooks(o.pilot, hookInput(o));
  assert.deepEqual([preview.actions[0].status, preview.actions[0].events, preview.actions[0].foreign], ["update", EVENTS.map((event) => ({ event, status: "missing" })), listed]);
  assert.deepEqual((await planHooks(o.pilot, hookInput(o, "uninstall"))).actions.map((a) => [a.status, a.foreign]), [["absent", listed]]);
  assert.equal((await agyHooks(o, "install", "run_agyother1")).result.applied, true);
  assert.deepEqual(JSON.parse(await read(o)), { "sample-status": SAMPLE, devtwin: { ...o.expected, Stop: [other, o.expected.Stop[0]] } }, "devtwin's handler follows the other pilot's, which keeps its place");
  const installed = await planHooks(o.pilot, hookInput(o));
  assert.deepEqual([installed.actions[0].status, installed.actions[0].events, installed.actions[0].foreign], ["installed", EVENTS.map((event) => ({ event, status: "installed" })), listed]);
  const seen = inventoryHookFile("antigravity", o.file, realpathSync(o.pilotPath));
  assert.deepEqual(seen.foreign, [{ event: "Stop", sha256: sha256(Buffer.from(canonicalJson(other))) }], "the inventory holds its hash only");
  const removal = await agyHooks(o, "uninstall", "run_agyother2");
  assert.deepEqual([removal.plan.actions[0].status, removal.plan.actions[0].foreign, removal.result.applied], ["remove", listed, true]);
  assert.equal(await read(o), original, "the other pilot's handler is unchanged after the install and the uninstall");
});
