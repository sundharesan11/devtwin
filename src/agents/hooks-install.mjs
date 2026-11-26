import { realpathSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { DevtwinError } from "../errors.mjs";
import { assertInPilot, assertWritable, agentDirsFor } from "../config/pilot.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { sha256, canonicalJson } from "../storage/canonical.mjs";
import { readPrivateJson, writeNewFile, atomicReplace, ensurePrivatePath, info } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { RUN_ID } from "../storage/runs.mjs";
import { editOwnedFile, readOwnedText, replaceOwnedEntries } from "../storage/owned-file.mjs";
import { writeKitReceipt, receiptPath, receiptProblem, readPilotBytes } from "../hooks/receipt.mjs";
import { readIndex, rebuildDerived } from "../lessons/index.mjs";
import { SCOPE_ID } from "../identity/ids.mjs";
import { stableNodePath } from "../schedule/launchd.mjs";
import { adapter, AGENT_IDS, LISTED, wholeFileHooks as wholeFile } from "./adapters/index.mjs";
import { commandPaths } from "./command-form.mjs";
export { CODEX_TRUST_NOTE } from "./adapters/codex.mjs";
// U8: devtwin's hook entries in the agent settings files (KTD6, KTD7, KTD9). The only files are the approved
// hookTargets, one per agent adapter (src/agents/adapters): <claudeDir>/settings.json, ~/.codex/hooks.json,
// ~/.gemini/settings.json and ~/.gemini/config/hooks.json. The first three use the shape
// { "hooks": { "<Event>": [ { "matcher"?: "<regex>", "hooks": [ { "type": "command", "command": "...", "timeout": 10 } ] } ] } },
// and the adapter builds the entry: Gemini CLI adds a name and counts the timeout in milliseconds.
// The Antigravity CLI file is keyed by hook name, so its event lists sit under the adapter's hooks.container:
// { "devtwin": { "<Event>": [ ... ], "enabled"?: false }, "<another name>": { ... } }. There a lifecycle event's entry is
// the handler itself, { "type": "command", "command": "...", "timeout": 10 }, and a tool event's entry is the group
// above. devtwin reads and changes its own container only; an object under another name is never read.
// An entry is devtwin's only when a completed hook journal of this config wrote it and each of its commands names
// this pilot. Every other entry, including one that looks like devtwin's, is the developer's and is never changed.
// A whole-file target (the adapter's hooks.target is "file": the OpenCode plugin, ~/.config/opencode/plugins/devtwin.js)
// is no JSON file with entries. The adapter generates its text, hooks.content(context), and the file is devtwin's as a
// whole or not at all. Plans, journals, inventories and status rows keep their shapes: the target has one pseudo-event,
// "file", with one entry, { "sha256": "<hash of the file's text>" }. The file is devtwin's only when a completed hook
// journal of this config recorded that hash for that path. devtwin never writes over and never removes any other file.
export const HOOK_KIND = "hook-bundled";
export const HOOK_INVENTORY = "hook-inventory";
const KIT = fileURLToPath(new URL("../..", import.meta.url));
const AGENTS = AGENT_IDS, WRITES = ["create", "update", "remove"];
// [agent event, devtwin hook event, matcher], per agent, from its adapter.
// U33 (KTD32): Stop writes the stop stub and prints nothing. It is added last, so every earlier entry keeps its bytes;
// an install made before it reports Stop as missing (status partial) until the owner installs the hooks again.
export const HOOK_EVENTS = Object.freeze(Object.fromEntries(AGENTS.map((id) => [id, adapter(id).hooks.events])));
// The notes an owner needs after a hook install for these agents, such as the Codex /hooks trust step.
const notesFor = (agents) => [...new Set(agents)].map((id) => adapter(id).hooks.note).filter(Boolean);
const UNSAFE_IN_COMMAND = /["$`\\\n\r]/;
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const lockPath = (roots) => join(roots.stateRoot, "locks", "install.lock");
const configIdOf = (pilot) => pilot.live?.configId ?? null;
const hashText = (text) => text === null ? null : sha256(Buffer.from(text));
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The hook line. It names the kit clone and the pilot only, so a new kit commit in the same clone keeps it byte-identical.
export const hookCommand = ({ kitRoot, pilotPath, event, agent }) => 'node "' + kitRoot + '/bin/devtwin.mjs" hook --event ' + event + " --agent " + agent + ' --pilot "' + pilotPath + '"';
const shapeFor = (pilotPath, agent = "[a-z]+") => new RegExp('^node "/[^"$`\\\\\\n\\r]+/bin/devtwin\\.mjs" hook --event [a-z-]+ --agent ' + agent + ' --pilot "' + escapeRe(pilotPath) + '"$');
// The top-level key of the hook file that holds this agent's event lists.
const containerOf = (agent) => adapter(agent).hooks.container ?? "hooks";
// True for an agent whose hook file is keyed by hook name: only there can an entry be the handler itself.
const flatOf = (agent) => adapter(agent).hooks.container !== undefined;
// An entry's commands: each handler's command in a group and, when flat is set, the entry's own command. A Claude
// Code, Codex or Gemini CLI entry is always a group, so a top-level command there is no handler and is not read.
const commandsOf = (entry, flat) => isObject(entry) ? [flat ? entry.command : null, ...(Array.isArray(entry.hooks) ? entry.hooks.filter(isObject).map((h) => h.command) : [])].filter((c) => typeof c === "string") : [];
const devtwinLike = (entry, flat) => commandsOf(entry, flat).some((c) => /devtwin/i.test(c) && /\bhook\b/.test(c));
// The name of the one pseudo-event of a whole-file target (wholeFile: the registry's wholeFileHooks).
const FILE_EVENT = "file";
// The kit and pilot paths the hook line names. In live mode the kit is the live config's pinned clone.
// nodePath is the Node path a whole-file target bakes in for a PATH with no node. A hook line never names it: it runs
// plain "node". It is the stable path that the scheduled jobs use (stableNodePath in src/schedule/launchd.mjs): under
// Homebrew, process.execPath is a versioned Cellar folder, so with it every brew upgrade would change the expected
// text, turn an installed plugin into an outdated one, and end a preview that another Node version made. This is the
// one place that reads it, so the expected hash and the written text come from one value. nodeLookup
// ({ execPath, realpath, isFile }) is the test seam of the jobs; a hook plan takes it as input.nodeLookup.
export function hookContext(pilot, kitRoot, nodeLookup) {
  const context = commandPaths(pilot, kitRoot ?? KIT);
  for (const path of Object.values(context)) if (UNSAFE_IN_COMMAND.test(path)) throw new DevtwinError("INVALID_INPUT", "Path cannot be quoted in a hook command", { field: "hookCommand" });
  return { ...context, nodePath: stableNodePath(nodeLookup ?? {}) };
}
// The text of a whole-file target for a hook context. The expected hash and the written file both come from here.
const fileText = (agent, context) => adapter(agent).hooks.content(context);
export function expectedEntries(agent, context) {
  if (wholeFile(agent)) return { [FILE_EVENT]: [{ sha256: hashText(fileText(agent, context)) }] };
  return Object.fromEntries(HOOK_EVENTS[agent].map(([name, event, matcher]) => [name, [adapter(agent).hooks.entry({ command: hookCommand({ ...context, event, agent }), matcher, event })]]));
}
function targets(pilot, { targetHome, agents }) {
  if (!Array.isArray(agents) || !agents.length || agents.some((a) => typeof a !== "string" || !AGENTS.includes(a))) throw new DevtwinError("INVALID_INPUT", "Invalid installer selection");
  let dirs;
  if (pilot.live) {
    if (targetHome !== undefined && targetHome !== pilot.live.home) throw new DevtwinError("GATE_REQUIRED", "Live target must be the live config home", { field: "targetHome" });
    dirs = agentDirsFor({ home: pilot.live.home, env: pilot._context?.env ?? process.env });
  } else {
    assertInPilot(pilot, targetHome, "agentHomes");
    if (targetHome === homedir()) throw new DevtwinError("GATE_REQUIRED", "Real home refused");
    dirs = agentDirsFor({ home: targetHome, env: {} });
  }
  return [...new Set(agents)].sort().map((agent) => ({ agent, path: join(dirs[agent], adapter(agent).hooks.file) }));
}
// Journals: stateRoot/runs/<runId>/journal.json, shared with the skill installer. An unreadable journal is null.
async function readJournals(stateRoot) {
  let ids = [];
  try { ids = await readdir(join(stateRoot, "runs")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const found = [];
  for (const id of ids.sort()) {
    if (!RUN_ID.test(id) || !info(join(stateRoot, "runs", id, "journal.json"))) continue;
    try { found.push({ id, journal: await readPrivateJson(join(stateRoot, "runs", id, "journal.json")) }); } catch { found.push({ id, journal: null }); }
  }
  return found;
}
export const isHookKind = (journal) => journal?.kind === HOOK_KIND;
export const isHookJournal = (pilot, id, j) => isHookKind(j) && j.configId === configIdOf(pilot) && j.schemaVersion === 1 && j.runId === id && ["install", "uninstall"].includes(j.mode)
  && Array.isArray(j.intended) && Array.isArray(j.started) && Array.isArray(j.completed)
  && j.intended.every((e) => isObject(e) && AGENTS.includes(e.agent) && typeof e.path === "string" && WRITES.includes(e.status) && isObject(e.entries));
export const hookJournalFinished = (j) => j.closed === true || j.intended.every((_, i) => j.completed.includes(i));
const key = (path, event, entry) => path + "\n" + event + "\n" + canonicalJson(entry);
// Every entry a completed hook journal of this config wrote, and the commands in them.
function ledger(pilot, journals) {
  const entries = new Set(), commands = new Set();
  for (const { id, journal } of journals) {
    if (!isHookJournal(pilot, id, journal)) continue;
    for (const i of journal.completed) {
      const e = journal.intended[i];
      if (!e) continue;
      for (const [event, list] of Object.entries(e.entries)) for (const entry of Array.isArray(list) ? list : []) { entries.add(key(e.path, event, entry)); for (const c of commandsOf(entry, flatOf(e.agent))) commands.add(c); }
    }
  }
  return { entries, commands };
}
// Per agent event: installed (devtwin's entries equal the expected ones), outdated (devtwin's entries differ, such as an
// earlier kit clone), missing, modified (an entry with devtwin's command was edited) or foreign-entry (an exact copy
// devtwin did not write). Entries that only look like devtwin's are listed in foreign and left alone.
function analyze(text, { agent, path, owned, expected, context }) {
  let root;
  try { root = text === null ? {} : JSON.parse(text); } catch { return { conflict: "invalid-json" }; }
  const box = containerOf(agent), flat = flatOf(agent);
  if (!isObject(root) || (root[box] !== undefined && !isObject(root[box]))) return { conflict: "unexpected-shape" };
  const shape = shapeFor(context.pilotPath, agent), ours = new Set(Object.values(expected).flat().flatMap((entry) => commandsOf(entry, flat)));
  const events = [], foreign = [];
  for (const [name] of HOOK_EVENTS[agent]) {
    const list = Object.hasOwn(root[box] ?? {}, name) ? root[box][name] : [];
    if (!Array.isArray(list)) return { conflict: "unexpected-shape" };
    const mine = [], marks = new Set();
    list.forEach((entry, index) => {
      const commands = commandsOf(entry, flat);
      if (owned.entries.has(key(path, name, entry)) && commands.length && commands.every((c) => shape.test(c))) mine.push(entry);
      else if (canonicalJson(entry) === canonicalJson(expected[name][0])) marks.add("foreign-entry");
      else if (commands.some((c) => ours.has(c) || owned.commands.has(c))) marks.add("modified");
      else if (devtwinLike(entry, flat)) foreign.push({ event: name, index, reason: "devtwin-like-entry" });
    });
    const status = marks.has("modified") ? "modified" : marks.has("foreign-entry") ? "foreign-entry" : !mine.length ? "missing" : canonicalJson(mine) === canonicalJson(expected[name]) ? "installed" : "outdated";
    events.push({ event: name, status, mine });
  }
  return { root, events, foreign };
}
// The one row of a whole-file target: installed (devtwin's file with the expected text), outdated (devtwin's file with
// text that devtwin wrote before, such as for an earlier kit clone or an earlier plugin), missing, foreign-entry (the
// expected bytes, which no journal wrote) or modified (any other content).
function analyzeFile(text, { path, owned, expected }) {
  const entry = { sha256: hashText(text) }, mine = text !== null && owned.entries.has(key(path, FILE_EVENT, entry)), same = entry.sha256 === expected[FILE_EVENT][0].sha256;
  const status = text === null ? "missing" : mine ? (same ? "installed" : "outdated") : same ? "foreign-entry" : "modified";
  return { events: [{ event: FILE_EVENT, status, mine: mine ? [entry] : [] }], foreign: [] };
}
function serialize(root, text) {
  const indent = /\n([ \t]+)"/.exec(text ?? "")?.[1] ?? "  ";
  return JSON.stringify(root, null, indent) + (text && !text.endsWith("\n") ? "" : "\n");
}
// The new file text: devtwin's entries replaced by the expected ones (install) or removed (uninstall). Every other
// entry stays in place. Uninstall also drops an event list that it left empty, and then the container when no key is
// left in it. A key devtwin did not write, such as "enabled", keeps the container.
// A whole-file target has no other entry: the new text is the generated file (install) or null, no file (uninstall).
// The caller plans it only for a file that is absent or devtwin's.
function rewrite(text, { agent, path, owned, expected, mode, context }) {
  if (wholeFile(agent)) return mode === "install" ? fileText(agent, context) : null;
  const box = containerOf(agent);
  let out = text, emptied = [];
  for (const [name] of HOOK_EVENTS[agent]) {
    const fresh = mode === "install" ? structuredClone(expected[name]) : [];
    const mine = (entry) => owned.entries.has(key(path, name, entry));
    if (mode === "uninstall") {
      const list = out === null ? [] : JSON.parse(out)[box]?.[name];
      if (!Array.isArray(list) || !list.some(mine)) continue;
      emptied.push(name);
    }
    out = replaceOwnedEntries(out, { path: [box, name], owns: (entry) => fresh.includes(entry) || mine(entry), entries: fresh });
  }
  if (mode === "uninstall" && emptied.length) {
    const root = JSON.parse(out);
    for (const name of emptied) if (Array.isArray(root[box][name]) && !root[box][name].length) delete root[box][name];
    if (!Object.keys(root[box]).length) delete root[box];
    out = serialize(root, text);
  }
  return out;
}
const readTarget = (path) => { try { return { text: readOwnedText(path) }; } catch (error) { if (error instanceof DevtwinError) return { error: error.code }; throw error; } };
async function analyzeAll(pilot, input) {
  const list = targets(pilot, input), context = hookContext(pilot, input.kitRoot, input.nodeLookup);
  const owned = ledger(pilot, await readJournals(pilot.stateRoot)), approved = pilot.writeClasses?.hookTargets ?? [];
  return { context, owned, rows: list.map(({ agent, path }) => {
    const expected = expectedEntries(agent, context), base = { agent, path, expected };
    if (!approved.includes(path)) return { ...base, blocked: "not-approved" };
    const parent = info(dirname(path));
    if (!parent?.isDirectory() || parent.isSymbolicLink()) return { ...base, blocked: "agent-folder-missing" };
    const read = readTarget(path);
    if (read.error) return { ...base, conflict: read.error === "DEVTWIN_LIMIT" ? "file-too-large" : "unsafe-file" };
    const seen = wholeFile(agent) ? analyzeFile(read.text, { path, owned, expected }) : analyze(read.text, { agent, path, owned, expected, context });
    return { ...base, text: read.text, ...seen };
  }) };
}
const eventRows = (events) => events.map(({ event, status }) => ({ event, status }));
export async function planHooks(pilot, { targetHome, agents, mode = "install", kitRoot, nodeLookup }) {
  if (!["install", "uninstall"].includes(mode)) throw new DevtwinError("INVALID_INPUT", "Invalid installer selection");
  const { context, owned, rows } = await analyzeAll(pilot, { targetHome, agents, kitRoot, nodeLookup });
  const actions = rows.map((row) => {
    const { agent, path, expected } = row, base = { agent, path };
    if (row.blocked) return { ...base, status: "blocked", reason: row.blocked };
    if (row.conflict) return { ...base, status: "conflict", reason: row.conflict };
    const before = hashText(row.text), events = eventRows(row.events), foreign = row.foreign;
    const blocking = row.events.find((e) => ["modified", "foreign-entry"].includes(e.status));
    // A whole-file target that is not devtwin's stays in place and stays active, so an uninstall says so too: it is
    // no absent file. In a JSON file the other entries stay and the uninstall removes devtwin's own, as before.
    if (blocking && (mode === "install" || wholeFile(agent))) return { ...base, status: "conflict", reason: blocking.status, before, events, foreign };
    if (mode === "uninstall" && !row.events.some((e) => e.mine.length)) return { ...base, status: "absent", before, events, foreign };
    const after = rewrite(row.text, { agent, path, owned, expected, mode, context });
    if (row.text !== null && after === row.text) return { ...base, status: "installed", before, events, foreign };
    const changes = row.events.flatMap((e) => {
      const keep = mode === "install" && e.status === "installed";
      return keep ? [] : [...e.mine.map((entry) => ({ event: e.event, op: "remove", entry })), ...(mode === "install" ? expected[e.event].map((entry) => ({ event: e.event, op: "add", entry })) : [])];
    });
    return { ...base, status: row.text === null ? "create" : mode === "install" ? "update" : "remove", before, after: hashText(after), events, changes, foreign };
  });
  const notes = mode === "install" ? notesFor(actions.map((a) => a.agent)) : [];
  return finalizePlan({ kind: "hook-install", mode, configId: configIdOf(pilot), pilotPath: context.pilotPath, kitRoot: context.kitRoot, agents: actions.map((a) => a.agent), receipt: mode === "install" ? receiptPath(pilot.stateRoot) : null, actions, notes });
}
// The pre-apply inventory of one hook target. Devtwin rows are entries whose commands all name this pilot; foreign
// rows keep only a hash of the entry, so the store holds no copy of the developer's own commands.
// A whole-file target has one row, the file's hash: a devtwin row when owned (the ledger of the completed journals)
// holds that hash for this path, else a foreign row. With no ledger the file is foreign.
export function inventoryHookFile(agent, path, pilotPath, owned) {
  const read = readTarget(path), shape = shapeFor(pilotPath), box = containerOf(agent), flat = flatOf(agent);
  if (read.error) return { agent, path, existed: true, unreadable: true, sha256: null, devtwin: [], foreign: [] };
  if (read.text === null) return { agent, path, existed: false, sha256: null, devtwin: [], foreign: [] };
  const row = { agent, path, existed: true, sha256: hashText(read.text), devtwin: [], foreign: [] };
  if (wholeFile(agent)) {
    const entry = { sha256: row.sha256 };
    return owned?.entries.has(key(path, FILE_EVENT, entry)) ? { ...row, devtwin: [{ event: FILE_EVENT, entry }] } : { ...row, foreign: [{ event: FILE_EVENT, sha256: row.sha256 }] };
  }
  let root;
  try { root = JSON.parse(read.text); } catch { return { ...row, invalid: true }; }
  for (const [event, list] of Object.entries(isObject(root?.[box]) ? root[box] : {})) for (const entry of Array.isArray(list) ? list : []) {
    const commands = commandsOf(entry, flat);
    if (commands.length && commands.every((c) => shape.test(c))) row.devtwin.push({ event, entry });
    else row.foreign.push({ event, sha256: sha256(Buffer.from(canonicalJson(entry ?? null))) });
  }
  return row;
}
// faults.afterInventory and faults.afterEdit are test seams: a crash after the inventory, and after one file's edit.
export async function applyHooks(roots, pilot, input, { fingerprint, runId, now = new Date() }, { faults = {} } = {}) {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new DevtwinError("INVALID_ID", "Invalid run ID");
  assertFingerprint(await planHooks(pilot, input), fingerprint);
  const runDir = join(roots.stateRoot, "runs", runId), journalPath = join(runDir, "journal.json"), inventoryPath = join(runDir, "inventory.json");
  const result = await withPilotLock(roots, lockPath(roots), { kind: "hook-install", runId }, async () => {
    const { incompleteInstallRuns } = await import("./install.mjs");
    if ((await incompleteInstallRuns(pilot)).length) throw new DevtwinError("RECOVERY_REQUIRED", "Incomplete installer journal");
    const plan = await planHooks(pilot, input);
    assertFingerprint(plan, fingerprint);
    // The context of the plan that was just checked: the same kit, pilot and Node path, so the text has the planned hash.
    const { owned, context } = await analyzeAll(pilot, input);
    const intended = plan.actions.filter((a) => WRITES.includes(a.status));
    if (intended.length) {
      assertWritable(roots, [journalPath, inventoryPath]);
      ensurePrivatePath(roots.stateRoot, ["runs"]);
      try { await mkdir(runDir, { mode: 0o700 }); }
      catch (error) { if (error.code === "EEXIST") throw new DevtwinError("CONFLICT", "Run ID already exists"); throw error; }
      const files = plan.actions.filter((a) => a.status !== "blocked").map((a) => inventoryHookFile(a.agent, a.path, plan.pilotPath, owned));
      await writeNewFile(inventoryPath, canonicalJson({ schemaVersion: 1, kind: HOOK_INVENTORY, runId, configId: configIdOf(pilot), mode: plan.mode, pilotPath: plan.pilotPath, recordedAt: now.toISOString(), files }) + "\n");
      await faults.afterInventory?.();
      const entries = intended.map((a) => ({ agent: a.agent, path: a.path, status: a.status, before: a.before, after: a.after, entries: plan.mode === "install" ? expectedEntries(a.agent, context) : {} }));
      const journal = { schemaVersion: 1, kind: HOOK_KIND, configId: configIdOf(pilot), runId, mode: plan.mode, planFingerprint: fingerprint, intended: entries, started: [], completed: [] };
      const save = () => atomicReplace(journalPath, canonicalJson(journal) + "\n");
      await save();
      for (const [i, entry] of entries.entries()) {
        journal.started.push(i);
        await save();
        // rewrite never reads the expected entries of a whole-file target, so its text is not built again here.
        const expected = wholeFile(entry.agent) ? null : expectedEntries(entry.agent, context);
        // Only the removal of a whole-file target names the bytes to remove. Without priorHash a null result fails.
        const priorHash = wholeFile(entry.agent) && entry.status === "remove" ? entry.before : undefined;
        await editOwnedFile(roots, { path: entry.path, writeClass: "hookTargets", runId, priorHash, edit: (text) => {
          if (hashText(text) !== entry.before) throw new DevtwinError("STALE_VERSION", "Hook file changed during apply");
          const next = rewrite(text, { agent: entry.agent, path: entry.path, owned, expected, mode: plan.mode, context });
          if (hashText(next) !== entry.after) throw new DevtwinError("STALE_VERSION", "Hook file changed during apply");
          return next;
        } });
        await faults.afterEdit?.(entry);
        journal.completed.push(i);
        await save();
      }
    }
    // Install refreshes the kit receipt, which the hook trusts in place of the full pilot load.
    const receipt = plan.mode === "install" ? await writeKitReceipt(roots, { pilotPath: pilot.path, kitRoot: input.kitRoot, now }) : null;
    return { applied: intended.length > 0, runId: intended.length ? runId : null, actions: plan.actions, receipt: receipt ? receipt.path : null, notes: plan.notes };
  }, { destinations: [runDir] });
  // Upgrade fix: the hook finds a bound project through the lesson index, so an install rebuilds every scope's index
  // and session summaries after the lock is released. An upgraded install then works at once (src/lessons/index.mjs).
  return result.receipt ? { ...result, derived: await rebuildDerived(roots) } : result;
}
// Recovery of one started, unfinished entry, from the file's hash against the journal's before and after hashes.
// An absent file has the hash null, as the after of a whole-file removal has: no file after a remove is complete.
export function hookRecoveryFor(entry) {
  const read = readTarget(entry.path);
  if (read.error) return { op: "hold", reason: "unsafe-file", observed: null };
  const observed = hashText(read.text);
  if (observed === entry.after) return { op: "hook-complete", observed };
  if (observed === entry.before) return { op: "hook-unapplied", observed };
  return { op: "hold", reason: "unmatched-file", observed };
}
// A repository root bound in two or more scopes. The hook gives such a root no lessons.
async function ambiguousRoots(stateRoot) {
  let names;
  try { names = await readdir(join(stateRoot, "lessons")); } catch { return []; }
  const byRoot = new Map();
  for (const scope of names.filter((n) => n.endsWith(".json") && SCOPE_ID.test(n.slice(0, -5))).map((n) => n.slice(0, -5)).sort()) {
    let index;
    try { index = await readIndex({ stateRoot }, scope); } catch { continue; }
    for (const r of Array.isArray(index?.roots) ? index.roots : []) {
      if (typeof r?.root !== "string") continue;
      if (!byRoot.has(r.root)) byRoot.set(r.root, new Set());
      byRoot.get(r.root).add(r.scope ?? scope);
    }
  }
  return [...byRoot].filter(([, scopes]) => scopes.size > 1).map(([root, scopes]) => ({ code: "AMBIGUOUS_ROOT", root, scopes: [...scopes].sort(), message: "This repository root is bound in more than one scope, so the hook gives it no lessons." }));
}
const overall = (events) => {
  const set = new Set(events.map((e) => e.status));
  for (const status of ["modified", "foreign-entry"]) if (set.has(status)) return status;
  return set.size === 1 ? [...set][0] : set.has("outdated") ? "outdated" : "partial";
};
// The agents hook status lists: Claude Code and Codex always, as before adapters existed, and any other agent that the
// live config names or whose hook file is an approved hook target.
function statusAgents(pilot, targetHome) {
  const approved = pilot.writeClasses?.hookTargets ?? [];
  const home = pilot.live ? pilot.live.home : targetHome, env = pilot.live ? pilot._context?.env ?? process.env : {};
  const fileOf = (id) => join(adapter(id).agentDir({ home, env }), adapter(id).hooks.file);
  const named = (id) => (pilot.live && Object.hasOwn(pilot.live.skillDirs, id)) || (typeof home === "string" && approved.includes(fileOf(id)));
  return AGENTS.filter((id) => LISTED.includes(id) || named(id));
}
// Read-only: each agent's hook entries, the kit receipt and the notes an owner needs.
export async function hookStatus(pilot, { targetHome, kitRoot, now = new Date(), nodeLookup }) {
  const { context, rows } = await analyzeAll(pilot, { targetHome, agents: statusAgents(pilot, targetHome), kitRoot, nodeLookup });
  const agents = rows.map((row) => ({ agent: row.agent, path: row.path,
    status: row.blocked ?? row.conflict ?? overall(row.events), ...(row.events ? { events: eventRows(row.events), foreign: row.foreign } : {}) }));
  let receipt;
  try { receipt = (await receiptProblem(pilot.stateRoot, { pilotPath: context.pilotPath, pilotBytes: readPilotBytes(context.pilotPath), kitRoot, now })) ?? "ok"; } catch { receipt = "invalid"; }
  const notes = [...notesFor(agents.filter((a) => a.events).map((a) => a.agent)), ...await ambiguousRoots(pilot.stateRoot)];
  return { agents, receipt, notes };
}
// Rollback check for a hook install run: devtwin's entries now must equal those before the run; foreign entries are listed.
function diff(before, now) {
  const tag = (rows) => { const seen = new Map(); return rows.map((row) => { const id = canonicalJson(row); const n = (seen.get(id) ?? 0) + 1; seen.set(id, n); return [id + "#" + n, row]; }); };
  const a = new Map(tag(before)), b = new Map(tag(now)), out = [];
  for (const [id, row] of a) if (!b.has(id)) out.push({ change: "removed", row });
  for (const [id, row] of b) if (!a.has(id)) out.push({ change: "added", row });
  return out;
}
// A whole-file target is compared by its hash row. The ledger is read now, so a file that a later journal wrote is
// devtwin's. A whole-file target that did not exist before the run and exists now is a devtwin difference whoever
// wrote it: OpenCode loads any file at that path, and an edited devtwin plugin has a hash no journal holds. Its row
// moves from the foreign list to the devtwin list. While an installer journal of this config is incomplete the ledger
// is not final, so the check refuses as the apply does.
export async function hookRollbackCheck(pilot, inventory, runId) {
  const valid = inventory?.schemaVersion === 1 && inventory.runId === runId && typeof inventory.pilotPath === "string" && ["install", "uninstall"].includes(inventory.mode) && Array.isArray(inventory.files)
    && inventory.files.every((f) => AGENTS.includes(f?.agent) && typeof f.path === "string" && Array.isArray(f.devtwin) && Array.isArray(f.foreign));
  if (!valid) throw new DevtwinError("INTEGRITY", "Invalid install inventory", { runId });
  if (inventory.configId !== configIdOf(pilot)) throw new DevtwinError("GATE_REQUIRED", "Inventory belongs to another live config", { runId });
  if (inventory.mode !== "install") throw new DevtwinError("INVALID_INPUT", "Rollback check needs an install run", { runId });
  // install.mjs imports this module, so the helper comes in through a dynamic import, as in applyHooks.
  const { incompleteInstallRuns } = await import("./install.mjs");
  if ((await incompleteInstallRuns(pilot)).length) throw new DevtwinError("RECOVERY_REQUIRED", "Incomplete installer journal");
  const approved = pilot.writeClasses?.hookTargets ?? [], owned = ledger(pilot, await readJournals(pilot.stateRoot));
  const files = inventory.files.map((before) => {
    if (!approved.includes(before.path)) throw new DevtwinError("GATE_REQUIRED", "Inventory names a file outside this live config", { agent: before.agent });
    let now = inventoryHookFile(before.agent, before.path, inventory.pilotPath, owned);
    if (wholeFile(before.agent) && !before.existed && now.existed) now = { ...now, devtwin: now.devtwin.length ? now.devtwin : [{ event: FILE_EVENT, sha256: now.sha256 }], foreign: [] };
    return { agent: before.agent, path: before.path, existedBefore: before.existed, existsNow: now.existed, devtwin: diff(before.devtwin, now.devtwin), foreign: diff(before.foreign, now.foreign) };
  });
  const report = { runId, kind: HOOK_INVENTORY, recordedAt: inventory.recordedAt, files };
  if (files.some((f) => f.devtwin.length)) throw new DevtwinError("ROLLBACK_MISMATCH", "Hook file differs from its install inventory", report);
  return { status: "ok", ...report };
}
