# Changelog

This file lists the notable changes in each devtwin release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/). A prerelease version goes to the `alpha` dist-tag on npm.

## [Unreleased]

### Added

- **Antigravity CLI as the fourth agent.** `live init --agent antigravity`, `agents install --agent antigravity`, `agents install --hooks --agent antigravity` and `instructions plan --agent antigravity` set up Antigravity CLI (`agy`). Its skills go to `~/.gemini/config/skills`, its instruction block to `~/.gemini/GEMINI.md`, and its hook entries under a `devtwin` key in `~/.gemini/config/hooks.json`. The setup wizard has the new steps `skills-antigravity` and `hooks-antigravity`.
- **Antigravity CLI hooks.** The hook reads Antigravity CLI payloads. For a hook line with a valid event, agent and pilot, it always prints one JSON object. On `PreToolUse` it denies owner-only devtwin commands in `run_command` and `manage_task` with `{"decision":"deny","reason":...}`. With nothing to deny, it prints `{"decision":"ask"}`, which hands the call to the agent's normal permission flow. The session-start line and the prompt lessons arrive as an injected system message, on `SessionStart` and `PreInvocation`. Lessons for a file or a command are held on `PostToolUse` and arrive on the next model call. `Stop` writes the stop stub.
- **`live add-agent`.** `live add-agent --agent <id>` adds an agent to an existing live config. It has a preview, and its apply shows an owner dialog that names the agent and its skills folder. One setup batch then installs the agent's skills and hooks. Before the agent is added, `setup status` shows its steps as skipped, with the reason "agent not in the live config".
- **`antigravity` actor.** A record written from an Antigravity CLI shell (`ANTIGRAVITY_AGENT` or `ANTIGRAVITY_CONVERSATION_ID` set) has the actor `antigravity`. An older devtwin refuses such a record in a portable handoff.
- **OpenCode as the fifth agent.** `live init --agent opencode`, `live add-agent --agent opencode`, `agents install --agent opencode`, `agents install --hooks --agent opencode` and `instructions plan --agent opencode` set up OpenCode 2.x. The setup wizard has the new steps `skills-opencode` and `hooks-opencode`. OpenCode's support level is `full`.
- **OpenCode plugin file.** OpenCode has no hook settings file. `agents install --hooks --agent opencode` writes one devtwin-owned plugin file, `~/.config/opencode/plugins/devtwin.js`, as a whole, with mode 0600. Before the `shell` tool, the plugin blocks an owner-only devtwin command, and the model reads the devtwin reason. After `shell`, `read`, `edit`, `write`, `patch`, `grep` and `glob`, it appends matching lessons to the tool result. Before that text it puts one line: `[devtwin hook note: the text below was added after the tool output and is not part of it]`. Without the line, a model can read the lesson as part of the file. On a prompt, it sends session-start once for each session, and again on the first prompt after a compaction, and then the prompt. A prompt with no text gets no session-start line; the line arrives with the next prompt that has text. It appends the reply to the prompt text, and OpenCode shows that text in your prompt in the conversation. It also sends the compaction and stop events. It passes on only the command, the path and the header lines of a patch, never a file body.
- **Plugin file statuses.** `agents status` and the install preview report the plugin file as `missing`, `installed`, `outdated`, `foreign-entry` or `modified`. devtwin never writes over and never removes a file that it did not write: an install and an uninstall both report `conflict` for `foreign-entry` and `modified`. An uninstall removes the file only when devtwin wrote it and it is unchanged. The setup batch dialog names the file with `Approve plugin file ...` and `Install the devtwin plugin file ...`, or `Rewrite the devtwin plugin file ...` for an outdated one.
- **OpenCode instruction file.** The instruction block for OpenCode lives in the devtwin-owned file `~/.config/opencode/devtwin.md`, with no import line in any file. The plugin adds its text as system context on each model call. devtwin never creates or edits an OpenCode `AGENTS.md` or `opencode.json`. Those files are yours. To make OpenCode read your `~/.claude/CLAUDE.md`, add `"instructions": ["~/.claude/CLAUDE.md"]` to your own `~/.config/opencode/opencode.json`. devtwin does not write that setting. While the devtwin plugin file is not installed, `instructions plan` warns with `INSTRUCTIONS_NEED_PLUGIN`, because no OpenCode session reads the block without the plugin. The warning changes no action.
- **Rollback check for the plugin file.** `agents rollback-check` for a hook install run fails with `DEVTWIN_ROLLBACK_MISMATCH` when the OpenCode plugin file did not exist before the run and exists now. This is also true for a plugin file that you edited after the install.
- **Shared skills for OpenCode.** OpenCode reads `~/.agents/skills`, the folder that Codex and Gemini CLI use. One install serves the three agents, and an uninstall for one keeps the skills while another agent of the live config still uses the folder.
- **`opencode` actor.** A record written from an OpenCode shell (`OPENCODE` set) has the actor `opencode`. An older devtwin refuses such a record in a portable handoff.

### Changed

- **One edit for a shared instruction file.** Gemini CLI and Antigravity CLI both read `~/.gemini/GEMINI.md`. `instructions plan` now plans a file that two selected agents name once, and lists the other agent in `shared`. `instructions apply` edits the file once. A `--remove` for one agent keeps the block while the other agent still uses the file, with the reason `shared-file`.
- When it writes the block, the `instructions apply` owner dialog always names Claude Code and Codex, and it now adds each other agent that reads a planned file. A plan that holds `GEMINI.md` adds Gemini CLI and Antigravity CLI. A plan that holds the OpenCode file adds OpenCode.
- The `hookTargets` write class also accepts `~/.gemini/config/hooks.json`. A live config may name `~/.gemini/config/skills`, and only that folder in `~/.gemini`, as the Antigravity CLI skills folder.
- The `hookTargets` write class also accepts the OpenCode plugin file, `~/.config/opencode/plugins/devtwin.js`. The `instructionTargets` write class also accepts `~/.config/opencode/devtwin.md`. No other path in `~/.config/opencode` is accepted.
- The text of the `write-classes-hooks` setup step now says "the hook settings file or the plugin file of each agent".
- **New conflict reason for instruction files.** devtwin creates no agent folder. `instructions plan` now reports a target file in a missing agent folder as `conflict` with the reason `agent-folder-missing`, for every agent. `instructions apply` then stops before the dialog and writes nothing. Before, the apply failed part-way with an internal error.
- `agents rollback-check` for a hook install run now fails with `DEVTWIN_RECOVERY_REQUIRED` while an installer journal of the config is incomplete, as a new apply does. Run `agents recover` first. Before, the check compared the files at once.
- A skills install for Codex and Gemini CLI now also names OpenCode in `shared` when you select it, and a skills uninstall names OpenCode in `keptFor` when the live config has it.
- `~/.config/opencode` is a protected path, and so is the folder that `OPENCODE_CONFIG_DIR` names when it is set. A pilot or a live config never accepts a root or a skills folder there. When `OPENCODE_CONFIG_DIR` names a folder inside or around a root, a registered repository, a skills folder, or an approved hub or backup folder of the config, every devtwin command that loads the config in that shell is refused with `DEVTWIN_GATE_REQUIRED`. The error details name the field and `protected: OPENCODE_CONFIG_DIR`. The hook command does not load the config that way, so the owner-action block and the lessons keep working in a session that loads the plugin. One hook step does run that check: the step that posts a "working on" note. So in a project that joined a hub, the hook posts no "working on" note from such a session.

### Fixed

- **Agent-facing commands run as written.** Every route except a root-free one needs `--pilot`, so the bare `devtwin <command>` that the instruction block and the hook hints named failed in every session. The instruction block now names the command form once, with the kit and the pilot: ``Run devtwin as `node '<kit>/bin/devtwin.mjs' <command> --pilot '<pilot>'`, written here as `devtwin <command>`.`` Its rules use that compact form. The handoff rule now lists every flag that `handoff write` requires, and it applies in a bound project. Each hook hint (`lesson notices`, `lesson show`, `lesson match`, `paths confirm` and `hook verify`) ends with `(command form: your devtwin instruction block)`. The bound session-start line also names the scope: `Scope: <scope>.`. A radar guide and the radar note of a stack digest give the full command with both paths. The command form takes part of the block's 1,200 characters, so long paths leave less room for preferences.
- **The session-start output keeps its size caps.** The session-start line is at most 400 bytes, and the whole session-start output is at most 1,600 bytes. The line always keeps the project, the lesson count, the scope and the session ID. Other parts use a short form or are left out in a fixed order. The session summary gets the bytes that are left.
- **Radar commands are safe to copy.** The `lesson propose` command in a radar guide and the `radar guide` command in a digest put each placeholder in single quotes, so a copied command cannot redirect the shell. A note says to replace the placeholders. The `lesson propose` command now has `--summary`, a match rule and `--apply`, so it writes the proposal.
- **Linked worktrees resolve in `context resolve`.** A linked worktree of a bound repository now resolves to its project, as it already did for the hooks and `lesson match`. The result has `worktree.linked: true` and the worktree's own root, branch, head and dirty state. The three resolvers share one rule. When bound roots of two or more projects in the scope share the Git common directory, `context resolve` fails with `PROJECT_UNBOUND` and the new reason `ambiguous-worktree`. The reason `worktree-not-confirmed` and the wrong `project onboard --repo <worktree>` remedy are gone. A folder with a forged `.git` file never resolves: a `.git` file counts only for a worktree that `git worktree add` made. `context brief` checks source freshness in the selected worktree. Portable handoff export stays fenced to the pilot's repositories.

### Known limits

- Antigravity CLI support is checked in a real Antigravity CLI 1.5 session: the events, the payload, the deny and the `ask` reply on `PreToolUse`. A later version can change them. The Antigravity app and IDE read the same hooks file and are not checked.
- One real session ran devtwin's own hook entries from a hooks file in a disposable workspace. The session-start line arrived, an owner-only command was denied, a normal command ran, and the lesson for a read file arrived on the next model call. That session also read the block in `~/.gemini/GEMINI.md` and listed the skills in `~/.gemini/config/skills`. No real session has yet run devtwin's installed entries from `~/.gemini/config/hooks.json` or loaded a devtwin skill from `~/.gemini/config/skills`.
- On Antigravity CLI, a lesson for a file or a command arrives one model call later, after the tool ran. When two hook calls of one conversation overlap, a held lesson can wait for the next tool call that matches it. A lesson held in one worktree is not printed in another.
- Antigravity CLI has no compaction event, so the four-line lesson cap does not reset after a compaction.
- An Antigravity CLI tool call shows no report of a teammate's "working on" note. The agent's own note is still posted.
- `{"decision":"ask"}` is not a gate. In the agent's auto mode a command runs with no prompt. The only gate is the deny of the owner-action block.
- `agents status` does not read the `enabled` key that the Antigravity CLI `/hooks` screen writes. With `enabled` set to `false`, it still says `installed` while the agent runs no devtwin hook.
- A pinned kit older than this release does not know `live add-agent`. Run `live set-kit` to the new kit first.
- No command removes an agent from a live config. A kit from before this release refuses a live config that names Antigravity CLI, so you cannot roll back to such a kit after `live add-agent --agent antigravity`. See [Upgrading](docs/UPGRADING.md#roll-back-after-you-add-an-agent).
- OpenCode support is for OpenCode 2.x and is checked on OpenCode 2.3.0 only. An OpenCode 1.x binary loads the plugin file and gets no hooks from it, so devtwin does nothing there. This 1.x behavior comes from the OpenCode docs, and no 1.x binary was run.
- A real OpenCode 2.3.0 session ran the plugin file that devtwin generated. `agents install --hooks --agent opencode` wrote the file into a disposable home. The session-start line arrived once. The plugin blocked an owner-only command with the devtwin reason, and a normal command ran with no devtwin text. The lesson for a read file arrived with the result of the `read` call, and a prompt lesson arrived in the prompt text. The model quoted text from the instruction block in `devtwin.md`, and the idle event wrote the stop stub. The session listed the devtwin skills of the shared `~/.agents/skills` folder. A later version can change these results.
- In that session, the model described the lesson text as content of the file that it read. The plugin now puts a marker line before the text that it appends to a tool result. A second session ran the plugin with the marker line. The model then said that the lesson text was added after the tool output.
- No session has yet run the plugin from a real `~/.config/opencode`. The `edit`, `patch` and `grep` tools and the compaction event were not seen in a session with the generated plugin. The `write` and `glob` tools were seen, but a lesson on a `write` or `glob` result was not. The `patch` and `grep` tools and the compaction event come from the OpenCode source and docs.
- In a real OpenCode 2.3.0 session, OpenCode loaded a project `AGENTS.md` and a global `~/.config/opencode/AGENTS.md`. It did not load `~/.claude/CLAUDE.md`. It loaded the Claude Code file after the developer's own `~/.config/opencode/opencode.json` named it under `instructions`.
- The OpenCode source says that OpenCode expands no `@path` line, so an import line in `CLAUDE.md` gives OpenCode no block text. The devtwin block reaches OpenCode through the plugin, from `~/.config/opencode/devtwin.md`.
- The OpenCode source says that OpenCode also reads `~/.claude/skills` and that `~/.agents/skills` wins for two skills with the same name. No session showed this.
- OpenCode gets no lessons before a tool runs. A lesson for a file or a command arrives with the tool result.
- On OpenCode, the session-start line and the prompt lessons are appended to the prompt text, so they stay in the conversation. OpenCode shows that text in your prompt in the conversation, so you see it too.
- devtwin installs only to `~/.config/opencode`. An OpenCode with a moved config folder (`OPENCODE_CONFIG_DIR` or a non-default `XDG_CONFIG_HOME`) is not supported.
- devtwin creates no OpenCode folder. Create `~/.config/opencode/plugins` yourself before the hooks install. Without the folder, the hooks install reports `blocked` with `agent-folder-missing` once the plugin file is an approved hook target. Before the approval, it reports `blocked` with `not-approved`.
- OpenCode loads the plugin file with no approval step. A plugin hook that fails or takes over 10 seconds counts as nothing to say, and the tool runs. The plugin file holds a Node path, and a Node install that moves makes the file `outdated` until you run the hooks install again.
- The Node path in the plugin file is part of its hash. A Node outside a Homebrew Cellar folder, such as one from nvm, fnm, volta or asdf, goes into the file as it is. So when devtwin runs under another Node, `agents status` shows the plugin file as `outdated`, and a hooks preview made under one Node cannot be applied under another.
- A kit from before this release refuses a live config that names `opencode`, and no command removes an agent from a live config. You cannot roll back to such a kit after `live add-agent --agent opencode`.

## [0.1.0-alpha.2]

Gemini CLI joins Claude Code and Codex, and lessons can go to an org knowledge server over MCP. Upgrade with `npm i -g devtwin@alpha`, then follow [Upgrading](docs/UPGRADING.md).

### Added

- An AI software factory section on the landing page and in the README explains how devtwin carries context and lessons between agents. The landing page shows an animated decision-to-lesson workflow with a pause control.

- **Gemini CLI as the third agent.** `live init --agent gemini`, `agents install --agent gemini`, `agents install --hooks --agent gemini` and `instructions plan --agent gemini` set up Gemini CLI. Its skills go to `~/.agents/skills`, its instruction block to `~/.gemini/GEMINI.md`, and its hook entries to `~/.gemini/settings.json`. The setup wizard has the new steps `skills-gemini` and `hooks-gemini`.
- **Gemini CLI hooks.** The hook reads Gemini CLI payloads and prints Gemini CLI JSON. On `BeforeTool` it denies owner-only devtwin commands with `{"decision":"deny","reason":...}`. Lesson lines arrive on `AfterTool`, because Gemini CLI reads no added context before a tool runs. `AfterAgent` writes the stop stub.
- **Shared skills folder.** Codex and Gemini CLI read the same `~/.agents/skills` folder. An install for both writes each skill once, and the plan names the other agent in `shared`. In live mode, an uninstall for one keeps the entries while the other is in the live config, with the reason `shared-folder`.
- **Support levels.** `agents status` has a `support` field, and `doctor` has an `agents` check. Each gives an agent's `supportLevel` (`full` or `partial`) and its capability flags. `setup status` gives the level on each skills and hooks step.
- **`gemini` actor.** A record written from a Gemini CLI shell (`GEMINI_CLI` set) has the actor `gemini`. An older devtwin refuses such a record in a portable handoff.
- A consented `server` lesson target shares scoped lessons through an agent's MCP connection and records returned learning IDs.
- **Docs for routines and the knowledge server.** The preferences guide shows how to make a routine of your own, such as asking a reviewer on Slack when you open a pull request. The new Team knowledge server guide covers the binding, the consent, the payload and record steps and reading at session start.

### Changed

- Agent-specific code now lives in one adapter per agent under `src/agents/adapters/`. Claude Code and Codex behave as before.
- The `instructionTargets` and `hookTargets` write classes also accept `~/.gemini/GEMINI.md` and `~/.gemini/settings.json`.

### Known limits

- Gemini CLI support is checked against the Gemini CLI documentation and tests, not yet in a real Gemini CLI session. Gemini CLI runs hooks in a reduced environment; if `node` is not found there, the hooks do not run.
- A Gemini CLI settings file with comments is refused as `invalid-json`.
- Antigravity CLI is not supported yet.

## [0.1.0-alpha.1]

The first npm release. Install it with `npm i -g devtwin`. A Git clone stays a supported install for contributors.

### Added

- **npm package.** The package holds only the runtime files: `bin/`, `src/`, `skills/`, `templates/`, `schemas/`, `catalog/`, the license files and the README. Tests, docs, scripts and the site stay in Git. The package audit checks that the pack equals this runtime set.
- **Offline demo.** `devtwin demo` runs the disposable demo from the installed package, with no network and no Git clone.
- **Kit identity.** A package kit has an identity: its version plus a SHA-256 digest of its runtime files, written as `npm:<version>+sha256:<digest>`. `devtwin --version` reads the version from `package.json`. It adds the commit for a Git kit and the first 12 hex digits of the digest for a package kit. `devtwin kit list` shows a package kit's full kit ID.
- **`kit install` and `kit list`.** `devtwin kit install --apply` copies the installed package into a locked, read-only folder under `~/.devtwin/kits/` and checks the copy against its digest. The command prints the `live set-kit` command to run next. `kit list` shows the kit folders and the pinned one.
- **`live set-kit --kit` with an owner dialog.** Pinning a kit, or changing the pinned kit, now needs the owner's approval in a terminal dialog. The dialog names the old and new kit IDs and folders. For a package kit, it tells the owner to compare the digest with the one in the GitHub release. `live init --kit` also accepts a package kit.
- **Pinned kit for hooks, jobs and skills.** Hooks, jobs and agent-invoked skills run from the pinned kit folder, never from npm's global folder. A later `npm i -g` changes nothing until the owner pins a new kit.
- **Forwarding for a person at the terminal.** The global `devtwin` command forwards live commands to the pinned kit when the live config is approved and the kit passes its identity check. It prints the kit ID on stderr. Agents never use the global command.
- **Release workflow.** A `v*` tag that the owner pushes starts `.github/workflows/release.yml`. The workflow runs the gates on macOS with Node 22.13.0 and 26.4.0, publishes with npm trusted publishing and provenance after the owner approves the `npm-release` environment, and creates a draft GitHub release with the kit digest. It never moves the default dist-tag.
- **Upgrade guide.** `docs/UPGRADING.md` describes the upgrade, the rollback, the provenance and digest checks, nvm, and the move from a Git clone to a package kit.
- **`npm-install` acceptance check.** From a Git clone, the acceptance harness packs the kit, installs the tarball offline and runs `devtwin demo` from that install.

### Changed

- `package.json` has a description, keywords and the documentation site as its homepage.
- `package.json` no longer has `"private": true`. A `prepublishOnly` guard refuses a publish outside GitHub Actions unless `DEVTWIN_ALLOW_LOCAL_PUBLISH=1` is set.

[Unreleased]: https://github.com/sundharesan11/devtwin/compare/v0.1.0-alpha.2...HEAD
[0.1.0-alpha.2]: https://github.com/sundharesan11/devtwin/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/sundharesan11/devtwin/releases/tag/v0.1.0-alpha.1
