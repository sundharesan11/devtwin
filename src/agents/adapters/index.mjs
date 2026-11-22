import { DevtwinError } from "../../errors.mjs";
import claude from "./claude.mjs";
import codex from "./codex.mjs";
import gemini from "./gemini.mjs";
import antigravity from "./antigravity.mjs";
import opencode from "./opencode.mjs";
// Issue #8: the agent adapter registry. Each adapter (claude.mjs, codex.mjs, gemini.mjs, antigravity.mjs, opencode.mjs)
// declares, as data and small pure functions: id, name, actor, its skills folder, its global instructions file, its
// hook file with the event map, tool matchers, parse(payload) and format(result), and its capabilities. Code outside
// the adapters names no agent: it asks the registry. The order is the order every list shows, and the order actorOf
// checks: an Antigravity CLI shell does not set GEMINI_CLI, so it is safe after gemini, and an OpenCode shell sets
// none of the earlier markers (OPENCODE_SESSION_ID does not start with CODEX_), so it is safe last.
const ADAPTERS = Object.freeze([claude, codex, gemini, antigravity, opencode]);
export const AGENT_IDS = Object.freeze(ADAPTERS.map((a) => a.id));
export const isAgent = (id) => typeof id === "string" && AGENT_IDS.includes(id);
export function adapter(id) {
  const found = ADAPTERS.find((a) => a.id === id);
  if (!found) throw new DevtwinError("INVALID_INPUT", "Unknown agent", { field: "agent" });
  return found;
}
// "full" only when the skills, the instruction block and the owner-action block all work for the agent.
export const supportLevel = (capabilities) => capabilities.skills && capabilities.instructions && capabilities.ownerBlock ? "full" : "partial";
// What status and doctor report for one agent.
export const support = (id) => { const a = adapter(id); return { agent: a.id, name: a.name, supportLevel: supportLevel(a.capabilities), capabilities: { ...a.capabilities } }; };
// The agents shown without a live config naming them (Claude Code and Codex, as before adapters existed).
export const LISTED = Object.freeze(ADAPTERS.filter((a) => a.listed).map((a) => a.id));
// The agents instructions plan and activity review target when none is named: the listed agents, and any other agent
// the live config names.
export const defaultInstructionAgents = (pilot) => AGENT_IDS.filter((id) => LISTED.includes(id) || Object.hasOwn(pilot?.live?.skillDirs ?? {}, id));
// True for an agent whose hook target is one whole file that devtwin owns (hooks.target "file": the OpenCode plugin
// file), and not entries in a settings file.
export const wholeFileHooks = (id) => adapter(id).hooks.target === "file";
// Agents whose skills folder is the same folder as id's, id excluded. Codex, Gemini CLI and OpenCode share
// ~/.agents/skills.
export const skillPeers = (id) => AGENT_IDS.filter((other) => other !== id && adapter(other).skills.folder === adapter(id).skills.folder);
// The actor for a CLI caller: the first adapter whose detect(env) matches, in registry order, or "human".
export const actorOf = (env) => ADAPTERS.find((a) => a.detect(env ?? {}))?.actor ?? "human";
