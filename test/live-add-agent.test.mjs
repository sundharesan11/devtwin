import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile, chmod, stat, rm, symlink } from "node:fs/promises";
import { sandbox, makePilot, makeRepo, fixtureGit, runCli, treeSnapshot, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { loadPilot, readApprovedDigest } from "../src/config/pilot.mjs";
import { planLiveAddAgent, applyLiveAddAgent } from "../src/config/live.mjs";
import { SKILL_NAMES } from "../src/agents/install.mjs";
import { ownerAction, OWNER_ACTIONS, DENY_REASON } from "../src/hooks/owner-block.mjs";
import { tierOf } from "../src/policy/tiers.mjs";

// live add-agent: the one route that adds an agent to an existing live config. Every test builds its live config in a
// temp home, as test/live-commands.test.mjs does, and every owner dialog goes to a recording fake.
const KIT = realpathSync(join(import.meta.dirname, ".."));
const ROUTE = ["live", "add-agent"];
async function liveHome(t, { folders = [".claude/skills", ".agents/skills", ".gemini/config/skills"] } = {}) {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin");
  for (const rel of folders) await mkdir(join(home, rel), { recursive: true });
  await mkdir(devtwin);
  await chmod(devtwin, 0o700);
  // The kit carries the bundled skills, so the setup steps of a new agent can plan their install.
  const files = { "README.md": "kit\n" };
  for (const name of SKILL_NAMES) files["skills/" + name + "/SKILL.md"] = await readFile(join(KIT, "skills", name, "SKILL.md"), "utf8");
  const kit = await makeRepo(join(devtwin, "kit"), files);
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  const repo = await makeRepo(join(sb, "work/atlas"), { "README.md": "# Atlas\n" });
  const liveConfig = join(devtwin, "live.json");
  // env is the environment of every command and of context; a test sets a variable in it. launchctl is a recording
  // fake, so a setup batch loads no real job.
  const dialogs = [], loaded = [], env = {};
  let answer = "approved";
  const ownerDialog = async (content) => { dialogs.push(content); return answer; };
  const launchctl = (args) => { loaded.push(args.join(" ")); return { status: 0, stdout: "", stderr: "" }; };
  const cli = async (args) => {
    const chunks = [];
    const code = await main(args, { stdout: { write: (v) => { chunks.push(v); return true; } }, now, home, env, kitRoot: kit, ownerDialog, launchctl });
    return { code, json: JSON.parse(chunks.join("")) };
  };
  const context = { home, env, kitRoot: kit, ownerDialog };
  const ok = async (args) => {
    const out = await cli(args);
    assert.equal(out.json.ok, true, args.slice(0, 2).join(" ") + ": " + JSON.stringify(out.json.error));
    return out.json.result;
  };
  const init = async (agents = ["claude", "codex"]) => {
    const args = ["live", "init", "--pilot", liveConfig, ...agents.flatMap((agent) => ["--agent", agent]), "--repo", repo];
    return ok([...args, "--apply", "--plan-fingerprint", (await ok(args)).fingerprint]);
  };
  const add = (agent, extra = []) => cli([...ROUTE, "--pilot", liveConfig, ...(agent === undefined ? [] : ["--agent", agent]), ...extra]);
  const apply = (agent, fingerprint) => add(agent, ["--apply", "--plan-fingerprint", fingerprint]);
  return { sb, home, devtwin, kit, repo, liveConfig, env, cli, ok, context, init, add, apply, dialogs, loaded, setAnswer: (value) => { answer = value; } };
}
const readConfig = async (path) => JSON.parse(await readFile(path, "utf8"));
const failed = (r, code, field) => {
  assert.equal(r.json.ok, false, JSON.stringify(r.json));
  assert.equal(r.json.error.code, code, JSON.stringify(r.json.error));
  if (field !== undefined) assert.equal(r.json.error.details.field, field, JSON.stringify(r.json.error));
};

test("live add-agent previews and applies a new agent, keeps every other key, and shows one owner dialog naming the agent and its folder", async (t) => {
  const h = await liveHome(t);
  const applied = await h.init();
  const dir = join(h.home, ".gemini/config/skills"), before = await readConfig(h.liveConfig), tree = await treeSnapshot(h.home);
  const skillDirs = { from: { claude: join(h.home, ".claude/skills"), codex: join(h.home, ".agents/skills") }, to: { antigravity: dir, claude: join(h.home, ".claude/skills"), codex: join(h.home, ".agents/skills") } };
  const preview = await h.add("antigravity");
  assert.equal(preview.json.ok, true, JSON.stringify(preview.json.error));
  assert.equal(preview.json.command, "live add-agent");
  const plan = preview.json.result;
  assert.match(plan.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual({ ...plan, fingerprint: null, digest: { ...plan.digest, to: null } },
    { preview: true, kind: "live-add-agent", config: h.liveConfig, configId: applied.configId, digest: { from: applied.digest, to: null }, agent: "antigravity", skillDir: dir, skillDirs, fingerprint: null });
  // The preview writes nothing and shows no dialog; an apply with no fingerprint is refused before the dialog.
  assert.equal(await treeSnapshot(h.home), tree);
  failed(await h.add("antigravity", ["--apply"]), "DEVTWIN_PLAN_REQUIRED");
  assert.equal(h.dialogs.length, 0);
  const done = await h.apply("antigravity", plan.fingerprint);
  assert.equal(done.json.ok, true, JSON.stringify(done.json.error));
  assert.deepEqual(done.json.result, { applied: true, config: h.liveConfig, configId: applied.configId, digest: plan.digest.to });
  // One dialog: the agent by name and by id, and the exact folder that devtwin may then write in.
  assert.equal(h.dialogs.length, 1);
  const { title, body } = h.dialogs[0];
  assert.equal(title, "devtwin: Add an agent to the live config");
  for (const part of ["Agent: Antigravity CLI (antigravity)", "Skills folder: " + dir, "devtwin-*"]) assert.ok(body.includes(part), part + " in " + body);
  // Only live.skillDirs changed: every other key has the value it had, and the keys keep their order.
  const written = await readConfig(h.liveConfig);
  assert.deepEqual(written, { ...before, live: { ...before.live, skillDirs: skillDirs.to } });
  assert.deepEqual([Object.keys(written), Object.keys(written.live), Object.keys(written.live.skillDirs)], [Object.keys(before), Object.keys(before.live), ["antigravity", "claude", "codex"]]);
  assert.equal(await readFile(h.liveConfig, "utf8"), JSON.stringify(written, null, 2) + "\n");
  assert.equal((await stat(h.liveConfig)).mode & 0o777, 0o600);
  // The new config loads with its approval, and a command that needs the live config runs.
  const pilot = await loadPilot(h.liveConfig, h.context);
  assert.equal(pilot.digest, plan.digest.to);
  assert.deepEqual(await readApprovedDigest(pilot), { schemaVersion: 1, configId: applied.configId, digest: pilot.digest });
  assert.equal((await h.cli(["doctor", "--pilot", h.liveConfig])).json.ok, true);
  // The agent is now named: the same request is refused, and nothing asks the owner again.
  failed(await h.add("antigravity"), "DEVTWIN_INVALID_INPUT", "agent");
  failed(await h.apply("antigravity", plan.fingerprint), "DEVTWIN_INVALID_INPUT", "agent");
  assert.equal(h.dialogs.length, 1);
});

test("live add-agent refuses an unknown agent, an agent already named, a missing skills folder and a stale fingerprint", async (t) => {
  const h = await liveHome(t, { folders: [".claude/skills", ".agents/skills", ".gemini"] });
  await h.init();
  const text = await readFile(h.liveConfig, "utf8"), dir = join(h.home, ".gemini/config/skills");
  const fake = "sha256:" + "1".repeat(64);
  // An id that is not a registered agent, with and without --apply; no value; and two values.
  for (const agent of ["cursor", "Claude", "", "skillDirs", "__proto__", undefined]) {
    failed(await h.add(agent), "DEVTWIN_INVALID_INPUT", "agent");
    failed(await h.apply(agent, fake), "DEVTWIN_INVALID_INPUT", "agent");
  }
  const twice = await h.cli([...ROUTE, "--pilot", h.liveConfig, "--agent", "gemini", "--agent", "antigravity"]);
  failed(twice, "DEVTWIN_USAGE");
  assert.equal(twice.code, 2);
  // An agent the live config already names.
  for (const agent of ["claude", "codex"]) {
    failed(await h.add(agent), "DEVTWIN_INVALID_INPUT", "agent");
    failed(await h.apply(agent, fake), "DEVTWIN_INVALID_INPUT", "agent");
  }
  // The skills folder must exist as a real directory: a missing folder, a file and a link to a folder are refused by
  // the live config validation, in the preview and in the apply.
  const refusedFolder = async (label) => {
    for (const r of [await h.add("antigravity"), await h.apply("antigravity", fake)]) {
      failed(r, "DEVTWIN_GATE_REQUIRED", "live.skillDirs.antigravity");
      assert.equal(r.json.error.details.protected, undefined, label);
    }
  };
  await refusedFolder("missing");
  await mkdir(join(h.home, ".gemini/config"));
  await refusedFolder("missing under its parent");
  await writeFile(dir, "x");
  await refusedFolder("a file");
  await rm(dir);
  await mkdir(join(h.home, "elsewhere"));
  await symlink(join(h.home, "elsewhere"), dir);
  await refusedFolder("a link");
  await rm(dir);
  await mkdir(dir);
  // A fingerprint that is not this plan's: a made-up one, and another agent's.
  const preview = await h.add("antigravity"), other = await h.add("gemini");
  assert.equal(preview.json.ok, true, JSON.stringify(preview.json.error));
  failed(await h.apply("antigravity", fake), "DEVTWIN_PLAN_MISMATCH");
  failed(await h.apply("antigravity", other.json.result.fingerprint), "DEVTWIN_PLAN_MISMATCH");
  assert.equal(h.dialogs.length, 0, "every refusal so far comes before the owner dialog");
  assert.equal(await readFile(h.liveConfig, "utf8"), text);
  // A stale one: the config changed after the preview, so the old fingerprint no longer names the change.
  assert.equal((await h.apply("gemini", other.json.result.fingerprint)).json.ok, true);
  const changed = await readFile(h.liveConfig, "utf8");
  failed(await h.apply("antigravity", preview.json.result.fingerprint), "DEVTWIN_PLAN_MISMATCH");
  assert.equal(h.dialogs.length, 1, "only the gemini change reached the dialog");
  assert.equal(await readFile(h.liveConfig, "utf8"), changed);
  // A disposable pilot has no live block to add an agent to.
  const p = await makePilot(t);
  const pilotRun = await runCli([...ROUTE, "--pilot", p.path, "--agent", "antigravity"], { home: p.fakeHome, env: {}, kitRoot: "/nonexistent-kit" });
  failed(pilotRun, "DEVTWIN_GATE_REQUIRED", "live");
  assert.equal(pilotRun.json.error.details.reason, "not-live");
});

test("a denied owner dialog leaves the live config and its approval unchanged", async (t) => {
  const h = await liveHome(t);
  const applied = await h.init();
  const preview = await h.add("antigravity");
  assert.equal(preview.json.ok, true, JSON.stringify(preview.json.error));
  const input = { configPath: h.liveConfig, agent: "antigravity", fingerprint: preview.json.result.fingerprint };
  assert.equal((await planLiveAddAgent(input, h.context)).fingerprint, input.fingerprint);
  const text = await readFile(h.liveConfig, "utf8"), tree = await treeSnapshot(h.home);
  const approval = await readApprovedDigest(await loadPilot(h.liveConfig, h.context));
  h.setAnswer("denied");
  failed(await h.apply("antigravity", input.fingerprint), "DEVTWIN_OWNER_DENIED");
  await assert.rejects(applyLiveAddAgent(input, h.context), { code: "DEVTWIN_OWNER_DENIED" });
  assert.equal(h.dialogs.length, 2, "each apply asked once");
  assert.equal(await readFile(h.liveConfig, "utf8"), text);
  assert.equal(await treeSnapshot(h.home), tree, "a denied dialog writes nothing");
  const pilot = await loadPilot(h.liveConfig, h.context);
  assert.equal(pilot.digest, applied.digest);
  assert.deepEqual(await readApprovedDigest(pilot), approval);
  assert.deepEqual(approval, { schemaVersion: 1, configId: applied.configId, digest: applied.digest });
  assert.deepEqual(Object.keys(pilot.live.skillDirs), ["claude", "codex"]);
  // The same preview still applies once the owner approves.
  h.setAnswer("approved");
  assert.deepEqual(await applyLiveAddAgent(input, h.context), { applied: true, config: h.liveConfig, configId: applied.configId, digest: preview.json.result.digest.to });
  assert.equal(h.dialogs.length, 3);
  assert.deepEqual(Object.keys((await loadPilot(h.liveConfig, h.context)).live.skillDirs), ["antigravity", "claude", "codex"]);
});

test("live add-agent accepts an agent that shares another agent's skills folder", async (t) => {
  const h = await liveHome(t, { folders: [".agents/skills"] });
  await h.init(["codex"]);
  const shared = join(h.home, ".agents/skills");
  const plan = await h.ok([...ROUTE, "--pilot", h.liveConfig, "--agent", "gemini"]);
  assert.deepEqual([plan.agent, plan.skillDir, plan.skillDirs], ["gemini", shared, { from: { codex: shared }, to: { codex: shared, gemini: shared } }]);
  await h.ok([...ROUTE, "--pilot", h.liveConfig, "--agent", "gemini", "--apply", "--plan-fingerprint", plan.fingerprint]);
  assert.equal(h.dialogs.length, 1);
  for (const part of ["Agent: Gemini CLI (gemini)", "Skills folder: " + shared]) assert.ok(h.dialogs[0].body.includes(part), part);
  const pilot = await loadPilot(h.liveConfig, h.context);
  assert.deepEqual(pilot.live.skillDirs, { codex: shared, gemini: shared });
  assert.deepEqual(Object.keys((await readConfig(h.liveConfig)).live.skillDirs), ["codex", "gemini"]);
  // The two agents now share one skills install, as after a live init that named both.
  const install = await h.ok(["agents", "install", "--pilot", h.liveConfig, "--agent", "codex", "--agent", "gemini"]);
  assert.deepEqual(install.shared, [{ agent: "gemini", dir: shared, with: "codex" }]);
  // An agent whose folder is missing is still refused in this config.
  failed(await h.add("claude"), "DEVTWIN_GATE_REQUIRED", "live.skillDirs.claude");
});

test("the hook denies live add-agent with --apply from an agent shell and allows its preview", async (t) => {
  const p = await makePilot(t);
  const PREVIEW = 'node "/opt/example-kit/bin/devtwin.mjs" live add-agent --pilot /x/live.json --agent antigravity';
  const APPLY = PREVIEW + " --apply --plan-fingerprint sha256:00";
  // One shell payload per agent, in the shape that agent sends.
  const shells = {
    claude: (command) => ({ session_id: "s-owner", cwd: p.reposDir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, description: "run" }, tool_use_id: "toolu_01Example" }),
    codex: (command) => ({ session_id: "s-owner", cwd: p.reposDir, hook_event_name: "PreToolUse", tool_name: "shell", tool_input: { command: ["bash", "-c", command] } }),
    gemini: (command) => ({ session_id: "s-owner", cwd: p.reposDir, hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command } }),
    antigravity: (command) => ({ conversationId: "agy-conversation-0001", cwd: p.reposDir, hookEventName: "PreToolUse", workspacePaths: [p.reposDir], stepIdx: 3, toolCall: { id: "call-0001", name: "run_command", args: { CommandLine: command } } })
  };
  const denyOut = (agent) => (["gemini", "antigravity"].includes(agent) ? '{"decision":"deny","reason":' + JSON.stringify(DENY_REASON) + "}"
    : '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":' + JSON.stringify(DENY_REASON) + "}}") + "\n";
  // The real hook entry, as the agent runs it.
  const hook = async (agent, body) => {
    const chunks = [];
    const code = await main(["hook", "--event", "pre-tool", "--agent", agent, "--pilot", p.path], { stdout: { write: (v) => { chunks.push(v); return true; } }, stdin: JSON.stringify(body), now });
    return { code, out: chunks.join("") };
  };
  assert.ok(OWNER_ACTIONS.some((a) => a.words.join(" ") === "live add-agent" && a.apply === true));
  assert.equal(tierOf({ route: "live add-agent" }), "always-ask");
  for (const [agent, shell] of Object.entries(shells)) {
    assert.equal(ownerAction(agent, shell(APPLY)), "live add-agent --apply", agent);
    assert.equal(ownerAction(agent, shell("script -q /dev/null " + APPLY)), "live add-agent --apply", agent + " through a wrapper");
    assert.equal(ownerAction(agent, shell(PREVIEW)), null, agent + " preview");
    assert.deepEqual(await hook(agent, shell(APPLY)), { code: 0, out: denyOut(agent) }, agent);
    const open = await hook(agent, shell(PREVIEW));
    assert.equal(open.code, 0, agent);
    assert.ok(!open.out.includes('"deny"') && !open.out.includes(DENY_REASON), agent + " preview => " + open.out);
  }
  // Antigravity CLI also types into a running task; that text is a shell command too.
  const typed = { ...shells.antigravity(""), toolCall: { id: "call-0002", name: "manage_task", args: { Action: "send_input", Input: APPLY + "\n" } } };
  assert.equal(ownerAction("antigravity", typed), "live add-agent --apply");
  assert.deepEqual(await hook("antigravity", typed), { code: 0, out: denyOut("antigravity") });
});

test("after live add-agent, setup status lists the agent's skills and hooks steps as pending instead of skipped", async (t) => {
  const h = await liveHome(t);
  await h.init();
  await h.ok(["init", "--pilot", h.liveConfig, "--actor", "email:owner@example.com", "--apply"]);
  const agentSteps = async () => Object.fromEntries((await h.ok(["setup", "status", "--pilot", h.liveConfig])).steps.filter((s) => s.agent === "antigravity").map((s) => [s.id, s]));
  const before = await agentSteps();
  assert.deepEqual(Object.keys(before), ["skills-antigravity", "hooks-antigravity"]);
  for (const step of Object.values(before)) assert.deepEqual([step.skipped, step.done], ["agent not in the live config", false], step.id);
  const plan = await h.ok([...ROUTE, "--pilot", h.liveConfig, "--agent", "antigravity"]);
  await h.ok([...ROUTE, "--pilot", h.liveConfig, "--agent", "antigravity", "--apply", "--plan-fingerprint", plan.fingerprint]);
  const after = await agentSteps();
  for (const step of Object.values(after)) assert.deepEqual([Object.hasOwn(step, "skipped"), step.done, step.owner, step.problem], [false, false, true, undefined], step.id);
  // The skills step can now plan its install into the new folder, and writes nothing until its own apply.
  const skills = await h.ok(["setup", "plan", "--pilot", h.liveConfig, "--step", "skills-antigravity"]);
  assert.equal(skills.step.skipped, undefined);
  assert.match(skills.fingerprint, /^sha256:/);
  assert.ok(skills.preview.actions.length === SKILL_NAMES.length && skills.preview.actions.every((a) => a.agent === "antigravity" && a.status === "create"), JSON.stringify(skills.preview.actions));
  // The agents the config named before keep their state.
  const all = (await h.ok(["setup", "status", "--pilot", h.liveConfig])).steps.filter((s) => s.agent);
  assert.deepEqual(all.filter((s) => s.skipped).map((s) => s.id), ["skills-gemini", "hooks-gemini"]);
});

test("live add-agent takes the Claude Code skills folder from CLAUDE_CONFIG_DIR", async (t) => {
  // Claude Code keeps its files in CLAUDE_CONFIG_DIR when the variable is set. The default folder ~/.claude/skills
  // exists here too, so only the environment decides which folder the route names.
  const h = await liveHome(t, { folders: [".claude/skills", ".agents/skills"] });
  const moved = join(h.home, "claude-config"), dir = join(moved, "skills"), shared = join(h.home, ".agents/skills");
  const request = [...ROUTE, "--pilot", h.liveConfig, "--agent", "claude"];
  await mkdir(moved);
  const applied = await h.init(["codex"]);
  // Without the variable the route plans the default folder.
  const plain = await h.ok(request);
  assert.equal(plain.skillDir, join(h.home, ".claude/skills"));
  h.env.CLAUDE_CONFIG_DIR = moved;
  // With it the folder is <CLAUDE_CONFIG_DIR>/skills, and that folder must exist: the default one does not stand in.
  failed(await h.add("claude"), "DEVTWIN_GATE_REQUIRED", "live.skillDirs.claude");
  await mkdir(dir);
  const plan = await h.ok(request);
  assert.deepEqual([plan.agent, plan.skillDir, plan.skillDirs], ["claude", dir, { from: { codex: shared }, to: { claude: dir, codex: shared } }]);
  // The plan made without the variable names another folder, so its fingerprint does not apply in this environment.
  failed(await h.apply("claude", plain.fingerprint), "DEVTWIN_PLAN_MISMATCH");
  assert.equal(h.dialogs.length, 0);
  const done = await h.apply("claude", plan.fingerprint);
  assert.equal(done.json.ok, true, JSON.stringify(done.json.error));
  assert.equal(h.dialogs.length, 1);
  for (const part of ["Agent: Claude Code (claude)", "Skills folder: " + dir]) assert.ok(h.dialogs[0].body.includes(part), part + " in " + h.dialogs[0].body);
  assert.deepEqual((await readConfig(h.liveConfig)).live.skillDirs, { claude: dir, codex: shared });
  // The new config loads in that environment with its approval, and a command that needs the live config runs.
  const pilot = await loadPilot(h.liveConfig, h.context);
  assert.deepEqual([pilot.digest, pilot.live.skillDirs], [plan.digest.to, { claude: dir, codex: shared }]);
  assert.deepEqual(await readApprovedDigest(pilot), { schemaVersion: 1, configId: applied.configId, digest: pilot.digest });
  assert.equal((await h.cli(["doctor", "--pilot", h.liveConfig])).json.ok, true);
  // The validation reads the same variable: without it, the config names a folder that is not Claude Code's.
  await assert.rejects(loadPilot(h.liveConfig, { ...h.context, env: {} }), (e) => e.code === "DEVTWIN_GATE_REQUIRED" && e.details.field === "live.skillDirs.claude");
});

// The hook events of Antigravity CLI, in the order devtwin writes them, and the devtwin hook event each one runs.
const AGY_EVENTS = { SessionStart: "session-start", PreInvocation: "user-prompt", PreToolUse: "pre-tool", PostToolUse: "post-tool", Stop: "stop" };

test("after live add-agent, one setup batch installs the agent's skills and hooks", async (t) => {
  // The agent folder ~/.gemini/config exists before anything runs: devtwin creates no agent folder.
  const h = await liveHome(t, { folders: [".claude/skills", ".agents/skills", ".codex", ".gemini/config/skills", "Library/LaunchAgents"] });
  await h.init();
  await h.ok(["init", "--pilot", h.liveConfig, "--actor", "email:owner@example.com", "--apply"]);
  const skillsDir = join(h.home, ".gemini/config/skills"), hooksFile = join(h.home, ".gemini/config/hooks.json"), agentSteps = ["skills-antigravity", "hooks-antigravity"];
  const flags = ["--pilot", h.liveConfig, "--all-pending", "--backup-target", join(h.home, "devtwin-backups")];
  const steps = async (ids) => {
    const all = (await h.ok(["setup", "status", "--pilot", h.liveConfig, "--backup-target", join(h.home, "devtwin-backups")])).steps;
    return ids.map((id) => all.find((s) => s.id === id));
  };
  // One batch, as the owner runs it: a plan, which shows no dialog, then the apply behind one owner dialog.
  const batch = async () => {
    const shown = h.dialogs.length, plan = await h.ok(["setup", "plan", ...flags]);
    assert.equal(h.dialogs.length, shown, "a plan shows no dialog");
    const out = await h.cli(["setup", "apply", ...flags, "--apply", "--plan-fingerprint", plan.fingerprint]);
    assert.equal(out.json.ok, true, JSON.stringify(out.json.error));
    assert.equal(h.dialogs.length, shown + 1, "one owner dialog for the whole batch");
    assert.equal(h.dialogs.at(-1).body, "Approve only if you started this action yourself.\n\n" + plan.dialog.body);
    assert.deepEqual(out.json.result.done.map((d) => d.id), plan.items.map((i) => i.id));
    return plan;
  };
  // The owner set up Claude Code and Codex earlier. That batch leaves out the agent the config does not name.
  const first = await batch();
  for (const id of agentSteps) assert.equal(first.skipped.find((s) => s.id === id)?.reason, "agent not in the live config", id);
  const others = () => Promise.all([".claude", ".agents", ".codex", "Library/LaunchAgents"].map((rel) => treeSnapshot(join(h.home, rel))));
  const gemini = await treeSnapshot(join(h.home, ".gemini")), before = await others(), jobs = h.loaded.length;
  assert.deepEqual([await readdir(skillsDir), existsSync(hooksFile)], [[], false]);
  assert.ok(jobs > 0, "the first batch loaded its jobs through the launchctl fake");
  // The route adds the agent and installs nothing. Its dialog names the batch that does.
  const add = await h.ok([...ROUTE, "--pilot", h.liveConfig, "--agent", "antigravity"]);
  await h.ok([...ROUTE, "--pilot", h.liveConfig, "--agent", "antigravity", "--apply", "--plan-fingerprint", add.fingerprint]);
  assert.ok(h.dialogs.at(-1).body.includes("the next setup batch installs the skills and hooks for this agent"), h.dialogs.at(-1).body);
  assert.equal(await treeSnapshot(join(h.home, ".gemini")), gemini, "the route writes nothing in the agent folder");
  for (const step of await steps(["write-classes-hooks", ...agentSteps])) assert.deepEqual([step.done, step.skipped, step.problem], [false, undefined, undefined], step.id);
  // The next batch: the hook settings file joins the hookTargets write class first, then the skills, then the hooks.
  // The paths confirmation is in it because the route changed the live config.
  const plan = await batch();
  assert.deepEqual(plan.items.map((i) => i.id), ["config", "skills-antigravity", "paths-confirm", "hooks-antigravity"]);
  const lines = Object.fromEntries(plan.items.map((i) => [i.id, i.lines]));
  assert.deepEqual([plan.items[0].covers, lines.config, lines["skills-antigravity"], lines["hooks-antigravity"]], [["write-classes-hooks"], ["Approve hook settings file ~/.gemini/config/hooks.json"],
    ["Install skills in ~/.gemini/config/skills: " + SKILL_NAMES.join(", ")], ["Add devtwin hook entries to ~/.gemini/config/hooks.json: " + Object.keys(AGY_EVENTS).join(", ")]]);
  assert.deepEqual(plan.excluded, []);
  assert.equal(h.dialogs.at(-1).title, "devtwin: Approve 4 setup changes");
  // The bundled skills are in the agent's skills folder, with the bytes the kit holds.
  assert.deepEqual((await readdir(skillsDir)).sort(), [...SKILL_NAMES].sort());
  for (const name of SKILL_NAMES) assert.equal(await readFile(join(skillsDir, name, "SKILL.md"), "utf8"), await readFile(join(h.kit, "skills", name, "SKILL.md"), "utf8"), name);
  // hooks.json holds one key, devtwin, with one handler for each of the five events. Each handler runs the hook of
  // the pinned kit for this agent and this live config.
  const hooks = JSON.parse(await readFile(hooksFile, "utf8"));
  assert.deepEqual([Object.keys(hooks), Object.keys(hooks.devtwin ?? {})], [["devtwin"], Object.keys(AGY_EVENTS)]);
  for (const [event, word] of Object.entries(AGY_EVENTS)) {
    const handlers = hooks.devtwin[event].flatMap((entry) => entry.hooks ?? [entry]);
    assert.deepEqual(handlers.map((x) => x.command), ['node "' + h.kit + '/bin/devtwin.mjs" hook --event ' + word + ' --agent antigravity --pilot "' + realpathSync(h.liveConfig) + '"'], event);
  }
  // The batch approved the hook settings file in the live config, next to the files of the other agents.
  assert.deepEqual((await readConfig(h.liveConfig)).writeClasses.hookTargets, [join(h.home, ".claude/settings.json"), join(h.home, ".codex/hooks.json"), hooksFile]);
  for (const step of await steps(["write-classes-hooks", ...agentSteps])) assert.deepEqual([step.done, step.skipped, step.problem], [true, undefined, undefined], step.id);
  // Nothing of the other agents changed, no job was loaded again, and a new plan has no step left for the agent.
  assert.deepEqual(await others(), before);
  assert.equal(h.loaded.length, jobs);
  const next = await h.ok(["setup", "plan", ...flags]);
  for (const id of agentSteps) assert.equal(next.skipped.find((s) => s.id === id)?.reason, "done", id);
});
