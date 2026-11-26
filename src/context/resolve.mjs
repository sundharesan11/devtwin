import { realpathSync } from "node:fs";
import { resolve, relative } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { locateWorktree } from "../identity/git.mjs";
import { readRegistry } from "../config/registry.mjs";
import { requireCommittedProject } from "../records/store.mjs";
import { matchWorktree, readCommonDir } from "../lessons/index.mjs";
// K1 (KTD6): the worktree for cwd resolves by the rule that the hooks and lesson match use (matchWorktree in
// src/lessons/index.mjs). An exact bound root of the requested scope comes first. Otherwise a worktree whose Git common
// directory matches the bound roots of exactly one project in that scope resolves to that project, as a linked
// worktree (worktree.linked). The common directory counts only when the .git entry proves it without Git
// (readCommonDir): a folder with a forged .git file or its own fake gitdir never resolves. Only the requested
// scope's roots count, as for lesson match; the hooks, which have no scope, turn lessons off when roots of two scopes
// match or when any one scope is ambiguous. Nothing here widens what the hooks already read.
const unbound = (reason) => new DevtwinError("PROJECT_UNBOUND", "Worktree not bound in selected scope", { reason });
export async function resolveContext(roots, { scope, cwd }) {
  let canonical;
  try { canonical = realpathSync(cwd); } catch { throw new DevtwinError("PATH_UNSAFE", "Working directory unavailable"); }
  if (canonical !== resolve(cwd)) throw new DevtwinError("PATH_UNSAFE", "Working directory must be canonical");
  const location = await locateWorktree(canonical);
  if (!location.git) throw unbound("not-bound-in-scope");
  const registry = (await readRegistry(roots)).value;
  const entries = registry.bindings.filter((x) => x.scope === scope).map((x) => ({ ...x, root: x.path }));
  const commonDir = readCommonDir(location.root) === location.commonDir ? location.commonDir : null;
  const match = matchWorktree(entries, { root: location.root, commonDir });
  if (match.status === "ambiguous") throw unbound("ambiguous-worktree");
  if (match.status === "none") throw unbound("not-bound-in-scope");
  const linked = match.status === "common-dir";
  const { binding } = await requireCommittedProject(roots, scope, match.entry.project);
  if (!binding.roots.some((r) => linked ? r.commonDir === commonDir : r.path === location.root)) throw new DevtwinError("RECOVERY_REQUIRED", "Binding root mismatch");
  const worktree = { root: location.root, branch: location.branch, head: location.head, dirty: location.dirty, ...(linked ? { linked: true } : {}) };
  return { state: "bound", scope, project: match.entry.project, binding, worktree, cwdRelative: relative(location.root, canonical), warnings: location.warnings };
}
