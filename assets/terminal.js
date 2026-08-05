(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const sessionId = params.get("session") || "";
  const titleEl = document.getElementById("term-title");
  const metaEl = document.getElementById("term-meta");
  const statusEl = document.getElementById("term-status");
  const helpTitle = document.getElementById("help-title");
  const helpBody = document.getElementById("help-body");

  function helpFor(session) {
    const kind = session?.kind || "agent";
    if (kind === "signin") {
      helpTitle.textContent = "Sign-in Sandbox";
      helpBody.innerHTML = `
        <p>Network is Open so this tool can finish its own login. Only this profile’s auth storage is mounted — Project files are not.</p>
        <ul>
          <li>Complete the vendor login in the terminal.</li>
          <li>Bumper never reads your token.</li>
          <li>When done, close this window. Use Verify again on the AI tools page if status looks wrong.</li>
          <li>Auth is not a hard gate for <code>bumper &lt;cli&gt;</code> — Launch anyway from the Project page if needed.</li>
        </ul>`;
      return;
    }
    if (kind === "shell") {
      helpTitle.textContent = "Sandbox shell";
      helpBody.innerHTML = `
        <p>Sandbox shell for this Project. Folder and network follow the Project policy.</p>
        <ul>
          <li>Daily work stays in your own terminal with <code>bumper &lt;cli&gt;</code>.</li>
          <li>Stop the session from Project → Sessions when finished.</li>
        </ul>`;
      return;
    }
    helpTitle.textContent = "Protected session";
    helpBody.innerHTML = `
      <p>Debug attach to a Sandbox session. This utility window is separate from the main Bumper control plane.</p>
      <ul>
        <li>Same session focuses this window instead of opening a duplicate.</li>
        <li>Stop from Project → Sessions if you need to end the process.</li>
      </ul>`;
  }

  if (!sessionId || !window.Terminal) {
    metaEl.textContent = "Missing session id.";
    return;
  }

  const term = new window.Terminal({
    fontSize: 13,
    lineHeight: 1.22,
    fontFamily: '"SFMono-Regular", Consolas, monospace',
    cursorBlink: true,
    theme: { background: "#111317", foreground: "#e8e9eb", cursor: "#7da2ff" },
    scrollback: 8000,
  });
  let fit = null;
  if (window.FitAddon) {
    fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
  }
  term.open(document.getElementById("terminal"));
  const resize = () => {
    try { fit?.fit(); } catch { /* ignore */ }
    if (socket?.readyState === 1) {
      socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  };
  setTimeout(resize, 0);
  window.addEventListener("resize", resize);

  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}/ws/sessions/${encodeURIComponent(sessionId)}`);
  socket.addEventListener("open", resize);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "snapshot") {
      const session = message.session || {};
      titleEl.textContent = session.agentName || "Bumper terminal";
      document.title = session.agentName || "Bumper terminal";
      const profile = session.profileId ? ` · profile ${session.profileId}` : "";
      metaEl.textContent = `${session.context || "—"}${profile} · ${session.backend || "room"}`;
      statusEl.textContent = session.status || "running";
      statusEl.className = `status-pill ${session.status || ""}`;
      helpFor(session);
      term.write(message.output || "");
    }
    if (message.type === "output") term.write(message.data || "");
    if (message.type === "status" && message.session) {
      statusEl.textContent = message.session.status || "";
      statusEl.className = `status-pill ${message.session.status || ""}`;
      term.options.cursorBlink = message.session.status === "running";
    }
  });
  socket.addEventListener("close", () => {
    metaEl.textContent = "Disconnected";
    term.options.cursorBlink = false;
  });
  term.onData((data) => {
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: "input", data }));
  });
})();
