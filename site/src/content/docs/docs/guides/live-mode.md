---
title: Live mode
description: Turn on devtwin for real on one machine, with a private store under ~/.devtwin, a pinned kit and the real skill folders of Claude Code, Codex, Gemini CLI, Antigravity CLI and OpenCode.
---

A disposable pilot is for trying devtwin. **Live mode** is for daily use. It points devtwin at a real private store and your real agent skill folders, and onboards your real repositories read-only.

Every write is still a preview followed by an apply of the exact fingerprint you approved.

## What live mode sets up

```text
~/.devtwin/            0700, created by you
  live.json           the live config
  kits/               package kits, one locked folder per version and digest
  kit/                or a separate clone of the kit, detached at a reviewed commit
  store/              the private store
    config/ data/ state/ inputs/
```

- Outside the store, devtwin writes only `devtwin-*` entries directly inside `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`), `~/.agents/skills` and `~/.gemini/config/skills`, plus the exact paths you approve as [write classes](/docs/reference/configuration/#write-classes). It writes in a folder only when the live config names it. It never creates, removes or changes the mode of those folders.
- Codex skills go to `~/.agents/skills`, never `~/.codex/skills`. `CODEX_HOME` does not change this; the preview warns `CODEX_HOME_IGNORED` if it is set.
- Gemini CLI reads the same `~/.agents/skills` folder, so one install serves every agent that reads this folder. See [Gemini CLI](#gemini-cli).
- Antigravity CLI skills go to `~/.gemini/config/skills`, a folder of its own. See [Antigravity CLI](#antigravity-cli).
- OpenCode reads `~/.agents/skills` too, so the same install serves Codex, Gemini CLI and OpenCode. Its hooks are one plugin file that devtwin owns. See [OpenCode](#opencode).
- Live commands run only from the kit the live config names: a locked package kit folder that matches its version and digest, or a Git clone that is clean and detached at the configured commit.
- Hooks, jobs and agent skills run the pinned kit's own `bin/devtwin.mjs`, never npm's global folder. A later `npm i -g` changes nothing until you pin the new kit.
- The live config changes only through `live init`, `live add-repo`, `live add-agent`, `live set-kit`, `live write-classes`, `live stack-watch`, `live approval` and `live migrate`. Each records an approved digest of the config; a `live.json` that differs from the approved one is refused.
- Listed repositories are read-only.
- `import run` and the `import-daily` job also read, never write, two things for each onboarded repository: its own Claude Code folder in `~/.claude/projects`, and the `docs/solutions` files of its remote default branch. See [`import run`](/docs/reference/cli/#import-run). A shell `import run` writes as its caller, under the caller's limits; only the `import-daily` job writes as the job.

:::caution[Turn on backups]
Until you approve a backup folder, there is no backup: losing `~/.devtwin` loses your records, decisions and journals, and leaves installed skills unowned. Onboarding copies some repository text into the store, protected only by mode 0700 and your disk encryption. See [Backup and restore](#backup-and-restore).
:::

The steps below use these variables:

```sh
KIT='<kit path from step 4>'
LIVE_CONFIG="$HOME/.devtwin/live.json"
REPO='/absolute/real/path/to/your/repository'
```

## 1. Check your agents' skill folders

```sh
ls -ld ~/.claude/skills ~/.agents/skills
```

Each must be a real directory, not a symbolic link, and so must `~/.claude` and `~/.agents`. If one is missing or is a link, create or fix it yourself first; devtwin never creates it. If `CLAUDE_CONFIG_DIR` is set, check `$CLAUDE_CONFIG_DIR/skills` instead.

For Antigravity CLI, check `~/.gemini/config/skills` the same way, with `~/.gemini` and `~/.gemini/config`.

For OpenCode, check that `opencode --version` shows 2.x: an OpenCode 1.x binary gets no devtwin hooks. Then check its config folder with `ls -ld ~/.config/opencode ~/.config/opencode/plugins`. If the plugins folder is missing, create it yourself with `mkdir -p ~/.config/opencode/plugins`; devtwin never creates it.

Your home directory must not be inside a Git worktree: `git -C ~ rev-parse --show-toplevel` should fail with "not a git repository".

## 2. Check the repository

Onboarding refuses a repository that Git filters could touch and stops on a slow `git status`. Check both up front, in a shell with no `GIT_*` variables set:

```sh
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$REPO" config --includes --name-only --get-regexp '^(filter|diff)\.'
time GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.untrackedCache=false -C "$REPO" status --porcelain=v1 -z --untracked-files=normal --ignore-submodules=all | wc -c
```

- Any output from the first command (for example a repository-local Git LFS filter) means onboarding will fail with `DEVTWIN_PATH_UNSAFE`. Don't change the repository's Git config to get past it.
- The status must finish well inside 30 seconds and print less than 16 MiB, or onboarding fails with `DEVTWIN_GIT_QUERY_FAILED` or `DEVTWIN_LIMIT`.

## 3. Create the private folder

```sh
mkdir -m 700 ~/.devtwin
ls -ld ~/.devtwin
```

It must be yours, mode `drwx------`, and outside any Git worktree.

## 4. Install the kit

Copy the installed package into a locked kit folder. Preview first; the plan writes nothing:

```sh
npm i -g devtwin
devtwin kit install
```

Compare the `digest` in the plan with the kit digest in the [GitHub release](https://github.com/sundharesan11/devtwin/releases) for that version. If they differ, stop. When they match, copy the kit and set `KIT` to the `kitRoot` it prints:

```sh
devtwin kit install --apply
devtwin kit list
```

The kit folder is `~/.devtwin/kits/<version>-<digest prefix>/`, read-only and checked against its digest. `kit install --apply` is an owner action: the devtwin hook denies it from an agent shell.

:::note[Contributors: pin a Git clone]
You can pin a clone instead. Clone the kit to `~/.devtwin/kit`, run `git -C ~/.devtwin/kit checkout --detach '<reviewed commit>'`, and check that `git -C ~/.devtwin/kit status --porcelain` prints nothing. Set `KIT="$HOME/.devtwin/kit"`, and leave out `--kit` in step 5. Don't create files in the clone: an untracked file makes it dirty, and live commands then refuse.
:::

## 5. Create the live config

Preview. `--kit` names the kit from step 4, and `devtwin` runs the command in that kit folder:

```sh
devtwin live init --pilot "$LIVE_CONFIG" --agent claude --agent codex --repo "$REPO" --kit '<version>+<digest>'
```

Review `config` (home, skill folders, kit path and identity, repositories), `layout` and `warnings`. `KIT_NOT_SIBLING` means the kit is neither in `~/.devtwin/kits` nor at `~/.devtwin/kit`. Then apply:

```sh
devtwin live init --pilot "$LIVE_CONFIG" --agent claude --agent codex --repo "$REPO" --kit '<version>+<digest>' \
  --apply --plan-fingerprint '<fingerprint>'
```

The steps below run `node "$KIT/bin/devtwin.mjs"`. At the terminal, plain `devtwin` works too: the global command runs live commands in the kit your live config pins, and prints `devtwin: running kit <kit ID>` on stderr. Agents never use the global command.

Apply creates the store folders, records the approved digest, writes `live.json` and draws a random config ID.

## 6. Initialize the store and add a scope

```sh
node "$KIT/bin/devtwin.mjs" init --pilot "$LIVE_CONFIG" --actor 'email:you@example.com'
node "$KIT/bin/devtwin.mjs" init --pilot "$LIVE_CONFIG" --actor 'email:you@example.com' --apply
node "$KIT/bin/devtwin.mjs" scope add --pilot "$LIVE_CONFIG" --scope '<scope>'
node "$KIT/bin/devtwin.mjs" scope add --pilot "$LIVE_CONFIG" --scope '<scope>' --apply
```

## 7. Onboard the repository

Follow [Onboard a repository](/docs/guides/onboard-a-repository/) with `--pilot "$LIVE_CONFIG"`. Check that `repoWrites` is empty before you apply.

### Optional: prove the repository was untouched

A Git clone of the kit includes a snapshot script; the npm package does not. Set `TOOLS` to a clone of the repository, then take a snapshot before onboarding and compare after:

```sh
node "$TOOLS/scripts/repo-snapshot.mjs" --repo "$REPO" --out /private/path/before.json
# … onboard …
node "$TOOLS/scripts/repo-snapshot.mjs" --repo "$REPO" --out /private/path/after.json
node "$TOOLS/scripts/repo-snapshot.mjs" --compare /private/path/before.json /private/path/after.json
```

`identical: true` is the expected result. Keep snapshots in private state such as `~/.devtwin/store/state/evidence/`. Close editors and Git clients on the repository while you do this, so they don't change files between snapshots.

## 8. Install the skills

One agent at a time, preview then apply. Omit `--home` in live mode:

```sh
node "$KIT/bin/devtwin.mjs" agents install --pilot "$LIVE_CONFIG" --agent claude
node "$KIT/bin/devtwin.mjs" agents install --pilot "$LIVE_CONFIG" --agent claude --apply --plan-fingerprint '<fingerprint>'
```

Repeat for `codex`, `gemini`, `antigravity` and `opencode`. Codex, Gemini CLI and OpenCode share `~/.agents/skills`: after the Codex install, the Gemini CLI and OpenCode previews show each skill as `installed`. Antigravity CLI has its own folder, `~/.gemini/config/skills`. A `conflict` or `modified` entry blocks all of that agent's writes (`blocked`); resolve it by hand and preview again. Keep the `runId` for the rollback check. See [Use with coding agents](/docs/guides/coding-agents/) for statuses, uninstall and recovery.

## 9. Point the skills at the kit

With the hooks installed, the session-start line names the pinned kit as ``Kit: `<path>` ``, and the skills run `node '<kit>/bin/devtwin.mjs'` from it. They never run a `devtwin` found on `PATH`.

`DEVTWIN_KIT` is only the fallback for a session without that line. To set it, add one line to your shell profile, for example `~/.zshrc`, and change it with each kit change:

```sh
export DEVTWIN_KIT='<kit path>'
```

devtwin edits agent settings files only through `agents install --hooks` and `agents uninstall --hooks`, after you approve them as write classes.

To turn on lesson delivery and the owner-action block, follow [Turn on the hooks in live mode](/docs/guides/lessons-and-hooks/#turn-on-the-hooks-in-live-mode). Then run [`paths confirm`](/docs/guides/lessons-and-hooks/#confirm-the-kit-and-config-paths) once, so that the skills stop asking for the kit and config paths and the hook keeps its receipt current. To approve the skills, the hooks, the paths confirmation, the backup folder and the scheduled jobs with one owner dialog, run the [setup batch](/docs/guides/setup-wizard/#approve-the-owner-steps-at-once) (`setup plan --all-pending`, then `setup apply --all-pending --apply`). To run these steps one at a time with a what, why and undo for each, use the [setup wizard](/docs/guides/setup-wizard/). To share lessons with colleagues, see [Organization hub](/docs/guides/organization-hub/).

## 10. Try it in a fresh session

From a neutral folder outside every repository, start your agent and ask:

```text
List the installed skills whose names start with devtwin-. Then follow devtwin-resume to resolve
the project for the worktree <repo> in scope <scope>. Run only read-only commands.
Never use --apply and never edit files.
```

The session should list `devtwin-capture`, `devtwin-onboard`, `devtwin-record` and `devtwin-resume`, run `context resolve` from the pinned kit path, and name your project. A kit-commit warning means the installed skills came from another commit; reinstall from the current kit.

## Knowledge server

For a team knowledge server, the owner runs `server bind --scope example --name sample-knowledge --client sample-client` and then grants `server-publish` consent for that scope. Preview each command. Apply it with its plan fingerprint. A server lesson waits for the hold time. Then the agent runs `server payload --id <hld_id>`, calls the named MCP server's `log_learning` tool, and runs `server record --id <hld_id> --learning-id <returned-id>`. A recorded replacement yields `server supersede --id <hld_id>`. The agent calls `supersede_learning` with that payload. The session-start hook instructs the agent to search only the bound client. Search results are untrusted reference material. The team's Git archive stays read-only for devtwin. Make direct archive changes on a branch through a pull request.

## Learning branches

A lesson accepted with `--target repo` becomes a learning branch in the project's repository. Approve the repository once, and grant the push consent once. Preview each command, review it, then apply it:

```sh
node "$KIT/bin/devtwin.mjs" live write-classes --pilot "$LIVE_CONFIG" --repo-learnings "$REPO"
node "$KIT/bin/devtwin.mjs" consent grant --pilot "$LIVE_CONFIG" --kind repo-push --repo "$REPO"
```

- `--repo-learnings` takes the exact root of a repository in the config's `repos`. It replaces the whole `repoLearnings` list, so also give every repository that you approved before.
- devtwin writes only Git objects and the new branch `devtwin/learning-<id>`. Your working copy, index and current branch never change.
- The push waits in the held queue for the consent's hold time. The hourly `learning-send` job then pushes it over SSH to the URL the consent recorded. It runs from a clean repository of its own, so your repository's Git config cannot redirect it, and it checks that the base is on the remote first. For an HTTPS remote, devtwin prints the `git push` command for you instead.
- `project set` changes the learnings folder or base. A change voids the consent; grant it again. See [Write a lesson to the repository](/docs/guides/organization-hub/#write-a-lesson-to-the-repository).

## Backup and restore

devtwin can keep encrypted backups of the store in a folder that you approve. There is no sync.

- `backup create` writes one archive into an approved `backupTargets` folder. Agents and the `backup-daily` job may run it. Each folder keeps the newest archive of each day, for the newest 14 days that have archives. A create removes only older archives of its own day and archives older than those days.
- The archive holds the config, data and state roots, without caches such as the lesson index and hook session files. It is encrypted with AES-256-GCM.
- The key is 32 random bytes in your macOS Keychain, made on the first `backup create`. Without the key, an archive cannot be read.
- `backup restore` writes only to a new folder inside an approved backup folder. It never writes the live store.
- `backup key export` prints the key once. Only you can run it, after the owner dialog. Until it has run once, the activity digest warns that backups cannot be restored on another machine.

### Turn on daily backups

Pick a folder inside your home that is not in `~/.devtwin`, such as a folder that a cloud drive or an external copy job saves. Preview each command, review it, then apply it:

```sh
node "$KIT/bin/devtwin.mjs" live write-classes --pilot "$LIVE_CONFIG" --backup-target "$HOME/devtwin-backups"
node "$KIT/bin/devtwin.mjs" live write-classes --pilot "$LIVE_CONFIG" --launch-agent "$HOME/Library/LaunchAgents/devtwin.backup-daily.plist"
node "$KIT/bin/devtwin.mjs" schedule plan --pilot "$LIVE_CONFIG" --job backup-daily
node "$KIT/bin/devtwin.mjs" schedule apply --pilot "$LIVE_CONFIG" --job backup-daily --plan-fingerprint '<fingerprint>'
```

The `--launch-agent` flag replaces the whole `launchAgents` list, so also give every plist that you approved before. Then export the key once, in your own terminal and outside any agent session:

```sh
node "$KIT/bin/devtwin.mjs" backup key export --pilot "$LIVE_CONFIG"
node "$KIT/bin/devtwin.mjs" backup key export --pilot "$LIVE_CONFIG" --apply --plan-fingerprint '<fingerprint>'
```

Store the key in a password manager, then clear the terminal.

### Restore a backup

1. Run `backup status` to list the archives in each approved folder.
2. Preview the restore into a new folder inside the backup folder:

   ```sh
   node "$KIT/bin/devtwin.mjs" backup restore --pilot "$LIVE_CONFIG" --from "$HOME/devtwin-backups/<archive>.dtb" --to "$HOME/devtwin-backups/restored"
   ```

3. Check the file count and the archive time in the preview.
4. Run the same command with `--apply --plan-fingerprint '<fingerprint>'`, and approve the owner dialog.
5. Read the result. It gives the number of files written and the number verified.

Restore decrypts and checks the whole archive in memory before it writes. A changed archive or a wrong key fails with `DEVTWIN_INTEGRITY`, and nothing is written. The restored files are plain text: when a cloud drive copies the backup folder, move the restored folder out of it or delete it after use.

The restored folder holds `config`, `data` and `state`, the same layout as `~/.devtwin/store`. No command points the live config at it. To use it, stop every agent session and move the current store aside. Then move the restored folders into `~/.devtwin/store` by hand, and make an empty `inputs` folder at mode 0700.

To restore on another machine, add the exported key to that machine's Keychain with `security add-generic-password -s devtwin-backup -a "$USER" -w`, and paste the key when it asks for the password. Then copy the archive into an approved backup folder there and follow the steps above.

## Answer owner prompts over SSH

By default, an always-ask action needs the macOS owner dialog, so it is denied in a session with no GUI, such as an SSH login. To answer on the terminal instead, opt in once:

```sh
node "$KIT/bin/devtwin.mjs" live approval --pilot "$LIVE_CONFIG" --mode dialog-or-tty
node "$KIT/bin/devtwin.mjs" live approval --pilot "$LIVE_CONFIG" --mode dialog-or-tty --apply --plan-fingerprint '<fingerprint>'
```

- In a GUI session the dialog is still required. With no GUI session, devtwin writes the prompt and a random six-letter code to the terminal. Type the code and press Return to approve. Anything else, or no answer in 300 seconds, denies.
- The devtwin hook still denies always-ask commands from agent shells.
- This is an owner action, and the apply shows the owner dialog. `--mode dialog` turns it off again.
- The key is part of the approved config, so a change ends the path confirmation. Run `paths confirm` again after it.

## Gemini CLI

Gemini CLI works like Claude Code and Codex, with full support: skills, the instruction block and the owner-action block. Add `--agent gemini` at step 5.

- **Skills.** They go to `~/.agents/skills`, the folder Codex and OpenCode read too. An uninstall for one of these agents keeps the skills while another one is in the live config.
- **Instruction block.** It goes between the devtwin markers in `~/.gemini/GEMINI.md`.
- **Hooks.** They go in `~/.gemini/settings.json`, under `hooks`. Your other settings and the hooks of other tools stay.
- **Lesson lines.** Gemini CLI reads the lesson lines right after a tool opens, edits or runs the matching file or command, not before it.
- **Owner-only commands.** The hook denies them from a Gemini CLI shell, as it does for the other agents.

## Antigravity CLI

Antigravity CLI (`agy`) is the fourth agent, with full support: skills, the instruction block and the owner-action block. Add `--agent antigravity` at step 5, or [add it to an existing live config](#add-an-agent-to-an-existing-live-config).

- **Skills.** They go to `~/.gemini/config/skills`, a folder of its own. A live config may name exactly that folder for Antigravity CLI.
- **Instruction block.** It goes between the devtwin markers in `~/.gemini/GEMINI.md`, the file Gemini CLI also reads. One block serves both agents. A remove for one of them keeps the block while the other still uses the file.
- **Hooks.** They go under a `devtwin` key in `~/.gemini/config/hooks.json`. The file is keyed by hook name. devtwin reads and changes only its own key. Another tool's named hook keeps its content, and the file keeps its indent. devtwin creates no agent folder: when `~/.gemini/config` is missing, the hooks step is blocked with `agent-folder-missing`.
- **Events.** devtwin adds `SessionStart`, `PreInvocation`, `PreToolUse`, `PostToolUse` and `Stop`. `PreInvocation` is devtwin's prompt event, and it runs before every model call.
- **No trust step.** Antigravity CLI has no approval step for the hooks in this file. Its `/hooks` screen can turn the devtwin hooks off by writing `enabled` inside `devtwin`. devtwin keeps that key, and `agents status` does not read it: with `enabled` set to `false`, the status still says `installed` while Antigravity CLI runs no devtwin hook.
- **Lesson lines.** Antigravity CLI reads no added context on a tool call. The session-start line and the lessons for a prompt arrive as an injected system message. The hook holds the lessons for a read or edited file and for a command, and they arrive on the next model call. The cap of four lines per session still holds.
- **Owner-only commands.** The hook denies them from an Antigravity CLI shell with `{"decision":"deny","reason":"..."}`. On a shell call that it does not deny, it prints `{"decision":"ask"}`. `ask` hands the call to the agent's normal permission flow. devtwin does not approve tools, and `ask` is not a gate: in the agent's auto mode a command runs with no prompt.

The limits are on the [limitations page](/docs/security/limitations/#lessons-hooks-and-hubs).

## OpenCode

OpenCode is the fifth agent, with full support: skills, the instruction block and the owner-action block. devtwin supports OpenCode 2.x, checked on OpenCode 2.3.0 only. Add `--agent opencode` at step 5, or [add it to an existing live config](#add-opencode).

- **Skills.** They go to `~/.agents/skills`, the folder Codex and Gemini CLI use. One install serves the three agents. An uninstall for one of them keeps the skills while another one is in the live config. A real OpenCode 2.3.0 session listed the devtwin skills of this folder. The OpenCode source says that OpenCode also reads `~/.claude/skills`, so it can also show the skills of a Claude Code install, and that `~/.agents/skills` wins for two skills with the same name. These two facts come from the source; no session showed them.
- **Create the folder first.** devtwin creates no agent folder. Run `mkdir -p ~/.config/opencode/plugins` yourself. Without it, the hook install and the hook uninstall are `blocked` with the reason `agent-folder-missing`. That reason shows only after the plugin file is an approved hook target; before the approval, the preview reports `blocked` with the reason `not-approved`.
- **Hooks.** OpenCode has no hook settings file. `agents install --hooks --agent opencode` writes one plugin file, `~/.config/opencode/plugins/devtwin.js`, as a whole, with mode 0600. OpenCode loads it with no approval step. Other plugins in the folder stay.
- **Plugin statuses.** The file is `missing`, `installed`, `outdated`, `foreign-entry` or `modified`. `outdated` means that devtwin wrote the file for an earlier kit path, an earlier plugin version or another Node path; an install rewrites it. `foreign-entry` is a file with the expected bytes that no devtwin journal wrote. `modified` is any other content.
- **Never another file.** devtwin never writes over and never removes a file that it did not write. For `foreign-entry` and `modified`, an install and an uninstall both report `conflict`; delete or move that file by hand. An uninstall removes the file only when devtwin wrote it and it is unchanged.
- **Owner-only commands.** Before the `shell` tool runs, the plugin asks the devtwin hook. It blocks an owner-only devtwin command, and the model reads the devtwin reason.
- **Lesson lines.** OpenCode gets no lessons before a tool runs. After `shell`, `read`, `edit`, `write`, `patch`, `grep` and `glob`, the plugin appends the matching lessons to the tool result. The cap of four lines per session still holds.
- **Marker line.** The plugin puts one line before the text that it appends to a tool result: `[devtwin hook note: the text below was added after the tool output and is not part of it]`. Without that line, a model can read the lesson as part of the file.
- **Session start and prompts.** On a prompt, the plugin sends `session-start` once for each session, and again on the first prompt after a compaction, and then the prompt. A prompt with no text gets no session-start line; the line arrives with the next prompt that has text. The plugin appends the reply to the prompt text, so that text stays in the conversation. OpenCode shows it in your prompt in the conversation, so you see it too.
- **Instruction block.** It goes between the devtwin markers in `~/.config/opencode/devtwin.md`, a file that devtwin owns. No import line names the file. On each model call, the plugin adds the text of the file as system context. The plugin reads the file only when it is a regular file of at most 65,536 bytes, and it follows no link. A link, a folder or a FIFO at that path adds nothing. `instructions apply --remove --agent opencode` empties the block and leaves the file. While the plugin file is not installed, `instructions plan` warns with `INSTRUCTIONS_NEED_PLUGIN`: no OpenCode session reads the block without the plugin.
- **Your instruction files.** devtwin never creates or edits an OpenCode `AGENTS.md` or `opencode.json`. Those files are yours. In a real OpenCode 2.3.0 session, OpenCode loaded a project `AGENTS.md` and a global `~/.config/opencode/AGENTS.md`, and it did not load `~/.claude/CLAUDE.md`. To make OpenCode read the Claude Code file, name it in your own `~/.config/opencode/opencode.json`:

  ```json
  { "instructions": ["~/.claude/CLAUDE.md"] }
  ```

  A real session loaded the file with that setting. devtwin does not write that setting. The OpenCode source says that OpenCode expands no `@path` line, so an import line in `CLAUDE.md` gives OpenCode no block text. The devtwin block reaches OpenCode through the plugin, from `~/.config/opencode/devtwin.md`.
- **Compaction and stop.** The plugin sends OpenCode's compaction event and its idle event, which is devtwin's stop event. After a compaction, the next prompt of the session gets the session-start line again.
- **What the plugin passes on.** Only the command, the path and the header lines of a patch. It never passes on a file body.
- **Node.** The plugin runs `node` from `PATH` and falls back to the Node path that the install wrote into the file. With a Homebrew Node, that is the stable link. A Node outside a Homebrew Cellar folder, such as one from nvm, fnm, volta or asdf, goes into the file as it is. The path is part of the file's hash, so devtwin under another Node shows the file as `outdated`, and a hooks preview made under one Node cannot be applied under another. A Node install that moves, for example after a version manager upgrade, makes the file `outdated` until you run the hooks install again.
- **Not a sandbox.** A hook that fails, prints something else, is too large or takes over 10 seconds counts as nothing to say, and the tool runs. As for every agent, the hook is not a sandbox.
- **OpenCode 1.x.** A 1.x binary loads the plugin file and gets no hooks from it. devtwin does nothing there.
- **Moved config folder.** devtwin installs only to `~/.config/opencode`. An OpenCode with a moved config folder (`OPENCODE_CONFIG_DIR` or a non-default `XDG_CONFIG_HOME`) is not supported. A live config never accepts a root or a skills folder in `~/.config/opencode`, or in the folder that `OPENCODE_CONFIG_DIR` names.
- **`OPENCODE_CONFIG_DIR` near a repository.** Do not point `OPENCODE_CONFIG_DIR` at a folder inside or around a root, a registered repository, a skills folder, or an approved hub or backup folder of the config. A per-project config folder inside a repository is one example. In a shell with such a value, every devtwin command that loads the config is refused with `DEVTWIN_GATE_REQUIRED`, and the error details name the field and `protected: OPENCODE_CONFIG_DIR`. The hook command does not load the config that way, so the owner-action block and the lessons keep working in a session that loads the plugin. One hook step does run that check: the step that posts a "working on" note. So in a project that joined a hub, the hook posts no "working on" note from such a session.
- **What was checked.** A real OpenCode 2.3.0 session ran the plugin file that devtwin generated, written by `agents install --hooks --agent opencode` into a disposable home. The session-start line arrived once, the plugin blocked an owner-only command with the devtwin reason, and a normal command ran. The lesson for a read file arrived with the result of the `read` call, a prompt lesson arrived in the prompt text, the model quoted text from the instruction block in `devtwin.md`, and the idle event wrote the stop stub. That session ran the plugin before the marker line existed. A second session ran the plugin with the marker line. The model then said that the lesson text was added after the tool output. The [limitations page](/docs/security/limitations/#agents-and-sessions) lists what is not checked yet.

The limits are on the [limitations page](/docs/security/limitations/#lessons-hooks-and-hubs).

## Add an agent to an existing live config

`live init` refuses an existing live config. To add an agent later, such as Antigravity CLI or OpenCode, use `live add-agent`. It adds the agent's skills folder to the live config and installs nothing.

```sh
node "$KIT/bin/devtwin.mjs" live add-agent --pilot "$LIVE_CONFIG" --agent antigravity
node "$KIT/bin/devtwin.mjs" live add-agent --pilot "$LIVE_CONFIG" --agent antigravity --apply --plan-fingerprint '<fingerprint>'
```

1. Check that the agent's skills folder is a real directory. devtwin never creates it.
2. Preview `live add-agent`, then apply the fingerprint in your own terminal. The owner dialog "Add an agent to the live config" names the agent and the exact skills folder.
3. Run one setup batch, `setup plan --all-pending` and then `setup apply --all-pending --apply`. It approves the agent's hook file, installs its skills and hooks, and confirms the paths again.
4. Run `instructions plan`, then `instructions apply` with its fingerprint. When the plan shows the agent's instruction file as `blocked`, approve it first with `live write-classes --instruction-target`. For Antigravity CLI the file is `~/.gemini/GEMINI.md`, and for OpenCode it is `~/.config/opencode/devtwin.md`. Give every instruction target that is already approved again, because the flag replaces the class.

- Each apply is an owner action. An agent can run the previews, and the devtwin hook denies the applies from an agent shell.
- A pinned kit older than this route answers with "Unknown command". Pin a kit that has it first with `live set-kit`; see [Upgrade the kit](#upgrade-the-kit).
- Until you add the agent, `setup status` shows its steps as skipped, with the reason "agent not in the live config".
- No command removes an agent from a live config. A kit that does not know the agent refuses the config, so you cannot go back to such a kit afterwards. To stop devtwin for the agent, uninstall its hooks and its skills with `agents uninstall`. Their setup steps are then pending again, and a batch with `--all-pending` installs them again; use `--steps` to leave them out. The [upgrade guide](https://github.com/sundharesan11/devtwin/blob/main/docs/UPGRADING.md#roll-back-after-you-add-an-agent) has the details.

### Add OpenCode

OpenCode takes the same route, with two more steps of your own:

1. Check that `~/.agents/skills` is a real directory.
2. Create the plugins folder with `mkdir -p ~/.config/opencode/plugins`. devtwin never creates an agent folder.
3. Preview `live add-agent --agent opencode`, then apply the fingerprint in your own terminal. The dialog names OpenCode, the folder `~/.agents/skills` and the instruction file `~/.config/opencode/devtwin.md`.
4. Approve the instruction file: preview `live write-classes --instruction-target "$HOME/.config/opencode/devtwin.md"`, with every instruction target that you approved before, then apply the fingerprint in your own terminal.
5. Run one setup batch, preview first. It approves the plugin file as a hook target and installs it.
6. Run `instructions plan`, then `instructions apply` with its fingerprint in your own terminal.

When Codex or Gemini CLI already has the skills in `~/.agents/skills` and no other step is pending, the batch dialog looks like this:

```text
Approve 3 setup changes
1. Approve plugin file ~/.config/opencode/plugins/devtwin.js
2. Confirm kit ~/.devtwin/kits/<kit folder> at <kit ID> and config ~/.devtwin/live.json
3. Install the devtwin plugin file ~/.config/opencode/plugins/devtwin.js
```

For an `outdated` plugin file, the last line is `Rewrite the devtwin plugin file ~/.config/opencode/plugins/devtwin.js`. Without `~/.config/opencode`, the instruction plan shows `conflict` with the reason `agent-folder-missing`.

## Add another repository

Run the step 2 checks on it, then:

```sh
node "$KIT/bin/devtwin.mjs" live add-repo --pilot "$LIVE_CONFIG" --repo '<repo>'
node "$KIT/bin/devtwin.mjs" live add-repo --pilot "$LIVE_CONFIG" --repo '<repo>' --apply --plan-fingerprint '<fingerprint>'
```

## Upgrade the kit

For a package kit, an upgrade has four steps:

1. Install the new release with `npm i -g devtwin@alpha`.
2. Run `devtwin kit install`, compare the digest with the GitHub release, then run it again with `--apply`.
3. Pin the new folder with `devtwin live set-kit --pilot "$LIVE_CONFIG" --kit '<version>+<digest>'`, preview then apply. The apply shows the owner dialog "Change the kit devtwin runs", with both kit IDs and the digest to compare.
4. Run one setup batch, `setup plan --all-pending` and then `setup apply --all-pending --apply`, to move the skills, hooks, jobs and confirmed paths to the new folder.

A rollback is `live set-kit` to an earlier folder from `devtwin kit list`, then one batch. An earlier kit must know every agent in the live config. The [upgrade guide](https://github.com/sundharesan11/devtwin/blob/main/docs/UPGRADING.md) has every command, the provenance check, the nvm notes and the move from a Git clone to a package kit.

### Upgrade a Git clone

Upgrade side by side, so the old clone keeps working until the new one is proven.

1. Clone the new reviewed commit next to the old one, for example `~/.devtwin/kit-next`, detached and clean.
2. From the **new** clone, preview and apply the change:

   ```sh
   node ~/.devtwin/kit-next/bin/devtwin.mjs live set-kit --pilot "$LIVE_CONFIG" --commit '<new commit>'
   node ~/.devtwin/kit-next/bin/devtwin.mjs live set-kit --pilot "$LIVE_CONFIG" --commit '<new commit>' --apply --plan-fingerprint '<fingerprint>'
   ```

   The apply also rebuilds the lesson index and session summaries of every scope, so the hook finds your bound projects at once.

3. From now on run every live command from the new clone. Update the skills and the hooks and confirm the new paths with one owner dialog:

   ```sh
   node ~/.devtwin/kit-next/bin/devtwin.mjs setup plan --pilot "$LIVE_CONFIG" --all-pending
   node ~/.devtwin/kit-next/bin/devtwin.mjs setup apply --pilot "$LIVE_CONFIG" --all-pending --apply --plan-fingerprint '<fingerprint>'
   ```

   Or run the steps one at a time: preview `agents install` for each agent (changed skills show `update`), then `agents install --hooks` and `paths confirm`. Each one asks on its own.
4. If you set `DEVTWIN_KIT`, point it at the new clone.
5. If you ran the steps one at a time, run `paths confirm` from the new clone last, preview first. The new kit path ends the old confirmation.

Installed skills stay owned across a kit change. Don't move or rename a clone after `live set-kit`. To go back, run `live set-kit` from the old clone with its commit.

If you installed the hooks, their entries name the kit clone. After a move to another clone, preview `agents install --hooks` again: it shows the changed entries as `update`. Then run `hook verify` to write a new kit receipt, and trust the changed entries in Codex `/hooks`.

## Coming from devctx

If you set up live mode under the old devctx name, move it with [Migrate from devctx](/docs/guides/migrate-from-devctx/) instead of starting again.

## Troubleshooting

| Error | Likely cause |
| --- | --- |
| `GATE_REQUIRED`, field `live.kitRoot`, reason `running-kit` | You ran the command from another kit, not the live config's kit. At the terminal, `devtwin` says why it did not forward on stderr. |
| `GATE_REQUIRED`, field `live.kitCommit`, reason `dirty`, `attached` or `commit` | The kit has changes, is on a branch, or is at another commit. A stray file such as `.DS_Store` under `bin`, `src`, `skills`, `scripts`, `schemas` or `catalog` counts; list them with `git -C "$KIT" ls-files --others --ignored --exclude-standard -- bin src skills scripts schemas catalog`. |
| `GATE_REQUIRED`, field `live.approval` | `live.json` differs from the approved config. Don't edit it by hand. |
| `GATE_REQUIRED`, field `live.home` | `$HOME` differs from the live config's home. |
| `GATE_REQUIRED`, field `writeClasses.backupTargets` or `to` | No backup folder is approved, or the folder you named is not one. Approve it with `live write-classes --backup-target`. |
| `GATE_REQUIRED`, `Live skill folder unavailable` | A skill folder is missing or is a link. See step 1. |
| `GATE_REQUIRED`, reason `no-live-exception`, `scope-required` or `host-not-in-exception` | The stack watch needs the `stackWatch` exception, a `--scope`, and every approved host in the exception. See [Stack watch and radar](/docs/guides/stack-watch/#live-mode). |
| `APPROVAL_REQUIRED` from `stack check` | The config changed after the stack approval, for example by `live set-kit` or `live stack-watch`. Run `stack plan` and `stack approve` again. |
| `PATH_UNSAFE`, field `configDir` | `~/.devtwin` is missing, not yours, or not mode 0700. |
| `BUSY` | A lock is held. If no devtwin command is running, [release the stale lock](/docs/guides/coding-agents/#clear-a-stale-lock). |
| `RECOVERY_REQUIRED` | An earlier install stopped part way. [Recover it](/docs/guides/coding-agents/#recover-an-interrupted-install). |

## If the store is lost

If you have a backup, [restore it](#restore-a-backup) into a new folder and move it into place. Without the store, installed `devtwin-*` entries have no matching journal, become unowned, and devtwin refuses to update or remove them. Remove them by hand: check each entry is a real directory holding only `SKILL.md` and `.devtwin-owned.json`, that the receipt's `kind` is `skill-bundled` and its `configId` is your old one, then move it into a private holding folder. Move the old `live.json` aside too, since `live init` refuses an existing config or a non-empty store, and start again from step 5. The OpenCode plugin file `~/.config/opencode/plugins/devtwin.js` is unowned then too: a hook install reports it as `conflict` until you move it away by hand.

The approved digest catches accidental edits to `live.json`, not deliberate tampering by your own user account. See the [security model](/docs/security/security-model/).
