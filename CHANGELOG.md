# Changelog

This file lists the notable changes in each devtwin release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/). A prerelease version goes to the `alpha` dist-tag on npm.

## [Unreleased]

### Added

- **Antigravity CLI as the fourth agent.** `live init --agent antigravity`, `agents install --agent antigravity`, `agents install --hooks --agent antigravity` and `instructions plan --agent antigravity` set up Antigravity CLI (`agy`). Its skills go to `~/.gemini/config/skills`, its instruction block to `~/.gemini/GEMINI.md`, and its hook entries under a `devtwin` key in `~/.gemini/config/hooks.json`. The setup wizard has the new steps `skills-antigravity` and `hooks-antigravity`.
- **Antigravity CLI hooks.** The hook reads Antigravity CLI payloads. For a hook line with a valid event, agent and pilot, it always prints one JSON object. On `PreToolUse` it denies owner-only devtwin commands in `run_command` and `manage_task` with `{"decision":"deny","reason":...}`. With nothing to deny, it prints `{"decision":"ask"}`, which hands the call to the agent's normal permission flow. The session-start line and the prompt lessons arrive as an injected system message, on `SessionStart` and `PreInvocation`. Lessons for a file or a command are held on `PostToolUse` and arrive on the next model call. `Stop` writes the stop stub.
- **`live add-agent`.** `live add-agent --agent <id>` adds an agent to an existing live config. It has a preview, and its apply shows an owner dialog that names the agent and its skills folder. One setup batch then installs the agent's skills and hooks. Before the agent is added, `setup status` shows its steps as skipped, with the reason "agent not in the live config".
- **`antigravity` actor.** A record written from an Antigravity CLI shell (`ANTIGRAVITY_AGENT` or `ANTIGRAVITY_CONVERSATION_ID` set) has the actor `antigravity`. An older devtwin refuses such a record in a portable handoff.

### Changed

- **One edit for a shared instruction file.** Gemini CLI and Antigravity CLI both read `~/.gemini/GEMINI.md`. `instructions plan` now plans a file that two selected agents name once, and lists the other agent in `shared`. `instructions apply` edits the file once. A `--remove` for one agent keeps the block while the other agent still uses the file, with the reason `shared-file`.
- When it writes the block, the `instructions apply` owner dialog names every agent that reads a planned file. A plan that holds `GEMINI.md` names Gemini CLI and Antigravity CLI.
- The `hookTargets` write class also accepts `~/.gemini/config/hooks.json`. A live config may name `~/.gemini/config/skills`, and only that folder in `~/.gemini`, as the Antigravity CLI skills folder.

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
