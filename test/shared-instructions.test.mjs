import test from "node:test";
import assert from "node:assert/strict";
import { basename, dirname, join, relative } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile, chmod, rm, rmdir } from "node:fs/promises";
import { makePilot, sandbox, makeRepo, fixtureGit, treeSnapshot, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { applyInit } from "../src/config/store.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";
import { addPersonalRecord } from "../src/records/personal.mjs";
import { MARKERS } from "../src/storage/owned-file.mjs";
import { digest } from "../src/storage/canonical.mjs";
import { mergeTargets, OWNED_FILE } from "../src/agents/instructions.mjs";
import { adapter } from "../src/agents/adapters/index.mjs";
import { planHooks, applyHooks } from "../src/agents/hooks-install.mjs";

// Gemini CLI and Antigravity CLI name one instruction file, <home>/.gemini/GEMINI.md. These tests cover the plan, the
// edit, the owner dialog and the remove for that shared file.
const KIT = realpathSync(join(import.meta.dirname, ".."));
const BOTH = ["--agent", "gemini", "--agent", "antigravity"];
const blocks = (text) => text.split(MARKERS.begin).length - 1;
const rows = (plan) => plan.actions.map((a) => [a.agent, a.role, a.status, a.reason ?? null]);
// The line of an owner dialog that lists the files the apply writes.
const filesLine = (dialog) => dialog.body.split("\n").filter((line) => line.startsWith("Files: "));
// The line of an owner dialog that names the agents whose sessions read the block.
const readersLine = (dialog) => dialog.body.split("\n").filter((line) => line.startsWith("Every "));
// Every agent that reads GEMINI.md is named with the listed agents, in registry order.
const READERS = "Every Claude Code, Codex, Gemini CLI and Antigravity CLI session on this machine reads this block:";
// The routes through main(), with an owner dialog that records what it was shown and approves. extra holds the flags
// every route takes but a bare one, such as --home in a disposable pilot.
function routes({ pilot, home, kitRoot, extra = [] }) {
  const dialogs = [];
  const cli = async (args, { env = {}, bare = false } = {}) => {
    const chunks = [];
    await main([...args, "--pilot", pilot, ...(bare ? [] : extra)], { now, home, env, kitRoot, ownerDialog: async (content) => { dialogs.push(content); return "approved"; }, stdout: { write: (v) => { chunks.push(v); return true; } } });
    return JSON.parse(chunks.join(""));
  };
  const ok = async (args, options) => { const out = await cli(args, options); assert.equal(out.ok, true, args.join(" ") + ": " + JSON.stringify(out.error)); return out.result; };
  const apply = async (args) => { const plan = await ok(["instructions", "plan", ...args]); return { plan, result: await ok(["instructions", "apply", ...args, "--plan-fingerprint", plan.fingerprint]) }; };
  return { dialogs, cli, ok, apply };
}
// A disposable pilot whose first fake agent home has GEMINI.md approved as an instruction target and the Antigravity
// CLI hooks file approved as a hook target. Each path in instructionTargets is an approved instruction target too, and
// each path in hookTargets an approved hook target.
async function disposable(t, { instructionTargets = [], hookTargets = [] } = {}) {
  const p = await makePilot(t), home = p.agentHomes[0], file = join(home, ".gemini/GEMINI.md");
  const more = instructionTargets.map((rel) => join(home, rel));
  for (const dir of [join(home, ".gemini/config"), ...more.map((path) => dirname(path))]) await mkdir(dir, { recursive: true });
  const pilotPath = await p.with({ writeClasses: { instructionTargets: [file, ...more], hookTargets: [join(home, ".gemini/config/hooks.json"), ...hookTargets.map((rel) => join(home, rel))] } });
  const pilot = await loadPilot(pilotPath, { home: p.fakeHome, kitRoot: KIT, env: {} }), roots = rootsFromPilot(pilot);
  await applyInit(roots, { actorRefs: ["email:owner@example.com"], preferences: {}, now });
  const pref = (n, text, title = "Rule " + n) => addPersonalRecord(roots, { requestId: "req_sharedpref" + String(n).padStart(4, "0"), recordedBy: { actor: "human", runId: "run_cli00001" }, draft: { kind: "preference", class: "lesson", reach: "personal", status: "observed", title, body: text + "\n" } }, { now: () => new Date(now().getTime() + n * 1000) });
  // Installs the Antigravity CLI hooks with a completed journal, then returns the status an uninstall plan gives them.
  const agyHooks = async () => {
    const input = (mode) => ({ targetHome: home, agents: ["antigravity"], mode, kitRoot: KIT }), plan = await planHooks(pilot, input("install"));
    await applyHooks(roots, pilot, input("install"), { fingerprint: plan.fingerprint, runId: "run_sharedagy1", now: now() });
    return (await planHooks(pilot, input("uninstall"))).actions.map((a) => [a.agent, a.status]);
  };
  return { home, file, pref, agyHooks, sandbox: p.sandbox, ...routes({ pilot: pilotPath, home: p.fakeHome, kitRoot: KIT, extra: ["--home", home] }) };
}
// A fixture home with a live config for the named agents. GEMINI.md is an approved instruction target, with each path
// in instructionTargets, and each path in hookTargets is an approved hook target.
async function liveHome(t, agents, { hookTargets = [], instructionTargets = [] } = {}) {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin"), file = join(home, ".gemini/GEMINI.md");
  for (const rel of [".claude/skills", ".agents/skills", ".codex", ".gemini/config/skills", ...instructionTargets.map((target) => dirname(target))]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(devtwin);
  await chmod(devtwin, 0o700);
  const kit = await makeRepo(join(devtwin, "kit"), { "README.md": "kit\n" });
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  const repo = await makeRepo(join(sb, "work/atlas"), { "README.md": "# Atlas\n" });
  const liveConfig = join(devtwin, "live.json"), r = routes({ pilot: liveConfig, home, kitRoot: kit });
  const twice = async (args) => { const preview = await r.ok(args); return r.ok([...args, "--apply", "--plan-fingerprint", preview.fingerprint]); };
  await twice(["live", "init", ...agents.flatMap((a) => ["--agent", a]), "--repo", repo]);
  await r.ok(["init", "--actor", "email:owner@example.com", "--apply"]);
  await twice(["live", "write-classes", ...[file, ...instructionTargets.map((rel) => join(home, rel))].flatMap((path) => ["--instruction-target", path]), ...hookTargets.flatMap((rel) => ["--hook-target", join(home, rel)])]);
  r.dialogs.length = 0;
  return { home, file, twice, ...r };
}

test("gemini and antigravity share one GEMINI.md block: one action, one edit, and the dialog names both agents", async (t) => {
  const s = await disposable(t);
  await s.pref(1, "Prefer small pull requests.", "Small PRs");
  const { plan, result } = await s.apply(BOTH);
  // The path is planned once, under the first agent; shared names the other.
  assert.deepEqual(plan.actions.map((a) => [a.agent, a.role, a.path, a.status]), [["antigravity", "block", s.file, "create"]]);
  assert.deepEqual(plan.shared, [{ agent: "gemini", path: s.file, with: "antigravity" }]);
  assert.deepEqual([result.applied, result.written.map((w) => w.path)], [true, [s.file]], "one edit");
  assert.equal(s.dialogs.length, 1);
  assert.match(s.dialogs[0].body, /Every Claude Code, Codex, Gemini CLI and Antigravity CLI session on this machine reads this block:/);
  assert.deepEqual(filesLine(s.dialogs[0]), ["Files: " + s.file], "the file is listed once");
  let text = await readFile(s.file, "utf8");
  assert.equal(text, MARKERS.begin + "\n" + plan.block + MARKERS.end + "\n", "the block itself, once");
  // The order of the flags and a repeated agent change nothing, and a second plan has nothing to write.
  const again = await s.ok(["instructions", "plan", "--agent", "antigravity", "--agent", "gemini", "--agent", "gemini"]);
  assert.deepEqual([rows(again), again.shared], [[["antigravity", "block", "unchanged", null]], plan.shared]);
  // An update is one edit too.
  await s.pref(2, "Explain trade-offs in a short table.", "Trade-offs");
  const update = await s.apply(BOTH);
  assert.deepEqual([rows(update.plan), update.result.written.length], [[["antigravity", "block", "update", null]], 1]);
  text = await readFile(s.file, "utf8");
  assert.deepEqual([blocks(text), text.split("Trade-offs: Explain trade-offs").length - 1], [1, 1]);
  // A disposable pilot has no active users, as for the shared skills folder: a remove for one agent takes the block
  // out, even with the Antigravity CLI hooks installed by a completed journal.
  assert.deepEqual(await s.agyHooks(), [["antigravity", "remove"]], "the hooks are installed");
  const remove = await s.apply(["--agent", "gemini", "--remove"]);
  assert.deepEqual([rows(remove.plan), Object.hasOwn(remove.plan, "shared"), remove.result.applied], [[["gemini", "block", "remove", null]], false, true]);
  assert.equal(await readFile(s.file, "utf8"), "");
  // Malformed markers in the shared file are one conflict, and the apply is refused before any dialog.
  const broken = "notes\n" + MARKERS.begin + "\nhalf a block\n", asked = s.dialogs.length;
  await writeFile(s.file, broken);
  const conflict = await s.ok(["instructions", "plan", ...BOTH]);
  assert.deepEqual([rows(conflict), conflict.shared], [[["antigravity", "block", "conflict", "markers"]], plan.shared]);
  assert.equal((await s.cli(["instructions", "apply", ...BOTH, "--plan-fingerprint", conflict.fingerprint])).error.code, "DEVTWIN_CONFLICT");
  assert.deepEqual([await readFile(s.file, "utf8"), s.dialogs.length], [broken, asked]);
});

test("an instruction plan for one agent of a shared file is unchanged, and a single-path plan keeps its fingerprint shape", async (t) => {
  const s = await disposable(t);
  const KEYS = ["kind", "mode", "block", "chars", "preferences", "actions", "warnings", "fingerprint"];
  const { plan, result } = await s.apply(["--agent", "gemini"]);
  assert.deepEqual([Object.keys(plan), Object.keys(plan.actions[0])], [KEYS, ["agent", "role", "path", "status", "before", "after"]], "no shared key when nothing is shared");
  assert.deepEqual(plan.actions.map((a) => [a.agent, a.role, a.path, a.status]), [["gemini", "block", s.file, "create"]]);
  const { fingerprint, ...body } = plan;
  assert.equal(fingerprint, digest(body), "the fingerprint covers exactly these keys");
  assert.equal(result.written.length, 1);
  assert.deepEqual(readersLine(s.dialogs[0]), [READERS], "a plan for one agent of a shared file names both readers of the file");
  // The other agent of the file finds the block in place, and so does a plan for both.
  for (const agent of ["antigravity", "gemini"]) {
    const one = await s.ok(["instructions", "plan", "--agent", agent]);
    assert.deepEqual([Object.keys(one), rows(one)], [KEYS, [[agent, "block", "unchanged", null]]], agent);
    assert.equal((await s.ok(["instructions", "apply", "--agent", agent, "--plan-fingerprint", one.fingerprint])).applied, false, agent);
  }
  assert.deepEqual(rows(await s.ok(["instructions", "plan", ...BOTH])), [["antigravity", "block", "unchanged", null]]);
  // Agents with distinct paths: one action each, as before, and no shared key.
  const distinct = await s.ok(["instructions", "plan", "--agent", "claude", "--agent", "codex", "--agent", "gemini"]);
  assert.deepEqual([Object.keys(distinct), rows(distinct)], [KEYS, [["claude", "owned-file", "blocked", "not-approved"], ["claude", "import", "blocked", "not-approved"], ["codex", "block", "blocked", "not-approved"], ["gemini", "block", "unchanged", null]]]);
  assert.equal(s.dialogs.length, 1, "nothing but the first apply asked the owner");
});

test("the instruction dialog names every agent that reads a planned file, selected or not", async (t) => {
  const s = await disposable(t, { instructionTargets: [".claude/CLAUDE.md", ".claude/devtwin.md", ".codex/AGENTS.md"] });
  // Claude Code and Codex share no file with another agent: the sentence names the two of them, as before.
  const listed = await s.apply(["--agent", "claude", "--agent", "codex"]);
  assert.deepEqual(rows(listed.plan), [["claude", "owned-file", "create", null], ["claude", "import", "create", null], ["codex", "block", "create", null]]);
  assert.deepEqual(readersLine(s.dialogs[0]), ["Every Claude Code and Codex session on this machine reads this block:"]);
  // Antigravity CLI alone: the plan holds GEMINI.md, which Gemini CLI reads too, so the dialog names both.
  const one = await s.apply(["--agent", "antigravity"]);
  assert.deepEqual([rows(one.plan), Object.hasOwn(one.plan, "shared")], [[["antigravity", "block", "create", null]], false], "the plan is as it was: no shared key");
  assert.deepEqual(readersLine(s.dialogs[1]), [READERS]);
  // The readers come from the paths of the plan, changed or not: here only the Codex file changes.
  await writeFile(join(s.home, ".codex/AGENTS.md"), "");
  const mixed = await s.apply(["--agent", "codex", "--agent", "gemini"]);
  assert.deepEqual(rows(mixed.plan), [["codex", "block", "update", null], ["gemini", "block", "unchanged", null]]);
  assert.deepEqual([filesLine(s.dialogs[2]), readersLine(s.dialogs[2])], [["Files: " + join(s.home, ".codex/AGENTS.md")], [READERS]]);
  assert.equal(s.dialogs.length, 3);
});

test("removing the block for one agent keeps it while the other is an active user, and removing both removes it", async (t) => {
  const s = await liveHome(t, ["gemini", "antigravity"]);
  const { plan } = await s.apply(BOTH);
  assert.deepEqual([rows(plan), plan.shared], [[["antigravity", "block", "create", null]], [{ agent: "gemini", path: s.file, with: "antigravity" }]]);
  assert.match(s.dialogs[0].body, /Every Claude Code, Codex, Gemini CLI and Antigravity CLI session/);
  const text = await readFile(s.file, "utf8");
  assert.equal(blocks(text), 1);
  // Each agent alone: the other is in the live config, so the block stays, nothing is written and no dialog shows.
  for (const [agent, other] of [["gemini", "antigravity"], ["antigravity", "gemini"]]) {
    const kept = await s.apply(["--agent", agent, "--remove"]);
    assert.deepEqual(rows(kept.plan), [[agent, "block", "unchanged", "shared-file"]], agent);
    assert.deepEqual([kept.plan.mode, kept.plan.shared, Object.hasOwn(kept.plan.actions[0], "after")], ["remove", [{ agent, path: s.file, keptFor: [other] }], false], agent);
    assert.deepEqual([kept.result.applied, Object.hasOwn(kept.result, "written")], [false, false], agent);
    assert.equal(await readFile(s.file, "utf8"), text, agent);
  }
  assert.equal(s.dialogs.length, 1, "a kept block asks the owner nothing");
  // A remove that also names an agent with its own file takes that agent's block out and keeps the shared one.
  const mixed = await s.ok(["instructions", "plan", "--agent", "codex", "--agent", "gemini", "--remove"]);
  assert.deepEqual([rows(mixed), mixed.shared], [[["codex", "block", "blocked", "not-approved"], ["gemini", "block", "unchanged", "shared-file"]], [{ agent: "gemini", path: s.file, keptFor: ["antigravity"] }]]);
  // Both together: the block is removed with one edit.
  const both = await s.apply([...BOTH, "--remove"]);
  assert.deepEqual([rows(both.plan), both.plan.shared], [[["antigravity", "block", "remove", null]], [{ agent: "gemini", path: s.file, with: "antigravity" }]]);
  assert.deepEqual([both.result.applied, both.result.written.map((w) => w.path)], [true, [s.file]]);
  assert.deepEqual([s.dialogs.length, filesLine(s.dialogs[1])], [2, ["Files: " + s.file]]);
  assert.match(s.dialogs[1].title, /Remove the devtwin block from agent instructions/);
  assert.match(s.dialogs[1].body, /The block is removed\. Text outside the devtwin markers stays\./);
  assert.equal(await readFile(s.file, "utf8"), "");
  // With no block in the file, a remove for one agent has nothing to keep.
  const none = await s.ok(["instructions", "plan", "--agent", "gemini", "--remove"]);
  assert.deepEqual([rows(none), Object.hasOwn(none, "shared")], [[["gemini", "block", "unchanged", null]], false]);
});

test("a remove that mixes an own file and a kept shared file writes only the own file", async (t) => {
  // Gemini CLI and Antigravity CLI are the agents of the live config. The Codex AGENTS.md is an approved target too.
  const s = await liveHome(t, ["gemini", "antigravity"], { instructionTargets: [".codex/AGENTS.md"] });
  const own = join(s.home, ".codex/AGENTS.md"), MIXED = ["--agent", "codex", "--agent", "gemini"];
  const install = await s.apply(MIXED);
  assert.deepEqual([rows(install.plan), install.result.written.map((w) => w.path)], [[["codex", "block", "create", null], ["gemini", "block", "create", null]], [own, s.file]]);
  assert.deepEqual([filesLine(s.dialogs[0]), readersLine(s.dialogs[0])], [["Files: " + own + ", " + s.file], [READERS]]);
  const shared = await readFile(s.file);
  assert.deepEqual([blocks(await readFile(own, "utf8")), blocks(shared.toString("utf8"))], [1, 1]);
  // Antigravity CLI is in the live config and not part of the remove: the Codex block goes, the shared block stays.
  const remove = await s.apply([...MIXED, "--remove"]);
  assert.deepEqual([rows(remove.plan), remove.plan.shared], [[["codex", "block", "remove", null], ["gemini", "block", "unchanged", "shared-file"]], [{ agent: "gemini", path: s.file, keptFor: ["antigravity"] }]]);
  assert.deepEqual([remove.result.applied, remove.result.written.map((w) => w.path)], [true, [own]], "one edit, to the Codex file");
  assert.equal(s.dialogs.length, 2);
  assert.match(s.dialogs[1].title, /Remove the devtwin block from agent instructions/);
  assert.deepEqual(filesLine(s.dialogs[1]), ["Files: " + own], "the dialog lists the file it writes, not the kept one");
  assert.equal(s.dialogs[1].body.includes("GEMINI.md"), false);
  assert.equal(await readFile(own, "utf8"), "");
  assert.deepEqual(await readFile(s.file), shared, "the shared file keeps its bytes");
});

test("an approved hook target with no installed devtwin entries does not keep a shared instruction block", async (t) => {
  // Gemini CLI is the one agent of the live config. The Antigravity CLI hooks file is an approved hook target.
  const s = await liveHome(t, ["gemini"], { hookTargets: [".gemini/config/hooks.json"] });
  await s.apply(["--agent", "gemini"]);
  const text = await readFile(s.file, "utf8");
  const remove = () => s.ok(["instructions", "plan", "--agent", "gemini", "--remove"]);
  const stale = await remove();
  assert.deepEqual([rows(stale), Object.hasOwn(stale, "shared")], [[["gemini", "block", "remove", null]], false], "the approval alone keeps nothing");
  // A peer hooks file that is not valid JSON holds no installed entry: the remove plan does not throw and keeps nothing.
  const hooksFile = join(s.home, ".gemini/config/hooks.json");
  await writeFile(hooksFile, "{ not json\n");
  assert.deepEqual((await s.ok(["agents", "uninstall", "--hooks", "--agent", "antigravity"])).actions.map((a) => [a.agent, a.status, a.reason]), [["antigravity", "conflict", "invalid-json"]], "the hook plan reads the invalid file");
  const invalid = await remove();
  assert.deepEqual([invalid.mode, rows(invalid), Object.hasOwn(invalid, "shared")], ["remove", [["gemini", "block", "remove", null]], false], "an invalid peer hooks file keeps nothing");
  await rm(hooksFile);
  // Hook entries that a completed journal wrote make Antigravity CLI an active user of the file.
  const hooks = ["--hooks", "--agent", "antigravity"];
  assert.equal((await s.twice(["agents", "install", ...hooks])).applied, true);
  const kept = await s.apply(["--agent", "gemini", "--remove"]);
  assert.deepEqual([rows(kept.plan), kept.plan.shared, kept.result.applied], [[["gemini", "block", "unchanged", "shared-file"]], [{ agent: "gemini", path: s.file, keptFor: ["antigravity"] }], false]);
  assert.equal(await readFile(s.file, "utf8"), text);
  // A remove that names Antigravity CLI too is not held back by its own hooks.
  assert.deepEqual(rows(await s.ok(["instructions", "plan", ...BOTH, "--remove"])), [["antigravity", "block", "remove", null]]);
  // After the hooks are uninstalled the approval is stale again, and the block goes.
  assert.equal((await s.twice(["agents", "uninstall", ...hooks])).applied, true);
  assert.deepEqual(rows(await remove()), [["gemini", "block", "remove", null]]);
  const gone = await s.apply(["--agent", "gemini", "--remove"]);
  assert.deepEqual([gone.result.applied, await readFile(s.file, "utf8")], [true, ""]);
});

test("the instruction re-render after an activity review edits a shared file once", async (t) => {
  const s = await disposable(t);
  // The block is installed first, for one agent, with the owner dialog of instructions apply.
  await s.apply(["--agent", "gemini"]);
  const before = await readFile(s.file, "utf8");
  await s.ok(["pref", "propose", "--session", "ses_pref", "--title", "Browser tests", "--text", "Use Playwright for browser checks.", "--apply"], { env: { CLAUDECODE: "1" }, bare: true });
  const review = ["activity", "review", ...BOTH];
  const plan = await s.ok(review);
  assert.deepEqual(plan.instructions.agents, ["antigravity", "gemini"], "the review names both agents of the file");
  const result = await s.ok([...review, "--apply", "--plan-fingerprint", plan.fingerprint]);
  assert.match(s.dialogs.at(-1).body, /Use Playwright for browser checks\./);
  assert.deepEqual([result.accepted.length, result.instructions.applied, result.instructions.code ?? null], [1, true, null]);
  assert.deepEqual(result.instructions.written.map((w) => w.path), [s.file], "one edit");
  assert.deepEqual(result.instructions.actions.map((a) => [a.agent, a.status]), [["antigravity", "update"]]);
  const text = await readFile(s.file, "utf8");
  assert.notEqual(text, before);
  assert.deepEqual([blocks(text), text.split("- Browser tests: Use Playwright for browser checks.").length - 1], [1, 1]);
  assert.deepEqual(rows(await s.ok(["instructions", "plan", ...BOTH])), [["antigravity", "block", "unchanged", null]]);
});

test("two instruction targets with one path and different roles are refused", () => {
  // No adapter pair reaches this today, so the helper that merges targets by path is checked directly.
  const body = () => "x", path = "/h/example/.sample/NOTES.md";
  const merged = mergeTargets([{ agent: "a", role: "block", path, body }, { agent: "b", role: "owned-file", path: "/h/example/.sample/devtwin.md", body }, { agent: "c", role: "block", path, body }, { agent: "d", role: "block", path, body }]);
  assert.deepEqual(merged.map((m) => [m.agent, m.role, m.path, m.also]), [["a", "block", path, ["c", "d"]], ["b", "owned-file", "/h/example/.sample/devtwin.md", []]]);
  assert.deepEqual(mergeTargets([]), []);
  for (const list of [[{ agent: "a", role: "block", path, body }, { agent: "b", role: "import", path, body }], [{ agent: "a", role: "import", path, body }, { agent: "b", role: "import", path, body }, { agent: "c", role: "owned-file", path, body }]]) {
    assert.throws(() => mergeTargets(list), (e) => e.code === "DEVTWIN_INVALID_INPUT" && e.details.field === "agent" && e.details.path === path && /one instruction file/.test(e.message) && e.details.agents.length === 2, JSON.stringify(list.map((x) => x.role)));
  }
});

// OpenCode: the instruction file is devtwin's own file in the OpenCode folder (instructions.mode "owned-only"). No
// other file imports it: the generated plugin gives its text to the model.
const OPENCODE = ".config/opencode/devtwin.md";
const LISTED_READERS = "Every Claude Code and Codex session on this machine reads this block:";
const targets = (plan) => plan.actions.map((a) => [a.agent, a.role, a.path, a.status]);
// Every file under dir, as sorted paths relative to it.
async function filesUnder(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) if (!entry.isDirectory()) found.push(relative(dir, join(entry.parentPath, entry.name)));
  return found.sort();
}
// The instruction files OpenCode itself reads, anywhere under dir. devtwin makes none of them for OpenCode.
const agentFiles = async (dir) => (await filesUnder(dir)).filter((rel) => ["agents.md", "claude.md"].includes(basename(rel).toLowerCase()));

test("opencode instructions plan one action: the owned devtwin.md, with no import line and no AGENTS.md", async (t) => {
  const s = await disposable(t, { instructionTargets: [OPENCODE] }), owned = join(s.home, OPENCODE), ONE = ["--agent", "opencode"];
  assert.deepEqual([adapter("opencode").instructions.file, adapter("opencode").instructions.mode, basename(OPENCODE)], [OWNED_FILE, "owned-only", OWNED_FILE]);
  await s.pref(1, "Prefer small pull requests.", "Small PRs");
  const { plan, result } = await s.apply(ONE);
  // One action: the owned file. No import action in any other file, and no shared key.
  assert.deepEqual(targets(plan), [["opencode", "owned-file", owned, "create"]]);
  assert.deepEqual([Object.keys(plan), Object.keys(plan.actions[0])], [["kind", "mode", "block", "chars", "preferences", "actions", "warnings", "fingerprint"], ["agent", "role", "path", "status", "before", "after"]]);
  assert.deepEqual([result.applied, result.written.map((w) => w.path)], [true, [owned]], "one edit");
  // The dialog names the one file and OpenCode as a reader of the block.
  assert.equal(s.dialogs.length, 1);
  assert.deepEqual([s.dialogs[0].title, filesLine(s.dialogs[0]), readersLine(s.dialogs[0])], ["devtwin: Write the devtwin block to agent instructions", ["Files: " + owned], ["Every Claude Code, Codex and OpenCode session on this machine reads this block:"]]);
  // The file holds the block itself between the markers. No line imports another file.
  let text = await readFile(owned, "utf8");
  assert.equal(text, MARKERS.begin + "\n" + plan.block + MARKERS.end + "\n");
  assert.match(text, /Small PRs: Prefer small pull requests\./);
  assert.deepEqual(text.split("\n").filter((line) => line.startsWith("@")), []);
  // The OpenCode folder holds devtwin.md only, it is the one file in the agent home, and no AGENTS.md or CLAUDE.md
  // exists anywhere in the sandbox.
  assert.deepEqual([await readdir(join(s.home, ".config/opencode")), await filesUnder(s.home), await agentFiles(s.sandbox)], [["devtwin.md"], [OPENCODE], []]);
  // A second plan has nothing to write, and its apply asks the owner nothing.
  const again = await s.apply(ONE);
  assert.deepEqual([rows(again.plan), again.result.applied, s.dialogs.length], [[["opencode", "owned-file", "unchanged", null]], false, 1]);
  // An update is one edit to the same file, with one block.
  await s.pref(2, "Explain trade-offs in a short table.", "Trade-offs");
  const update = await s.apply(ONE);
  assert.deepEqual([rows(update.plan), update.result.written.map((w) => w.path)], [[["opencode", "owned-file", "update", null]], [owned]]);
  text = await readFile(owned, "utf8");
  assert.deepEqual([blocks(text), text.split("Trade-offs: Explain trade-offs").length - 1, await filesUnder(s.home), await agentFiles(s.sandbox)], [1, 1, [OPENCODE], []]);

  // A live config that names OpenCode: the plan with no flag includes it after the two listed agents, and the apply
  // for OpenCode writes the one file.
  const live = await liveHome(t, ["opencode"], { instructionTargets: [OPENCODE] }), liveOwned = join(live.home, OPENCODE);
  assert.deepEqual(rows(await live.ok(["instructions", "plan"])), [["claude", "owned-file", "blocked", "not-approved"], ["claude", "import", "blocked", "not-approved"], ["codex", "block", "blocked", "not-approved"], ["opencode", "owned-file", "create", null]]);
  const wrote = await live.apply(ONE);
  assert.deepEqual([targets(wrote.plan), wrote.result.written.map((w) => w.path)], [[["opencode", "owned-file", liveOwned, "create"]], [liveOwned]]);
  assert.deepEqual([filesLine(live.dialogs[0]), readersLine(live.dialogs[0])], [["Files: " + liveOwned], ["Every Claude Code, Codex and OpenCode session on this machine reads this block:"]]);
  assert.equal(await readFile(liveOwned, "utf8"), MARKERS.begin + "\n" + wrote.plan.block + MARKERS.end + "\n");
  assert.deepEqual([await filesUnder(join(live.home, ".config")), await agentFiles(join(live.home, ".config")), await filesUnder(join(live.home, ".claude")), await filesUnder(join(live.home, ".codex")), await filesUnder(join(live.home, ".gemini"))],
    [["opencode/devtwin.md"], [], [], [], []]);
});

test("removing the OpenCode instruction block empties its devtwin.md and touches no other file", async (t) => {
  // Claude Code and OpenCode are the agents of the live config. Both keep the block in a file named devtwin.md.
  const s = await liveHome(t, ["claude", "opencode"], { instructionTargets: [".claude/CLAUDE.md", ".claude/devtwin.md", OPENCODE] });
  const owned = join(s.home, OPENCODE), claudeMd = join(s.home, ".claude/CLAUDE.md"), claudeOwned = join(s.home, ".claude/devtwin.md"), BOTH_OWNED = ["--agent", "claude", "--agent", "opencode"];
  const install = await s.apply(BOTH_OWNED);
  assert.deepEqual([targets(install.plan), install.result.written.map((w) => w.path)], [[["claude", "owned-file", claudeOwned, "create"], ["claude", "import", claudeMd, "create"], ["opencode", "owned-file", owned, "create"]], [claudeOwned, claudeMd, owned]]);
  // The only import line is Claude Code's, and it names the Claude Code file.
  assert.equal(await readFile(claudeMd, "utf8"), MARKERS.begin + "\n@" + claudeOwned + "\n" + MARKERS.end + "\n");
  assert.equal(await readFile(owned, "utf8"), await readFile(claudeOwned, "utf8"));
  const others = async () => Promise.all([".claude", ".codex", ".gemini", ".agents"].map((rel) => treeSnapshot(join(s.home, rel))));
  const before = await others();
  // The remove is one edit: the block leaves the file, and the file stays, empty. No other agent names this path, so
  // nothing keeps the block.
  const remove = await s.apply(["--agent", "opencode", "--remove"]);
  assert.deepEqual([remove.plan.mode, rows(remove.plan), Object.hasOwn(remove.plan, "shared")], ["remove", [["opencode", "owned-file", "remove", null]], false]);
  assert.deepEqual([remove.result.applied, remove.result.written.map((w) => w.path)], [true, [owned]]);
  assert.deepEqual([s.dialogs.length, s.dialogs[1].title, filesLine(s.dialogs[1])], [2, "devtwin: Remove the devtwin block from agent instructions", ["Files: " + owned]]);
  assert.match(s.dialogs[1].body, /The block is removed\. Text outside the devtwin markers stays\./);
  assert.equal(await readFile(owned, "utf8"), "");
  assert.deepEqual([await filesUnder(join(s.home, ".config")), await agentFiles(join(s.home, ".config"))], [["opencode/devtwin.md"], []]);
  // Every other agent folder keeps its files, bytes and times: the Claude Code block and its import are as they were.
  assert.deepEqual(await others(), before);
  assert.deepEqual(rows(await s.ok(["instructions", "plan", "--agent", "claude"])), [["claude", "owned-file", "unchanged", null], ["claude", "import", "unchanged", null]]);
  // With no block in the file, a second remove writes nothing and asks nothing.
  const none = await s.apply(["--agent", "opencode", "--remove"]);
  assert.deepEqual([rows(none.plan), none.result.applied, s.dialogs.length], [[["opencode", "owned-file", "unchanged", null]], false, 2]);
  // Text outside the markers stays byte for byte through an install and a remove, as in every instruction file.
  await writeFile(owned, "kept line\n");
  const back = await s.apply(["--agent", "opencode"]);
  assert.equal(await readFile(owned, "utf8"), "kept line\n" + MARKERS.begin + "\n" + back.plan.block + MARKERS.end + "\n");
  await s.apply(["--agent", "opencode", "--remove"]);
  assert.deepEqual([await readFile(owned, "utf8"), await others()], ["kept line\n", before]);
});

test("an OpenCode instruction target that is not approved is blocked, and only the exact devtwin.md path can be approved", async (t) => {
  // The live config names OpenCode. Its instruction file is not an approved target yet.
  const s = await liveHome(t, ["opencode"]), dir = join(s.home, ".config/opencode"), owned = join(dir, "devtwin.md");
  await mkdir(join(dir, "plugins"), { recursive: true });
  const plan = await s.ok(["instructions", "plan", "--agent", "opencode"]);
  assert.deepEqual([targets(plan), plan.actions[0].reason], [[["opencode", "owned-file", owned, "blocked"]], "not-approved"]);
  const refused = await s.cli(["instructions", "apply", "--agent", "opencode", "--plan-fingerprint", plan.fingerprint]);
  assert.deepEqual([refused.ok, refused.error.code, refused.error.details], [false, "DEVTWIN_CONFLICT", { path: owned, status: "blocked", reason: "not-approved" }]);
  assert.deepEqual([s.dialogs.length, await readdir(dir)], [0, ["plugins"]], "no dialog and no file");
  // The write class takes no other path in or near the OpenCode folder: no AGENTS.md, no second devtwin file, no
  // settings file, and not the plugin file, which is a hook target.
  const classes = (...paths) => ["live", "write-classes", ...[s.file, ...paths].flatMap((path) => ["--instruction-target", path])];
  for (const rel of [".config/opencode/AGENTS.md", ".config/opencode/devtwin-notes.md", ".config/opencode/devtwin.md.bak", ".config/opencode/opencode.json", ".config/opencode/plugins/devtwin.md", ".config/opencode/plugins/devtwin.js",
    ".config/devtwin.md", ".config/opencode-next/devtwin.md", ".opencode/devtwin.md"]) {
    const out = await s.cli(classes(join(s.home, rel)));
    assert.deepEqual([out.ok, out.error?.code, out.error?.details.field], [false, "DEVTWIN_GATE_REQUIRED", "writeClasses.instructionTargets"], rel);
  }
  assert.deepEqual(rows(await s.ok(["instructions", "plan", "--agent", "opencode"])), [["opencode", "owned-file", "blocked", "not-approved"]], "a refused approval changes nothing");
  // The exact path, approved through the preview and the apply of live write-classes, makes the plan writable.
  const approved = await s.twice(classes(owned));
  assert.equal(approved.applied, true);
  s.dialogs.length = 0;
  const { plan: open, result } = await s.apply(["--agent", "opencode"]);
  assert.deepEqual([targets(open), result.written.map((w) => w.path), s.dialogs.length], [[["opencode", "owned-file", owned, "create"]], [owned], 1]);
  assert.deepEqual([(await readdir(dir)).sort(), await agentFiles(join(s.home, ".config"))], [["devtwin.md", "plugins"], []]);
  // A disposable pilot checks the same shape against its fake agent home.
  const p = await makePilot(t), home = p.agentHomes[0];
  await mkdir(join(home, ".config/opencode"), { recursive: true });
  const load = async (rel) => loadPilot(await p.with({ writeClasses: { instructionTargets: [join(home, rel)] } }), { home: p.fakeHome, kitRoot: KIT, env: {} });
  for (const rel of [".config/opencode/AGENTS.md", ".config/opencode/devtwin-notes.md"]) await assert.rejects(load(rel), (e) => e.code === "DEVTWIN_GATE_REQUIRED" && e.details.field === "writeClasses.instructionTargets", rel);
  assert.deepEqual((await load(OPENCODE)).writeClasses.instructionTargets, [join(home, OPENCODE)]);
});

test("an instruction target in a missing agent folder is a conflict, and the apply asks nothing and writes no file", async (t) => {
  // Claude Code and OpenCode are the agents of the live config. The OpenCode folder does not exist: the agent joins
  // with the shared skills folder alone, and the write class takes the path of a folder that is not there.
  const s = await liveHome(t, ["claude", "opencode"], { instructionTargets: [".claude/CLAUDE.md", ".claude/devtwin.md"] });
  const dir = join(s.home, ".config/opencode"), owned = join(dir, "devtwin.md"), claudeMd = join(s.home, ".claude/CLAUDE.md"), claudeOwned = join(s.home, ".claude/devtwin.md");
  const ONE = ["--agent", "opencode"], BOTH_OWNED = ["--agent", "claude", "--agent", "opencode"];
  assert.equal(existsSync(dir), false);
  assert.equal((await s.twice(["live", "write-classes", ...[s.file, claudeMd, claudeOwned, owned].flatMap((path) => ["--instruction-target", path])])).applied, true);
  s.dialogs.length = 0;
  const before = await treeSnapshot(join(s.home, ".claude"));
  const refusedWith = async (args, plan) => {
    const out = await s.cli(["instructions", "apply", ...args, "--plan-fingerprint", plan.fingerprint]);
    assert.deepEqual([out.ok, out.error.code, out.error.details], [false, "DEVTWIN_CONFLICT", { path: owned, status: "conflict", reason: "agent-folder-missing" }], args.join(" "));
  };
  // The plan names the missing folder, and the apply is refused before the dialog. devtwin does not make the folder.
  const plan = await s.ok(["instructions", "plan", ...ONE]);
  assert.deepEqual([targets(plan), Object.keys(plan.actions[0]), plan.actions[0].reason], [[["opencode", "owned-file", owned, "conflict"]], ["agent", "role", "path", "status", "reason"], "agent-folder-missing"]);
  await refusedWith(ONE, plan);
  // With Claude Code in the same apply nothing is written at all: the Claude Code files stay absent.
  const both = await s.ok(["instructions", "plan", ...BOTH_OWNED]);
  assert.deepEqual(rows(both), [["claude", "owned-file", "create", null], ["claude", "import", "create", null], ["opencode", "owned-file", "conflict", "agent-folder-missing"]]);
  await refusedWith(BOTH_OWNED, both);
  assert.deepEqual([s.dialogs.length, existsSync(dir), existsSync(claudeOwned), existsSync(claudeMd), await treeSnapshot(join(s.home, ".claude"))], [0, false, false, false, before]);
  // A remove has no block to take out: unchanged, with no dialog and no folder.
  const remove = await s.apply([...ONE, "--remove"]);
  assert.deepEqual([rows(remove.plan), remove.result.applied, s.dialogs.length, existsSync(dir)], [[["opencode", "owned-file", "unchanged", null]], false, 0, false]);
  // After the developer makes the folder, the same selection writes all three files.
  await mkdir(dir, { recursive: true });
  const wrote = await s.apply(BOTH_OWNED);
  assert.deepEqual([rows(wrote.plan), wrote.result.written.map((w) => w.path), s.dialogs.length], [[["claude", "owned-file", "create", null], ["claude", "import", "create", null], ["opencode", "owned-file", "create", null]], [claudeOwned, claudeMd, owned], 1]);
  assert.deepEqual([await readdir(dir), await agentFiles(join(s.home, ".config"))], [["devtwin.md"], []]);
  // The rule is the same for an earlier agent. Codex in a disposable home with no .codex folder: the approved
  // AGENTS.md is a conflict under the reason name the hook installer uses, the apply writes nothing and makes no
  // folder, and a remove stays unchanged.
  const d = await disposable(t, { instructionTargets: [".codex/AGENTS.md"] }), codexDir = join(d.home, ".codex"), agentsMd = join(codexDir, "AGENTS.md"), CODEX = ["--agent", "codex"];
  await rmdir(codexDir);
  const codexPlan = await d.ok(["instructions", "plan", ...CODEX]);
  assert.deepEqual([targets(codexPlan), rows(codexPlan)], [[["codex", "block", agentsMd, "conflict"]], [["codex", "block", "conflict", "agent-folder-missing"]]]);
  const codexApply = await d.cli(["instructions", "apply", ...CODEX, "--plan-fingerprint", codexPlan.fingerprint]);
  assert.deepEqual([codexApply.ok, codexApply.error.code, codexApply.error.details], [false, "DEVTWIN_CONFLICT", { path: agentsMd, status: "conflict", reason: "agent-folder-missing" }]);
  const codexRemove = await d.apply([...CODEX, "--remove"]);
  assert.deepEqual([rows(codexRemove.plan), codexRemove.result.applied, d.dialogs.length, existsSync(codexDir)], [[["codex", "block", "unchanged", null]], false, 0, false]);
  // With the folder in place the same plan creates the file, as it always did.
  await mkdir(codexDir);
  assert.deepEqual(rows(await d.ok(["instructions", "plan", ...CODEX])), [["codex", "block", "create", null]]);
});

test("an OpenCode instruction plan warns while the devtwin plugin file is not installed, and changes nothing else", async (t) => {
  const PLUGIN = ".config/opencode/plugins/devtwin.js";
  const s = await disposable(t, { instructionTargets: [OPENCODE, ".codex/AGENTS.md"], hookTargets: [PLUGIN] }), owned = join(s.home, OPENCODE), plugin = join(s.home, PLUGIN), ONE = ["--agent", "opencode"];
  const WARNING = { code: "INSTRUCTIONS_NEED_PLUGIN", agent: "opencode", message: "OpenCode reads this block only through the devtwin plugin file ~/.config/opencode/plugins/devtwin.js, which is not installed. Run agents install --hooks --agent opencode." };
  const need = (plan) => plan.warnings.filter((w) => w.code === "INSTRUCTIONS_NEED_PLUGIN");
  const hooks = async (route) => { const preview = await s.ok(["agents", route, "--hooks", ...ONE]); return s.ok(["agents", route, "--hooks", ...ONE, "--apply", "--plan-fingerprint", preview.fingerprint]); };
  // No plugins folder: the hook plan is blocked, so the plan warns. The plan and the apply are as they were: the
  // file is created and the warning comes back with the result.
  const first = await s.apply(ONE);
  assert.deepEqual([need(first.plan), targets(first.plan), first.result.applied, first.result.written.map((w) => w.path), need(first.result)], [[WARNING], [["opencode", "owned-file", owned, "create"]], true, [owned], [WARNING]]);
  // A plugins folder with no plugin file, and a plugin file that devtwin did not write: still not installed.
  await mkdir(dirname(plugin));
  assert.deepEqual(need(await s.ok(["instructions", "plan", ...ONE])), [WARNING], "no plugin file");
  await writeFile(plugin, "export default { id: \"sample\" };\n");
  assert.deepEqual(need(await s.ok(["instructions", "plan", ...ONE])), [WARNING], "a foreign plugin file");
  await rm(plugin);
  // The warning is part of the plan, so of its fingerprint: a plan made before the plugin install is stale after it.
  await s.pref(1, "Prefer small pull requests.", "Small PRs");
  const stale = await s.ok(["instructions", "plan", ...ONE]);
  assert.deepEqual(need(stale), [WARNING]);
  // After the plugin install through the real CLI, the plan has no such warning.
  assert.equal((await hooks("install")).applied, true);
  const fresh = await s.ok(["instructions", "plan", ...ONE]);
  assert.deepEqual([need(fresh), rows(fresh), fresh.warnings], [[], [["opencode", "owned-file", "update", null]], []]);
  const late = await s.cli(["instructions", "apply", ...ONE, "--plan-fingerprint", stale.fingerprint]);
  assert.deepEqual([late.ok, late.error.code], [false, "DEVTWIN_PLAN_MISMATCH"]);
  assert.equal((await s.ok(["instructions", "apply", ...ONE, "--plan-fingerprint", fresh.fingerprint])).applied, true);
  // A plan for the other agents never has the warning, with or without the plugin. A remove has none either: it
  // delivers no block.
  for (const args of [["--agent", "codex"], ["--agent", "claude", "--agent", "codex"], [...ONE, "--remove"]]) assert.deepEqual(need(await s.ok(["instructions", "plan", ...args])), [], args.join(" "));
  // After the plugin uninstall the warning is back, also in a plan that holds another agent.
  assert.equal((await hooks("uninstall")).applied, true);
  assert.equal(existsSync(plugin), false);
  assert.deepEqual(need(await s.ok(["instructions", "plan", "--agent", "codex", ...ONE])), [WARNING]);
  assert.deepEqual(need(await s.ok(["instructions", "plan", "--agent", "codex"])), []);
});

test("the instruction plans and dialogs of Claude Code, Codex, Gemini CLI and Antigravity CLI are unchanged", async (t) => {
  // Every instruction target of the five agents is approved, so only the selection decides what a plan holds.
  const s = await disposable(t, { instructionTargets: [".claude/CLAUDE.md", ".claude/devtwin.md", ".codex/AGENTS.md", OPENCODE] });
  const claudeMd = join(s.home, ".claude/CLAUDE.md"), claudeOwned = join(s.home, ".claude/devtwin.md"), agentsMd = join(s.home, ".codex/AGENTS.md"), owned = join(s.home, OPENCODE);
  // No flag in a disposable pilot: the two listed agents, with the three actions they always had.
  assert.deepEqual(targets(await s.ok(["instructions", "plan"])), [["claude", "owned-file", claudeOwned, "create"], ["claude", "import", claudeMd, "create"], ["codex", "block", agentsMd, "create"]]);
  // Claude Code: the owned file, and the import of it in CLAUDE.md.
  const claude = await s.apply(["--agent", "claude"]);
  assert.deepEqual([targets(claude.plan), claude.result.written.map((w) => w.path)], [[["claude", "owned-file", claudeOwned, "create"], ["claude", "import", claudeMd, "create"]], [claudeOwned, claudeMd]]);
  assert.deepEqual([filesLine(s.dialogs[0]), readersLine(s.dialogs[0])], [["Files: " + claudeOwned + ", " + claudeMd], [LISTED_READERS]]);
  assert.deepEqual([await readFile(claudeOwned, "utf8"), await readFile(claudeMd, "utf8")], [MARKERS.begin + "\n" + claude.plan.block + MARKERS.end + "\n", MARKERS.begin + "\n@" + claudeOwned + "\n" + MARKERS.end + "\n"]);
  // Codex: the block itself in AGENTS.md.
  const codex = await s.apply(["--agent", "codex"]);
  assert.deepEqual([targets(codex.plan), filesLine(s.dialogs[1]), readersLine(s.dialogs[1])], [[["codex", "block", agentsMd, "create"]], ["Files: " + agentsMd], [LISTED_READERS]]);
  assert.equal(await readFile(agentsMd, "utf8"), MARKERS.begin + "\n" + codex.plan.block + MARKERS.end + "\n");
  // Antigravity CLI and Gemini CLI: the block itself in the one GEMINI.md, and the dialog names both readers.
  const agy = await s.apply(["--agent", "antigravity"]);
  assert.deepEqual([targets(agy.plan), Object.hasOwn(agy.plan, "shared"), filesLine(s.dialogs[2]), readersLine(s.dialogs[2])], [[["antigravity", "block", s.file, "create"]], false, ["Files: " + s.file], [READERS]]);
  assert.deepEqual(targets(await s.ok(["instructions", "plan", "--agent", "gemini"])), [["gemini", "block", s.file, "unchanged"]]);
  await s.pref(1, "Prefer small pull requests.", "Small PRs");
  const gemini = await s.apply(["--agent", "gemini"]);
  assert.deepEqual([targets(gemini.plan), filesLine(s.dialogs[3]), readersLine(s.dialogs[3])], [[["gemini", "block", s.file, "update"]], ["Files: " + s.file], [READERS]]);
  assert.deepEqual(rows(await s.ok(["instructions", "plan", ...BOTH])), [["antigravity", "block", "unchanged", null]]);
  // None of these plans holds an OpenCode action, no dialog named OpenCode or its file, and its folder is empty.
  for (const plan of [claude.plan, codex.plan, agy.plan, gemini.plan]) assert.ok(plan.actions.every((a) => a.agent !== "opencode" && a.path !== owned), JSON.stringify(targets(plan)));
  assert.deepEqual([s.dialogs.length, s.dialogs.filter((d) => /OpenCode/.test(readersLine(d)[0]) || filesLine(d)[0].includes(owned)).length, await readdir(join(s.home, ".config/opencode"))], [4, 0, []]);
  // The five agents together: each earlier action is as it was, and OpenCode adds one action, for its own file.
  const ALL = ["claude", "codex", "gemini", "antigravity", "opencode"].flatMap((agent) => ["--agent", agent]);
  const all = await s.apply(ALL);
  assert.deepEqual(targets(all.plan), [["antigravity", "block", s.file, "unchanged"], ["claude", "owned-file", claudeOwned, "update"], ["claude", "import", claudeMd, "unchanged"], ["codex", "block", agentsMd, "update"], ["opencode", "owned-file", owned, "create"]]);
  assert.deepEqual([all.plan.shared, all.result.written.map((w) => w.path)], [[{ agent: "gemini", path: s.file, with: "antigravity" }], [claudeOwned, agentsMd, owned]]);
  assert.deepEqual([filesLine(s.dialogs[4]), readersLine(s.dialogs[4])], [["Files: " + claudeOwned + ", " + agentsMd + ", " + owned], ["Every Claude Code, Codex, Gemini CLI, Antigravity CLI and OpenCode session on this machine reads this block:"]]);
  // The Claude Code import still names the Claude Code file, and the OpenCode file is imported by nothing.
  assert.equal(await readFile(claudeMd, "utf8"), MARKERS.begin + "\n@" + claudeOwned + "\n" + MARKERS.end + "\n");
  for (const path of [claudeMd, claudeOwned, agentsMd, s.file, owned]) assert.equal((await readFile(path, "utf8")).includes(owned), false, path);
  // A remove for the four earlier agents plans what it always did and leaves the OpenCode file alone.
  const remove = await s.apply([...["claude", "codex", "gemini", "antigravity"].flatMap((agent) => ["--agent", agent]), "--remove"]);
  assert.deepEqual(targets(remove.plan), [["antigravity", "block", s.file, "remove"], ["claude", "owned-file", claudeOwned, "remove"], ["claude", "import", claudeMd, "remove"], ["codex", "block", agentsMd, "remove"]]);
  assert.deepEqual([await readFile(claudeOwned, "utf8"), await readFile(claudeMd, "utf8"), await readFile(agentsMd, "utf8"), await readFile(s.file, "utf8"), blocks(await readFile(owned, "utf8"))], ["", "", "", "", 1]);
});
