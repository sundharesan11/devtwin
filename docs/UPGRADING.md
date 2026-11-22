# Upgrading and rollback

This guide moves live mode to a new devtwin release, and back to an earlier one. It also moves a Git-clone setup to a package kit. Read [Live activation](LIVE.md) first: this guide uses its placeholders and its owner dialogs.

devtwin is an alpha. A new release goes to the `alpha` dist-tag on npm first, and `latest` follows when the owner moves it. To upgrade to the newest release, install `devtwin@alpha` or an exact version.

## How an upgrade works

Live mode never runs code from npm's global folder. Hooks, jobs and agent-invoked skills run a pinned copy of the kit under `~/.devtwin/kits/`. A new `npm i -g` changes only the global `devtwin` command. Nothing in live mode changes until you pin the new kit.

An upgrade has four steps:

1. Install the new release with npm.
2. Copy it into a kit folder with `devtwin kit install`.
3. Pin that folder with `devtwin live set-kit`, behind an owner dialog.
4. Move the skills, hooks, jobs and confirmed paths to the new folder with one setup batch.

The old kit folder stays on disk. A rollback pins it again and runs one more batch.

Set the live config path in the shell you use:

```sh
LIVE_CONFIG="$HOME/.devtwin/live.json"
```

## Upgrade to a new release

1. Install the new release:

   ```sh
   npm i -g devtwin@alpha
   devtwin --version
   ```

2. Check the package signatures and provenance. `npm audit signatures` does not check global packages, so install the same version into an empty temporary folder and check it there:

   ```sh
   CHECK="$(mktemp -d)"
   npm install --prefix "$CHECK" devtwin@<version>
   npm audit signatures --prefix "$CHECK"
   ```

   Expect a verified registry signature and a verified attestation for `devtwin`. Remove the temporary folder after the check.

3. Preview the kit install. The plan writes nothing:

   ```sh
   devtwin kit install
   ```

4. Compare the `digest` in the plan with the kit digest in the [GitHub release](https://github.com/sundharesan11/devtwin/releases) for that version. If they differ, stop. The installed package is not the published one.

5. Copy the kit into its folder:

   ```sh
   devtwin kit install --apply
   ```

   The result gives the new `kitRoot` and the next command, `devtwin live set-kit --kit <version>+<digest>`.

6. Preview the kit change. The global command runs it in the new kit folder:

   ```sh
   devtwin live set-kit --pilot "$LIVE_CONFIG" --kit '<version>+<digest>'
   ```

7. Apply the previewed fingerprint in your own terminal:

   ```sh
   devtwin live set-kit --pilot "$LIVE_CONFIG" --kit '<version>+<digest>' --apply --plan-fingerprint '<fingerprint>'
   ```

   The owner dialog "Change the kit devtwin runs" names the old and new kit IDs and folders. It shows the digest again. Compare it with the release before you approve.

8. Preview the setup batch. It lists the skills, hook entries, job files and paths confirmation that still name the old kit. For OpenCode, it lists the plugin file:

   ```sh
   devtwin setup plan --pilot "$LIVE_CONFIG" --all-pending
   ```

9. Apply the batch in your own terminal. One owner dialog covers every line:

   ```sh
   devtwin setup apply --pilot "$LIVE_CONFIG" --all-pending --apply --plan-fingerprint '<fingerprint>'
   ```

10. Check the result:

    ```sh
    devtwin kit list
    devtwin agents status --pilot "$LIVE_CONFIG"
    devtwin schedule status --pilot "$LIVE_CONFIG"
    devtwin paths check --pilot "$LIVE_CONFIG"
    ```

    `kit list` marks the new folder as pinned. Each job shows `current`, each hook entry shows `installed` and `paths check` reports `match`.

11. If you set `DEVTWIN_KIT` in your shell profile, change it to the new `kitRoot`, with the owner's approval.

12. In Codex, run `/hooks` and trust each changed devtwin entry. Antigravity CLI and OpenCode have no such step.

The devtwin hook denies `kit install --apply`, `live set-kit --apply` and `setup apply --all-pending` from an agent shell. An agent can show you the previews, but you run each apply.

Until the batch runs, the hook lines and job files still name the old kit. The live config no longer pins that kit, so the kit gate refuses their live commands. `schedule status` shows those jobs as `outdated`. The OpenCode plugin file names the old kit too, and `agents status` shows it as `outdated`.

## Add an agent after an upgrade

A release can add support for an agent, such as Antigravity CLI or OpenCode. The upgrade does not add that agent to your live config. `setup status` shows its skills and hooks steps as skipped, with the reason "agent not in the live config". Read [Roll back after you add an agent](#roll-back-after-you-add-an-agent) first. Then add the agent after step 10 of the upgrade:

1. Preview the change:

   ```sh
   devtwin live add-agent --pilot "$LIVE_CONFIG" --agent antigravity
   ```

2. Apply the previewed fingerprint in your own terminal:

   ```sh
   devtwin live add-agent --pilot "$LIVE_CONFIG" --agent antigravity --apply --plan-fingerprint '<fingerprint>'
   ```

   The owner dialog "Add an agent to the live config" names the agent and its skills folder.

3. Run one more setup batch, as in steps 8 and 9 of the upgrade. It approves the agent's hook file and installs its skills and hooks.

4. Preview the instruction block:

   ```sh
   devtwin instructions plan --pilot "$LIVE_CONFIG"
   ```

   The plan shows the agent's instruction file as `blocked` when that file is not an approved instruction target. For Antigravity CLI the file is `~/.gemini/GEMINI.md`. For OpenCode it is `~/.config/opencode/devtwin.md`. Approve it with `live write-classes --instruction-target`, preview first. Give every instruction target that is already approved again, because the flag replaces the class. Then preview the instruction block again.

5. Apply it in your own terminal:

   ```sh
   devtwin instructions apply --pilot "$LIVE_CONFIG" --plan-fingerprint '<fingerprint>'
   ```

`live add-agent` runs in the pinned kit. A kit from before the route answers with "Unknown command", so pin the new kit first, as step 7 of the upgrade shows. Each apply here is an owner action, and the devtwin hook denies it from an agent shell. [Add an agent to a live config](LIVE.md#add-an-agent-to-a-live-config) has the details.

### Add OpenCode after an upgrade

OpenCode has two more steps: you create its plugins folder first, and you approve its instruction file before the setup batch. [Add OpenCode](LIVE.md#add-opencode) has the details.

1. Create the plugins folder with `mkdir -p ~/.config/opencode/plugins`. devtwin never creates an agent folder.
2. Preview and apply `live add-agent` with `--agent opencode`, as in steps 1 and 2 of the list above.
3. Approve `~/.config/opencode/devtwin.md` with `live write-classes --instruction-target`, preview first. Give every instruction target that you approved before again.
4. Run one setup batch, as in step 3 of the list above. Its dialog has the lines `Approve plugin file ...` and `Install the devtwin plugin file ...`.
5. Preview and apply the instruction block, as in steps 4 and 5 of the list above.

Without the plugins folder, the batch leaves the `hooks-opencode` step out, and its reason names `agent-folder-missing`. Without `~/.config/opencode`, the instruction plan shows `conflict` with the same reason.

## Roll back

A rollback pins an earlier kit folder again. `kit install` never deletes a folder, so each earlier release stays in `~/.devtwin/kits/`.

Once the live config names a package kit, a kit from before 0.1.0-alpha.1 cannot load it: those kits do not know the `kitVersion` and `kitDigest` fields. A rollback therefore goes to a kit from 0.1.0-alpha.1 or later.

1. List the kit folders and find the earlier one:

   ```sh
   devtwin kit list
   ```

   Each row gives the `kitId`, `npm:<version>+sha256:<digest>`. Use only a row with the status `ok`.

2. Preview the kit change with that version and digest:

   ```sh
   devtwin live set-kit --pilot "$LIVE_CONFIG" --kit '<earlier version>+<earlier digest>'
   ```

3. Apply it in your own terminal, and approve the owner dialog:

   ```sh
   devtwin live set-kit --pilot "$LIVE_CONFIG" --kit '<earlier version>+<earlier digest>' --apply --plan-fingerprint '<fingerprint>'
   ```

4. Run one setup batch, preview then apply, as in steps 8 and 9 of the upgrade.

5. Run the checks in step 10 of the upgrade.

The global command can be newer than the pinned kit. That is safe: it forwards live commands to the pinned kit. To make `devtwin --version` match, install the earlier version with `npm i -g devtwin@<earlier version>`.

A kit folder that shows `bad` in `kit list` failed its digest or mode check. Do not pin it. devtwin never deletes a kit folder. The folders are read-only, so give the owner write bit back with `chmod -R u+w` before you remove one by hand. Remove a folder only when nothing points at it.

### Roll back after you add an agent

A kit works only with the agents it knows. A kit from before Antigravity CLI support refuses a live config that names `antigravity`. The error is `GATE_REQUIRED` with the field `live.skillDirs.antigravity`. The `live set-kit` preview in step 2 then stops, and the newer kit stays pinned. The same holds for `opencode` and a kit from before OpenCode support, with the field `live.skillDirs.opencode`.

No command removes an agent from a live config. After `live add-agent`, roll back only to a kit that knows the agent. Add an agent only when you plan to keep a release that supports it.

To stop devtwin for the agent, uninstall its hooks and its skills. Run each command as a preview first, then apply its fingerprint in your own terminal:

```sh
devtwin agents uninstall --hooks --pilot "$LIVE_CONFIG" --agent antigravity
devtwin agents uninstall --pilot "$LIVE_CONFIG" --agent antigravity
```

Uninstall with a kit that knows the agent, before any move to another kit. An earlier kit refuses the agent's name, so it cannot remove those entries. It also treats a hook journal that names the agent as an incomplete run. The live config still names the agent after the uninstall. `setup status` then shows the steps `skills-antigravity` and `hooks-antigravity` as pending again. A setup batch with `--all-pending` installs them again. To keep them out, run the batch with `--steps` and name only the steps that you want.

For OpenCode, use `--agent opencode` in both commands, and mind these points:

- The hook uninstall removes the plugin file `~/.config/opencode/plugins/devtwin.js`. It removes the file only when devtwin wrote it and you did not change it. For any other file it reports `conflict`, and you delete or move the file by hand.
- The skills uninstall keeps the skills in `~/.agents/skills` while Codex or Gemini CLI is in the live config. Each skill shows `preserve` with the reason `shared-folder`.
- To take the instruction block out, preview `instructions plan --remove --agent opencode` and apply it with `instructions apply --remove --agent opencode` in your own terminal. The block leaves `~/.config/opencode/devtwin.md`, and the file stays.
- After the uninstall, the step `hooks-opencode` is pending again. The step `skills-opencode` stays done while the shared folder holds the skills.

## Move from a Git clone to a package kit

A setup made from a clone at `~/.devtwin/kit` moves to a package kit with the same steps as an upgrade:

1. Install the release with `npm i -g devtwin@alpha`.
2. Run steps 2 to 9 of the upgrade.
3. Run the checks in step 10.

The dialog shows the move from `git:<commit>` to `npm:<version>+sha256:<digest>`. The batch rewrites every hook line and job file, because they name the kit folder. It rewrites the OpenCode plugin file for the same reason.

The clone stays on disk. To go back, run `live set-kit` from the clone with its commit, preview then apply:

```sh
node ~/.devtwin/kit/bin/devtwin.mjs live set-kit --pilot "$LIVE_CONFIG" --commit '<commit>'
```

The clone must still be clean and detached at that commit, and the commit must be from 0.1.0-alpha.1 or later. Then run one setup batch.

`live set-kit --commit` and `live migrate` run in the kit you start them from. The global command does not forward them to the pinned kit, so start them with the clone's own `bin/devtwin.mjs`.

## Node versions and nvm

The pinned kit decides which devtwin code runs. The Node interpreter is a separate matter:

- **Hooks** run `node` from the agent's `PATH`. Under nvm, the hook uses the Node version that is active in the shell that started the agent.
- **The OpenCode plugin file** runs `node` from the `PATH` too. For a `PATH` with no `node`, it holds a fixed Node path, the one that the job files use. When that path changes, `agents status` shows the file as `outdated`. Run the hooks install again, or one setup batch.
- **Jobs** run a fixed Node path, which the setup batch writes into each job file. A Homebrew Node uses its stable link, so `brew upgrade` does not break the jobs.
- **The global `devtwin` command** lives in the global folder of the active Node version. After `nvm use` to another version, `devtwin` can be missing or older. Install it again for that version with `npm i -g devtwin@alpha`.

A Node switch does not change the kit code: hooks, jobs and skills still run the pinned folder. Each Node version must meet the floor, Node 22.13.0 or later.

If you remove the Node version that the job files name, the jobs fail. Run one setup batch from a shell with the Node version you want. `schedule status` shows each job that names another Node path as `outdated`, and the batch rewrites it.

## See also

- [Live activation](LIVE.md): the first activation, the set-kit dialog and how the global command forwards.
- [Release checklist](RELEASING.md): how a release is built, and where the kit digest comes from.
- [Changelog](../CHANGELOG.md): what changed in each release.
