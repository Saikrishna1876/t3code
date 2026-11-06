import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import {
  makeWorkspaceTelemetry,
  parseListeningSockets,
  parseProcessStat,
} from "./WorkspaceTelemetry.ts";

function stat(pid: number, ppid: number, startTime = "100") {
  const fields = Array<string>(20).fill("0");
  fields[0] = "S";
  fields[1] = String(ppid);
  fields[2] = String(pid);
  fields[19] = startTime;
  return `${pid} (node (dev)) ${fields.join(" ")}`;
}

async function fixture() {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-workspace-telemetry-"),
  );
  const proc = NodePath.join(directory, "proc");
  const cgroup = NodePath.join(directory, "cgroup");
  await NodeFSP.mkdir(NodePath.join(proc, "net"), { recursive: true });
  await NodeFSP.mkdir(cgroup);
  await NodeFSP.writeFile(
    NodePath.join(proc, "net/tcp"),
    "header\n 0: 0100007F:0BB8 00000000:0000 0A 0:0 00:0 0 1000 0 777\n",
  );
  await NodeFSP.writeFile(NodePath.join(cgroup, "memory.max"), "1048576");
  await NodeFSP.writeFile(NodePath.join(cgroup, "memory.current"), "262144");
  await NodeFSP.writeFile(NodePath.join(cgroup, "cpu.max"), "200000 100000");
  const process = async (pid: number, ppid: number, cwd: string, env = "", start = "100") => {
    const root = NodePath.join(proc, String(pid));
    await NodeFSP.mkdir(NodePath.join(root, "fd"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, "stat"), stat(pid, ppid, start));
    await NodeFSP.writeFile(
      NodePath.join(root, "status"),
      `Uid:\t${globalThis.process.getuid?.() ?? 0}\t0\t0\t0`,
    );
    await NodeFSP.writeFile(NodePath.join(root, "environ"), env);
    await NodeFSP.symlink(cwd, NodePath.join(root, "cwd"));
  };
  return {
    proc,
    process,
    telemetry: () => makeWorkspaceTelemetry(proc, cgroup),
    [Symbol.asyncDispose]: () => NodeFSP.rm(directory, { recursive: true, force: true }),
  };
}

it("reads Linux listener identities without confusing process-name parentheses or non-listening sockets", () => {
  expect(parseProcessStat(stat(123, 1))).toMatchObject({
    pid: 123,
    ppid: 1,
    startTime: "100",
    command: "node (dev)",
  });
  expect(parseProcessStat("invalid")).toBeNull();
  expect(
    parseListeningSockets(
      "header\n0: 0100007F:0BB8 00000000:0000 0A 0:0 00:0 0 1000 0 777\n1: 0100007F:0BB9 00000000:0000 01 0:0 00:0 0 1000 0 778",
    ),
  ).toEqual([{ port: 3000, inode: "777" }]);
});

it("scopes sockets to the selected checkout, preserves unknown owners and reports container limits", async () => {
  await using test = await fixture();
  await test.process(123, 1, "/workspaces/project");
  await NodeFSP.symlink("socket:[777]", NodePath.join(test.proc, "123/fd/3"));
  const input = { cwd: "/workspaces/project", threadId: ThreadId.make("thread") };
  const snapshot = await test.telemetry().scan(input);
  expect(snapshot.servers).toEqual([
    expect.objectContaining({
      port: 3000,
      pid: 123,
      processStartTime: "100",
      agent: null,
      terminal: null,
    }),
  ]);
  expect(snapshot.resources).toMatchObject({
    cpuCount: 2,
    totalMemoryBytes: 1048576,
    availableMemoryBytes: 786432,
    cpuUtilization: null,
  });
  expect((await test.telemetry().scan({ ...input, cwd: "/workspaces/other" })).servers).toEqual([]);
  const protectedTelemetry = makeWorkspaceTelemetry(test.proc, undefined, new Set([123]));
  expect((await protectedTelemetry.scan(input)).servers).toEqual([]);
  await expect(
    protectedTelemetry.stop({ ...input, pid: 123, port: 3000, processStartTime: "100" }),
  ).rejects.toThrow();
  await NodeFSP.writeFile(
    NodePath.join(test.proc, "123/environ"),
    "T3CODE_THREAD_ID=other-thread\0",
  );
  expect((await test.telemetry().scan(input)).servers).toEqual([]);
});

it("uses marked remote shell children rather than the host SSH process for terminal activity", async () => {
  await using test = await fixture();
  const env = "T3CODE_THREAD_ID=thread\0T3CODE_TERMINAL_ID=term-1\0";
  await test.process(123, 1, "/workspaces/project", env);
  await test.process(124, 123, "/workspaces/project", env);
  const input = {
    cwd: "/workspaces/project",
    threadId: ThreadId.make("thread"),
    terminalId: "term-1",
  };
  expect(await test.telemetry().terminal(input)).toEqual({
    hasRunningSubprocess: true,
    childCommand: "node (dev)",
    processIds: [],
  });
  expect(await test.telemetry().terminal({ ...input, terminalId: "term-2" })).toEqual({
    hasRunningSubprocess: false,
    childCommand: null,
    processIds: [],
  });
});

it("rejects stale process identities and other workspaces before signaling a remote server", async () => {
  await using test = await fixture();
  using signal = vi.spyOn(globalThis.process, "kill").mockReturnValue(true);
  await test.process(123, 1, "/workspaces/project");
  await NodeFSP.symlink("socket:[777]", NodePath.join(test.proc, "123/fd/3"));
  const telemetry = test.telemetry();
  const input = {
    cwd: "/workspaces/project",
    threadId: ThreadId.make("thread"),
    pid: 123,
    port: 3000,
    processStartTime: "100",
  };
  await telemetry.scan(input);
  await NodeFSP.writeFile(NodePath.join(test.proc, "123/stat"), stat(123, 1, "200"));
  await expect(telemetry.stop(input)).rejects.toThrow();
  await expect(
    telemetry.stop({ ...input, cwd: "/workspaces/other", processStartTime: "200" }),
  ).rejects.toThrow();
  expect(signal).not.toHaveBeenCalled();
  await telemetry.stop({ ...input, processStartTime: "200" });
  expect(signal).toHaveBeenCalledWith(123, "SIGTERM");
});
