// @effect-diagnostics nodeBuiltinImport:off -- Reads the Codespace worker's Linux process namespace.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  ThreadId,
  type DiscoveredLocalServer,
  type HostResourcesSnapshot,
  PreviewStopLocalServerInput,
} from "@t3tools/contracts";

const ScanInput = Schema.Struct({ cwd: Schema.String, threadId: ThreadId });
const TerminalInput = Schema.Struct({ ...ScanInput.fields, terminalId: Schema.String });
const StopInput = Schema.Struct({ ...PreviewStopLocalServerInput.fields, ...ScanInput.fields });
const decodeScan = Schema.decodeUnknownSync(ScanInput);
const decodeTerminal = Schema.decodeUnknownSync(TerminalInput);
const decodeStop = Schema.decodeUnknownSync(StopInput);

interface ProcessSample {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly startTime: string;
  readonly command: string;
  readonly cwd: string;
  readonly threadId: string | null;
  readonly terminalId: string | null;
  readonly uid: number;
}

export function parseProcessStat(text: string) {
  const end = text.lastIndexOf(")");
  const start = text.indexOf("(");
  const fields = text
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const pid = Number(text.slice(0, start).trim());
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const startTime = fields[19];
  if (
    start < 0 ||
    end <= start ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(ppid) ||
    !Number.isSafeInteger(pgid) ||
    !startTime ||
    !/^\d+$/.test(startTime)
  )
    return null;
  return { pid, ppid, pgid, startTime, command: text.slice(start + 1, end) };
}

export function parseListeningSockets(text: string) {
  return text
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const fields = line.trim().split(/\s+/);
      if (fields[3] !== "0A" || !fields[1] || !fields[9]) return [];
      const port = Number.parseInt(fields[1].split(":")[1] ?? "", 16);
      return port > 0 && port < 65536 ? [{ port, inode: fields[9] }] : [];
    });
}

const inside = (value: string, root: string) =>
  value === root || value.startsWith(root + NodePath.sep);
const read = (file: string) => NodeFSP.readFile(file, "utf8").catch(() => "");

export function makeWorkspaceTelemetry(
  procRoot = "/proc",
  cgroupRoot = "/sys/fs/cgroup",
  excludedPids: ReadonlySet<number> = new Set([process.pid]),
) {
  let previousCpu: { usage: number; sampledAt: number } | null = null;
  const readProcesses = async () => {
    const entries = (await NodeFSP.readdir(procRoot))
      .filter((pid) => /^\d+$/.test(pid))
      .slice(0, 16384);
    const result: ProcessSample[] = [];
    for (let offset = 0; offset < entries.length; offset += 64) {
      await Promise.all(
        entries.slice(offset, offset + 64).map(async (entry) => {
          const directory = NodePath.join(procRoot, entry);
          const [stat, cwd, environment, status] = await Promise.all([
            read(NodePath.join(directory, "stat")),
            NodeFSP.readlink(NodePath.join(directory, "cwd")).catch(() => ""),
            read(NodePath.join(directory, "environ")),
            read(NodePath.join(directory, "status")),
          ]);
          const parsed = parseProcessStat(stat);
          const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
          if (!parsed || !cwd || !uid) return;
          const env = new Map(
            environment.split("\0").map((item) => {
              const index = item.indexOf("=");
              return [item.slice(0, index), item.slice(index + 1)];
            }),
          );
          result.push({
            ...parsed,
            cwd,
            uid: Number(uid),
            threadId: env.get("T3CODE_THREAD_ID") ?? env.get("T3CODE_AGENT_THREAD_ID") ?? null,
            terminalId: env.get("T3CODE_TERMINAL_ID") ?? null,
          });
        }),
      );
    }
    return result;
  };
  let processCache: { at: number; value: Promise<ProcessSample[]> } | null = null;
  const processes = () => {
    const at = Date.now();
    if (!processCache || at - processCache.at >= 750) processCache = { at, value: readProcesses() };
    return processCache.value;
  };
  const resources = async (): Promise<HostResourcesSnapshot> => {
    const [memoryMax, memoryCurrent, cpuMax, cpuStat, meminfo] = await Promise.all([
      read(NodePath.join(cgroupRoot, "memory.max")),
      read(NodePath.join(cgroupRoot, "memory.current")),
      read(NodePath.join(cgroupRoot, "cpu.max")),
      read(NodePath.join(cgroupRoot, "cpu.stat")),
      read(NodePath.join(procRoot, "meminfo")),
    ]);
    const [quota, period] = cpuMax.trim().split(/\s+/).map(Number);
    const cpuCount =
      Number.isFinite(quota) && quota > 0 && period && period > 0
        ? Math.max(1, Math.ceil(quota / period))
        : NodeOS.availableParallelism();
    const limit = Number(memoryMax.trim());
    const totalMemoryBytes =
      limit > 0 && Number.isFinite(limit) ? Math.min(limit, NodeOS.totalmem()) : NodeOS.totalmem();
    const used = Number(memoryCurrent.trim());
    const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
    const availableMemoryBytes =
      memoryCurrent.trim() && Number.isFinite(used)
        ? Math.max(0, totalMemoryBytes - used)
        : Math.min(totalMemoryBytes, available ? Number(available) * 1024 : NodeOS.freemem());
    const sampledAt = Date.now();
    const usage = Number(/^usage_usec\s+(\d+)$/m.exec(cpuStat)?.[1]);
    const prior = previousCpu;
    const cpuUtilization =
      prior && Number.isFinite(usage) && usage >= prior.usage && sampledAt > prior.sampledAt
        ? Math.max(
            0,
            Math.min(1, (usage - prior.usage) / ((sampledAt - prior.sampledAt) * 1000 * cpuCount)),
          )
        : null;
    if (Number.isFinite(usage)) previousCpu = { usage, sampledAt };
    return { sampledAt, cpuUtilization, cpuCount, availableMemoryBytes, totalMemoryBytes };
  };
  const listeners = async (cwd: string, threadId: ThreadId, fresh = false) => {
    const [table, tcp, tcp6] = await Promise.all([
      fresh ? readProcesses() : processes(),
      read(NodePath.join(procRoot, "net/tcp")),
      read(NodePath.join(procRoot, "net/tcp6")),
    ]);
    const sockets = [...parseListeningSockets(tcp), ...parseListeningSockets(tcp6)];
    const byInode = new Map(sockets.map((socket) => [socket.inode, socket.port]));
    const servers: DiscoveredLocalServer[] = [];
    for (const process of table.filter(
      (item) =>
        !excludedPids.has(item.pid) &&
        (item.threadId === null || item.threadId === threadId) &&
        inside(item.cwd, cwd) &&
        item.uid === (globalThis.process.getuid?.() ?? item.uid),
    )) {
      const directory = NodePath.join(procRoot, String(process.pid), "fd");
      const descriptors = await NodeFSP.readdir(directory).catch(() => []);
      const links = await Promise.all(
        descriptors.map((descriptor) =>
          NodeFSP.readlink(NodePath.join(directory, descriptor)).catch(() => ""),
        ),
      );
      for (const inode of new Set(
        links.flatMap((link) => /^socket:\[(\d+)\]$/.exec(link)?.[1] ?? []),
      )) {
        const port = byInode.get(inode);
        if (!port || servers.some((server) => server.port === port)) continue;
        servers.push({
          host: "127.0.0.1",
          port,
          url: `http://127.0.0.1:${port}/`,
          pid: process.pid,
          processName: process.command,
          processStartTime: process.startTime,
          terminal:
            process.threadId === threadId && process.terminalId
              ? { threadId, terminalId: process.terminalId }
              : null,
          agent: process.threadId === threadId && !process.terminalId ? { threadId } : null,
        });
      }
    }
    return { table, servers };
  };
  return {
    scan: async (raw: unknown) => {
      const input = decodeScan(raw);
      const [inventory, snapshot] = await Promise.all([
        listeners(input.cwd, input.threadId),
        resources(),
      ]);
      return { servers: inventory.servers, resources: snapshot };
    },
    terminal: async (raw: unknown) => {
      const input = decodeTerminal(raw);
      const table = await processes();
      const shells = table.filter(
        (item) => item.threadId === input.threadId && item.terminalId === input.terminalId,
      );
      const shell = shells.find((item) => !shells.some((parent) => parent.pid === item.ppid));
      const child = shell ? table.find((item) => item.ppid === shell.pid) : null;
      return {
        hasRunningSubprocess: child != null,
        childCommand: child?.command ?? null,
        processIds: [],
      };
    },
    stop: async (raw: unknown) => {
      const input = decodeStop(raw);
      const inventory = await listeners(input.cwd, input.threadId, true);
      const server = inventory.servers.find(
        (item) =>
          item.pid === input.pid &&
          item.port === input.port &&
          item.processStartTime === input.processStartTime,
      );
      const target = inventory.table.find((item) => item.pid === input.pid);
      if (!input.processStartTime || !server || !target || target.pid === globalThis.process.pid)
        throw new Error("The server process is no longer owned by this workspace.");
      const current = parseProcessStat(
        await read(NodePath.join(procRoot, String(input.pid), "stat")),
      );
      if (current?.startTime !== input.processStartTime)
        throw new Error("The server process has changed.");
      globalThis.process.kill(input.pid, "SIGTERM");
    },
  };
}
