import test from "node:test";
import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { onboardFixture, fixtureGit, runCli, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { applyOnboard, planOnboard } from "../src/onboarding/onboard.mjs";
import { applyScopeAdd } from "../src/config/store.mjs";
import { resolveContext } from "../src/context/resolve.mjs";
import { buildBrief } from "../src/context/brief.mjs";
import { buildPortableHandoff } from "../src/handoff/portable.mjs";
import { rebuildIndex, readCommonDir } from "../src/lessons/index.mjs";
import { writeKitReceipt } from "../src/hooks/receipt.mjs";
import { writeStub } from "../src/hooks/stub.mjs";
import { hookLogPath } from "../src/hooks/session.mjs";

// K1 (KTD6): context resolve, lesson match and the hooks resolve a linked worktree of a bound repository by one rule
// (matchWorktree in src/lessons/index.mjs). The repository at repos/atlas is bound as acme.atlas.
async function bound(t) {
  const s = await onboardFixture(t);
  await applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now });
  // A real linked worktree, made by git worktree add, outside the pilot's repositories and not onboarded.
  const linked = join(s.sandbox, "work", "atlas-feature");
  await mkdir(join(s.sandbox, "work"));
  await fixtureGit(s.repo, ["worktree", "add", "-q", "-b", "feature", linked]);
  return { ...s, linked: await realpath(linked) };
}
// A second linked worktree at repos/beacon, a pilot repository, onboarded as the given project and scope. name puts
// it at repos/<name>, which the onboarding is given as one more pilot repository.
async function onboardBeacon(s, { scope = "acme", project, name = "beacon" }) {
  const beacon = join(s.reposDir, name);
  await fixtureGit(s.repo, ["worktree", "add", "-q", "-b", name + "-" + scope, beacon]);
  const input = { ...s.input, scope, project, repo: await realpath(beacon), requestId: "req_" + name + scope };
  const pilot = s.pilot.repos.includes(input.repo) ? s.pilot : { ...s.pilot, repos: [...s.pilot.repos, input.repo] };
  const plan = await planOnboard(s.roots, pilot, input);
  await applyOnboard(s.roots, pilot, input, { fingerprint: plan.fingerprint, now });
  return input.repo;
}
// The three resolvers on one folder: context resolve, lesson match --cwd and the hook's session-start line. Each gives
// the project it resolved, or a refusal.
async function resolvers(s, cwd, scope = "acme") {
  const context = await resolveContext(s.roots, { scope, cwd }).then((r) => r.project, (e) => e.details?.reason ?? e.code);
  const match = await runCli(["lesson", "match", "--pilot", s.path, "--scope", scope, "--cwd", cwd]);
  const lesson = match.json.ok ? match.json.result.repo.project : match.json.error.details?.reason ?? match.json.error.code;
  const chunks = [];
  await main(["hook", "--event", "session-start", "--agent", "claude", "--pilot", s.path], { stdout: { write: (v) => { chunks.push(v); return true; } }, stdin: JSON.stringify({ session_id: "s-linked", cwd, hook_event_name: "SessionStart", source: "startup" }), now });
  const line = JSON.parse(chunks.join("")).hookSpecificOutput.additionalContext;
  const hook = /lessons? for ([a-z0-9.-]+)\. Scope: ([a-z0-9-]+)\./.exec(line)?.[1] ?? (line.includes("(ambiguous-worktree)") ? "ambiguous-worktree" : line.includes("more than one scope") ? "ambiguous-scope" : "unbound");
  return { context, lesson, hook };
}
async function withHooks(s) {
  for (const scope of ["acme", "globex"]) await rebuildIndex(s.roots, scope).catch(() => null);
  await writeKitReceipt(s.roots, { pilotPath: s.path, now: now() });
}

test("linked worktree: context resolve gives the bound project with the worktree's own root, branch and head", async (t) => {
  const s = await bound(t);
  const resolved = await resolveContext(s.roots, { scope: "acme", cwd: s.linked });
  assert.equal(resolved.state, "bound");
  assert.equal(resolved.project, "acme.atlas");
  assert.equal(resolved.worktree.root, s.linked);
  assert.equal(resolved.worktree.branch, "feature");
  assert.equal(resolved.worktree.head, (await fixtureGit(s.linked, ["rev-parse", "HEAD"])).trim());
  assert.equal(resolved.worktree.dirty, false);
  assert.equal(resolved.worktree.linked, true);
  // A folder inside the worktree resolves too, relative to the worktree root.
  const sub = join(s.linked, "src");
  await mkdir(sub);
  assert.equal((await resolveContext(s.roots, { scope: "acme", cwd: sub })).cwdRelative, "src");
  // Exact-root precedence: the bound root itself is no linked match.
  const exact = await resolveContext(s.roots, { scope: "acme", cwd: s.repo });
  assert.deepEqual([exact.project, exact.worktree.root, exact.worktree.linked], ["acme.atlas", s.repo, undefined]);
  // The CLI gives the same, with no onboard remedy.
  const cli = await runCli(["context", "resolve", "--pilot", s.path, "--scope", "acme", "--cwd", s.linked]);
  assert.equal(cli.json.result.project, "acme.atlas", JSON.stringify(cli.json));
});

test("linked worktree: cross-scope isolation and an unrelated repository stay not-bound-in-scope", async (t) => {
  const s = await bound(t);
  await applyScopeAdd(s.roots, { scope: "globex", hubs: [], policies: [], now });
  for (const cwd of [s.linked, s.repo]) await assert.rejects(resolveContext(s.roots, { scope: "globex", cwd }), (e) => e.code === "DEVTWIN_PROJECT_UNBOUND" && e.details.reason === "not-bound-in-scope" && e.details.remedy === undefined);
  const other = join(s.sandbox, "other");
  await mkdir(other);
  await fixtureGit(other, ["init", "-q", "-b", "main"]);
  await fixtureGit(other, ["commit", "-q", "--allow-empty", "-m", "other"]);
  await assert.rejects(resolveContext(s.roots, { scope: "acme", cwd: await realpath(other) }), (e) => e.details.reason === "not-bound-in-scope");
});

test("linked worktree: a forged .git file that names the bound repository's Git folder does not resolve", async (t) => {
  const s = await bound(t);
  await withHooks(s);
  const commonDir = await realpath(join(s.repo, ".git"));
  // One forged folder names the common directory itself, one names the real linked worktree's own Git folder.
  const forged = [];
  for (const [name, gitdir] of [["forged-main", commonDir], ["forged-linked", join(commonDir, "worktrees", "atlas-feature")]]) {
    const dir = join(s.sandbox, name);
    await mkdir(dir);
    await writeFile(join(dir, ".git"), "gitdir: " + gitdir + "\n");
    forged.push(await realpath(dir));
  }
  // K1 round 3 (review M1): a folder that holds its own fake gitdir, with a commondir file that names the bound
  // repository's Git folder and a back-link to itself. Git accepts this layout, so only the place of the gitdir (it is
  // not under <commondir>/worktrees) tells it apart from a real linked worktree.
  const crafted = join(s.sandbox, "crafted");
  await mkdir(join(crafted, ".fakegit"), { recursive: true });
  await writeFile(join(crafted, ".git"), "gitdir: .fakegit\n");
  await writeFile(join(crafted, ".fakegit", "commondir"), commonDir + "\n");
  await writeFile(join(crafted, ".fakegit", "gitdir"), join(await realpath(crafted), ".git") + "\n");
  await writeFile(join(crafted, ".fakegit", "HEAD"), "ref: refs/heads/main\n");
  forged.push(await realpath(crafted));
  assert.equal(readCommonDir(s.linked), commonDir, "the real linked worktree proves its common directory");
  for (const dir of forged) {
    assert.equal(readCommonDir(dir), null, dir);
    const result = await resolvers(s, dir);
    assert.ok(result.context !== "acme.atlas" && result.lesson !== "acme.atlas" && result.hook === "unbound", JSON.stringify(result));
  }
});

// K1 round 4: readCommonDir checks the place of the gitdir (directly in <common>/worktrees), its commondir file (the
// same common directory) and its gitdir back-pointer (this folder's .git), each by real path.
test("linked worktree: a path with a space and a relative gitdir resolve; a gitdir in worktrees whose back-pointer names another folder is refused", async (t) => {
  const s = await bound(t);
  await withHooks(s);
  const commonDir = await realpath(join(s.repo, ".git"));
  const ALL = { context: "acme.atlas", lesson: "acme.atlas", hook: "acme.atlas" };
  // A real git worktree add worktree, and one whose path has a space.
  assert.deepEqual(await resolvers(s, s.linked), ALL);
  const spaced = join(s.sandbox, "work", "atlas feature two");
  await fixtureGit(s.repo, ["worktree", "add", "-q", "-b", "spaced", spaced]);
  assert.equal(readCommonDir(await realpath(spaced)), commonDir);
  assert.deepEqual(await resolvers(s, await realpath(spaced)), ALL);
  // Relative paths, as git worktree add --relative-paths writes them: the .git file names the gitdir relative to the
  // worktree, and the back-pointer names the .git file relative to the gitdir. Git still reads the worktree.
  const rel = join(s.sandbox, "work", "atlas-rel");
  await fixtureGit(s.repo, ["worktree", "add", "-q", "-b", "rel", rel]);
  const relRoot = await realpath(rel), admin = (await readFile(join(relRoot, ".git"), "utf8")).replace(/^gitdir: /, "").trim();
  await writeFile(join(relRoot, ".git"), "gitdir: " + relative(relRoot, admin) + "\n");
  await writeFile(join(admin, "gitdir"), relative(admin, join(relRoot, ".git")) + "\n");
  assert.equal((await fixtureGit(relRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), "rel");
  assert.equal(readCommonDir(relRoot), commonDir);
  assert.deepEqual(await resolvers(s, relRoot), ALL);
  // A gitdir placed inside <common>/worktrees with a correct commondir file, whose back-pointer names another folder
  // (the real linked worktree). The crafted folder that points at it is refused by every resolver.
  const fakeAdmin = join(commonDir, "worktrees", "crafted-admin"), crafted = join(s.sandbox, "crafted-in-worktrees");
  await mkdir(fakeAdmin);
  await mkdir(crafted);
  await writeFile(join(fakeAdmin, "commondir"), "../..\n");
  await writeFile(join(fakeAdmin, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(fakeAdmin, "gitdir"), join(s.linked, ".git") + "\n");
  await writeFile(join(crafted, ".git"), "gitdir: " + fakeAdmin + "\n");
  const craftedRoot = await realpath(crafted);
  assert.equal(readCommonDir(craftedRoot), null);
  const refused = await resolvers(s, craftedRoot);
  assert.ok(refused.context !== "acme.atlas" && refused.lesson !== "acme.atlas" && refused.hook === "unbound", JSON.stringify(refused));
  // A commondir file that names another directory than the one the gitdir sits in is refused too.
  await writeFile(join(fakeAdmin, "gitdir"), join(craftedRoot, ".git") + "\n");
  await writeFile(join(fakeAdmin, "commondir"), relative(fakeAdmin, s.sandbox) + "\n");
  assert.equal(readCommonDir(craftedRoot), null);
  // The control: with all three checks met, the folder is a linked worktree. Only a write inside the bound
  // repository's own .git can make one, and such a write already controls that repository.
  await writeFile(join(fakeAdmin, "commondir"), "../..\n");
  assert.equal(readCommonDir(craftedRoot), commonDir);
});

// K1 round 4 (review m2): a .git file whose gitdir has no commondir file (a --separate-git-dir checkout or a
// submodule) is no linked worktree, but the stop stub still reads its own gitdir's config, as before K1.
test("linked worktree: a separate-git-dir checkout is no linked worktree and still gets its stop stub", async (t) => {
  const s = await bound(t);
  const work = join(s.sandbox, "separate"), store = join(s.sandbox, "separate-store.git");
  await mkdir(work);
  await fixtureGit(work, ["init", "-q", "-b", "main", "--separate-git-dir", store]);
  await fixtureGit(work, ["commit", "-q", "--allow-empty", "-m", "first"]);
  const root = await realpath(work);
  assert.equal(readCommonDir(root), null);
  const stub = await writeStub(s.stateRoot, { scope: "acme", project: "acme.atlas", root }, { key: "s-separate", now: now() });
  assert.ok(stub && stub.branch === "main", JSON.stringify(stub));
  // A risky config in that gitdir still blocks the stub.
  await writeFile(join(store, "config"), (await readFile(join(store, "config"), "utf8")) + "[filter \"x\"]\n\tclean = cat\n");
  assert.equal(await writeStub(s.stateRoot, { scope: "acme", project: "acme.atlas", root }, { key: "s-separate", now: now() }), null);
});

test("linked worktree: the hooks, lesson match and context resolve agree on the same fixtures", async (t) => {
  const s = await bound(t);
  await withHooks(s);
  assert.deepEqual(await resolvers(s, s.repo), { context: "acme.atlas", lesson: "acme.atlas", hook: "acme.atlas" });
  assert.deepEqual(await resolvers(s, s.linked), { context: "acme.atlas", lesson: "acme.atlas", hook: "acme.atlas" });
  const other = join(s.sandbox, "other");
  await mkdir(other);
  await fixtureGit(other, ["init", "-q", "-b", "main"]);
  await fixtureGit(other, ["commit", "-q", "--allow-empty", "-m", "other"]);
  assert.deepEqual(await resolvers(s, await realpath(other)), { context: "not-bound-in-scope", lesson: "not-bound-in-scope", hook: "unbound" });
});

test("linked worktree: a main entry and linked entries of one project resolve; two projects on one common dir are ambiguous", async (t) => {
  const one = await bound(t);
  // repos/beacon is a second linked worktree, onboarded into the same project: one project, two entries.
  const beacon = await onboardBeacon(one, { project: "acme.atlas" });
  await withHooks(one);
  assert.deepEqual(await resolvers(one, one.linked), { context: "acme.atlas", lesson: "acme.atlas", hook: "acme.atlas" });
  assert.equal((await resolveContext(one.roots, { scope: "acme", cwd: beacon })).worktree.linked, undefined, "an onboarded linked root matches exactly");
  // A second project in the same scope on the same common directory: the unbound worktree is ambiguous, every bound
  // root still resolves exactly.
  const two = await bound(t);
  const other = await onboardBeacon(two, { project: "acme.beacon" });
  await withHooks(two);
  // K1 round 5: the hook refuses with the same reason as context resolve and lesson match.
  assert.deepEqual(await resolvers(two, two.linked), { context: "ambiguous-worktree", lesson: "ambiguous-worktree", hook: "ambiguous-worktree" });
  assert.equal((await resolveContext(two.roots, { scope: "acme", cwd: two.repo })).project, "acme.atlas");
  assert.equal((await resolveContext(two.roots, { scope: "acme", cwd: other })).project, "acme.beacon");
});

test("linked worktree: a common dir bound in two scopes resolves per requested scope, and the hooks turn lessons off", async (t) => {
  const s = await bound(t);
  await applyScopeAdd(s.roots, { scope: "globex", hubs: [], policies: [], now });
  await onboardBeacon(s, { scope: "globex", project: "globex.beacon" });
  await withHooks(s);
  // context resolve and lesson match read only the requested scope; the hook has no scope and fails closed.
  assert.deepEqual(await resolvers(s, s.linked, "acme"), { context: "acme.atlas", lesson: "acme.atlas", hook: "ambiguous-worktree" });
  assert.deepEqual(await resolvers(s, s.linked, "globex"), { context: "globex.beacon", lesson: "globex.beacon", hook: "ambiguous-worktree" });
});

// K1 round 5 (Codex final review, major 1): an ambiguous scope must not drop out of the hook's lookup. Scope acme has
// two projects on one Git common directory and scope globex has one project on the same directory. Before, the hook
// skipped acme as "no match" and gave the linked worktree globex's lessons.
test("linked worktree: same-scope ambiguity plus a second matching scope is refused by every resolver; an exact bound root still wins", async (t) => {
  const s = await bound(t);
  const beacon = await onboardBeacon(s, { project: "acme.beacon" });
  await withHooks(s);
  // Same-scope ambiguity alone: the linked worktree is refused with one reason, and each bound root resolves exactly.
  const REFUSED = { context: "ambiguous-worktree", lesson: "ambiguous-worktree", hook: "ambiguous-worktree" };
  assert.deepEqual(await resolvers(s, s.linked), REFUSED);
  assert.deepEqual(await resolvers(s, s.repo), { context: "acme.atlas", lesson: "acme.atlas", hook: "acme.atlas" });
  assert.deepEqual(await resolvers(s, beacon), { context: "acme.beacon", lesson: "acme.beacon", hook: "acme.beacon" });
  // A second scope with one project on the same common directory.
  await applyScopeAdd(s.roots, { scope: "globex", hubs: [], policies: [], now });
  await onboardBeacon(s, { scope: "globex", project: "globex.comet", name: "comet" });
  await withHooks(s);
  assert.deepEqual(await resolvers(s, s.linked, "acme"), REFUSED);
  // The requested scope globex names one project, so context resolve and lesson match give it; the hook, which has no
  // scope, still refuses.
  assert.deepEqual(await resolvers(s, s.linked, "globex"), { context: "globex.comet", lesson: "globex.comet", hook: "ambiguous-worktree" });
  // An exact bound root of acme still resolves in acme; the hook refuses it, because globex matches it too.
  assert.deepEqual(await resolvers(s, s.repo, "acme"), { context: "acme.atlas", lesson: "acme.atlas", hook: "ambiguous-worktree" });
  // The hook logs the reason.
  const log = (await readFile(hookLogPath(s.stateRoot), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.code === "ambiguous-worktree"), JSON.stringify(log));
});

test("linked worktree: the brief checks source freshness in the selected worktree, and portable export stays fenced", async (t) => {
  const s = await bound(t);
  await writeFile(join(s.linked, "README.md"), "# Atlas\nChanged in the linked worktree.\n");
  const fromMain = await buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.repo });
  const fromLinked = await buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.linked });
  const readme = (brief) => brief.records.filter((r) => r.sources.some((x) => x.ref === "file:README.md")).map((r) => r.freshness);
  assert.ok(readme(fromMain).length > 0, "an onboarding record cites README.md");
  assert.ok(readme(fromMain).every((f) => f !== "needs-revalidation"), JSON.stringify(readme(fromMain)));
  assert.ok(readme(fromLinked).includes("needs-revalidation"), JSON.stringify(readme(fromLinked)));
  // Portable export still refuses a working directory outside the pilot's repositories.
  const recordIds = [fromMain.records[0].id];
  await assert.rejects(buildPortableHandoff(s.roots, s.pilot, { scope: "acme", cwd: s.linked, recordIds, asOf: now().toISOString() }), (e) => e.code === "DEVTWIN_GATE_REQUIRED" || e.code === "DEVTWIN_HANDOFF_EXPORT_REFUSED");
});
