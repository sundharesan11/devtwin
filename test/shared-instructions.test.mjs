import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { makePilot, sandbox, makeRepo, fixtureGit, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { applyInit } from "../src/config/store.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";
import { addPersonalRecord } from "../src/records/personal.mjs";
import { MARKERS } from "../src/storage/owned-file.mjs";
import { digest } from "../src/storage/canonical.mjs";
import { mergeTargets } from "../src/agents/instructions.mjs";
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
// CLI hooks file approved as a hook target. Each path in instructionTargets is an approved instruction target too.
async function disposable(t, { instructionTargets = [] } = {}) {
  const p = await makePilot(t), home = p.agentHomes[0], file = join(home, ".gemini/GEMINI.md");
  const more = instructionTargets.map((rel) => join(home, rel));
  for (const dir of [join(home, ".gemini/config"), ...more.map((path) => dirname(path))]) await mkdir(dir, { recursive: true });
  const pilotPath = await p.with({ writeClasses: { instructionTargets: [file, ...more], hookTargets: [join(home, ".gemini/config/hooks.json")] } });
  const pilot = await loadPilot(pilotPath, { home: p.fakeHome, kitRoot: KIT, env: {} }), roots = rootsFromPilot(pilot);
  await applyInit(roots, { actorRefs: ["email:owner@example.com"], preferences: {}, now });
  const pref = (n, text, title = "Rule " + n) => addPersonalRecord(roots, { requestId: "req_sharedpref" + String(n).padStart(4, "0"), recordedBy: { actor: "human", runId: "run_cli00001" }, draft: { kind: "preference", class: "lesson", reach: "personal", status: "observed", title, body: text + "\n" } }, { now: () => new Date(now().getTime() + n * 1000) });
  // Installs the Antigravity CLI hooks with a completed journal, then returns the status an uninstall plan gives them.
  const agyHooks = async () => {
    const input = (mode) => ({ targetHome: home, agents: ["antigravity"], mode, kitRoot: KIT }), plan = await planHooks(pilot, input("install"));
    await applyHooks(roots, pilot, input("install"), { fingerprint: plan.fingerprint, runId: "run_sharedagy1", now: now() });
    return (await planHooks(pilot, input("uninstall"))).actions.map((a) => [a.agent, a.status]);
  };
  return { home, file, pref, agyHooks, ...routes({ pilot: pilotPath, home: p.fakeHome, kitRoot: KIT, extra: ["--home", home] }) };
}
// A fixture home with a live config for the named agents. GEMINI.md is an approved instruction target, with each path
// in instructionTargets, and each path in hookTargets is an approved hook target.
async function liveHome(t, agents, { hookTargets = [], instructionTargets = [] } = {}) {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin"), file = join(home, ".gemini/GEMINI.md");
  for (const rel of [".claude/skills", ".agents/skills", ".codex", ".gemini/config/skills"]) await mkdir(join(home, rel), { recursive: true });
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
