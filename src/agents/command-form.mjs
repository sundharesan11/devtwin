// K1: the one executable form of a devtwin command. src/cli.mjs refuses every route that is not root-free without a
// literal --pilot, in every mode, so a command that devtwin renders for an agent or the developer to run names the
// kit's bin and the pilot. There is no bare `devtwin <command>` fallback: a disposable pilot needs --pilot too.
// The instruction block defines the form once (formLine) and then writes the compact `devtwin <command>`. A hook hint is
// a separate output: it writes the compact form followed by FORM_POINTER, which names the block as the definition.
// A stored file that no block travels with (a radar guide, a stack digest) writes the full form (commandFor).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DevtwinError } from "../errors.mjs";

const KIT = fileURLToPath(new URL("../..", import.meta.url));
// POSIX single quotes: every path, also one with a space, a dollar sign or a quote, runs as written.
export const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
export const binOf = (kitRoot) => kitRoot + "/bin/devtwin.mjs";
// The kit and pilot a rendered command names: the live config's pinned kit in live mode, else the running kit. K1
// round 4 (review m5): a rendered command sits in an inline code span, which a backtick or a line break would end, so
// a path with one is refused. Quotes, spaces and $ are safe, because quote handles them. hookContext
// (src/agents/hooks-install.mjs) starts from the same commandPaths and refuses a wider set that holds these
// characters, because a hook command line also passes through the agent's own JSON or TOML and its shell.
export const UNSAFE_IN_CODE = /[`\n\r]/;
export const commandPaths = (pilot, kitRoot) => ({ pilotPath: realpathSync(pilot.path), kitRoot: pilot.live ? pilot.live.kitRoot : realpathSync(kitRoot ?? KIT) });
export function commandContext(pilot, kitRoot) {
  const context = commandPaths(pilot, kitRoot);
  for (const path of Object.values(context)) if (UNSAFE_IN_CODE.test(path)) throw new DevtwinError("INVALID_INPUT", "Path cannot be written in a devtwin command", { field: "commandPath" });
  return context;
}
export const commandFor = (words, { kitRoot, pilotPath }) => "node " + quote(binOf(kitRoot)) + " " + words + " --pilot " + quote(pilotPath);
export const FORM_START = "Run devtwin as `";
export const formLine = (context) => FORM_START + commandFor("<command>", context) + "`, written here as `devtwin <command>`.";
export const FORM_POINTER = "(command form: your devtwin instruction block)";
// The compact form in backticks, as the block and the hook hints write it. Tests use it to find every rendered command.
export const COMPACT_COMMAND = /`devtwin [a-z][^`]*`/g;
