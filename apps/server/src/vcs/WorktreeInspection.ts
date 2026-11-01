import { GitCommandError, type WorktreeCleanupRules } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isNetworkPath } from "@t3tools/shared/path";
import { parse as parseYaml } from "yaml";
import * as CodespacesWorkspace from "../codespaces/CodespacesWorkspace.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

class WorktreeInspection extends Context.Service<
  WorktreeInspection,
  {
    readonly metadata: (
      cwd: string,
    ) => Effect.Effect<
      { readonly path: string; readonly type: string; readonly modifiedAt: string | null } | null,
      GitCommandError
    >;
    readonly readDirectory: (cwd: string) => Effect.Effect<ReadonlyArray<string>, GitCommandError>;
    readonly managedDirectory: (
      cwd: string,
    ) => Effect.Effect<{ readonly path: string }, GitCommandError>;
    readonly measure: (cwd: string) => Effect.Effect<number | null, GitCommandError>;
    readonly branchChanged: (
      cwd: string,
      branch: string | null,
    ) => Effect.Effect<boolean, GitCommandError>;
    readonly localChangesReason: (
      cwd: string,
      rules: WorktreeCleanupRules,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly submoduleRemoval: (
      cwd: string,
      rules: WorktreeCleanupRules,
    ) => Effect.Effect<
      { readonly force: boolean; readonly reason: string | null },
      GitCommandError
    >;
  }
>()("t3/vcs/WorktreeInspection") {}

// pnpm 11 writes this file as JSON, older versions as YAML.
const decodePnpmModulesManifest = Schema.decodeUnknownEffect(
  Schema.Struct({
    storeDir: Schema.String,
    virtualStoreDir: Schema.optional(Schema.String),
  }),
);

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const workspace = Option.getOrUndefined(
    yield* Effect.serviceOption(CodespacesWorkspace.CodespacesWorkspace),
  );
  const isWindows = yield* HostProcess.isWindows;
  const pathKey = (target: string) => {
    const resolved = path.resolve(target);
    return isWindows ? resolved.toLowerCase() : resolved;
  };
  const inside = (root: string, target: string) => {
    const relative = path.relative(pathKey(root), pathKey(target));
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const failure = (cause: unknown, operation: string, cwd: string) =>
    new GitCommandError({
      operation,
      cwd,
      command: "worktree inspection",
      detail: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  const guard = <A, E>(operation: string, cwd: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError((cause) => failure(cause, operation, cwd)));
  // pnpm imports packages by clone or reflink when its store shares a device
  // with the worktree. Those files have one link but share blocks with the
  // store, so removing them frees almost nothing. A store on another device
  // forces real copies, which still count.
  const sharedPnpmVirtualStore = Effect.fnUntraced(
    function* (root: string) {
      const nodeModules = path.join(root, "node_modules");
      const text = yield* fs.readFileString(path.join(nodeModules, ".modules.yaml"));
      const manifest = yield* decodePnpmModulesManifest(yield* Effect.try(() => parseYaml(text)));
      // An agent can write this manifest, and statting a network path makes
      // Windows sign in to its host with the user's NTLM credentials.
      if (isNetworkPath(manifest.storeDir) || isNetworkPath(manifest.virtualStoreDir ?? "")) {
        return null;
      }
      const virtualStore = path.resolve(nodeModules, manifest.virtualStoreDir ?? ".pnpm");
      const [store, virtual] = yield* Effect.all([
        fs.stat(manifest.storeDir),
        fs.stat(virtualStore),
      ]);
      return store.dev === virtual.dev ? virtualStore : null;
    },
    Effect.orElseSucceed(() => null),
  );

  const measureWorktree = Effect.fn("storageCleanup.measureWorktree")(
    function* (worktreePath: string) {
      const root = yield* fs.realPath(worktreePath);
      const skipped = yield* sharedPnpmVirtualStore(root);
      const pending = [root];
      let entries = 1;
      let bytes = 0;
      while (pending.length > 0) {
        const target = pending.pop()!;
        if (target === skipped) continue;
        // Effect's stat follows links. Probe with readLink first to get lstat
        // semantics, including skipping dangling links and directory links.
        const isLink = yield* fs.readLink(target).pipe(
          Effect.as(true),
          Effect.catchIf(
            (error) =>
              error.cause instanceof Error &&
              "code" in error.cause &&
              error.cause.code === "EINVAL",
            () => Effect.succeed(false),
          ),
        );
        if (isLink) continue;
        if ((yield* fs.realPath(target)) !== target) return null;
        const stat = yield* fs.stat(target);
        if (stat.type === "File") {
          // Removing a shared hardlink leaves its blocks allocated.
          if (Option.getOrElse(stat.nlink, () => 1n) !== 1n) continue;
          bytes += Option.match(stat.blocks, {
            onNone: () => Number(stat.size),
            onSome: (blocks) => Number(blocks * 512n),
          });
        } else if (stat.type === "Directory") {
          const names = yield* fs.readDirectory(target);
          entries += names.length;
          if (entries > 2_000_000) return null;
          for (const name of names) {
            const child = path.join(target, name);
            if (!inside(root, child)) return null;
            pending.push(child);
          }
        }
      }
      return bytes;
    },
    Effect.timeout("30 seconds"),
    Effect.orElseSucceed(() => null),
  );

  // Use two small Git reads: statusDetailsLocal also diffs and counts for every worktree.
  const branchChanged = Effect.fn("StorageCleanup.branchChanged")(function* (
    cwd: string,
    branch: string | null,
  ) {
    const failure = (detail: string) =>
      new GitCommandError({
        operation: "StorageCleanup.branchChanged",
        command: "git",
        cwd,
        detail,
      });
    // Return null for missing/non-repository cwd; force untranslated git diagnostics for matching.
    const read = Effect.fnUntraced(function* (args: string[], allowedExitCode?: number) {
      const result = yield* git
        .execute({
          operation: "StorageCleanup.branchChanged",
          cwd,
          args,
          env: { LC_ALL: "C" },
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.flatMap(fs.exists(cwd), (exists) =>
              exists ? Effect.fail(error) : Effect.succeed(null),
            ),
          ),
        );
      if (result === null) return null;
      if (result.exitCode === 0 || result.exitCode === allowedExitCode) return result;
      if (result.stderr.toLowerCase().includes("not a git repository")) return null;
      return yield* failure(
        result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 1000) || "command failed",
      );
    });
    const index = yield* read(["rev-parse", "--git-path", "index"]);
    if (index === null) return true;
    if (yield* fs.exists(`${path.resolve(cwd, index.stdout.trim())}.lock`))
      return yield* failure(
        "Git index is locked. Status will resume when the index lock is removed.",
      );
    // Detached HEAD exits 1; full refs avoid shortening when a tag shares the branch name.
    const head = yield* read(["symbolic-ref", "--quiet", "HEAD"], 1);
    if (head === null) return true;
    const ref = head.exitCode === 0 ? head.stdout.trim() : "";
    const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length).trim() : null;
    return (name?.startsWith("(") ? null : name) !== branch;
  });

  const localChangesReason = Effect.fn("StorageCleanup.localChangesReason")(function* (
    cwd: string,
    rules: WorktreeCleanupRules,
  ) {
    const status = yield* git.execute({
      operation: "StorageCleanup.localChanges",
      cwd,
      args: [
        "status",
        "--porcelain=v1",
        "-z",
        "--ignore-submodules=none",
        rules.worktreeKeepWhen === "tracked-changes"
          ? "--untracked-files=no"
          : "--untracked-files=all",
      ],
      maxOutputBytes: 64 * 1024,
    });
    if (status.stdoutTruncated) return "local changes exceed the inspection limit";
    const records = status.stdout.split("\0").filter(Boolean);
    let count = 0;
    for (let i = 0; i < records.length; i++) {
      count++;
      if (/^[RC]|^.[RC]/.test(records[i]!)) i++;
    }
    if (count > 0) return `has uncommitted changes (${count} ${count === 1 ? "file" : "files"})`;
    if (rules.worktreeKeepWhen !== "any-local-files") return null;
    const ignored = yield* git.execute({
      operation: "StorageCleanup.ignoredFiles",
      cwd,
      args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      maxOutputBytes: 64 * 1024,
    });
    if (ignored.stdoutTruncated) return "ignored files exceed the inspection limit";
    const file = ignored.stdout
      .split("\0")
      .find((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry));
    return file === undefined ? null : `has ignored files (${file})`;
  });

  const submoduleRemoval = Effect.fn("StorageCleanup.submoduleRemoval")(
    function* (cwd: string, rules: WorktreeCleanupRules) {
      const inspect = (args: string[], maxOutputBytes = 64 * 1024) =>
        git.execute({
          operation: "StorageCleanup.submodules",
          cwd,
          args,
          maxOutputBytes,
        });
      const admin = yield* inspect(["rev-parse", "--absolute-git-dir"]);
      if (admin.stdoutTruncated || admin.stderrTruncated)
        return { force: false, reason: "submodule inspection exceeded the limit" };
      const modules = path.join(admin.stdout.replace(/\n$/, ""), "modules");
      const stored = yield* fs.exists(modules);
      if (!stored && !(yield* fs.exists(path.join(cwd, ".gitmodules"))))
        return { force: false, reason: null };
      const populated = yield* inspect([
        "submodule",
        "foreach",
        "--recursive",
        "--quiet",
        'printf "%s\\0" "$toplevel/$sm_path"',
      ]);
      if (populated.stdoutTruncated || populated.stderrTruncated)
        return { force: false, reason: "submodule inspection exceeded the limit" };
      const paths = populated.stdout.split("\0").filter(Boolean);
      const pending = [modules];
      for (const submodule of paths) {
        const directory = yield* inspect(["-C", submodule, "rev-parse", "--absolute-git-dir"]);
        if (directory.stdoutTruncated || directory.stderrTruncated)
          return { force: false, reason: "submodule inspection exceeded the limit" };
        pending.push(directory.stdout.replace(/\n$/, ""));
      }
      const visited = new Set<string>();
      while (pending.length > 0) {
        const directory = pending.pop()!;
        if (!(yield* fs.exists(directory))) continue;
        const canonical = yield* fs.realPath(directory);
        if (visited.has(canonical)) continue;
        visited.add(canonical);
        if (visited.size > 10_000)
          return { force: false, reason: "submodule inspection exceeded the limit" };
        if ((yield* fs.stat(directory)).type !== "Directory")
          return { force: false, reason: "submodule repository could not be inspected" };
        if (yield* fs.exists(path.join(directory, "HEAD"))) {
          const unpushed = yield* inspect([
            "--git-dir",
            directory,
            "--work-tree",
            cwd,
            "rev-list",
            "--max-count=1",
            "HEAD",
            "--all",
            "--reflog",
            "--not",
            "--remotes",
          ]);
          if (unpushed.stdoutTruncated || unpushed.stderrTruncated)
            return { force: false, reason: "submodule inspection exceeded the limit" };
          if (unpushed.stdout.trim() !== "")
            return { force: false, reason: "submodule has commits not on a remote-tracking ref" };
          pending.push(path.join(directory, "modules"));
        } else {
          for (const name of yield* fs.readDirectory(directory))
            pending.push(path.join(directory, name));
        }
      }
      // Check files after walking stored history to shorten the gap before forced removal.
      for (const submodule of paths) {
        const changes = yield* localChangesReason(submodule, rules);
        if (changes !== null) return { force: false, reason: `submodule ${changes}` };
      }
      const force = stored || paths.length > 0;
      if (force && rules.worktreeKeepWhen !== "tracked-changes") {
        const root = yield* fs.realPath(cwd);
        // Git status and foreach omit files inside deinitialized gitlink directories.
        const populatedPaths = new Set(paths.map(pathKey));
        const unchecked: string[] = [];
        for (const repository of [root, ...paths]) {
          const index = yield* inspect(
            ["-C", repository, "ls-files", "--stage", "-z"],
            16 * 1024 * 1024,
          );
          if (index.stdoutTruncated || index.stderrTruncated)
            return { force: false, reason: "submodule inspection exceeded the limit" };
          for (const entry of index.stdout.split("\0")) {
            if (!entry.startsWith("160000 ")) continue;
            const submodule = path.resolve(repository, entry.slice(entry.indexOf("\t") + 1));
            if (!inside(root, submodule))
              return { force: false, reason: "submodules could not be inspected" };
            if (!populatedPaths.has(pathKey(submodule)) && (yield* fs.exists(submodule)))
              unchecked.push(submodule);
          }
        }
        let inspected = unchecked.length;
        while (unchecked.length > 0) {
          if (inspected > 10_000)
            return { force: false, reason: "submodule inspection exceeded the limit" };
          const target = unchecked.pop()!;
          if (
            (yield* fs.realPath(target)) !== path.resolve(target) ||
            (yield* fs.stat(target)).type !== "Directory"
          )
            return { force: false, reason: "submodule has local files" };
          if (path.basename(target) === "node_modules") continue;
          const names = yield* fs.readDirectory(target);
          inspected += names.length;
          for (const name of names) unchecked.push(path.join(target, name));
        }
      }
      return { force, reason: null };
    },
    Effect.orElseSucceed(() => ({ force: false, reason: "submodules could not be inspected" })),
  );

  return WorktreeInspection.of(
    CodespacesWorkspace.routeWorkspaceMethods(
      {
        metadata: Effect.fn("WorktreeInspection.metadata")(function* (cwd: string) {
          return yield* guard(
            "metadata",
            cwd,
            Effect.gen(function* () {
              const stat = yield* fs.stat(cwd);
              return {
                path: yield* fs.realPath(cwd),
                type: stat.type,
                modifiedAt: Option.match(stat.mtime, {
                  onNone: () => null,
                  onSome: (time) => time.toISOString(),
                }),
              };
            }).pipe(
              Effect.catchIf(
                (error) => error.reason._tag === "NotFound",
                () => Effect.succeed(null),
              ),
            ),
          );
        }),
        readDirectory: Effect.fn("WorktreeInspection.readDirectory")((cwd: string) =>
          guard("readDirectory", cwd, fs.readDirectory(cwd)),
        ),
        managedDirectory: Effect.fn("WorktreeInspection.managedDirectory")(function* (cwd: string) {
          const common = yield* git.execute({
            operation: "WorktreeInspection.managedDirectory",
            cwd,
            args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          });
          return { path: path.join(common.stdout.trim(), "t3-worktrees") };
        }),
        measure: Effect.fn("WorktreeInspection.measure")((cwd: string) =>
          guard("measure", cwd, measureWorktree(cwd)),
        ),
        branchChanged: Effect.fn("WorktreeInspection.branchChanged")(
          (cwd: string, branch: string | null) =>
            guard("branchChanged", cwd, branchChanged(cwd, branch)),
        ),
        localChangesReason,
        submoduleRemoval,
      },
      workspace,
      "worktrees",
      failure,
    ),
  );
});
