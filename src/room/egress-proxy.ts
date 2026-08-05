/**
 * Filtering egress proxy — the enforcement core for allowlisted network access.
 *
 * A room with `egress: blocked` has no network at all (the strong, VM-enforced
 * default). But real AI CLIs need to reach their vendor API, and `egress: open`
 * throws that boundary away. The middle ground is an allowlist: the room may talk
 * to `api.anthropic.com` and nothing else.
 *
 * This module is the reusable, testable heart of that: an HTTP forward proxy
 * that tunnels CONNECT (HTTPS) and forwards plain HTTP only to hosts on the
 * allowlist, and refuses everything else. It is genuine enforcement for any
 * client that honors HTTP(S)_PROXY (the AI CLIs and git do). Wiring it so the
 * room is *forced* through it — with no direct-IP bypass — is a separate,
 * namespace-level step tracked in the Room backend; this component holds no
 * opinion about how it is attached, which keeps it unit-testable on its own.
 *
 * Phase 4: refuse bodies use standardized Bumper boundary denial copy
 * (attribution, what/why/fix, new-session effect).
 */
import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { formatEgressDenial, type BoundaryDenial } from "../boundary-denial.js";

/**
 * Does `host` match the allowlist? A rule matches its exact host and any
 * subdomain of it ("api.anthropic.com" matches "api.anthropic.com" and
 * "x.api.anthropic.com"), never a sibling ("evil-anthropic.com" does not match).
 */
export function hostAllowed(allowlist: string[], host: string): boolean {
  const clean = (host || "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  return allowlist.some((raw) => {
    const rule = raw.toLowerCase().trim().replace(/^\*\./, "").replace(/\.$/, "");
    if (!rule) return false;
    return clean === rule || clean.endsWith("." + rule);
  });
}

/** Vendor host templates so a project can allow "Anthropic" without typing hosts. */
export const EGRESS_TEMPLATES: Record<string, { label: string; hosts: string[] }> = {
  anthropic: { label: "Anthropic (Claude)", hosts: ["api.anthropic.com", "statsig.anthropic.com"] },
  openai: { label: "OpenAI (Codex)", hosts: ["api.openai.com", "chatgpt.com", "auth.openai.com"] },
  cursor: { label: "Cursor", hosts: ["api2.cursor.sh", "api3.cursor.sh", "cursor.com", "api.cursor.com"] },
  google: { label: "Google (Antigravity)", hosts: ["antigravity.google", "generativelanguage.googleapis.com", "oauth2.googleapis.com"] },
  xai: { label: "xAI (Grok)", hosts: ["api.x.ai", "x.ai"] },
  github: { label: "GitHub (git push/pull)", hosts: ["github.com", "api.github.com", "codeload.github.com"] },
};

/** Expand a set of template names into a flat, de-duplicated host list. */
export function egressTemplateHosts(names: string[]): string[] {
  const hosts = new Set<string>();
  for (const name of names) for (const host of EGRESS_TEMPLATES[name]?.hosts ?? []) hosts.add(host);
  return [...hosts];
}

export interface EgressEvent {
  host: string;
  allowed: boolean;
  method: string;
  /** Present when the proxy refused; includes AI message + GUI fix tab. */
  denial?: BoundaryDenial;
}

export interface EgressProxyOptions {
  /** Project name for standardized denial copy. */
  project?: string;
}

/** A running filtering proxy. */
export class EgressProxy {
  private server?: Server;
  private port = 0;
  private readonly project: string;

  constructor(
    private readonly allowlist: string[],
    private readonly onEvent?: (event: EgressEvent) => void,
    options?: EgressProxyOptions,
  ) {
    this.project = options?.project?.trim() || "";
  }

  /** Start listening. Binds all interfaces so a guest VM can reach it. */
  async listen(host = "0.0.0.0"): Promise<number> {
    const server = createServer((req, res) => this.onHttp(req, res));
    server.on("connect", (req, socket, head) => this.onConnect(req, socket as Socket, head));
    // A malformed or aborted request must not take the proxy down with it.
    server.on("clientError", (_error, socket) => {
      try { (socket as Socket).destroy(); } catch { /* already gone */ }
    });
    this.server = server;
    await new Promise<void>((resolvePromise) => server.listen(0, host, () => resolvePromise()));
    this.port = (server.address() as import("node:net").AddressInfo).port;
    return this.port;
  }

  address(): number { return this.port; }

  stop(): void {
    try { this.server?.close(); } catch { /* already closing */ }
    this.server = undefined;
  }

  private refuseBody(host: string, method: string): { body: string; denial: BoundaryDenial } {
    const denial = formatEgressDenial({
      project: this.project || undefined,
      host,
      method,
    });
    return { body: denial.aiMessage + "\n", denial };
  }

  /** Plain HTTP: forward only to allowed hosts. */
  private onHttp(req: IncomingMessage, res: ServerResponse): void {
    let host = "";
    try { host = new URL(req.url ?? "").hostname || req.headers.host || ""; }
    catch { host = req.headers.host ?? ""; }
    const method = req.method ?? "GET";
    const allowed = hostAllowed(this.allowlist, host);
    if (!allowed) {
      const { body, denial } = this.refuseBody(host, method);
      this.onEvent?.({ host, allowed: false, method, denial });
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end(body);
      return;
    }
    this.onEvent?.({ host, allowed: true, method });
    try {
      const target = new URL(req.url ?? "");
      const upstream = httpRequest({
        host: target.hostname, port: target.port || 80, method: req.method,
        path: target.pathname + target.search, headers: req.headers,
      }, (upRes) => { res.writeHead(upRes.statusCode ?? 502, upRes.headers); upRes.pipe(res); });
      upstream.on("error", () => { res.writeHead(502); res.end("upstream error"); });
      req.pipe(upstream);
    } catch { res.writeHead(400); res.end("bad request"); }
  }

  /** HTTPS CONNECT: tunnel bytes only to allowed hosts. */
  private onConnect(req: IncomingMessage, clientSocket: Socket, head: Buffer): void {
    /*
     * A CONNECT socket is raw: Node attaches no default 'error' listener, so an
     * unhandled ECONNRESET becomes an uncaught exception. The refuse path below
     * ends the socket while the client is often already tearing the connection
     * down, which crashed the whole proxy — and the proxy runs inside the Bumper
     * app/CLI process, so one blocked HTTPS request could kill the session.
     * Attach the guard before any branch can touch the socket.
     */
    clientSocket.on("error", () => { /* client vanished; nothing to recover */ });
    const [rawHost, rawPort] = (req.url ?? "").split(":");
    const host = rawHost ?? "";
    const port = Number(rawPort) || 443;
    const method = "CONNECT";
    const allowed = hostAllowed(this.allowlist, host);
    if (!allowed) {
      const { body, denial } = this.refuseBody(host, method);
      this.onEvent?.({ host, allowed: false, method, denial });
      // CONNECT refuse: status line + body so clients that log the response see Bumper copy.
      clientSocket.write(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`);
      clientSocket.end();
      return;
    }
    this.onEvent?.({ host, allowed: true, method });
    const upstream = connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => { try { clientSocket.end(); } catch { /* gone */ } });
    clientSocket.on("close", () => { try { upstream.end(); } catch { /* gone */ } });
  }
}
