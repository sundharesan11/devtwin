---
title: Antigravity CLI and OpenCode adapters - Plan
type: feat
date: 2026-11-18
topic: antigravity-opencode-adapters
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# Antigravity CLI and OpenCode adapters - Plan

## Goal Capsule

- **Objective:** Add two agent adapters, `antigravity` (Antigravity CLI, `agy`) and `opencode` (OpenCode 2.x), next to `claude`, `codex` and `gemini`. Each gets skills, the instruction block, the owner-action block and lesson delivery, through the same routes Gemini CLI uses.
- **Delivery:** Two issues and two pull requests into `main`. Part A (Antigravity) lands first on `feat/antigravity-adapter`. Part B (OpenCode) is stacked on it on `feat/opencode-adapter`.
- **Owner decisions (2026-11-18):** OpenCode 2.x is the supported line. OpenCode keeps reading the developer's `~/.claude/CLAUDE.md`; devtwin does not create a global OpenCode `AGENTS.md`. Antigravity shares `~/.gemini/GEMINI.md` with Gemini CLI. Deferred lessons for Antigravity are in Part A. The landing page does not change.
- **Stop conditions:** Stop and ask if a unit needs a write outside a disposable pilot, a change to the owner dialog, or a weaker fence than this plan names.
- **Not in scope:** OpenCode 1.x behaviour, the Antigravity app and IDE as tested surfaces, the landing page, a release.

## Verified facts

These facts come from real sessions in a visible terminal on 2026-11-18, not from docs alone. The probe used a disposable workspace with its own `.agents/hooks.json`. No real agent settings file was written.

### Antigravity CLI (1.5.4, then 1.5.10 after its own update)

| Fact | Evidence |
| --- | --- |
| `SessionStart` and `PreInvocation` context reaches the model | `{"injectSteps":[{"systemMessage":{"systemMessage":"..."}}]}` on each; the model repeated both injected words |
| `SessionStart` fires with the first prompt and carries `cwd`, `lastUserInput`, `conversationId`, `workspacePaths`, `hookEventName` | Recorded payload |
| `PreInvocation` fires before every model call, `invocationNum` starts at 0 | Recorded order: `PreInvocation`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `Stop` |
| `PreToolUse` `{"decision":"deny","reason":"..."}` blocks the call and the model reads the reason | The model reported the code in the reason |
| `PreToolUse` `{}` denies the tool | "tool call denied by pre-tool hook" |
| `PreToolUse` `{"decision":""}` denies the tool | The read was blocked |
| `PreToolUse` with no stdout lets the tool run | The read ran |
| `PreToolUse` `{"decision":"ask"}` follows the normal permission flow | A read ran with no prompt, a write and a shell command prompted, and in `--mode auto` a shell command ran with no prompt |
| Tool names and arguments | `run_command` (`CommandLine`), `read_file` (`Path`), `write_file` (`Path`), `edit_file` (`Path`); `PostToolUse` has `error` and no tool output |
| Shell marker | `agy` sets `ANTIGRAVITY_AGENT` and `ANTIGRAVITY_CONVERSATION_ID` in the shells it starts; `GEMINI_CLI` is not set |
| Hook process | Runs through `sh -c` in the folder that holds `hooks.json`, with the launching shell's `PATH`; `node` was found |
| Global hooks | `~/.gemini/config/hooks.json`, keyed by hook name; no approval step. Another tool's named hook already lives there on the test machine |

Docs disagree on three points, and the adapter takes the safe side of each. The web hooks page lists `view_file`, `write_to_file` and `replace_file_content`; the real CLI sends `read_file`, `write_file` and `edit_file`, so `parse` accepts both sets. The bundled docs say `allow` approves the tool and the web docs say it defers, so devtwin never prints `allow`. A third-party guide names `~/.gemini/antigravity-cli/hooks.json`; the official changelog calls that a fixed bug.

### OpenCode (2.3.0)

A real session on 2026-11-18 confirmed the first eight rows. It used a disposable config folder through `OPENCODE_CONFIG_DIR`, a private server through `--standalone`, and a probe plugin. The other rows are from the source and docs.

| Fact | Source |
| --- | --- |
| A single `.js` file in the config folder's `plugins/` loads automatically, with a default export `{ id, setup(ctx), server() }`, ESM imports of `node:fs` and `node:child_process`, and no OpenCode import | Session: `setup` ran, and a spawned `node` child returned its version |
| Before-tool hook: `ctx.tool.hook("execute.before", cb)` gets `{ tool, sessionID, input }`; a throw blocks the call and the model reads the message | Session: the model reported the code in the thrown message |
| After-tool hook: `ctx.tool.hook("execute.after", cb)`; text appended to `event.result.content` (an array of `{ type: "text", text }`) reaches the model | Session: the model repeated the appended word, for `shell`, `read` and `edit` |
| Prompt hook: `ctx.session.hook("prompt", cb)`; text appended to `event.prompt.text` reaches the model, is kept in the conversation, and shows in the user's own message | Session |
| Context hook: `ctx.session.hook("context", cb)`; `event.system.push({ type: "text", text })` adds system text for that model call only | Session: the model repeated the pushed word |
| `experimental.idle` fires when a turn ends | Session |
| Tools: `shell` (`command`), `read`, `edit`, `write` (`path`, which can be relative to the session folder), `patch` (`patchText`), `grep`, `glob` (`path`) | Session for `shell`, `read`, `edit`; source for the rest |
| Global instructions: the first existing file of `~/.config/opencode/AGENTS.md` and `~/.claude/CLAUDE.md` wins; `@path` lines are not expanded | `packages/core/src/config/plugin/instruction.ts` |
| Skills: `~/.agents/skills` and `~/.claude/skills` are read; `~/.agents/skills` wins on a name clash | `packages/core/src/config/plugin/compatibility.ts` |
| Shell marker: `OPENCODE`, `OPENCODE_SESSION_ID`, `AGENT` and `AI_AGENT` are set in tool shells | Session |
| Plugins run in one shared background server; hooks are awaited, with no time limit | Docs `troubleshooting.mdx`, `packages/core/src/plugin/hooks.ts` |
| OpenCode 1.x uses a different plugin API; a 1.x binary calls `server()` on the same file | Docs `build/plugins/migrate-v1.mdx` |

## Design

### Adapter data

| Field | `antigravity` | `opencode` |
| --- | --- | --- |
| `name`, `actor` | Antigravity CLI, `antigravity` | OpenCode, `opencode` |
| `listed` | `false` | `false` |
| `detect(env)` | `ANTIGRAVITY_AGENT` or `ANTIGRAVITY_CONVERSATION_ID` set | `OPENCODE` set |
| `agentDir` | `~/.gemini` | `~/.config/opencode` (the environment variables that move it are ignored, as `CODEX_HOME` is) |
| `skills.folder` | `.gemini/config/skills` | `.agents/skills`, shared with Codex and Gemini CLI |
| `instructions` | `GEMINI.md`, block, `ownedFiles: false`; the same file as `gemini` | `devtwin.md` in the OpenCode folder, a devtwin-owned file with no import line (`instructions.mode: "owned-only"`); the plugin reads it |
| `hooks.file` | `config/hooks.json` | `plugins/devtwin.js` |
| Hook target kind | JSON entries under the container key `devtwin` | One whole devtwin-owned file |
| `lessonEvent` | `PostToolUse`, deferred to the next `PreInvocation` | `PostToolUse`, appended to the tool result |
| `capabilities` | skills, instructions, sessionStartContext, ownerBlock, stopHook true; `preToolContext` false | The same |
| Support level | `full` | `full` |

Registry order becomes `claude`, `codex`, `gemini`, `antigravity`, `opencode`. The order matters for `actorOf`; `agy` does not set `GEMINI_CLI`, so the order is safe.

### Antigravity hooks

Entries written under `devtwin` in `~/.gemini/config/hooks.json`:

| Agent event | devtwin event | Shape | Matcher |
| --- | --- | --- | --- |
| `SessionStart` | `session-start` | flat handler | none |
| `PreInvocation` | `user-prompt` | flat handler | none |
| `PreToolUse` | `pre-tool` | grouped | `run_command\|manage_task` |
| `PostToolUse` | `post-tool` | grouped | the shell, read, edit and search tool names of both name sets |
| `Stop` | `stop` | flat handler | none |

A handler is `{ "type": "command", "command": "<hook line>", "timeout": 10 }`, with the timeout in seconds. The matcher is a plain alternation, because the docs do not state how it is anchored; `parse` checks the tool name exactly.

`parse(payload)` reads `hookEventName` (mapping `PreInvocation` to `UserPromptSubmit`), `conversationId` as the session, `cwd` with a fallback to the first absolute `workspacePaths` entry, `lastUserInput` as the prompt, and `toolCall.name` and `toolCall.args`. The shell command is `args.CommandLine` for `run_command`, and `args.Input` for `manage_task` when `Action` is `send_input`. File paths come from `Path`, `AbsolutePath`, `TargetFile`, `DirectoryPath`, `SearchDirectory` and `SearchPath`. `parse` never throws.

`format(result)` prints `{ "decision": "deny", "reason" }` for a deny and `{ "injectSteps": [ { "systemMessage": { "systemMessage": text } } ] }` for context.

`neutral(event)` is a new optional adapter function. `runHook` prints it when nothing else was printed, on every path after the agent is known, including a bad payload, an unreadable pilot and a thrown error. For Antigravity it returns `{ "decision": "ask" }` on `PreToolUse`, `{ "decision": "" }` on `Stop` and `{}` on the other events. Adapters without `neutral` keep their current bytes, including an empty stdout.

`ask` is not a gate. It hands the call back to Antigravity's own permission flow, which may run the tool with no prompt. The only gate is the deny, and `runHook` decides and prints the deny before it considers any neutral output. `ask` is needed because an empty reply denies the tool.

Context is injected only when there is new text, because each injected system message stays in the conversation.

### Deferred lessons (Antigravity)

`hooks.deferToolContext: true` marks an adapter whose post-tool hook cannot print context.

1. On `PostToolUse`, `respond` matches lessons as today. `deliver` runs in a `hold` mode: it stores each fresh lesson in the session file and prints nothing. The new optional session fields are `pending`, a list of at most four `{ id, scope, root }` entries, and `pendingMore`, `{ scope, root, count }` for the overflow line. `scope` and `root` are the bound scope and worktree root that `locate` returned for the call. An ID already in `delivered` or `pending` is not held again. Held entries are not in `delivered` and do not count in `lines`, but each one reserves a slot: a hold keeps at most `4 - lines - pending.length` new entries and counts the rest in `pendingMore`.
2. On the next `UserPromptSubmit` event (`PreInvocation`), `deliver` runs in a `flush` mode. It takes only the held entries whose `scope` and `root` equal those of the current call. It renders each from the current index after the same project filter a fresh match gets, and drops an entry whose ID is no longer in the index. It merges them with the prompt's own matches, prints once under the four-line cap, moves the printed IDs to `delivered`, and removes them from `pending`. Entries held for another root stay held, so a lesson is never printed into another project. `valid()` in `src/hooks/session.mjs` accepts the fields absent or within these bounds and treats anything else as a corrupt file, as today.
3. For a deferring adapter the prompt path does not return early on an empty prompt or no prompt match, so held lessons still flush. Other adapters keep their early returns and never read the session file on a non-match.
4. Output comes before state on a flush, as today. A hold writes state only. A failed hold write delays the lesson to the next matching call; a failed flush write repeats the block once.
5. Note reports ("working on" notes from teammates) are not deferred in Part A. A deferring adapter still posts its own notes; it prints no note report. This keeps teammate text out of session files.
6. Repeated `PreInvocation` calls with the same prompt are harmless: the per-session `delivered` list already makes the second match empty.
7. `compacted` is always false, because Antigravity has no compaction event. The four-line cap then lasts for the whole conversation. This is a documented limit.

### Hook installer changes

- `hooks.container` (default `"hooks"`) replaces the six hard-coded `hooks` keys in `analyze`, `rewrite` and `inventoryHookFile`.
- `commandsOf` also reads a flat handler's own `command`.
- `hooks.target: "file"` (Part B) adds a whole-file branch: one pseudo-event `file` with one entry `{ sha256 }`. Ownership is a completed journal that recorded that hash for that path. Statuses: `missing`, `installed`, `outdated` (ours, older content), `foreign-entry` (expected bytes that no journal wrote) and `modified` (any other content; never written). Uninstall removes the file only when its hash is ours.
- A file-target journal entry records `entries: { file: [{ sha256 }] }`, with the usual whole-file `before` and `after` hashes, so `isHookJournal` and the ledger need no schema change. `inventoryHookFile` branches before it parses JSON and records the file's hash as devtwin's or as foreign. `hookRecoveryFor` already compares whole-file hashes; an absent file after a remove counts as complete. `hookRollbackCheck` compares the hash rows. A same-name file that no journal wrote is foreign in every one of these paths.
- `editOwnedFile` gains a remove result (`null`), allowed only for the `hookTargets` write class and only when the caller passes the expected prior hash: backup, re-check of bytes, device and inode, unlink, fsync of the folder. Every other caller that returns a non-string still fails.
- The parent folder must exist, as today. A missing `~/.gemini/config` or `~/.config/opencode/plugins` reports `agent-folder-missing`; devtwin creates no agent folder.
- Journal schema stays at version 1. An older kit treats a journal that names a new agent as incomplete; the upgrade guide says to uninstall the new agents before a rollback.

### Fence and live config

- `SKILL_PARENTS` gains `real-gemini-home`, so `live.skillDirs.antigravity` may be exactly `~/.gemini/config/skills`. No other path under `~/.gemini` becomes writable.
- `protectedPaths` gains `real-opencode-home` (`~/.config/opencode`) in Part B.
- **New route `live add-agent --agent <id>`**, preview first and `--apply --plan-fingerprint` to apply. It adds `live.skillDirs.<id>` to an existing live config through the shared `planChange` and `applyChange`. It is an owner action (`OWNER_ACTIONS`, always-ask tier), and its apply calls `requireOwnerApproval` before `applyChange`, as `live set-kit` does. The dialog names the agent and the exact skills folder that becomes writable. It is never part of a setup batch. It refuses an unknown agent, an agent already named, and a skills folder that is missing. Today no route adds an agent, so a config made before this change could never install Antigravity skills.
- Write classes: `classShape` already accepts `~/.gemini/config/hooks.json`, `~/.config/opencode/plugins/devtwin.js` and `~/.config/opencode/devtwin.md` from the adapter data.

### Shared instruction file

`gemini` and `antigravity` name the same `~/.gemini/GEMINI.md`. Today two selected agents with one path make two actions, and the second write fails as stale. The fix mirrors the shared skills folder:

- `planInstructions` plans a path once and lists the other agents in `shared`.
- `--remove` for one agent keeps the block while another agent that uses the file is an active user and is not part of the same remove. An active user is an agent named in `live.skillDirs`, or one whose hook file holds devtwin-owned entries that a completed journal wrote. An approved hook target alone does not count. The action is `unchanged` with the reason `shared-file`.
- `writeChanges` and the preference re-render after `activity review` use the same deduplicated targets, so one path gets one edit.
- The dialog names every agent that reads the file.
- Two targets with one path and different roles are refused.

### OpenCode plugin file

`~/.config/opencode/plugins/devtwin.js` is generated text with the kit path, the pilot path and a Node path baked in as JSON strings. It imports only `node:child_process` and `node:fs`. Its default export is `{ id: "devtwin", setup, server }`.

- `setup(ctx)` (2.x) registers:
  - `execute.before`: for `shell` only, sends a pre-tool payload; on a deny reply it throws with the reason.
  - `execute.after`: for the shell, read, edit, write, patch, grep and glob tools with status `completed`, sends a post-tool payload and appends the reply text to `event.result.content`.
  - `prompt`: sends `session-start` once per session, then `user-prompt`, and appends any reply text to the prompt. The text is kept in the conversation and shows in the user's message, under the existing "devtwin lessons" notice line.
  - `context`: pushes the text of `devtwin.md` (the instruction block) as system text on each model call. The plugin reads the file at most once per second. A missing file adds nothing.
  - `compaction`: sends `pre-compact`. `experimental.idle`: sends `stop`, inside its own try block.
- `server()` (1.x) returns no hooks. A 1.x binary then loads the file without an error and devtwin does nothing there. The docs say OpenCode 1.x is not supported.
- Every hook except `execute.before` catches its own errors, because a throw in any other hook fails the user's turn.
- The child process is spawned with an argument array, a 10 second kill timer and a 256 KiB output cap. It tries `node` on `PATH` first and then the baked Node path.
- The payload is devtwin's own shape (`hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input`, `prompt`), and the reply is the adapter's `format` output. `cwd` is `ctx.location.directory`.
- The adapter's `parse` accepts `shell` and `bash`, `path` and `filePath`, and `patchText`, so the payload reader does not depend on the OpenCode line.

## Part A - Antigravity CLI (pull request 1)

Each unit starts with a failing test. Tests use disposable pilots in temp folders only.

### A1. Registry, adapter and fence

- **Files:** new `src/agents/adapters/antigravity.mjs`; `src/agents/adapters/index.mjs`; `src/config/pilot.mjs` (`SKILL_PARENTS`).
- **Tests:** update `test/agent-adapters.test.mjs` pins (ids, dirs, files, peers, support, actors, setup rows, doctor rows) and replace `antigravity` as the unknown agent with `cursor` there and in `test/live-commands.test.mjs`. New `test/antigravity-adapter.test.mjs`: parse of each event in both name sets and with pre-1.5.4 payloads (no `cwd`, no `hookEventName`); format; a live config accepts exactly `~/.gemini/config/skills` for `antigravity` and refuses `~/.gemini`, `~/.gemini/config`, `~/.gemini/skills` and a sibling such as `~/.gemini/config/plugins`.

### A2. `live add-agent`

- **Files:** `src/config/live.mjs`, `src/config/commands.mjs`, `src/cli.mjs`, `src/hooks/owner-block.mjs`, `src/policy/tiers.mjs`.
- **Tests:** preview and apply add the agent and keep every other key; the apply shows one owner dialog that names the agent and the folder, and a denied dialog writes nothing; refusals for an unknown agent, a named agent, a missing folder, a stale fingerprint; the hook denies `live add-agent --apply` from an agent shell; after it, `setup status` shows `skills-antigravity` and `hooks-antigravity` as pending, not skipped.

### A3. Hook installer

- **Files:** `src/agents/hooks-install.mjs`.
- **Tests:** install under `devtwin` keeps another named hook and unknown keys byte for byte, and is idempotent; uninstall removes only devtwin's handlers and drops the empty `devtwin` key; an `enabled` key inside `devtwin` survives; an edited handler reports `modified`; a missing event reports `partial`; the Claude, Codex and Gemini installer tests pass unchanged.

### A4. Hook runtime

- **Files:** `src/hooks/commands.mjs`, `src/hooks/session.mjs`, `src/hooks/owner-block.mjs` (comment only).
- **Tests:** the owner-action block prints the Antigravity deny for `run_command` and for `manage_task` `send_input`; every path prints exactly one JSON object and exits 0, in process and through the real binary (no receipt, bad payload, unreadable pilot, nothing to say); `PreToolUse` without an owner action prints `{"decision":"ask"}`; the deny is printed, and no neutral object follows it; a post-tool lesson is held and prints `{}`; the next `PreInvocation` prints it once; a second `PreInvocation` prints `{}`; a flush works with an empty prompt; repeated holds never pass four lines in total; a held lesson that left the index is dropped; a call from another worktree root does not print a lesson held for the first root; a failed hold write and a failed flush write behave as the design says; a session file written by an older kit still loads; a byte-for-byte regression test pins the stdout of Claude, Codex and Gemini for every event, including the empty stdout.

### A5. Shared instruction file

- **Files:** `src/agents/instructions.mjs`.
- **Tests:** `instructions apply` for `gemini` and `antigravity` together writes one block with one edit; the dialog names both; `--remove` for one keeps the block while the other is an active user; `--remove` for both together removes it; a stale approved hook target with no installed entries does not keep it; the re-render after `activity review` edits the file once.

### A6. Docs, changelog, manifests

- Follow the docs checklist below for the Antigravity items.
- `CHANGELOG.md` under `[Unreleased]`: Added, Changed, Known limits.
- `scripts/package-allowlist.json`: the new adapter, the new test file and this plan. `test/required-tests.json`: the new test titles.
- Remove "Antigravity CLI is not supported yet" from `docs/LIVE.md`, the site live-mode guide and the adapter comment. The line in the released `0.1.0-alpha.2` changelog section stays.

### A7. Real-session check

In a visible terminal, with a disposable pilot and a disposable workspace: generate the entries with `expectedEntries`, place them in the workspace `.agents/hooks.json`, and run `agy` there. Record that the session-start line arrives, that an owner command is denied with the devtwin reason, that a normal shell command behaves as without devtwin, and that a lesson for an edited file arrives on the next model call. The result goes in the pull request and in the limitations page.

## Part B - OpenCode (pull request 2, stacked on Part A)

### B1. Adapter and plugin source

- **Files:** new `src/agents/adapters/opencode.mjs` (adapter data, `parse`, `format`, and `content(context)` that renders the plugin text); `src/agents/adapters/index.mjs`; `src/config/pilot.mjs` (`protectedPaths`).
- **Tests:** new `test/opencode-adapter.test.mjs`: parse and format; the generated source imports in Node; with a fake `ctx` it sends each event to a fake hook command on stdin, throws on a deny, appends lesson text to `result.content`, appends prompt text, stays quiet when the hook fails or times out, and `server()` returns no hooks.

### B2. Whole-file hook target

- **Files:** `src/agents/hooks-install.mjs`, `src/storage/owned-file.mjs`, wording in `src/setup/steps.mjs` and `src/setup/batch.mjs`.
- **Tests:** create is idempotent; an earlier kit path reports `outdated` and an install rewrites it; an edited file is refused; a file devtwin did not write is never overwritten or removed; uninstall removes only the file devtwin wrote and keeps other plugins; an unrelated file with the same name reports `foreign-entry` or `modified` and blocks the install; the inventory, recovery and rollback-check cover the file target; `editOwnedFile` still refuses a remove for the instruction write class; the JSON targets of the other agents behave as before.

### B3. Runtime and instructions

- **Files:** `src/hooks/commands.mjs` only if the plugin payload needs it; `src/agents/instructions.mjs`: `targetsFor` gets an explicit `owned-only` mode that emits the owned file alone. Today every owned adapter also gets an import action in its instruction file, which would write `devtwin.md` twice. The owner approves the exact `instructionTargets` path through the normal `live write-classes` preview.
- **Tests:** owner-action block for `shell`; lessons arrive on post-tool and none on pre-tool; `instructions apply --agent opencode` plans one action, writes only `devtwin.md` in the OpenCode folder and never creates `AGENTS.md`; `--remove` empties the block in that file; live init and `live add-agent` accept `opencode`; Codex, Gemini CLI and OpenCode share one skills install that an uninstall of one keeps.

### B4. Docs, changelog, manifests

As A6, for the OpenCode items.

### B5. Real-session check

In a visible terminal: a disposable config folder through `OPENCODE_CONFIG_DIR`, a private server through `--standalone`, a disposable pilot and the generated plugin file. Record the same four results as A7, plus that the instruction block reaches the model and that the developer's `CLAUDE.md` is still read.

## Docs checklist

The landing page (`site/src/components/landing/`, `site/src/pages/index.astro`, `site/src/site.ts`) does not change.

- `README.md`: the agent lists.
- `docs/LIVE.md`: skill folders, the write-class rows, hook entries per agent, the instruction block, a new "Antigravity CLI" section and a new "OpenCode" section in the shape of the Gemini CLI section, and how an existing live config adds an agent with `live add-agent`.
- `docs/UPGRADING.md`: adding an agent after an upgrade; uninstall the new agents before a rollback to an older kit.
- `docs/AGENT-PROTOCOL.md`: `--agent` values, the Antigravity payload and output, the plugin payload, shell tools, actor variables.
- `docs/SECURITY-MODEL.md` and `docs/LIMITATIONS.md`: the new skill folder, the new hook targets, the plugin file as code that OpenCode loads, lesson timing, no compaction reset.
- `docs/ROADMAP.md`: the agent list.
- `docs/GETTING-STARTED.md`: the setup step IDs and the hook file count. `docs/RELEASING.md`: read it and change it only if it names package files or agents that this work changes.
- `templates/skills/`: no template matches `devtwin-setup` or `devtwin-capture` today; check again before the commit.
- Site docs: `guides/live-mode.md`, `guides/coding-agents.md`, `guides/lessons-and-hooks.md`, `guides/setup-wizard.md`, `guides/preferences-and-templates.md`, `reference/cli.md` (including the new `live add-agent` route, which `test/docs.test.mjs` requires), `reference/configuration.md`, `security/limitations.md`, `security/security-model.md`, `concepts/where-data-lives.mdx`, `index.mdx`.
- `skills/devtwin-setup/SKILL.md` and `skills/devtwin-capture/SKILL.md`: step IDs and lesson timing.
- `npm run check:writing` and `node --test test/docs.test.mjs` pass.

## Checks before each pull request

- The touched test files with `node --test`, normally and under `env -i HOME="$HOME" PATH="$PATH"`.
- `set -o pipefail; npm test`, `npm run check:package`, `npm run check:writing`, `git diff --check`.
- No test uses `skip`, `todo`, `only` or an empty callback.
- Every new test title is in `test/required-tests.json`, and every new tracked file is in `scripts/package-allowlist.json` next to its siblings.
- An independent review of the diff and a test run by a second agent before the pull request opens.

## Reaching live mode on the owner's machine

Neither adapter reaches live mode from a merge alone. The live config pins a package kit. After a release, the owner installs the new kit and runs `live set-kit`. Then, each as a preview followed by an owner apply:

1. `live add-agent --agent antigravity` and `live add-agent --agent opencode`.
2. `setup apply --all-pending`, which approves the new hook targets and installs the skills and hooks.
3. `instructions plan --agent antigravity --agent opencode`, then `instructions apply`.

An agent may run the previews. The owner runs every apply.

## Risks

| Risk | Handling |
| --- | --- |
| `ask` could change meaning in a later `agy` release | A7 records the behaviour per version; the limitations page names the checked version |
| The owner-action block fails open when the hook cannot run (missing `node`, timeout) | Same as the other agents; documented |
| Global `hooks.json` is shared with the Antigravity app and IDE | The payload reader accepts both tool name sets; only the CLI is checked |
| `agy` can add `enabled: false` inside `devtwin` through its `/hooks` screen | The key survives installs; `agents status` reports the entries as installed. A `disabled` flag in status is a follow-up |
| Two hook processes for one session can race on the session file | Last write wins, as today; the worst case repeats one lesson |
| The OpenCode plugin API is young and partly experimental | Only `experimental.idle` is experimental, and it is isolated; B5 checks each hook in a real session |
| A plugin reload forgets which sessions got the session-start line | The line can repeat once after a reload; documented |
| An older kit refuses a live config or journal that names a new agent | `docs/UPGRADING.md` gives the rollback order |

## Review record

A second agent reviewed this plan against the code on 2026-11-18. Its three blockers and four other findings are folded in above: the owner dialog on `live add-agent`, the `owned-only` instruction target for OpenCode, the bounded and root-bound pending state, the active-user rule for the shared `GEMINI.md`, the file-target journal and removal rules, the fence tests, and the extra docs.

Decisions on the open questions:

1. `live add-agent` is the route. `live write-classes` changes a different config field.
2. Note reports are not deferred in Part A. Note state is separate, and a report can hold teammate text.
3. A foreign plugin file keeps the two existing statuses: `foreign-entry` for the expected bytes that no journal wrote, and `modified` for any other content.
4. The plugin tries `node` on `PATH` first and keeps the baked Node path as a fallback. A Node upgrade that moves that path makes the file `outdated`; the docs say so and a test covers it.

If Part B grows past a reviewable size, the whole-file installer and removal machinery (unit B2) moves to its own small pull request before the adapter.
