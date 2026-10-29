// @effect-diagnostics nodeBuiltinImport:off -- the standalone worker owns process and filesystem boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import { parse, type ParseError } from "jsonc-parser";
import * as Schema from "effect/Schema";

const Command = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
const Lifecycle = Schema.Union([Command, Schema.Record(Schema.String, Command)]);
const Configuration = Schema.Struct({
  onCreateCommand: Schema.optionalKey(Lifecycle),
  updateContentCommand: Schema.optionalKey(Lifecycle),
  postCreateCommand: Schema.optionalKey(Lifecycle),
  postStartCommand: Schema.optionalKey(Lifecycle),
  containerEnv: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  remoteEnv: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  image: Schema.optionalKey(Schema.String),
  build: Schema.optionalKey(Schema.Unknown),
  features: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeConfiguration = Schema.decodeUnknownSync(Configuration);
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const setupUnavailable =
  "Project added. Automatic devcontainer setup needs memory isolation that this Codespace does not provide. Set up dependencies manually, or use a computer with delegated cgroup limits.";

async function run(command: string, args: string[], cwd: string, env = process.env) {
  await new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd,
      env,
      stdio: "ignore",
      timeout: 600_000,
      killSignal: "SIGKILL",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Project command failed.")),
    );
  });
}

async function setup(root: string, configurationPath: string | undefined): Promise<string | null> {
  if (!configurationPath) return null;
  let group: string | undefined;
  try {
    const configurationFile = await NodeFSP.realpath(NodePath.join(root, configurationPath));
    if (!configurationFile.startsWith(root + NodePath.sep))
      throw new Error("Configuration leaves project.");
    const errors: ParseError[] = [];
    const value: unknown = parse(await NodeFSP.readFile(configurationFile, "utf8"), errors, {
      allowTrailingComma: true,
    });
    if (errors.length) throw new Error("Invalid devcontainer configuration.");
    const configuration = decodeConfiguration(value);
    const commands = [
      configuration.onCreateCommand,
      configuration.updateContentCommand,
      configuration.postCreateCommand,
      configuration.postStartCommand,
    ].filter((command) => command !== undefined);
    const containerWarning =
      configuration.image || configuration.build || Object.keys(configuration.features ?? {}).length
        ? " Container images and features need a separate container and were not applied to this shared computer."
        : "";
    if (!commands.length) return containerWarning.trim() || null;
    const relative = /^0::(.*)$/m.exec(await NodeFSP.readFile("/proc/self/cgroup", "utf8"))?.[1];
    if (relative === undefined) return setupUnavailable;
    const parent = NodePath.join("/sys/fs/cgroup", relative);
    let available = NodeOS.freemem();
    for (let directory = parent; ; directory = NodePath.dirname(directory)) {
      const total = (await NodeFSP.readFile(NodePath.join(directory, "memory.max"), "utf8")).trim();
      const used = Number(
        await NodeFSP.readFile(NodePath.join(directory, "memory.current"), "utf8"),
      );
      available = Math.min(available, (total === "max" ? NodeOS.totalmem() : Number(total)) - used);
      if (directory === "/sys/fs/cgroup") break;
      if (!directory.startsWith("/sys/fs/cgroup/")) return setupUnavailable;
    }
    const limit = Math.floor(Math.min(1024 ** 3, available / 2));
    if (!Number.isFinite(limit) || limit < 512 * 1024 ** 2)
      return "Project added. Not enough free memory for automatic devcontainer setup. Free memory or choose a larger computer, then set up dependencies manually.";
    group = NodePath.join(parent, "t3-setup-" + NodeCrypto.randomUUID());
    await NodeFSP.mkdir(group);
    await NodeFSP.writeFile(NodePath.join(group, "memory.max"), String(limit));
    await NodeFSP.writeFile(NodePath.join(group, "memory.swap.max"), "0");
    await NodeFSP.writeFile(NodePath.join(group, "memory.oom.group"), "1");
    await NodeFSP.writeFile(NodePath.join(group, "pids.max"), "128");
    await NodeFSP.writeFile(NodePath.join(group, "cpu.max"), "100000 100000");
    await NodeFSP.access(NodePath.join(group, "cgroup.kill"), NodeFS.constants.W_OK);
    const env = { ...process.env };
    for (const [key, value] of Object.entries({
      ...configuration.containerEnv,
      ...configuration.remoteEnv,
    })) {
      if (/\$\{(?!containerWorkspaceFolder\})/.test(value))
        return "Project added. Devcontainer setup uses environment substitutions that need manual configuration.";
      env[key] = value.replaceAll("${containerWorkspaceFolder}", root);
    }
    // Every descendant inherits this cgroup; killing it cannot affect the worker or other projects.
    for (const command of commands) {
      const steps =
        typeof command === "string" || Array.isArray(command) ? [command] : Object.values(command);
      for (const step of steps) {
        const args = typeof step === "string" ? ["sh", "-c", step] : [...step];
        if (!args.length) continue;
        try {
          await run(
            "/bin/sh",
            [
              "-c",
              'printf "%s" "$$" > "$1/cgroup.procs" || exit 1; shift; exec "$@"',
              "t3-setup",
              group,
              ...args,
            ],
            root,
            env,
          );
        } catch {
          return "Project added. Devcontainer setup failed or exceeded its memory or time limit. Files remain available. Finish dependency setup manually.";
        }
      }
    }
    return containerWarning.trim() || null;
  } catch {
    return setupUnavailable;
  } finally {
    if (group) {
      await NodeFSP.writeFile(NodePath.join(group, "cgroup.kill"), "1").catch(() => {});
      await NodeFSP.rmdir(group).catch(() => {});
    }
  }
}

const pending = new Set<string>();
export async function prepareProject(
  workspace: string,
  input: {
    projectId: string;
    folder: string;
    ref?: string;
    origin?: string;
    devcontainerPath?: string;
  },
  bundle: NodeStream.Readable,
): Promise<{ remoteRoot: string; setupWarning: string | null }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(input.folder))
    throw new Error("Invalid project folder.");
  const root = NodePath.join(workspace, input.folder);
  if (pending.has(root)) throw new Error("Project is already being added.");
  pending.add(root);
  let temporary: string | undefined;
  try {
    const records = NodePath.join(workspace, ".t3-projects");
    await NodeFSP.mkdir(records, { recursive: true, mode: 0o700 });
    const record = NodePath.join(records, input.folder + ".json");
    let previous: { projectId?: unknown; setupWarning?: unknown } | undefined;
    try {
      previous = JSON.parse(await NodeFSP.readFile(record, "utf8"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const useUniqueFolder = () => {
      const suffix = NodeCrypto.createHash("sha256")
        .update(input.projectId)
        .digest("hex")
        .slice(0, 32);
      if (input.folder.endsWith("-" + suffix)) throw new Error("Project folder is occupied.");
      return prepareProject(
        workspace,
        { ...input, folder: input.folder.slice(0, 66) + "-" + suffix },
        bundle,
      );
    };
    if (previous) {
      if (previous.projectId !== input.projectId) return await useUniqueFolder();
      if ((await NodeFSP.realpath(root)) !== root) throw new Error("Project folder changed.");
      bundle.resume();
      return {
        remoteRoot: root,
        setupWarning: typeof previous.setupWarning === "string" ? previous.setupWarning : null,
      };
    }
    try {
      await NodeFSP.lstat(root);
      return await useUniqueFolder();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    temporary = await NodeFSP.mkdtemp(NodePath.join(workspace, ".t3-project-"));
    const archive = NodePath.join(temporary, "source.bundle");
    let bytes = 0;
    await NodeStreamPromises.pipeline(
      bundle,
      new NodeStream.Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          callback(
            bytes > MAX_BUNDLE_BYTES ? new Error("Project bundle exceeds 512 MiB.") : null,
            chunk,
          );
        },
      }),
      NodeFS.createWriteStream(archive, { flags: "wx", mode: 0o600 }),
    );
    const checkout = NodePath.join(temporary, "checkout");
    await run(
      "git",
      ["clone", ...(input.ref ? ["--branch", input.ref] : []), "--", archive, checkout],
      workspace,
    );
    await run("git", ["remote", "remove", "origin"], checkout);
    if (input.origin) await run("git", ["remote", "add", "origin", input.origin], checkout);
    await NodeFSP.rename(checkout, root);
    await NodeFSP.writeFile(
      record,
      JSON.stringify({
        projectId: input.projectId,
        setupWarning: "Project added. Setup was interrupted. Finish dependency setup manually.",
      }),
      { flag: "wx", mode: 0o600 },
    );
    const setupWarning = await setup(root, input.devcontainerPath);
    await NodeFSP.writeFile(record, JSON.stringify({ projectId: input.projectId, setupWarning }));
    return { remoteRoot: root, setupWarning };
  } finally {
    pending.delete(root);
    if (temporary) await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
}
