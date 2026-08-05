/**
 * What a `window.open` from the renderer should do.
 *
 * Its own module because `src/electron.ts` imports `electron` at load time and so
 * cannot be exercised by a plain node test — and this decision needs a test.
 *
 * Regression (2026-07-26): the rule was `/^https:\/\//`. Bumper's GitHub hand-off
 * page lives on its own loopback origin (`http://127.0.0.1:<port>`), so opening it
 * matched nothing, `shell.openExternal` was never called, and the Connect GitHub
 * button showed a toast saying the browser had opened while nothing had.
 */
export type WindowOpenAction =
  | { kind: "terminal"; sessionId: string }
  | { kind: "external" }
  | { kind: "deny" };

export function windowOpenAction(url: string, appOrigin: string): WindowOpenAction {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { kind: "deny" }; }
  if (appOrigin && parsed.origin === appOrigin) {
    if (parsed.pathname === "/terminal.html") {
      const sessionId = parsed.searchParams.get("session") || "";
      return sessionId ? { kind: "terminal", sessionId } : { kind: "deny" };
    }
    // Bumper's own pages that must run in the user's browser, carrying their
    // GitHub session and a POST body Electron would otherwise drop.
    return { kind: "external" };
  }
  return parsed.protocol === "https:" ? { kind: "external" } : { kind: "deny" };
}
