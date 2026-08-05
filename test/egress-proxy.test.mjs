import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { hostAllowed, egressTemplateHosts, EGRESS_TEMPLATES, EgressProxy } from "../dist/room/egress-proxy.js";

test("hostAllowed matches exact hosts and subdomains, never siblings", () => {
  assert.equal(hostAllowed(["api.anthropic.com"], "api.anthropic.com"), true);
  assert.equal(hostAllowed(["api.anthropic.com"], "x.api.anthropic.com"), true);
  assert.equal(hostAllowed(["anthropic.com"], "api.anthropic.com"), true);
  assert.equal(hostAllowed(["api.anthropic.com"], "api.anthropic.com:443"), true);
  assert.equal(hostAllowed(["anthropic.com"], "evil-anthropic.com"), false);
  assert.equal(hostAllowed(["anthropic.com"], "anthropiccom.evil.com"), false);
  assert.equal(hostAllowed([], "anything.com"), false);
});

test("egress templates expand to concrete hosts", () => {
  const hosts = egressTemplateHosts(["anthropic", "github"]);
  assert.ok(hosts.includes("api.anthropic.com"));
  assert.ok(hosts.includes("github.com"));
  assert.ok(EGRESS_TEMPLATES.openai.hosts.includes("api.openai.com"));
});

async function proxyRequest(proxyPort, targetUrl, targetHost) {
  return new Promise((resolvePromise, reject) => {
    const req = request({ host: "127.0.0.1", port: proxyPort, path: targetUrl, headers: { host: targetHost } }, (res) => {
      let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolvePromise({ status: res.statusCode, body }));
    });
    req.on("error", reject); req.end();
  });
}

test("proxy forwards allowed HTTP hosts and blocks the rest", async (t) => {
  const target = createServer((_req, res) => { res.writeHead(200); res.end("UPSTREAM_OK"); });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const targetPort = target.address().port;
  t.after(() => target.close());

  const allowProxy = new EgressProxy(["127.0.0.1"]);
  const allowPort = await allowProxy.listen("127.0.0.1");
  t.after(() => allowProxy.stop());
  const allowed = await proxyRequest(allowPort, `http://127.0.0.1:${targetPort}/`, `127.0.0.1:${targetPort}`);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body, "UPSTREAM_OK");

  const denyProxy = new EgressProxy(["example.com"]);
  const denyPort = await denyProxy.listen("127.0.0.1");
  t.after(() => denyProxy.stop());
  const blocked = await proxyRequest(denyPort, `http://127.0.0.1:${targetPort}/`, `127.0.0.1:${targetPort}`);
  assert.equal(blocked.status, 403);
  // Phase 4 standardized AI-facing denial (Bumper attribution + what/why/fix + new sessions).
  assert.match(blocked.body, /bumper: security boundary refusal/i);
  assert.match(blocked.body, /What:/i);
  assert.match(blocked.body, /Why:/i);
  assert.match(blocked.body, /Fix:.*Sandbox.*egress/i);
  assert.match(blocked.body, /new sessions only/i);
});

test("proxy refuses CONNECT to non-allowlisted hosts", async (t) => {
  const events = [];
  const proxy = new EgressProxy(["api.anthropic.com"], (e) => events.push(e));
  const port = await proxy.listen("127.0.0.1");
  t.after(() => proxy.stop());
  const status = await new Promise((resolvePromise, reject) => {
    const req = request({ method: "CONNECT", host: "127.0.0.1", port, path: "blocked.example.com:443" });
    req.on("connect", (res) => { resolvePromise(res.statusCode); req.destroy(); });
    req.on("response", (res) => resolvePromise(res.statusCode));
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
  assert.ok(events.some((e) => e.method === "CONNECT" && !e.allowed && e.host === "blocked.example.com"));
});
