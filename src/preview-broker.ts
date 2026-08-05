import { createServer, createConnection, type Server, type Socket } from "node:net";
import {
  mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Door, PublishedSocket, RoomSpec } from "./room/backend.js";
import {
  readDevelopmentSessionLease,
  updateDevelopmentSessionRuntime,
  type PreviewPortMapping,
} from "./development-session-lease.js";

const ROOM_STATE_PATH = "/bumper-development-state";
const ROOM_HELPER_PATH = "/bumper-development-helper";
const ROOM_SOCKET_PATH = "/tmp/bumper-preview.sock";
const MAX_PORTS = 8;

export interface PreviewBrokerParts {
  doors: Door[];
  socket: PublishedSocket;
  command: string[];
}

export interface PreviewBrokerEvent {
  decision: "allowed" | "blocked" | "failed";
  target: string;
  reason: string;
  roomPort?: number;
  hostPort?: number;
}

interface PortReport {
  ports?: unknown;
  at?: unknown;
}

function validPorts(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((port): port is number => Number.isInteger(port) && port >= 1024 && port <= 65535))]
    .sort((a, b) => a - b)
    .slice(0, MAX_PORTS);
}

export function previewRelaySource(): string {
  return `import net from "node:net";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const socketPath = process.env.BUMPER_PREVIEW_SOCKET || ${JSON.stringify(ROOM_SOCKET_PATH)};
const reportPath = process.env.BUMPER_PREVIEW_REPORT || ${JSON.stringify(`${ROOM_STATE_PATH}/preview-ports.json`)};
const connectionPath = reportPath.replace(/preview-ports\\.json$/, "preview-connection.json");

function connection(stage, port = 0, error = "") {
  try { fs.writeFileSync(connectionPath, JSON.stringify({ stage, port, error, at: new Date().toISOString() })); } catch {}
}

function portsFrom(path) {
  let text = "";
  try { text = fs.readFileSync(path, "utf8"); } catch { return []; }
  return text.split("\\n").slice(1).flatMap((line) => {
    const parts = line.trim().split(/\\s+/);
    if (parts.length < 4 || parts[3] !== "0A") return [];
    const local = parts[1] || "";
    const colon = local.lastIndexOf(":");
    const port = Number.parseInt(local.slice(colon + 1), 16);
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? [port] : [];
  });
}

function dockerPorts() {
  if (process.env.BUMPER_PREVIEW_DOCKER !== "1") return [];
  try {
    const output = execFileSync("docker", ["ps", "--format", "{{.Ports}}"], { encoding: "utf8", timeout: 1000 });
    return output.split("\\n").flatMap((line) =>
      [...line.matchAll(/(?:^|[, ]|:)([0-9]{1,5})->/g)].map((match) => Number(match[1])));
  } catch {
    return [];
  }
}

function report() {
  const ports = [...new Set([...portsFrom("/proc/net/tcp"), ...portsFrom("/proc/net/tcp6"), ...dockerPorts()])].sort((a, b) => a - b).slice(0, ${MAX_PORTS});
  try {
    fs.writeFileSync(reportPath + ".tmp", JSON.stringify({ ports, at: new Date().toISOString() }));
    fs.renameSync(reportPath + ".tmp", reportPath);
  } catch {}
}

try { fs.unlinkSync(socketPath); } catch {}
const server = net.createServer((client) => {
  connection("connected");
  let header = Buffer.alloc(0);
  const onData = (chunk) => {
    header = Buffer.concat([header, chunk]);
    const newline = header.indexOf(10);
    if (newline < 0) {
      if (header.length > 64) client.destroy();
      return;
    }
    if (newline > 64) return client.destroy();
    client.off("data", onData);
    const match = header.subarray(0, newline).toString("utf8").match(/^PORT ([0-9]{1,5})$/);
    const port = match ? Number(match[1]) : 0;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      connection("invalid-header");
      return client.destroy();
    }
    connection("upstream-start", port);
    const upstream = net.createConnection({ host: "127.0.0.1", port });
    upstream.on("connect", () => {
      connection("upstream-connected", port);
      const rest = header.subarray(newline + 1);
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", (error) => {
      connection("upstream-error", port, error.message);
      client.destroy();
    });
    client.on("error", () => upstream.destroy());
  };
  client.on("data", onData);
});
server.listen(socketPath);
report();
setInterval(report, 500).unref();
`;
}

export class PreviewBroker {
  private timer?: NodeJS.Timeout;
  private mappings = new Map<number, { server: Server; hostPort: number; clients: Set<Socket> }>();
  private started = false;
  readonly roomDir: string;
  readonly helperDir: string;
  readonly hostSocketPath: string;

  constructor(
    private dir: string,
    private sessionId: string,
    private onEvent: (event: PreviewBrokerEvent) => void = () => {},
    private source: "room" | "docker" = "room",
  ) {
    this.roomDir = join(dir, "room-state");
    this.helperDir = join(dir, "helper");
    // Keep below Darwin's Unix socket path limit even when BUMPER_STATE is long.
    this.hostSocketPath = `/tmp/bumper-preview-${source}-${sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)}.sock`;
  }

  setup(command: string[]): PreviewBrokerParts {
    mkdirSync(this.roomDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.helperDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.helperDir, "preview-relay.mjs"), previewRelaySource(), { mode: 0o500 });
    try { rmSync(this.hostSocketPath, { force: true }); } catch { /* best effort */ }
    return {
      doors: [
        { hostPath: this.roomDir, roomPath: ROOM_STATE_PATH, access: "read-write" },
        { hostPath: this.helperDir, roomPath: ROOM_HELPER_PATH, access: "read-only" },
      ],
      socket: { hostPath: this.hostSocketPath, roomPath: ROOM_SOCKET_PATH },
      command: [
        "/bin/sh", "-c",
        `node ${ROOM_HELPER_PATH}/preview-relay.mjs </dev/null >/tmp/bumper-preview.log 2>&1 & exec "$@"`,
        "bumper-development",
        ...command,
      ],
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => { void this.reconcile(); }, 400);
    this.timer.unref?.();
    void this.reconcile();
  }

  private reportPorts(): number[] {
    try {
      const report = JSON.parse(readFileSync(join(this.roomDir, "preview-ports.json"), "utf8")) as PortReport;
      const reportedAt = Date.parse(String(report.at ?? ""));
      if (!Number.isFinite(reportedAt) || Date.now() - reportedAt > 2_000) return [];
      return validPorts(report.ports);
    } catch {
      return [];
    }
  }

  private async open(roomPort: number): Promise<void> {
    if (this.mappings.has(roomPort)) return;
    const clients = new Set<Socket>();
    const server = createServer((client) => {
      clients.add(client);
      client.on("close", () => clients.delete(client));
      this.forward(client, roomPort);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Preview listener did not receive a TCP port.");
    }
    this.mappings.set(roomPort, { server, hostPort: address.port, clients });
    this.onEvent({
      decision: "allowed",
      target: `Local Preview :${roomPort}`,
      reason: `loopback mapping opened on 127.0.0.1:${address.port}`,
      roomPort,
      hostPort: address.port,
    });
  }

  private forward(client: Socket, roomPort: number): void {
    client.pause();
    const room = createConnection(this.hostSocketPath);
    room.on("connect", () => {
      room.write(`PORT ${roomPort}\n`);
      client.pipe(room);
      room.pipe(client);
      client.resume();
    });
    room.on("error", () => client.destroy());
    client.on("error", () => room.destroy());
  }

  private close(roomPort: number, reason: string): void {
    const mapping = this.mappings.get(roomPort);
    if (!mapping) return;
    this.mappings.delete(roomPort);
    for (const client of mapping.clients) client.destroy();
    mapping.clients.clear();
    mapping.server.close();
    this.onEvent({
      decision: "blocked",
      target: `Local Preview :${roomPort}`,
      reason,
      roomPort,
      hostPort: mapping.hostPort,
    });
  }

  private runtimeMappings(): PreviewPortMapping[] {
    return [...this.mappings.entries()].map(([roomPort, value]) => ({
      source: this.source,
      roomPort,
      hostPort: value.hostPort,
      url: `http://127.0.0.1:${value.hostPort}`,
    }));
  }

  async reconcile(): Promise<void> {
    const lease = readDevelopmentSessionLease(this.sessionId);
    const capabilityEnabled = lease?.live
      && lease.control.previewEnabled
      && (this.source !== "docker" || lease.control.dockerEnabled);
    const desired = capabilityEnabled ? this.reportPorts() : [];
    const wanted = new Set(desired);
    for (const roomPort of this.mappings.keys()) {
      if (!wanted.has(roomPort)) this.close(roomPort, lease?.control.previewEnabled ? "Room listener closed" : "Preview disabled or Session ended");
    }
    let error = "";
    for (const roomPort of desired) {
      try { await this.open(roomPort); }
      catch (cause) {
        error = (cause as Error).message;
        this.onEvent({ decision: "failed", target: `Local Preview :${roomPort}`, reason: error, roomPort });
      }
    }
    const otherMappings = (lease?.runtime.previewPorts ?? [])
      .filter((mapping) => (mapping.source ?? "room") !== this.source);
    updateDevelopmentSessionRuntime(this.sessionId, {
      previewPorts: [...otherMappings, ...this.runtimeMappings()],
      previewError: error,
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
    const closing = [...this.mappings.values()].map(({ server, clients }) => {
      for (const client of clients) client.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    });
    this.mappings.clear();
    await Promise.all(closing);
    try { rmSync(this.hostSocketPath, { force: true }); } catch { /* best effort */ }
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export function withPreviewParts(spec: RoomSpec, parts: PreviewBrokerParts): RoomSpec {
  return {
    ...spec,
    doors: [...spec.doors, ...parts.doors],
    publishSockets: [...(spec.publishSockets ?? []), parts.socket],
  };
}
