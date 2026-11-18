import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, writeFile, readFile, readdir, lstat, chmod, rm, rename, symlink } from "node:fs/promises";
import { sandbox, makePilot, makeRepo, fixtureGit, runCli, treeSnapshot, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";
import { adapter } from "../src/agents/adapters/index.mjs";
import { planHooks, applyHooks, hookStatus, expectedEntries, hookContext, inventoryHookFile, hookRecoveryFor } from "../src/agents/hooks-install.mjs";
import { agentsInstallCommand, agentsStatusCommand } from "../src/agents/commands.mjs";
import { installStatus, planRecovery, applyRecovery, SKILL_NAMES } from "../src/agents/install.mjs";
import { stableNodePath } from "../src/schedule/launchd.mjs";
import { rollbackCheck } from "../src/agents/inventory.mjs";
import { editOwnedFile } from "../src/storage/owned-file.mjs";
import { sha256 } from "../src/storage/canonical.mjs";

// The OpenCode hook target is one whole file that devtwin generates, <home>/.config/opencode/plugins/devtwin.js. The
// hook installer treats it as one pseudo-event, file, with one entry, the hash of the file's text.
const KIT = realpathSync(join(import.meta.dirname, ".."));
const REL = ".config/opencode/plugins/devtwin.js", SHOWN = "~/" + REL;
const OPTS = (p) => ({ home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {} });
const hash = (text) => sha256(Buffer.from(text));
const row = (status) => [{ event: "file", status }];
const crash = () => { throw new Error("injected crash"); };
// A plugin that a person or another tool wrote.
const OWN = "export default { id: \"sample\" };\n";
// A disposable pilot whose first fake agent home has the plugin file approved as a hook target. The folder
// ~/.config/opencode/plugins exists unless folder is false. more lists other hook files to approve, relative to the home.
async function ocPilot(t, { file, folder = true, more = [] } = {}) {
  const p = await makePilot(t), home = p.agentHomes[0], path = join(home, REL);
  await mkdir(folder ? dirname(path) : join(home, ".config/opencode"), { recursive: true });
  for (const rel of more) await mkdir(dirname(join(home, rel)), { recursive: true });
  if (file !== undefined) await writeFile(path, file, { mode: 0o644 });
  const pilotPath = await p.with({ writeClasses: { hookTargets: [path, ...more.map((rel) => join(home, rel))] } });
  const pilot = await loadPilot(pilotPath, OPTS(p));
  // The text the installer writes for a kit folder: the adapter renders it from the hook context.
  const textFor = (kitRoot) => adapter("opencode").hooks.content(hookContext(pilot, kitRoot));
  return { ...p, home, file: path, pilotPath, pilot, roots: rootsFromPilot(pilot), text: textFor(KIT), textFor };
}
const hookInput = (h, mode = "install", kitRoot = KIT, agents = ["opencode"]) => ({ targetHome: h.home, agents, mode, kitRoot });
async function ocHooks(h, mode, runId, kitRoot, options) {
  const plan = await planHooks(h.pilot, hookInput(h, mode, kitRoot));
  return { plan, result: await applyHooks(h.roots, h.pilot, hookInput(h, mode, kitRoot), { fingerprint: plan.fingerprint, runId, now: now() }, options) };
}
const cli = async (h, args) => {
  const out = await runCli([...args, "--pilot", h.pilotPath, "--home", h.home]);
  assert.equal(out.code, 0, JSON.stringify(out.json));
  return out.json.result;
};
const ocStatus = async (h) => (await hookStatus(h.pilot, { targetHome: h.home, kitRoot: KIT, now: now() })).agents.find((a) => a.agent === "opencode");
const read = (h) => readFile(h.file, "utf8");
const stored = async (h, runId, name) => JSON.parse(await readFile(join(h.stateRoot, "runs", runId, name + ".json"), "utf8"));
// The one backup a run wrote for a file.
async function backupOf(h, runId) {
  const dir = join(h.stateRoot, "runs", runId, "backups");
  return readFile(join(dir, (await readdir(dir)).find((name) => name.endsWith(".bak"))), "utf8");
}

test("opencode plugin install creates the file with the generated text, is idempotent, and status reports installed", async (t) => {
  const h = await ocPilot(t), entry = { sha256: hash(h.text) }, args = ["agents", "install", "--hooks", "--agent", "opencode"];
  // The text names this kit and this pilot, and ends with a newline. Its hash is the one expected entry.
  assert.ok(h.text.endsWith(";\n") && h.text.includes(", KIT = " + JSON.stringify(KIT) + ", PILOT = " + JSON.stringify(realpathSync(h.pilotPath)) + ";\n"), h.text.slice(0, 600));
  assert.deepEqual(expectedEntries("opencode", hookContext(h.pilot, KIT)), { file: [entry] });
  // Through the real CLI: a preview, then the apply.
  const preview = await cli(h, args);
  assert.equal(preview.kind, "hook-install");
  assert.deepEqual(preview.actions, [{ agent: "opencode", path: h.file, status: "create", before: null, after: entry.sha256, events: row("missing"), changes: [{ event: "file", op: "add", entry }], foreign: [] }]);
  assert.deepEqual(preview.notes, []);
  assert.equal(existsSync(h.file), false, "preview writes nothing");
  assert.equal((await cli(h, [...args, "--apply", "--plan-fingerprint", preview.fingerprint, "--run-id", "run_ocnew0001"])).applied, true);
  assert.equal(await read(h), h.text);
  // A created hook file is private, as for the other agents, and the write leaves nothing else in the folder.
  assert.equal((await lstat(h.file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dirname(h.file)), ["devtwin.js"]);
  // The journal keeps the shape of the other agents' journals: one entry list under the pseudo-event.
  const journal = await stored(h, "run_ocnew0001", "journal");
  assert.deepEqual([journal.schemaVersion, journal.kind, journal.mode, journal.started, journal.completed], [1, "hook-bundled", "install", [0], [0]]);
  assert.deepEqual(journal.intended, [{ agent: "opencode", path: h.file, status: "create", before: null, after: entry.sha256, entries: { file: [entry] } }]);
  // Idempotent: a second plan reports installed, and its apply writes nothing.
  const again = await cli(h, args);
  assert.deepEqual(again.actions, [{ agent: "opencode", path: h.file, status: "installed", before: entry.sha256, events: row("installed"), foreign: [] }]);
  const second = await cli(h, [...args, "--apply", "--plan-fingerprint", again.fingerprint]);
  assert.deepEqual([second.applied, second.runId], [false, null]);
  assert.equal(await read(h), h.text);
  // Status rows are sorted by agent id, and the row has the shape of every other agent's row.
  const status = (await cli(h, ["agents", "status"])).hooks;
  assert.deepEqual(status.agents, [{ agent: "claude", path: join(h.home, ".claude/settings.json"), status: "not-approved" }, { agent: "codex", path: join(h.home, ".codex/hooks.json"), status: "not-approved" },
    { agent: "opencode", path: h.file, status: "installed", events: row("installed"), foreign: [] }]);
  assert.deepEqual([status.receipt, status.notes], ["ok", []]);
});

test("an OpenCode plugin from an earlier kit path reports outdated and an install rewrites it", async (t) => {
  // An install from an earlier kit folder: devtwin wrote the file, and its text names the old kit.
  const h = await ocPilot(t), old = join(h.sandbox, "kit-old");
  await mkdir(old);
  await ocHooks(h, "install", "run_ocold0001", old);
  const stale = h.textFor(old), was = { sha256: hash(stale) }, entry = { sha256: hash(h.text) };
  assert.equal(await read(h), stale);
  assert.ok(stale !== h.text && stale.includes(", KIT = " + JSON.stringify(old) + ", "));
  const status = (await cli(h, ["agents", "status"])).hooks.agents.find((a) => a.agent === "opencode");
  assert.deepEqual([status.status, status.events, status.foreign], ["outdated", row("outdated"), []]);
  // The next install replaces the whole file, and the run keeps the old bytes as a backup.
  const { plan, result } = await ocHooks(h, "install", "run_ocold0002");
  assert.deepEqual(plan.actions, [{ agent: "opencode", path: h.file, status: "update", before: was.sha256, after: entry.sha256, events: row("outdated"),
    changes: [{ event: "file", op: "remove", entry: was }, { event: "file", op: "add", entry }], foreign: [] }]);
  assert.equal(result.applied, true);
  assert.equal(await read(h), h.text);
  assert.equal(await backupOf(h, "run_ocold0002"), stale);
  assert.equal((await lstat(h.file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dirname(h.file)), ["devtwin.js"]);
  assert.equal((await ocStatus(h)).status, "installed");
  // The old text is still text that devtwin wrote here. Put back by hand it reads as outdated, and an uninstall removes it.
  await writeFile(h.file, stale);
  assert.equal((await ocStatus(h)).status, "outdated");
  const removal = await ocHooks(h, "uninstall", "run_ocold0003");
  assert.deepEqual(removal.plan.actions, [{ agent: "opencode", path: h.file, status: "remove", before: was.sha256, after: null, events: row("outdated"), changes: [{ event: "file", op: "remove", entry: was }], foreign: [] }]);
  assert.equal(existsSync(h.file), false);
});

test("an edited OpenCode plugin file is modified: install and uninstall refuse it and leave its bytes", async (t) => {
  const h = await ocPilot(t);
  await ocHooks(h, "install", "run_ocedit001");
  const edited = h.text.replace("TIMEOUT_MS = 10000", "TIMEOUT_MS = 99000");
  assert.notEqual(edited, h.text);
  await writeFile(h.file, edited);
  const status = await ocStatus(h);
  assert.deepEqual(status, { agent: "opencode", path: h.file, status: "modified", events: row("modified"), foreign: [] });
  for (const [mode, runId] of [["install", "run_ocedit002"], ["uninstall", "run_ocedit003"]]) {
    const plan = await planHooks(h.pilot, hookInput(h, mode));
    assert.deepEqual(plan.actions, [{ agent: "opencode", path: h.file, status: "conflict", reason: "modified", before: hash(edited), events: row("modified"), foreign: [] }], mode);
    const result = await applyHooks(h.roots, h.pilot, hookInput(h, mode), { fingerprint: plan.fingerprint, runId, now: now() });
    assert.deepEqual([result.applied, result.runId], [false, null], mode);
    assert.equal(existsSync(join(h.stateRoot, "runs", runId)), false, mode);
    assert.equal(await read(h), edited, mode);
  }
  // The real CLI reports the same for both routes.
  for (const route of ["install", "uninstall"]) {
    const preview = await cli(h, ["agents", route, "--hooks", "--agent", "opencode"]);
    assert.deepEqual([preview.actions[0].status, preview.actions[0].reason], ["conflict", "modified"], route);
    assert.equal((await cli(h, ["agents", route, "--hooks", "--agent", "opencode", "--apply", "--plan-fingerprint", preview.fingerprint])).applied, false, route);
  }
  assert.equal(await read(h), edited);
  // Any other content is modified too: one byte more, one byte less, an empty file.
  for (const other of [h.text + "\n", h.text.slice(0, -1), "", " " + h.text]) {
    await writeFile(h.file, other);
    assert.equal((await ocStatus(h)).status, "modified", JSON.stringify(other.slice(0, 20)));
    for (const mode of ["install", "uninstall"]) assert.deepEqual((await planHooks(h.pilot, hookInput(h, mode))).actions.map((a) => [a.status, a.reason]), [["conflict", "modified"]], mode);
    assert.equal(await read(h), other);
  }
  // The bytes that devtwin wrote, put back: the file is devtwin's again.
  await writeFile(h.file, h.text);
  assert.equal((await ocStatus(h)).status, "installed");
});

test("a plugin file that devtwin did not write is never overwritten or removed, even with the expected bytes", async (t) => {
  // The exact expected bytes, written by hand: no journal of this pilot wrote the file, so it is not devtwin's.
  const h = await ocPilot(t);
  await writeFile(h.file, h.text, { mode: 0o644 });
  for (const [expected, reason, f] of [[h.text, "foreign-entry", h], [OWN, "modified", await ocPilot(t, { file: OWN })]]) {
    const before = await treeSnapshot(dirname(f.file));
    assert.deepEqual(await ocStatus(f), { agent: "opencode", path: f.file, status: reason, events: row(reason), foreign: [] });
    for (const [mode, runId] of [["install", "run_ocown0001"], ["uninstall", "run_ocown0002"]]) {
      const plan = await planHooks(f.pilot, hookInput(f, mode));
      assert.deepEqual(plan.actions, [{ agent: "opencode", path: f.file, status: "conflict", reason, before: hash(expected), events: row(reason), foreign: [] }], reason + " " + mode);
      const result = await applyHooks(f.roots, f.pilot, hookInput(f, mode), { fingerprint: plan.fingerprint, runId, now: now() });
      assert.deepEqual([result.applied, result.runId], [false, null], reason + " " + mode);
    }
    assert.equal(await read(f), expected, reason);
    assert.equal(await treeSnapshot(dirname(f.file)), before, reason);
    assert.equal((await lstat(f.file)).mode & 0o777, 0o644, reason);
    assert.equal(existsSync(join(f.stateRoot, "runs")), false, "no run folder, so no journal and no backup");
  }
  // A run that writes another agent's file leaves the foreign plugin file alone and takes no ownership of it.
  const m = await ocPilot(t, { more: [".claude/settings.json"] }), input = hookInput(m, "install", KIT, ["claude", "opencode"]);
  await writeFile(m.file, m.text, { mode: 0o644 });
  const plan = await planHooks(m.pilot, input);
  assert.deepEqual(plan.actions.map((a) => [a.agent, a.status, a.reason]), [["claude", "create", undefined], ["opencode", "conflict", "foreign-entry"]]);
  assert.equal((await applyHooks(m.roots, m.pilot, input, { fingerprint: plan.fingerprint, runId: "run_ocown0003", now: now() })).applied, true);
  assert.deepEqual((await stored(m, "run_ocown0003", "journal")).intended.map((e) => e.agent), ["claude"]);
  assert.equal((await ocStatus(m)).status, "foreign-entry");
  assert.equal(await read(m), m.text);
  assert.equal((await lstat(m.file)).mode & 0o777, 0o644);
  // Ownership is for one path. Two agent homes of one pilot approve the plugin path, and devtwin installs into the
  // first. The same expected bytes, written by hand into the second, are not devtwin's: the journal names the first
  // path only, so a hash that it recorded for another path gives no ownership here.
  const two = await makePilot(t), files = two.agentHomes.map((home) => join(home, REL));
  for (const file of files) await mkdir(dirname(file), { recursive: true });
  const pilot = await loadPilot(await two.with({ writeClasses: { hookTargets: files } }), OPTS(two));
  const a = { ...two, home: two.agentHomes[0], file: files[0], pilot, roots: rootsFromPilot(pilot) }, b = { ...a, home: two.agentHomes[1], file: files[1] };
  const text = adapter("opencode").hooks.content(hookContext(pilot, KIT)), entry = { sha256: hash(text) };
  await ocHooks(a, "install", "run_octwo0001");
  await writeFile(b.file, text, { mode: 0o644 });
  assert.deepEqual([await read(a), await read(b), (await stored(a, "run_octwo0001", "journal")).intended.map((e) => e.path)], [text, text, [a.file]]);
  assert.deepEqual([await ocStatus(a), await ocStatus(b)], [{ agent: "opencode", path: a.file, status: "installed", events: row("installed"), foreign: [] }, { agent: "opencode", path: b.file, status: "foreign-entry", events: row("foreign-entry"), foreign: [] }]);
  const snapshot = await treeSnapshot(dirname(b.file));
  for (const [mode, runId] of [["install", "run_octwo0002"], ["uninstall", "run_octwo0003"]]) {
    const refusal = await planHooks(pilot, hookInput(b, mode));
    assert.deepEqual(refusal.actions, [{ agent: "opencode", path: b.file, status: "conflict", reason: "foreign-entry", before: entry.sha256, events: row("foreign-entry"), foreign: [] }], mode);
    const result = await applyHooks(b.roots, pilot, hookInput(b, mode), { fingerprint: refusal.fingerprint, runId, now: now() });
    assert.deepEqual([result.applied, result.runId, existsSync(join(b.stateRoot, "runs", runId))], [false, null, false], mode);
  }
  assert.deepEqual([await read(b), await treeSnapshot(dirname(b.file)), (await lstat(b.file)).mode & 0o777], [text, snapshot, 0o644]);
  // The first home's file is still devtwin's: its uninstall removes that one file, and the second keeps its bytes.
  assert.deepEqual((await ocHooks(a, "uninstall", "run_octwo0004")).plan.actions.map((action) => [action.path, action.status]), [[a.file, "remove"]]);
  assert.deepEqual([existsSync(a.file), await read(b), (await ocStatus(b)).status], [false, text, "foreign-entry"]);
});

test("the OpenCode plugin bakes the stable Node link, so a Homebrew upgrade does not make it outdated", async (t) => {
  // A Homebrew layout under a prefix that no machine has. With a real prefix, a machine whose Node is the Homebrew
  // formula gives the same link with no seam, and then no assertion below can tell whether the seam was passed on.
  const h = await ocPilot(t), LINK = "/opt/example/bin/node", V1 = "/opt/example/Cellar/node/26.1.0/bin/node", V2 = "/opt/example/Cellar/node/26.2.0/bin/node";
  assert.ok(stableNodePath() !== LINK && !existsSync(LINK), "the fixture link is not the Node of this machine");
  // The seam of src/schedule/launchd.mjs: where this Node runs from, and what each stable link leads to.
  const lookup = (execPath, real = { [LINK]: execPath }) => ({ execPath, realpath: (path) => { if (!Object.hasOwn(real, path)) throw new Error("ENOENT"); return real[path]; }, isFile: () => true });
  const input = (nodeLookup, mode = "install") => ({ ...hookInput(h, mode), nodeLookup });
  const textWith = (nodePath) => adapter("opencode").hooks.content({ kitRoot: KIT, pilotPath: realpathSync(h.pilotPath), nodePath });
  const linked = textWith(LINK), entry = { sha256: hash(linked) };
  assert.ok(linked.includes("const NODE = " + JSON.stringify(LINK) + ", KIT = ") && !linked.includes("Cellar"), linked.slice(0, 600));
  // Node runs from a versioned Cellar folder, and the stable link of that prefix leads to it: the link is baked in.
  assert.deepEqual([hookContext(h.pilot, KIT, lookup(V1)), expectedEntries("opencode", hookContext(h.pilot, KIT, lookup(V1)))], [{ pilotPath: realpathSync(h.pilotPath), kitRoot: KIT, nodePath: LINK }, { file: [entry] }]);
  const plan = await planHooks(h.pilot, input(lookup(V1)));
  assert.deepEqual(plan.actions, [{ agent: "opencode", path: h.file, status: "create", before: null, after: entry.sha256, events: row("missing"), changes: [{ event: "file", op: "add", entry }], foreign: [] }]);
  // The upgrade moved Node to another version folder between the preview and the apply. The preview still applies,
  // and the file names the link.
  assert.equal((await planHooks(h.pilot, input(lookup(V2)))).fingerprint, plan.fingerprint);
  assert.equal((await applyHooks(h.roots, h.pilot, input(lookup(V2)), { fingerprint: plan.fingerprint, runId: "run_ocnode001", now: now() })).applied, true);
  assert.equal(await read(h), linked);
  assert.deepEqual((await stored(h, "run_ocnode001", "journal")).intended[0].entries, { file: [entry] });
  // Under either version the expected hash is the same one, so the file is installed and not outdated.
  for (const execPath of [V1, V2, "/opt/example/Cellar/node/27.0.0/bin/node"]) {
    const nodeLookup = lookup(execPath);
    assert.deepEqual(expectedEntries("opencode", hookContext(h.pilot, KIT, nodeLookup)), { file: [entry] }, execPath);
    assert.deepEqual((await planHooks(h.pilot, input(nodeLookup))).actions, [{ agent: "opencode", path: h.file, status: "installed", before: entry.sha256, events: row("installed"), foreign: [] }], execPath);
    assert.deepEqual((await hookStatus(h.pilot, { targetHome: h.home, kitRoot: KIT, now: now(), nodeLookup })).agents.find((agent) => agent.agent === "opencode"), { agent: "opencode", path: h.file, status: "installed", events: row("installed"), foreign: [] }, execPath);
    assert.deepEqual((await planHooks(h.pilot, input(nodeLookup, "uninstall"))).actions.map((action) => action.status), ["remove"], execPath);
  }
  // The agents commands pass the seam of their context on, to the plan and to the status.
  const ctx = { roots: h.roots, pilot: h.pilot, kitRoot: KIT, now, env: {}, nodeLookup: lookup(V2) };
  assert.deepEqual((await agentsInstallCommand.run({ home: h.home, agent: ["opencode"], hooks: true }, ctx)).actions.map((action) => action.status), ["installed"]);
  assert.equal((await agentsStatusCommand.run({ home: h.home }, ctx)).hooks.agents.find((agent) => agent.agent === "opencode").status, "installed");
  // A Node outside a Cellar folder is baked as it is. Against the installed file that is another text: outdated.
  const NVM = "/opt/example/versions/node/v24.0.0/bin/node", plain = { sha256: hash(textWith(NVM)) };
  assert.equal(hookContext(h.pilot, KIT, lookup(NVM)).nodePath, NVM);
  assert.deepEqual((await planHooks(h.pilot, input(lookup(NVM)))).actions, [{ agent: "opencode", path: h.file, status: "update", before: entry.sha256, after: plain.sha256, events: row("outdated"),
    changes: [{ event: "file", op: "remove", entry }, { event: "file", op: "add", entry: plain }], foreign: [] }]);
  // A Cellar path keeps its own text where the link is missing, leads to another formula or is no file: the rule is
  // the one of the scheduled jobs.
  for (const [label, nodeLookup] of [["no link", lookup(V1, {})], ["another formula", lookup(V1, { [LINK]: "/opt/example/Cellar/node@22/22.9.0/bin/node" })], ["no file", { ...lookup(V1), isFile: () => false }]]) {
    assert.deepEqual([hookContext(h.pilot, KIT, nodeLookup).nodePath, expectedEntries("opencode", hookContext(h.pilot, KIT, nodeLookup))], [V1, { file: [{ sha256: hash(textWith(V1)) }] }], label);
  }
  // A versioned formula has its link under opt.
  assert.equal(hookContext(h.pilot, KIT, lookup("/usr/local/Cellar/node@22/22.9.0/bin/node", { "/usr/local/opt/node@22/bin/node": "/usr/local/Cellar/node@22/22.9.1/bin/node" })).nodePath, "/usr/local/opt/node@22/bin/node");
  // With no seam the installer reads the running Node, by the same rule. The real CLI writes that path into the
  // file, and the entries of the other agents do not depend on the Node path.
  assert.equal(hookContext(h.pilot, KIT).nodePath, stableNodePath());
  const real = await ocPilot(t), preview = await cli(real, ["agents", "install", "--hooks", "--agent", "opencode"]);
  await cli(real, ["agents", "install", "--hooks", "--agent", "opencode", "--apply", "--plan-fingerprint", preview.fingerprint, "--run-id", "run_ocnode002"]);
  assert.ok((await read(real)).includes("const NODE = " + JSON.stringify(stableNodePath()) + ", KIT = "));
  assert.equal((await cli(real, ["agents", "status"])).hooks.agents.find((agent) => agent.agent === "opencode").status, "installed");
  for (const agent of ["claude", "codex", "gemini", "antigravity"]) assert.deepEqual(expectedEntries(agent, hookContext(h.pilot, KIT, lookup(V1))), expectedEntries(agent, hookContext(h.pilot, KIT, lookup(NVM))), agent);
});

test("opencode plugin uninstall removes only the file devtwin wrote and keeps other plugins in the folder", async (t) => {
  const h = await ocPilot(t), entry = { sha256: hash(h.text) }, other = join(dirname(h.file), "sample-plugin.js"), config = join(h.home, ".config/opencode/opencode.json");
  await writeFile(other, OWN);
  await writeFile(config, "{}\n");
  // With no file there is nothing to remove.
  const none = await planHooks(h.pilot, hookInput(h, "uninstall"));
  assert.deepEqual(none.actions, [{ agent: "opencode", path: h.file, status: "absent", before: null, events: row("missing"), foreign: [] }]);
  await ocHooks(h, "install", "run_ocrm00001");
  assert.deepEqual((await readdir(dirname(h.file))).sort(), ["devtwin.js", "sample-plugin.js"]);
  // Through the real CLI: a preview, then the apply.
  const args = ["agents", "uninstall", "--hooks", "--agent", "opencode"];
  const preview = await cli(h, args);
  assert.deepEqual(preview.actions, [{ agent: "opencode", path: h.file, status: "remove", before: entry.sha256, after: null, events: row("installed"), changes: [{ event: "file", op: "remove", entry }], foreign: [] }]);
  assert.equal(await read(h), h.text, "preview removes nothing");
  assert.equal((await cli(h, [...args, "--apply", "--plan-fingerprint", preview.fingerprint, "--run-id", "run_ocrm00002"])).applied, true);
  // The file is gone. The other plugin, the OpenCode config and the folder stay as they were.
  assert.deepEqual(await readdir(dirname(h.file)), ["sample-plugin.js"]);
  assert.deepEqual([await readFile(other, "utf8"), await readFile(config, "utf8")], [OWN, "{}\n"]);
  // The journal of the removal, and the removed bytes in the run's backup.
  assert.deepEqual((await stored(h, "run_ocrm00002", "journal")).intended, [{ agent: "opencode", path: h.file, status: "remove", before: entry.sha256, after: null, entries: {} }]);
  assert.equal(await backupOf(h, "run_ocrm00002"), h.text);
  // Absent again, and a new install creates the file again.
  assert.deepEqual(await ocStatus(h), { agent: "opencode", path: h.file, status: "missing", events: row("missing"), foreign: [] });
  const again = await cli(h, args);
  assert.deepEqual(again.actions.map((a) => a.status), ["absent"]);
  assert.equal((await cli(h, [...args, "--apply", "--plan-fingerprint", again.fingerprint])).applied, false);
  assert.equal((await ocHooks(h, "install", "run_ocrm00003")).plan.actions[0].status, "create");
  assert.equal(await read(h), h.text);
  assert.deepEqual((await readdir(dirname(h.file))).sort(), ["devtwin.js", "sample-plugin.js"]);
});

test("opencode plugin install refuses a missing plugins folder and a path that is not the approved file", async (t) => {
  // devtwin creates no agent folder: without ~/.config/opencode/plugins the row is blocked and nothing is written.
  const h = await ocPilot(t, { folder: false }), args = ["agents", "install", "--hooks", "--agent", "opencode"];
  const preview = await cli(h, args);
  assert.deepEqual(preview.actions, [{ agent: "opencode", path: h.file, status: "blocked", reason: "agent-folder-missing" }]);
  assert.equal((await cli(h, [...args, "--apply", "--plan-fingerprint", preview.fingerprint])).applied, false);
  assert.deepEqual(await readdir(join(h.home, ".config/opencode")), []);
  assert.deepEqual(await ocStatus(h), { agent: "opencode", path: h.file, status: "agent-folder-missing" });
  // A plugins entry that is a file, or a link to a folder, is no agent folder either.
  await writeFile(dirname(h.file), "example\n");
  assert.deepEqual((await planHooks(h.pilot, hookInput(h))).actions.map((a) => [a.status, a.reason]), [["blocked", "agent-folder-missing"]]);
  assert.equal(await readFile(dirname(h.file), "utf8"), "example\n");
  await rm(dirname(h.file));
  await mkdir(join(h.sandbox, "elsewhere"));
  await symlink(join(h.sandbox, "elsewhere"), dirname(h.file));
  for (const mode of ["install", "uninstall"]) assert.deepEqual((await planHooks(h.pilot, hookInput(h, mode))).actions.map((a) => [a.status, a.reason]), [["blocked", "agent-folder-missing"]], mode);
  assert.deepEqual(await readdir(join(h.sandbox, "elsewhere")), []);
  // A pilot that did not approve the file: blocked, and nothing is written. Another agent's approval does not count.
  const p = await makePilot(t), home = p.agentHomes[0], file = join(home, REL);
  await mkdir(dirname(file), { recursive: true });
  await mkdir(join(home, ".claude"));
  for (const pilotPath of [p.path, await p.with({ writeClasses: { hookTargets: [join(home, ".claude/settings.json")] } })]) {
    for (const route of ["install", "uninstall"]) {
      const out = await runCli(["agents", route, "--hooks", "--agent", "opencode", "--pilot", pilotPath, "--home", home]);
      assert.deepEqual(out.json.result.actions, [{ agent: "opencode", path: file, status: "blocked", reason: "not-approved" }], route);
      const applied = await runCli(["agents", route, "--hooks", "--agent", "opencode", "--pilot", pilotPath, "--home", home, "--apply", "--plan-fingerprint", out.json.result.fingerprint]);
      assert.equal(applied.json.result.applied, false, route);
    }
  }
  assert.deepEqual(await readdir(dirname(file)), []);
  // The hookTargets class takes the one plugin path and no other path in the OpenCode folder.
  for (const rel of ["plugins/other.js", "plugins/devtwin.mjs", "plugins/devtwin.js.bak", "plugins/nested/devtwin.js", "plugins", "devtwin.js", "opencode.json", "plugin/devtwin.js"]) {
    await assert.rejects(loadPilot(await p.with({ writeClasses: { hookTargets: [join(home, ".config/opencode", rel)] } }), OPTS(p)), (e) => e.code === "DEVTWIN_GATE_REQUIRED" && e.details.field === "writeClasses.hookTargets", rel);
  }
  await assert.rejects(loadPilot(await p.with({ writeClasses: { instructionTargets: [file] } }), OPTS(p)), (e) => e.code === "DEVTWIN_GATE_REQUIRED" && e.details.field === "writeClasses.instructionTargets");
  // An approved file that devtwin may not read safely is a conflict for both routes, and keeps its bytes: writable by
  // the group, not UTF-8, or larger than the limit.
  const u = await ocPilot(t, { file: OWN });
  for (const [prepare, reason] of [[() => chmod(u.file, 0o664), "unsafe-file"], [async () => { await chmod(u.file, 0o644); await writeFile(u.file, Buffer.from([0xff, 0xfe, 0x00])); }, "unsafe-file"],
    [() => writeFile(u.file, "//".padEnd(300000, "x") + "\n"), "file-too-large"]]) {
    await prepare();
    const bytes = await readFile(u.file);
    for (const mode of ["install", "uninstall"]) assert.deepEqual((await planHooks(u.pilot, hookInput(u, mode))).actions, [{ agent: "opencode", path: u.file, status: "conflict", reason }], reason + " " + mode);
    assert.equal((await ocStatus(u)).status, reason);
    assert.ok((await readFile(u.file)).equals(bytes), reason);
  }
});

test("the hook inventory, the recovery of an interrupted run and the rollback check cover the plugin file", async (t) => {
  const h = await ocPilot(t), pilotPath = realpathSync(h.pilotPath), entry = { sha256: hash(h.text) };
  const create = { agent: "opencode", path: h.file, status: "create", before: null, after: entry.sha256 }, remove = { agent: "opencode", path: h.file, status: "remove", before: entry.sha256, after: null };
  const none = { agent: "opencode", path: h.file, existed: false, sha256: null, devtwin: [], foreign: [] };
  assert.deepEqual(inventoryHookFile("opencode", h.file, pilotPath), none);
  assert.deepEqual(hookRecoveryFor(create), { op: "hook-unapplied", observed: null });
  // An install that stops after the file was written: the journal has the entry as started and not completed.
  await assert.rejects(ocHooks(h, "install", "run_occrash01", KIT, { faults: { afterEdit: crash } }), /injected crash/);
  assert.equal(await read(h), h.text);
  const journal = await stored(h, "run_occrash01", "journal");
  assert.deepEqual([journal.kind, journal.started, journal.completed, journal.intended], ["hook-bundled", [0], [], [{ ...create, entries: { file: [entry] } }]]);
  assert.deepEqual((await stored(h, "run_occrash01", "inventory")).files, [none], "the inventory was taken before the write");
  // No completed journal recorded the file yet, so it is not devtwin's: the expected bytes read as foreign.
  assert.equal((await ocStatus(h)).status, "foreign-entry");
  assert.deepEqual(inventoryHookFile("opencode", h.file, pilotPath), { ...none, existed: true, sha256: entry.sha256, foreign: [{ event: "file", sha256: entry.sha256 }] });
  assert.equal((await installStatus(h.roots, h.pilot, { targetHome: h.home })).status, "RECOVERY_REQUIRED");
  await assert.rejects(ocHooks(h, "install", "run_ocblock01"), { code: "DEVTWIN_RECOVERY_REQUIRED" });
  // Recovery compares the file with the journal's hashes: the write finished, so the entry is marked complete.
  const recovery = await planRecovery(h.roots, h.pilot);
  assert.deepEqual(recovery.actions, [{ runId: "run_occrash01", index: 0, hook: true, agent: "opencode", path: h.file, op: "hook-complete", observed: entry.sha256 }]);
  assert.deepEqual((await applyRecovery(h.roots, h.pilot, { fingerprint: recovery.fingerprint })).closed, ["run_occrash01"]);
  assert.equal((await installStatus(h.roots, h.pilot, { targetHome: h.home })).status, "ok");
  // The recovered write is devtwin's: status is installed and the next install has nothing to do.
  assert.deepEqual([(await ocStatus(h)).status, (await planHooks(h.pilot, hookInput(h))).actions[0].status], ["installed", "installed"]);
  assert.deepEqual([hookRecoveryFor(create), hookRecoveryFor(remove)], [{ op: "hook-complete", observed: entry.sha256 }, { op: "hook-unapplied", observed: entry.sha256 }]);
  // The rollback check of the install run sees the one file row that the run added.
  const added = [{ agent: "opencode", path: h.file, existedBefore: false, existsNow: true, devtwin: [{ change: "added", row: { event: "file", entry } }], foreign: [] }];
  await assert.rejects(rollbackCheck(h.roots, h.pilot, { runId: "run_occrash01" }), (e) => { assert.deepEqual(e.details.files, added); return e.code === "DEVTWIN_ROLLBACK_MISMATCH"; });
  // An uninstall that stops after the file was removed. Its inventory lists the file as devtwin's, by its hash.
  await assert.rejects(ocHooks(h, "uninstall", "run_occrash02", KIT, { faults: { afterEdit: crash } }), /injected crash/);
  assert.equal(existsSync(h.file), false);
  assert.deepEqual((await stored(h, "run_occrash02", "inventory")).files, [{ ...none, existed: true, sha256: entry.sha256, devtwin: [{ event: "file", entry }] }]);
  assert.deepEqual((await stored(h, "run_occrash02", "journal")).intended, [{ ...remove, entries: {} }]);
  // An absent file after a remove counts as complete.
  assert.deepEqual([hookRecoveryFor(remove), hookRecoveryFor(create)], [{ op: "hook-complete", observed: null }, { op: "hook-unapplied", observed: null }]);
  const second = await planRecovery(h.roots, h.pilot);
  assert.deepEqual(second.actions, [{ runId: "run_occrash02", index: 0, hook: true, agent: "opencode", path: h.file, op: "hook-complete", observed: null }]);
  assert.deepEqual((await applyRecovery(h.roots, h.pilot, { fingerprint: second.fingerprint })).closed, ["run_occrash02"]);
  assert.equal((await installStatus(h.roots, h.pilot, { targetHome: h.home })).status, "ok");
  // After the uninstall the check of the install run passes, through the real CLI.
  const check = async () => {
    const out = await runCli(["agents", "rollback-check", "--pilot", h.pilotPath, "--run-id", "run_occrash01"]);
    assert.equal(out.code, 0, JSON.stringify(out.json));
    return [out.json.result.status, out.json.result.files];
  };
  assert.deepEqual(await check(), ["ok", [{ agent: "opencode", path: h.file, existedBefore: false, existsNow: false, devtwin: [], foreign: [] }]]);
  // A same-name file that no journal wrote is foreign: recovery holds an entry that meets it, the inventory keeps
  // its hash only, and the check lists it as a foreign change and still passes.
  await writeFile(h.file, OWN);
  for (const intended of [create, remove]) assert.deepEqual(hookRecoveryFor(intended), { op: "hold", reason: "unmatched-file", observed: hash(OWN) });
  assert.deepEqual(inventoryHookFile("opencode", h.file, pilotPath), { ...none, existed: true, sha256: hash(OWN), foreign: [{ event: "file", sha256: hash(OWN) }] });
  assert.deepEqual(await check(), ["ok", [{ agent: "opencode", path: h.file, existedBefore: false, existsNow: true, devtwin: [], foreign: [{ change: "added", row: { event: "file", sha256: hash(OWN) } }] }]]);
  // A file that cannot be read safely holds the entry too.
  await chmod(h.file, 0o664);
  assert.deepEqual(hookRecoveryFor(create), { op: "hold", reason: "unsafe-file", observed: null });
  // The stored inventory of a run that changed another agent's file lists the foreign plugin file by its hash.
  const m = await ocPilot(t, { file: OWN, more: [".claude/settings.json"] }), input = hookInput(m, "install", KIT, ["claude", "opencode"]);
  await applyHooks(m.roots, m.pilot, input, { fingerprint: (await planHooks(m.pilot, input)).fingerprint, runId: "run_ocmixed01", now: now() });
  assert.deepEqual((await stored(m, "run_ocmixed01", "inventory")).files.find((f) => f.agent === "opencode"), { agent: "opencode", path: m.file, existed: true, sha256: hash(OWN), devtwin: [], foreign: [{ event: "file", sha256: hash(OWN) }] });
  assert.equal(await read(m), OWN);
});

test("editOwnedFile removes a file only for the hookTargets class with the expected prior hash", async (t) => {
  const p = await makePilot(t), home = p.agentHomes[0], plugin = join(home, REL), md = join(home, ".claude/CLAUDE.md"), sibling = join(dirname(plugin), "sample-plugin.js");
  await mkdir(dirname(plugin), { recursive: true });
  await mkdir(dirname(md));
  const roots = rootsFromPilot(await loadPilot(await p.with({ writeClasses: { hookTargets: [plugin], instructionTargets: [md] } }), OPTS(p)));
  const text = "export default {};\n", sum = hash(text), remove = () => null;
  for (const path of [plugin, md, sibling]) await writeFile(path, text, { mode: 0o644 });
  const invalid = (e) => e.code === "DEVTWIN_INVALID_INPUT" && e.message === "Invalid owned file content", changed = (e) => e.code === "DEVTWIN_INTEGRITY" && e.message === "Owned file changed";
  const call = (extra, options) => editOwnedFile(roots, { path: plugin, writeClass: "hookTargets", runId: "run_ownrm0001", edit: remove, ...extra }, options);
  // No hash, and a hash that is no SHA-256 string of this module: refused as every other non-string result is.
  await assert.rejects(call({}), invalid);
  for (const priorHash of [null, 7, "", true, [sum], sum.slice("sha256:".length)]) await assert.rejects(call({ priorHash }), invalid, JSON.stringify(priorHash));
  // A hash of other bytes: the file is not the one the caller means.
  await assert.rejects(call({ priorHash: hash("other\n") }), changed);
  // The instruction class never removes a file, with the right hash too. No other class does either.
  await assert.rejects(call({ path: md, writeClass: "instructionTargets", priorHash: sum }), invalid);
  await assert.rejects(call({ path: md, writeClass: "instructionTargets" }), invalid);
  // A path that is not the approved file is refused by the fence before anything is read.
  await assert.rejects(call({ path: sibling, priorHash: sum }), (e) => e.code === "DEVTWIN_GATE_REQUIRED" && e.details.field === "destination");
  await assert.rejects(call({ path: md, priorHash: sum }), (e) => e.code === "DEVTWIN_GATE_REQUIRED" && e.details.field === "destination");
  // Every other result that is not a string still fails, with a hash or without one.
  for (const value of [undefined, 7, false, {}, [text]]) for (const extra of [{}, { priorHash: sum }]) await assert.rejects(call({ edit: () => value, ...extra }), invalid, JSON.stringify(value));
  assert.equal(existsSync(join(roots.stateRoot, "runs")), false, "a refused remove writes no backup");
  // The file changed between the read and the unlink: other bytes in the same file, then the same bytes in another file.
  await assert.rejects(call({ priorHash: sum, runId: "run_ownrm0002" }, { faults: { beforeReplace: () => writeFile(plugin, "changed\n") } }), changed);
  assert.equal(await readFile(plugin, "utf8"), "changed\n");
  await writeFile(plugin, text);
  const swap = async () => { await writeFile(plugin + ".next", text, { mode: 0o644 }); await rename(plugin + ".next", plugin); };
  await assert.rejects(call({ priorHash: sum, runId: "run_ownrm0003" }, { faults: { beforeReplace: swap } }), changed);
  assert.equal(await readFile(plugin, "utf8"), text);
  // The file is gone before the unlink, and a remove of an absent file: refused, and nothing is created.
  await assert.rejects(call({ priorHash: sum, runId: "run_ownrm0004" }, { faults: { beforeReplace: () => rm(plugin) } }), changed);
  await assert.rejects(call({ priorHash: sum, runId: "run_ownrm0005" }), changed);
  assert.equal(existsSync(plugin), false);
  for (const path of [md, sibling]) assert.equal(await readFile(path, "utf8"), text, path);
  // A create goes through the same function, as for the other hook files: a record of absence, and a private file.
  const created = await call({ runId: "run_ownrm0006", edit: (current) => { assert.equal(current, null); return text; } });
  assert.deepEqual([created.changed, created.backup, JSON.parse(await readFile(created.record, "utf8")).absent], [true, null, true]);
  assert.equal((await lstat(plugin)).mode & 0o777, 0o600);
  // The remove: the hookTargets class, the hash of the bytes on disk, and the same bytes at the unlink. The backup
  // and its record are those of an edit.
  const done = await call({ runId: "run_ownrm0007", priorHash: sum, edit: (current) => { assert.equal(current, text); return null; } });
  assert.deepEqual([done.changed, done.removed, done.path], [true, true, plugin]);
  assert.equal(existsSync(plugin), false);
  assert.equal(await readFile(done.backup, "utf8"), text);
  assert.deepEqual(JSON.parse(await readFile(done.record, "utf8")), { schemaVersion: 1, path: plugin, writeClass: "hookTargets", sha256: sum, size: Buffer.byteLength(text) });
  assert.deepEqual(await readdir(dirname(plugin)), ["sample-plugin.js"]);
  for (const path of [md, sibling]) assert.equal(await readFile(path, "utf8"), text, path);
});

// A live config in a temp home, as test/live-add-agent.test.mjs builds it: a private ~/.devtwin, a pinned kit clone
// with the bundled skills and one repository. Every owner dialog goes to a recording fake, and launchctl is a fake.
async function liveHome(t, folders) {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin");
  for (const rel of folders) await mkdir(join(home, rel), { recursive: true });
  await mkdir(devtwin);
  await chmod(devtwin, 0o700);
  const files = { "README.md": "kit\n" };
  for (const name of SKILL_NAMES) files["skills/" + name + "/SKILL.md"] = await readFile(join(KIT, "skills", name, "SKILL.md"), "utf8");
  const kit = await makeRepo(join(devtwin, "kit"), files);
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  const repo = await makeRepo(join(sb, "work/atlas"), { "README.md": "# Atlas\n" });
  const liveConfig = join(devtwin, "live.json"), dialogs = [], loaded = [], env = {};
  const launchctl = (args) => { loaded.push(args.join(" ")); return { status: 0, stdout: "", stderr: "" }; };
  const run = async (args) => {
    const chunks = [];
    const code = await main(args, { stdout: { write: (v) => { chunks.push(v); return true; } }, now, home, env, kitRoot: kit, ownerDialog: async (content) => { dialogs.push(content); return "approved"; }, launchctl });
    return { code, json: JSON.parse(chunks.join("")) };
  };
  const ok = async (args) => {
    const out = await run(args);
    assert.equal(out.json.ok, true, args.slice(0, 2).join(" ") + ": " + JSON.stringify(out.json.error));
    return out.json.result;
  };
  const twice = async (args) => ok([...args, "--apply", "--plan-fingerprint", (await ok(args)).fingerprint]);
  const init = async (agents) => {
    await twice(["live", "init", "--pilot", liveConfig, ...agents.flatMap((agent) => ["--agent", agent]), "--repo", repo]);
    await ok(["init", "--pilot", liveConfig, "--actor", "email:owner@example.com", "--apply"]);
  };
  // One batch, as the owner runs it: a plan, which shows no dialog, then the apply behind one owner dialog.
  const batch = async (flags) => {
    const shown = dialogs.length, plan = await ok(["setup", "plan", "--pilot", liveConfig, ...flags]);
    assert.equal(dialogs.length, shown, "a plan shows no dialog");
    const result = await ok(["setup", "apply", "--pilot", liveConfig, ...flags, "--apply", "--plan-fingerprint", plan.fingerprint]);
    assert.equal(dialogs.length, shown + 1, "one owner dialog for the whole batch");
    assert.equal(dialogs.at(-1).body, "Approve only if you started this action yourself.\n\n" + plan.dialog.body);
    assert.deepEqual(result.done.map((d) => d.id), plan.items.map((i) => i.id));
    return plan;
  };
  const steps = async (ids) => {
    const all = (await ok(["setup", "status", "--pilot", liveConfig])).steps;
    return ids.map((id) => all.find((s) => s.id === id));
  };
  const pilot = () => loadPilot(liveConfig, { home, env, kitRoot: kit });
  return { sb, home, kit, liveConfig, ok, twice, init, batch, steps, pilot, dialogs, loaded };
}
const linesOf = (plan) => Object.fromEntries(plan.items.map((i) => [i.id, i.lines]));

test("the setup batch for OpenCode approves the plugin file and installs it, with its own dialog lines", async (t) => {
  // The plugins folder exists before anything runs: devtwin creates no agent folder.
  const h = await liveHome(t, [".claude/skills", ".agents/skills", ".codex", ".config/opencode/plugins", "Library/LaunchAgents"]);
  await h.init(["claude", "codex"]);
  const plugin = join(h.home, REL), all = ["--all-pending", "--backup-target", join(h.home, "devtwin-backups")], agentSteps = ["skills-opencode", "hooks-opencode"];
  // The owner set up Claude Code and Codex earlier. That batch leaves out the agent the config does not name.
  const first = await h.batch(all);
  for (const id of agentSteps) assert.equal(first.skipped.find((s) => s.id === id)?.reason, "agent not in the live config", id);
  const others = () => Promise.all([".claude", ".agents", ".codex", "Library/LaunchAgents"].map((rel) => treeSnapshot(join(h.home, rel))));
  const before = await others(), jobs = h.loaded.length;
  assert.deepEqual(await readdir(dirname(plugin)), []);
  await h.twice(["live", "add-agent", "--pilot", h.liveConfig, "--agent", "opencode"]);
  assert.deepEqual(await readdir(dirname(plugin)), [], "the route writes nothing in the agent folder");
  // The step texts name a plugin file that devtwin owns as a whole, not entries in a settings file.
  const [approve, hooksStep] = await h.steps(["write-classes-hooks", "hooks-opencode"]);
  assert.deepEqual([approve.done, hooksStep.done, hooksStep.skipped, hooksStep.problem], [false, false, undefined, undefined]);
  assert.equal(hooksStep.what, "Writes the devtwin plugin file " + SHOWN + ". Runs agents install --hooks --agent opencode. devtwin owns the whole file. Other plugins in the folder stay.");
  assert.equal(hooksStep.undo, "agents uninstall --hooks --agent opencode removes the file when devtwin wrote it and you did not change it. A backup of the file is kept in the run folder.");
  assert.ok(approve.what.startsWith("Adds the hook settings file or the plugin file of each agent in the live config (") && approve.what.includes(", " + SHOWN + ") to the hookTargets write class of the live config."), approve.what);
  // The next batch: the plugin file joins the hookTargets write class first, then the plugin is installed. The shared
  // skills folder already holds the skills, and the paths confirmation is in it because the route changed the config.
  const plan = await h.batch(all), lines = linesOf(plan);
  assert.deepEqual(plan.items.map((i) => i.id), ["config", "paths-confirm", "hooks-opencode"]);
  assert.deepEqual([plan.items[0].covers, lines.config, lines["hooks-opencode"]], [["write-classes-hooks"], ["Approve plugin file " + SHOWN], ["Install the devtwin plugin file " + SHOWN]]);
  assert.equal(plan.skipped.find((s) => s.id === "skills-opencode")?.reason, "done");
  assert.deepEqual(plan.excluded, []);
  assert.equal(h.dialogs.at(-1).title, "devtwin: Approve 3 setup changes");
  assert.ok(h.dialogs.at(-1).body.includes("\n1. Approve plugin file " + SHOWN + "\n") && h.dialogs.at(-1).body.endsWith("\n3. Install the devtwin plugin file " + SHOWN), h.dialogs.at(-1).body);
  // The file holds the generated text for the pinned kit and this live config, and nothing else is in the folder.
  const pilotPath = realpathSync(h.liveConfig), text = adapter("opencode").hooks.content({ kitRoot: h.kit, pilotPath, nodePath: stableNodePath() });
  assert.equal(await readFile(plugin, "utf8"), text);
  assert.deepEqual(await readdir(dirname(plugin)), ["devtwin.js"]);
  assert.deepEqual(JSON.parse(await readFile(h.liveConfig, "utf8")).writeClasses.hookTargets, [join(h.home, ".claude/settings.json"), join(h.home, ".codex/hooks.json"), plugin]);
  for (const step of await h.steps(["write-classes-hooks", ...agentSteps])) assert.deepEqual([step.done, step.skipped, step.problem], [true, undefined, undefined], step.id);
  const status = (await h.ok(["agents", "status", "--pilot", h.liveConfig])).hooks;
  assert.deepEqual(status.agents.map((a) => [a.agent, a.status]), [["claude", "installed"], ["codex", "installed"], ["opencode", "installed"]]);
  assert.deepEqual(status.agents.find((a) => a.agent === "opencode"), { agent: "opencode", path: plugin, status: "installed", events: row("installed"), foreign: [] });
  // Nothing of the other agents changed, no job was loaded again, and a new plan has no step left for the agent.
  assert.deepEqual(await others(), before);
  assert.equal(h.loaded.length, jobs);
  const next = await h.ok(["setup", "plan", "--pilot", h.liveConfig, ...all]);
  for (const id of agentSteps) assert.equal(next.skipped.find((s) => s.id === id)?.reason, "done", id);
  // A file from an earlier kit path, which a completed journal of this config recorded: the step is pending again,
  // and its line says that the file is written again.
  const pilot = await h.pilot(), old = adapter("opencode").hooks.content({ kitRoot: "/opt/example-kit-old", pilotPath, nodePath: stableNodePath() }), runDir = join(pilot.stateRoot, "runs/run_ocprior001");
  await mkdir(runDir, { mode: 0o700 });
  await writeFile(join(runDir, "journal.json"), JSON.stringify({ schemaVersion: 1, kind: "hook-bundled", configId: pilot.live.configId, runId: "run_ocprior001", mode: "install", planFingerprint: "sha256:" + "0".repeat(64),
    intended: [{ agent: "opencode", path: plugin, status: "create", before: null, after: hash(old), entries: { file: [{ sha256: hash(old) }] } }], started: [0], completed: [0] }) + "\n", { mode: 0o600 });
  await writeFile(plugin, old);
  const rewrite = await h.batch(["--steps", "hooks-opencode"]);
  assert.deepEqual([rewrite.items.map((i) => i.id), linesOf(rewrite)["hooks-opencode"], rewrite.excluded], [["hooks-opencode"], ["Rewrite the devtwin plugin file " + SHOWN], []]);
  assert.equal(await readFile(plugin, "utf8"), text);
  // A plugin file that the owner edited leaves the batch with a reason, and keeps its bytes.
  await writeFile(plugin, text + "// example\n");
  const refused = await h.ok(["setup", "plan", "--pilot", h.liveConfig, "--steps", "hooks-opencode"]);
  assert.deepEqual([refused.items, refused.excluded], [[], [{ id: "hooks-opencode", reason: "the hook file cannot be changed: conflict modified" }]]);
  assert.equal(await readFile(plugin, "utf8"), text + "// example\n");
});

// What the hook installer plans for the four agents whose hook target is a JSON settings file: the file under the
// home, and one row [agent event, devtwin hook event, matcher] for each entry it adds.
const SEARCH = "list_dir|find_by_name|grep_search", AGY_EDIT = "write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content";
const JSON_AGENTS = {
  antigravity: [".gemini/config/hooks.json", [["SessionStart", "session-start"], ["PreInvocation", "user-prompt"], ["PreToolUse", "pre-tool", "run_command|manage_task"],
    ["PostToolUse", "post-tool", "run_command|manage_task|read_file|view_file|" + AGY_EDIT + "|" + SEARCH], ["Stop", "stop"]]],
  claude: [".claude/settings.json", [["SessionStart", "session-start"], ["UserPromptSubmit", "user-prompt"], ["PreToolUse", "pre-tool", "Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep|Bash"], ["PreCompact", "pre-compact"], ["Stop", "stop"]]],
  codex: [".codex/hooks.json", [["SessionStart", "session-start"], ["UserPromptSubmit", "user-prompt"], ["PreToolUse", "pre-tool", "^(apply_patch|Bash)$"], ["PostToolUse", "post-tool", "^Bash$"], ["PreCompact", "pre-compact"], ["Stop", "stop"]]],
  gemini: [".gemini/settings.json", [["SessionStart", "session-start"], ["BeforeAgent", "user-prompt"], ["BeforeTool", "pre-tool", "^run_shell_command$"],
    ["AfterTool", "post-tool", "^(run_shell_command|read_file|read_many_files|write_file|replace|glob|grep_search|search_file_content)$"], ["PreCompress", "pre-compact"], ["AfterAgent", "stop"]]]
};
// The entry each of them writes, by hand: a group with a timeout in seconds for Claude Code and Codex, a named handler
// with a timeout in milliseconds for Gemini CLI, and for Antigravity CLI a flat handler when the event has no matcher.
const entryOf = (agent, command, event, matcher) => {
  const handler = { type: "command", command, timeout: 10 };
  if (agent === "gemini") return { ...(matcher ? { matcher } : {}), hooks: [{ name: "devtwin-" + event, type: "command", command, timeout: 10000 }] };
  if (agent === "antigravity") return matcher ? { matcher, hooks: [handler] } : handler;
  return { ...(matcher ? { matcher } : {}), hooks: [handler] };
};
const DISPLAY = { claude: "~/.claude/settings.json", codex: "~/.codex/hooks.json", gemini: "~/.gemini/settings.json", antigravity: "~/.gemini/config/hooks.json" };
const CODEX_NOTE = "Codex runs a new or changed hook only after you review it. Open Codex, run /hooks, and trust each devtwin entry.";

test("hook installs for Claude Code, Codex, Gemini CLI and Antigravity CLI plan the same actions as before", async (t) => {
  // One disposable pilot with the five hook targets approved, so the whole-file target is planned in the same run.
  const h = await ocPilot(t, { more: Object.values(JSON_AGENTS).map(([rel]) => rel) }), pilotPath = realpathSync(h.pilotPath), ids = Object.keys(JSON_AGENTS);
  const input = (mode) => hookInput(h, mode, KIT, [...ids, "opencode"]);
  const line = (agent, event) => 'node "' + KIT + '/bin/devtwin.mjs" hook --event ' + event + " --agent " + agent + ' --pilot "' + pilotPath + '"';
  const expected = (agent) => JSON_AGENTS[agent][1].map(([name, event, matcher]) => [name, entryOf(agent, line(agent, event), event, matcher)]);
  const plan = await planHooks(h.pilot, input("install"));
  assert.deepEqual([plan.kind, plan.mode, plan.agents, plan.notes.map((n) => n.message)], ["hook-install", "install", [...ids, "opencode"], [CODEX_NOTE]]);
  assert.deepEqual(plan.actions.slice(0, 4).map((a) => [a.agent, a.path, a.status, a.before, a.foreign, Object.keys(a).sort()]),
    ids.map((agent) => [agent, join(h.home, JSON_AGENTS[agent][0]), "create", null, [], ["after", "agent", "before", "changes", "events", "foreign", "path", "status"]]));
  for (const [i, agent] of ids.entries()) {
    assert.deepEqual(plan.actions[i].events, expected(agent).map(([event]) => ({ event, status: "missing" })), agent);
    assert.equal(JSON.stringify(plan.actions[i].changes), JSON.stringify(expected(agent).map(([event, entry]) => ({ event, op: "add", entry }))), agent);
    assert.equal(JSON.stringify(expectedEntries(agent, hookContext(h.pilot, KIT))), JSON.stringify(Object.fromEntries(expected(agent).map(([event, entry]) => [event, [entry]]))), agent);
  }
  assert.deepEqual([plan.actions[4].agent, plan.actions[4].status, plan.actions[4].events], ["opencode", "create", row("missing")]);
  // The apply writes each JSON file with its entries under the agent's own key, and the plugin file next to them.
  await applyHooks(h.roots, h.pilot, input("install"), { fingerprint: plan.fingerprint, runId: "run_ocfive001", now: now() });
  for (const agent of ids) {
    const body = Object.fromEntries(expected(agent).map(([event, entry]) => [event, [entry]]));
    assert.equal(await readFile(join(h.home, JSON_AGENTS[agent][0]), "utf8"), JSON.stringify({ [agent === "antigravity" ? "devtwin" : "hooks"]: body }, null, 2) + "\n", agent);
  }
  assert.equal(await read(h), h.text);
  const journal = await stored(h, "run_ocfive001", "journal");
  // The journal is stored as canonical JSON, so its keys are sorted. Each entry list is the planned one.
  assert.deepEqual(journal.intended.map((e) => [e.agent, e.status, Object.keys(e.entries)]), [...ids.map((agent) => [agent, "create", expected(agent).map(([event]) => event).sort()]), ["opencode", "create", ["file"]]]);
  for (const [i, agent] of ids.entries()) assert.deepEqual(journal.intended[i].entries, Object.fromEntries(expected(agent).map(([event, entry]) => [event, [entry]])), agent);
  const status = await hookStatus(h.pilot, { targetHome: h.home, kitRoot: KIT, now: now() });
  assert.deepEqual(status.agents.map((a) => [a.agent, a.status, a.events.map((e) => e.event)]), [...ids.map((agent) => [agent, "installed", expected(agent).map(([event]) => event)]), ["opencode", "installed", ["file"]]]);
  assert.deepEqual((await planHooks(h.pilot, input("install"))).actions.map((a) => a.status), ["installed", "installed", "installed", "installed", "installed"]);
  // The uninstall removes each agent's entries and leaves an empty object, as before, and removes the plugin file.
  const removal = await planHooks(h.pilot, input("uninstall"));
  assert.deepEqual(removal.actions.map((a) => [a.agent, a.status, a.changes.map((c) => c.op).join(",")]), [...ids.map((agent) => [agent, "remove", expected(agent).map(() => "remove").join(",")]), ["opencode", "remove", "remove"]]);
  await applyHooks(h.roots, h.pilot, input("uninstall"), { fingerprint: removal.fingerprint, runId: "run_ocfive002", now: now() });
  for (const agent of ids) assert.equal(await readFile(join(h.home, JSON_AGENTS[agent][0]), "utf8"), "{}\n", agent);
  assert.equal(existsSync(h.file), false);

  // The dialog lines of one setup batch for a live config that names the five agents.
  const live = await liveHome(t, [".claude/skills", ".agents/skills", ".codex", ".gemini/config/skills", ".config/opencode/plugins", "Library/LaunchAgents"]);
  await live.init(["claude", "codex", "gemini", "antigravity", "opencode"]);
  const order = ["claude", "codex", "gemini", "antigravity"], names = (agent) => JSON_AGENTS[agent][1].map(([name]) => name).join(", ");
  const batch = await live.ok(["setup", "plan", "--pilot", live.liveConfig, "--steps", ["write-classes-hooks", ...order.map((id) => "hooks-" + id), "hooks-opencode"].join(",")]), lines = linesOf(batch);
  assert.deepEqual(batch.items.map((i) => i.id), ["config", ...order.map((id) => "hooks-" + id), "hooks-opencode"]);
  assert.deepEqual(lines.config.slice(0, 4), ["Approve hook settings file ~/.claude/settings.json", "Approve hook settings file ~/.codex/hooks.json", "Approve hook settings file ~/.gemini/settings.json", "Approve hook settings file ~/.gemini/config/hooks.json"]);
  assert.equal(lines.config.length, 5);
  assert.deepEqual(order.map((id) => lines["hooks-" + id]), [
    ["Add devtwin hook entries to ~/.claude/settings.json: SessionStart, UserPromptSubmit, PreToolUse, PreCompact, Stop"],
    ["Add devtwin hook entries to ~/.codex/hooks.json: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Stop. Then trust them in Codex with /hooks"],
    ["Add devtwin hook entries to ~/.gemini/settings.json: SessionStart, BeforeAgent, BeforeTool, AfterTool, PreCompress, AfterAgent"],
    ["Add devtwin hook entries to ~/.gemini/config/hooks.json: SessionStart, PreInvocation, PreToolUse, PostToolUse, Stop"]]);
  for (const id of order) assert.equal(lines["hooks-" + id][0].split(": ")[1].split(". ")[0], names(id), id);
  // The step texts of the four agents, byte for byte.
  for (const [i, step] of (await live.steps(order.map((id) => "hooks-" + id))).entries()) {
    const agent = order[i];
    assert.equal(step.what, "Adds devtwin's hook entries to " + DISPLAY[agent] + ". Runs agents install --hooks --agent " + agent + ". Other entries in the file stay." + (agent === "codex" ? " " + CODEX_NOTE : ""), agent);
    assert.equal(step.undo, "agents uninstall --hooks --agent " + agent + " removes only devtwin's entries. A backup of the file is kept in the run folder.", agent);
    assert.deepEqual([step.title, step.why], ["Hooks for " + agent, "The hook gives the agent matching lessons at the moment it touches an area, and denies owner-only devtwin commands from agent shells."], agent);
  }
});
