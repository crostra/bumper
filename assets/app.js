(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const lines = (value) => String(value ?? "").split("\n").map((item) => item.trim()).filter(Boolean);
  const icons = (root) => {
    // Prefer the active route view so lucide does not walk the whole document.
    const fallback = () => {
      try {
        return document.querySelector(`#route-${route === "project" ? "project" : route}`) || document.body;
      } catch (_) {
        return document.body;
      }
    };
    const scope = root && root.querySelectorAll ? root : fallback();
    window.lucide?.createIcons({ attrs: { "aria-hidden": "true" }, root: scope });
  };
  const relative = (value) => {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    return seconds < 60 ? "just now" : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`;
  };
  const time = (value) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));

  const TOP_ROUTES = new Set(["projects", "events", "library", "settings", "setup", "create", "project"]);
  const PROJECT_SECTIONS = ["overview", "folders", "network", "development", "ai", "git", "connections"];
  const STORAGE_LAST_PROJECT = "bumper.lastProject";
  const STORAGE_SETUP_DONE = "bumper.systemSetupDone";
  // Prove-it results stay in memory for this app session only (no localStorage).
  // Drop any legacy key so old reloads do not resurrect a stale green stamp.
  try { localStorage.removeItem("bumper.boundaryProofs.v2"); localStorage.removeItem("bumper.boundaryProofs"); } catch { /* ignore */ }
  const PATH_GROUPS = [
    ["readPaths", "Extra read only", "book-open"],
    ["writePaths", "Extra read & write", "file-pen-line"],
    ["denyReadPaths", "Hidden", "eye-off"],
    ["denyWritePaths", "No writes", "file-lock-2"],
  ];
  const NEW_SESSION_EFFECT =
    "Takes effect on new sessions only (new bumper <cli>). The current session is unchanged.";
  const SETTINGS_CATEGORIES = [
    ["system", "settings.cat.system"],
    ["privacy", "settings.cat.privacy"],
    ["language", "settings.cat.language"],
    ["updates", "settings.cat.updates"],
    ["data", "settings.cat.data"],
    ["advanced", "settings.cat.advanced"],
  ];

  function t(key, vars) {
    if (typeof window.bumperT === "function") return window.bumperT(key, vars);
    return key;
  }

  /** Visual primitive: back navigation (arrow + label). Not for inline actions. */
  function backLink({ id, dataGo, label, icon = "arrow-left", className = "" } = {}) {
    const classes = ["back-link", className].filter(Boolean).join(" ");
    const attrs = [
      'type="button"',
      `class="${esc(classes)}"`,
      id ? `id="${esc(id)}"` : "",
      dataGo ? `data-go="${esc(dataGo)}"` : "",
    ].filter(Boolean).join(" ");
    return `<button ${attrs}><i data-lucide="${esc(icon)}"></i>${esc(label)}</button>`;
  }

  /** Visual primitive: horizontal in-page tabs (Project / Settings). */
  function pageSubnav({ id, items = [], dataAttr, className = "", ariaLabel = "Page sections" } = {}) {
    const classes = ["page-subnav", className].filter(Boolean).join(" ");
    const buttons = items.map((item) =>
      `<button type="button" class="subnav-item${item.active ? " active" : ""}" ${dataAttr}="${esc(item.id)}">${esc(item.label)}</button>`
    ).join("");
    return `<nav${id ? ` id="${esc(id)}"` : ""} class="${esc(classes)}" aria-label="${esc(ariaLabel)}">${buttons}</nav>`;
  }

  /** Visual primitive: full-width content panel with optional section-head. description/assurance/body are HTML. */
  function contentPanel({ title, description, assurance = "", body = "", className = "" } = {}) {
    const classes = ["panel", "content-panel", className].filter(Boolean).join(" ");
    const desc = description ? `<p>${description}</p>` : "";
    const head = title
      ? `<div class="section-head"><div><h2>${esc(title)}</h2>${desc}</div>${assurance}</div>`
      : "";
    return `<section class="${esc(classes)}">${head}${body}</section>`;
  }

  let state = null;
  let agents = [];
  let route = "projects";
  let projectSection = "overview";
  let selectedProject = null;
  let selectedAgent = null;
  let libraryView = "home"; // home | github-access | git-connections | git-connection-edit | mcp-integrations | mcp-integration-edit | mcp-connection-edit
  let libraryGitEdit = null; // { id?, returnTo? }
  let libraryMcpEdit = null; // { kind: "integration"|"connection", id?, integrationId?, returnTo? }
  /** When set, Library lists act as chooser for a Project (returnTo + banner + Use). */
  let libraryChooser = null; // { kind: "git"|"mcp", project: string, returnTo: string }
  let toastTimer = null;
  let editingProject = null;
  let roomPreflightCache = new Map();
  /** Server-owned AI proof plan, keyed by project + boundary fingerprint. */
  let aiProofPlanCache = new Map();
  let roomSetupStatus = null;
  let bootRouted = false;
  let settingsCategory = "system";
  let githubRefreshStatus = {};
  let githubRefreshBusy = new Set();
  let githubSetupIntent = null; // { project, repository, owner, resolution? }
  let githubAddAccountType = "personal";
  /** Library → GitHub access: personal/org picker is collapsed until the user asks to add. */
  let githubAddFormOpen = false;
  let projectGitIntentDraft = "";
  let projectGitIntentResult = null;
  /** Project → Git: add-form is collapsed when repos already exist (multi-repo list is primary). */
  let gitAddFormOpen = false;
  /** Last explicit live Git control result, keyed by host Session lease id. */
  let gitSessionFeedback = new Map();
  let lastDiagnostics = null;
  let proveItBusy = false;
  let sandboxDemoBusy = false;
  let sandboxDemoResult = null;

  let eventsRenderGen = 0;
  let eventsAbort = null;
  let routeRenderRaf = 0;
  let pendingRouteRender = false;
  let deferredRouteRender = false;
  let uiScrolling = false;
  let scrollIdleTimer = 0;
  let lastCountsKey = "";

  function abortEventsRender() {
    eventsRenderGen += 1;
    if (eventsAbort) {
      eventsAbort.abort();
      eventsAbort = null;
    }
  }

  function activeViewRoot() {
    return $(`#route-${route === "project" ? "project" : route}`) || document.body;
  }

  function finishPaint(root) {
    const scope = root && root.querySelectorAll ? root : activeViewRoot();
    icons(scope);
    window.bumperApplyI18n?.(scope);
  }

  /** Defer heavy route body work so nav/view toggles can paint first. */
  function scheduleRouteRender() {
    pendingRouteRender = true;
    if (routeRenderRaf) return;
    routeRenderRaf = requestAnimationFrame(() => {
      routeRenderRaf = requestAnimationFrame(() => {
        routeRenderRaf = 0;
        if (!pendingRouteRender) return;
        pendingRouteRender = false;
        renderRoute();
      });
    });
  }

  function noteUiScroll() {
    uiScrolling = true;
    if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(() => {
      uiScrolling = false;
      if (deferredRouteRender) {
        deferredRouteRender = false;
        scheduleRouteRender();
      }
    }, 180);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) } });
    if (options.signal?.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }
    const type = response.headers.get("content-type") || "";
    const value = type.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) throw new Error(value.error || value || `Request failed (${response.status})`);
    return value;
  }

  function toast(message, error = false) {
    const node = $("#toast");
    node.textContent = message;
    node.className = `toast show${error ? " error" : ""}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.className = "toast"; }, 3400);
  }

  function rememberProject(name) {
    if (!name) return;
    try { localStorage.setItem(STORAGE_LAST_PROJECT, name); } catch { /* ignore */ }
  }

  function lastRememberedProject() {
    try { return localStorage.getItem(STORAGE_LAST_PROJECT) || ""; } catch { return ""; }
  }

  function projectBoundaryFingerprint(project = {}) {
    return JSON.stringify({
      workspace: project.workspace || "",
      mode: project.effectiveMode || project.mode || "read-only",
      readPaths: project.effectiveReadPaths || project.readPaths || [],
      writePaths: project.effectiveWritePaths || project.writePaths || [],
      share: project.room?.workspaceShare || "whole",
      entries: project.room?.shareEntries || [],
      egress: project.room?.egress || "blocked",
      repos: (project.repos || []).map((repo) => repo.repo || repo),
      gitConnectionId: project.gitConnectionId || "",
    });
  }

  /**
   * A result with no named target is not evidence — it is a title with a ✓.
   * Reject those so the UI never paints "can't reach" without saying reach *what*.
   */
  function proofTargetOf(result) {
    const attempt = result?.attempt || {};
    return String(attempt.targetHost || attempt.target || "").trim();
  }

  function proofResultComplete(result) {
    if (!result) return false;
    // Idle plan cards only need a target to preview; completed ones also need a command.
    if (result._idle || result.observed == null) return Boolean(proofTargetOf(result));
    const cmd = result.command;
    const hasCommand = Array.isArray(cmd) ? cmd.length > 0 : Boolean(cmd);
    return Boolean(proofTargetOf(result)) && hasCommand;
  }

  function proofResultsComplete(results) {
    return Array.isArray(results) && results.length > 0 && results.every(proofResultComplete);
  }

  /** Drop in-session proof so a re-run never paints the previous pass as current. */
  function forgetProof(projectName = selectedProject) {
    if (!projectName) return;
    if (lastDiagnostics?.context === projectName) lastDiagnostics = null;
  }

  function setupDone() {
    try { return localStorage.getItem(STORAGE_SETUP_DONE) === "1"; } catch { return false; }
  }

  function markSetupDone() {
    try { localStorage.setItem(STORAGE_SETUP_DONE, "1"); } catch { /* ignore */ }
  }

  function needsSystemSetup() {
    if (!state) return false;
    if (setupDone()) return false;
    const projectCount = Object.keys(state.contexts || {}).length;
    const roomMissing = state.platform.macOS && !state.platform.room;
    return projectCount === 0 || roomMissing;
  }

  function syncHash() {
    let hash = "#/projects";
    if (route === "project" && selectedProject) hash = `#/projects/${encodeURIComponent(selectedProject)}/${projectSection}`;
    else if (route === "create") hash = "#/create";
    else if (route === "setup") hash = "#/setup";
    else if (route === "library" && libraryView === "github-access") hash = "#/library/github-access";
    else if (route === "library" && libraryView === "git-connections") hash = "#/library/git-connections";
    else if (route === "library" && libraryView === "git-connection-edit") {
      const id = libraryGitEdit?.id ? encodeURIComponent(libraryGitEdit.id) : "new";
      const qs = new URLSearchParams();
      if (libraryGitEdit?.returnTo) qs.set("returnTo", libraryGitEdit.returnTo);
      const q = qs.toString();
      hash = `#/library/git-connections/${id}${q ? `?${q}` : ""}`;
    }
    else if (route === "library" && libraryView === "mcp-integrations") hash = "#/library/mcp";
    else if (route === "library" && libraryView === "mcp-integration-edit") {
      const id = libraryMcpEdit?.id ? encodeURIComponent(libraryMcpEdit.id) : "new";
      hash = `#/library/mcp/${id}`;
    }
    else if (route === "library" && libraryView === "mcp-connection-edit") {
      const id = libraryMcpEdit?.id ? encodeURIComponent(libraryMcpEdit.id) : "new";
      const qs = new URLSearchParams();
      if (libraryMcpEdit?.integrationId) qs.set("integration", libraryMcpEdit.integrationId);
      if (libraryMcpEdit?.returnTo) qs.set("returnTo", libraryMcpEdit.returnTo);
      const q = qs.toString();
      hash = `#/library/mcp-connections/${id}${q ? `?${q}` : ""}`;
    }
    else if (TOP_ROUTES.has(route) && route !== "project") hash = `#/${route}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }

  function parseHash() {
    const raw = (location.hash || "").replace(/^#\/?/, "");
    if (!raw) return null;
    const [pathPart, queryPart] = raw.split("?");
    const parts = pathPart.split("/").map(decodeURIComponent);
    const query = new URLSearchParams(queryPart || "");
    if (parts[0] === "projects" && parts[1]) {
      const section = PROJECT_SECTIONS.includes(parts[2]) ? parts[2] : "overview";
      return { route: "project", project: parts[1], section };
    }
    if (parts[0] === "create") return { route: "create" };
    if (parts[0] === "setup") return { route: "setup" };
    // Phase 9-5/9-6: AI Library routes withdrawn → Settings → Privacy.
    if (parts[0] === "library" && parts[1] === "ai-profiles") {
      return { route: "settings", settingsCategory: "privacy" };
    }
    if (parts[0] === "library" && parts[1] === "github-access") {
      return { route: "library", libraryView: "github-access" };
    }
    if (parts[0] === "library" && parts[1] === "git-connections") {
      if (parts[2] === "new" || parts[2]) {
        return {
          route: "library",
          libraryView: "git-connection-edit",
          gitConnectionId: parts[2] === "new" ? "" : parts[2],
          returnTo: query.get("returnTo") || "",
        };
      }
      return { route: "library", libraryView: "git-connections" };
    }
    if (parts[0] === "library" && parts[1] === "mcp-connections") {
      return {
        route: "library",
        libraryView: "mcp-connection-edit",
        mcpConnectionId: parts[2] === "new" ? "" : (parts[2] || ""),
        mcpIntegrationId: query.get("integration") || "",
        returnTo: query.get("returnTo") || "",
      };
    }
    if (parts[0] === "library" && parts[1] === "mcp") {
      if (parts[2] === "new" || parts[2]) {
        return {
          route: "library",
          libraryView: "mcp-integration-edit",
          mcpIntegrationId: parts[2] === "new" ? "" : parts[2],
        };
      }
      return { route: "library", libraryView: "mcp-integrations" };
    }
    if (["projects", "events", "library", "settings"].includes(parts[0])) {
      return { route: parts[0], libraryView: parts[0] === "library" ? "home" : undefined };
    }
    return null;
  }

  function go(next, options = {}) {
    if (next === "tools" || next === "home" || next === "connections" || next === "verification" || next === "activity" || next === "blocked" || next === "sessions" || next === "global") {
      if (next === "tools" && selectedProject) {
        openProjectPage(selectedProject, "ai");
        return;
      }
      go("projects");
      return;
    }
    const leavingEvents = route === "events" && next !== "events";
    route = next;
    if (leavingEvents) abortEventsRender();
    if (options.project) {
      selectedProject = options.project;
      rememberProject(selectedProject);
    }
    if (options.section && PROJECT_SECTIONS.includes(options.section)) projectSection = options.section;
    if (options.libraryView) libraryView = options.libraryView;
    else if (next === "library" && !options.keepLibrary) libraryView = "home";
    if (options.settingsCategory) settingsCategory = options.settingsCategory;
    if (options.gitEdit) libraryGitEdit = options.gitEdit;
    if (options.mcpEdit) libraryMcpEdit = options.mcpEdit;
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.route === (route === "project" || route === "create" || route === "setup" ? "projects" : route)));
    $$(".view").forEach((view) => view.classList.toggle("active", view.id === `route-${route === "project" ? "project" : route}`));
    syncHash();
    // Paint chrome first; heavy innerHTML + lucide + i18n runs on the next frames.
    scheduleRouteRender();
  }





  function openLibraryGitConnections() {
    if (!libraryChooser || libraryChooser.kind !== "git") libraryChooser = null;
    go("library", { libraryView: "git-connections", keepLibrary: true });
  }

  function openLibraryGitHubAccess(options = {}) {
    libraryChooser = null;
    if (options?.intent) {
      githubSetupIntent = options.intent;
      const reconnect = options.intent.resolution?.status === "reconnect-required"
        ? options.intent.resolution.connections?.[0]
        : null;
      githubAddAccountType = reconnect
        ? (String(reconnect.ownerType).toLowerCase() === "organization" ? "organization" : "personal")
        : "";
      // Setup from a Project always needs the add form open.
      githubAddFormOpen = true;
    }
    go("library", { libraryView: "github-access", keepLibrary: true });
  }

  function openLibraryGitConnectionEdit({ id = "", returnTo = "" } = {}) {
    libraryGitEdit = { id, returnTo };
    go("library", { libraryView: "git-connection-edit", keepLibrary: true, gitEdit: libraryGitEdit });
  }

  function openLibraryMcpIntegrations() {
    if (!libraryChooser || libraryChooser.kind !== "mcp") libraryChooser = null;
    go("library", { libraryView: "mcp-integrations", keepLibrary: true });
  }

  function openLibraryMcpIntegrationEdit({ id = "" } = {}) {
    libraryMcpEdit = { kind: "integration", id };
    go("library", { libraryView: "mcp-integration-edit", keepLibrary: true, mcpEdit: libraryMcpEdit });
  }

  function openLibraryMcpConnectionEdit({ id = "", integrationId = "", returnTo = "" } = {}) {
    libraryMcpEdit = { kind: "connection", id, integrationId, returnTo };
    go("library", { libraryView: "mcp-connection-edit", keepLibrary: true, mcpEdit: libraryMcpEdit });
  }

  function emptyBindPanel({ message, ctaLabel, ctaId }) {
    return `<div class="empty-bind" role="status">
      <p>${esc(message)}</p>
      <button type="button" class="primary" id="${esc(ctaId)}"><i data-lucide="library"></i>${esc(ctaLabel)}</button>
    </div>`;
  }

  function libraryChooserBannerHtml() {
    if (!libraryChooser?.project) return "";
    return `<div class="library-chooser-banner" role="status">
      <div><b>Choosing for Project “${esc(libraryChooser.project)}”</b><small>Pick one or create the first.</small></div>
      <button type="button" class="tertiary" id="library-chooser-cancel">Back to Project</button>
    </div>`;
  }

  function wireLibraryChooserCancel(section) {
    $("#library-chooser-cancel")?.addEventListener("click", () => {
      const project = libraryChooser?.project;
      libraryChooser = null;
      if (project) openProjectPage(project, section);
      else go("library");
    });
  }

  function openLibraryToBind({ kind, projectName, tool = "", integrationId = "" } = {}) {
    const project = projectName || selectedProject;
    if (!project) return toast("Open a Project first.", true);
    if (kind === "ai") {
      // AI login is terminal-owned; no Library bind flow.
      toast(t("settings.privacy.ai_help"));
      go("settings", { settingsCategory: "privacy" });
      return;
    }
    if (kind === "git") {
      libraryChooser = {
        kind: "git",
        project,
        returnTo: `projects/${project}/git?select=`,
      };
      go("library", { libraryView: "git-connections", keepLibrary: true });
      return;
    }
    if (kind === "mcp") {
      libraryChooser = {
        kind: "mcp",
        project,
        returnTo: `projects/${project}/connections?select=${integrationId ? `${encodeURIComponent(integrationId)}:` : ""}`,
      };
      go("library", { libraryView: "mcp-integrations", keepLibrary: true });
      return;
    }
  }

  async function putProjectPatch(projectName, patch) {
    const project = state.contexts[projectName];
    if (!project) throw new Error("Project not found.");
    await api("/api/contexts", {
      method: "PUT",
      body: JSON.stringify({
        previous: projectName,
        name: projectName,
        description: project.description || "",
        workspace: project.workspace || "",
        mode: project.mode,
        inheritMode: project.inheritMode !== false,
        gitIgnored: project.gitIgnored || "visible",
        ...cloneProject(project),
        repos: (project.repos || []).map((repo) => repo.repo || repo),
        allowedHosts: project.allowedHosts || [],
        backends: project.backends || [],
        loginProfiles: project.loginProfiles || {},
        gitConnectionId: project.gitConnectionId || "",
        ...patch,
      }),
    });
    await refresh(false);
  }

  async function useLibraryItemForChooser(kind, itemId, toolId) {
    if (!libraryChooser?.project) return;
    const project = libraryChooser.project;
    const returnTo = libraryChooser.returnTo || `projects/${project}/${kind === "ai" ? "ai" : kind === "git" ? "git" : "connections"}?select=`;
    if (kind === "ai") {
      libraryChooser = null;
      toast(t("settings.privacy.ai_help"));
      openProjectPage(project, "ai");
      return;
    }
    if (kind === "git") {
      libraryChooser = null;
      await applyReturnToGitConnection(returnTo, itemId);
      return;
    }
    if (kind === "mcp") {
      libraryChooser = null;
      await applyReturnToMcpConnection(returnTo.includes("select=") ? returnTo : `projects/${project}/connections?select=`, itemId);
      return;
    }
  }



  async function applyReturnToGitConnection(returnTo, connectionId) {
    const target = parseReturnTo(returnTo);
    if (!target?.project || !state.contexts[target.project] || !connectionId) {
      openLibraryGitConnections();
      return;
    }
    const project = state.contexts[target.project];
    try {
      await api("/api/contexts", {
        method: "PUT",
        body: JSON.stringify({
          previous: target.project,
          name: target.project,
          description: project.description || "",
          workspace: project.workspace || "",
          mode: project.mode,
          inheritMode: project.inheritMode !== false,
          gitIgnored: project.gitIgnored || "visible",
          ...cloneProject(project),
          gitConnectionId: connectionId,
          repos: (project.repos || []).map((repo) => repo.repo || repo),
          allowedHosts: project.allowedHosts || [],
          backends: project.backends || [],
          loginProfiles: project.loginProfiles || {},
        }),
      });
      await refresh(false);
      toast(`Git Connection “${connectionId}” selected for ${target.project}.`);
      openProjectPage(target.project, "git");
    } catch (error) {
      toast(error.message, true);
      openLibraryGitConnections();
    }
  }


  function parseReturnTo(returnTo) {
    // Expected: projects/<name>/ai?select=<tool>:<profile> OR projects/<name>/git?select=<connectionId>
    const raw = String(returnTo || "").replace(/^#\/?/, "");
    const [path, query = ""] = raw.split("?");
    const parts = path.split("/").map(decodeURIComponent);
    const qs = new URLSearchParams(query);
    if (parts[0] === "projects" && parts[1] && parts[2] === "ai") {
      return { project: parts[1], section: "ai", select: qs.get("select") || "" };
    }
    if (parts[0] === "projects" && parts[1] && parts[2] === "git") {
      return { project: parts[1], section: "git", select: qs.get("select") || "" };
    }
    if (parts[0] === "projects" && parts[1] && parts[2] === "connections") {
      return { project: parts[1], section: "connections", select: qs.get("select") || "" };
    }
    return null;
  }

  async function applyReturnToMcpConnection(returnTo, connectionId) {
    const target = parseReturnTo(returnTo);
    if (!target?.project || !state.contexts[target.project] || !connectionId) {
      openLibraryMcpIntegrations();
      return;
    }
    const project = state.contexts[target.project];
    const conn = (state.mcpConnections || []).find((c) => c.id === connectionId);
    const integrationId = conn?.integrationId || String(target.select || "").split(":")[0] || "";
    if (!integrationId) {
      toast("Connection has no Integration.", true);
      openLibraryMcpIntegrations();
      return;
    }
    const cloned = cloneProject(project);
    const asMap = { ...(cloned.mcpBindings || {}) };
    asMap[integrationId] = connectionId;
    try {
      await api("/api/contexts", {
        method: "PUT",
        body: JSON.stringify({
          previous: target.project,
          name: target.project,
          description: project.description || "",
          workspace: project.workspace || "",
          mode: project.mode,
          inheritMode: project.inheritMode !== false,
          gitIgnored: project.gitIgnored || "visible",
          ...cloned,
          gitConnectionId: project.gitConnectionId || "",
          mcpBindings: asMap,
          repos: (project.repos || []).map((repo) => repo.repo || repo),
          allowedHosts: project.allowedHosts || [],
          backends: project.backends || [],
          loginProfiles: project.loginProfiles || {},
        }),
      });
      await refresh(false);
      toast(`Bound ${integrationId} → ${connectionId}.`);
      openProjectPage(target.project, "connections");
    } catch (error) {
      toast(error.message, true);
      openLibraryMcpIntegrations();
    }
  }

  async function applyReturnToSelection(returnTo, profileId) {
    const target = parseReturnTo(returnTo);
    if (target?.section === "git") {
      await applyReturnToGitConnection(returnTo, profileId);
      return;
    }
    if (target?.section === "connections") {
      await applyReturnToMcpConnection(returnTo, profileId);
      return;
    }
    // AI Library bind flow removed (Phase 9) — show Project AI facts only.
    if (target?.project && state.contexts[target.project]) {
      openProjectPage(target.project, "ai");
      return;
    }
    go("settings", { settingsCategory: "privacy" });
  }

  function authStatusLabel(status) {
    // Map legacy + unified vocab to connection-model display words.
    if (status === "verified" || status === "ready") return "Ready";
    if (status === "needs-signin") return "Needs sign-in";
    if (status === "needs-secret") return "Needs secret";
    if (status === "host-git") return "Host Git";
    if (status === "checking") return "Checking";
    return "Unverified";
  }

  function authStatusClass(status) {
    if (status === "verified" || status === "ready") return "signed";
    if (status === "needs-signin" || status === "needs-secret") return "needs";
    if (status === "host-git") return "host-git";
    if (status === "checking") return "checking";
    return "unknown";
  }

  /**
   * Unified Library/Project status vocab (connection-model decision).
   * Git always returns host-git — never Ready (we do not hold git secrets).
   */
  function connectionStatus(kind, item = {}) {
    if (kind === "git") return { key: "host-git", label: t("connection.status.hostGit"), className: "host-git" };
    if (kind === "mcp") {
      const ready = item.hasAllRequiredSecrets !== false && item.ready !== false;
      return ready
        ? { key: "ready", label: t("connection.status.ready"), className: "signed" }
        : { key: "needs-secret", label: t("connection.status.needsSecret"), className: "needs" };
    }
    // AI
    const raw = item.status || (item.persisted ? "unknown" : "needs-signin");
    if (raw === "verified" || raw === "ready") return { key: "ready", label: t("connection.status.ready"), className: "signed" };
    if (raw === "needs-signin") return { key: "needs-signin", label: t("connection.status.needsSignin"), className: "needs" };
    if (raw === "checking") return { key: "checking", label: t("connection.status.checking"), className: "checking" };
    return { key: "unverified", label: t("connection.status.unverified"), className: "unknown" };
  }

  /**
   * Shared list row: <identity> · <target> · <status> · actions.
   * Used by Library AI/Git/MCP and Project bind lists.
   */
  function connectionRow({ identity, target, statusHtml = "", actionsHtml = "", className = "" }) {
    return `<div class="connection-row library-template-row ${className}">
      <div class="connection-row-main">
        <b class="connection-identity">${esc(identity)}</b>
        <small class="connection-target">${esc(target)}</small>
        ${statusHtml}
      </div>
      <div class="connection-row-actions bound-row-actions">${actionsHtml}</div>
    </div>`;
  }

  function connectionStatusHtml(kind, item) {
    const s = connectionStatus(kind, item);
    return `<span class="tool-auth connection-status ${s.className}" data-status="${esc(s.key)}">${esc(s.label)}</span>`;
  }

  /**
   * Type catalog for Add — never the Library list itself.
   * options: [{ id, label, detail? }]
   *
   * `custom: false` omits the Custom tile. Only pass true where a custom type is
   * actually creatable — a tile whose only behaviour is explaining that it cannot be
   * used here is an unimplemented control, which the UI SSOT forbids in normal UI
   * (ui-control-plane.md §3).
   */
  function addConnectionPickerHtml({ kind, options = [], customId = "add-conn-custom", custom = false }) {
    const tiles = options.map((opt) => `
      <button type="button" class="add-conn-tile" data-kind="${esc(kind)}" data-type-id="${esc(opt.id)}">
        <b>${esc(opt.label)}</b>
        ${opt.detail ? `<small>${esc(opt.detail)}</small>` : ""}
      </button>`).join("");
    const customTile = custom
      ? `<button type="button" class="add-conn-tile muted" id="${esc(customId)}" data-kind="${esc(kind)}" data-type-id="__custom__">
          <b>${esc(t("connection.add.custom"))}</b><small>${esc(t("connection.add.customDetail"))}</small>
        </button>`
      : "";
    return `<div class="add-connection-picker" data-kind="${esc(kind)}">
      <div class="add-conn-head"><b>${esc(t("connection.add.chooseType"))}</b><button type="button" class="tertiary add-conn-cancel">${esc(t("connection.add.cancel"))}</button></div>
      <div class="add-conn-grid">${tiles}${customTile}</div>
    </div>`;
  }

  function openProjectPage(name, section = "overview") {
    if (!name || !state?.contexts?.[name]) {
      go("projects");
      return;
    }
    if (selectedProject !== name) clearProjectSections();
    if (selectedProject !== name) {
      projectGitIntentDraft = "";
      projectGitIntentResult = null;
      gitAddFormOpen = false;
    }
    selectedProject = name;
    rememberProject(name);
    projectSection = PROJECT_SECTIONS.includes(section) ? section : "overview";
    go("project");
  }

  function projectOptions(includeAll = false, selected = selectedProject || state.active) {
    return `${includeAll ? '<option value="">All projects</option>' : ""}${Object.keys(state.contexts).map((name) => `<option value="${esc(name)}"${name === selected ? " selected" : ""}>${esc(name)}</option>`).join("")}`;
  }

  function effectiveProject(name = selectedProject) {
    return state.contexts[name] || state.contexts[state.active];
  }

  function setSegment(id, value) {
    const root = $(id);
    if (!root) return;
    root.dataset.value = value;
    $$("button", root).forEach((button) => button.classList.toggle("active", button.dataset.value === value));
  }

  function accessSummary(project) {
    const roots = project.access?.roots || [];
    if (!roots.length && !project.workspace) return "No folder yet — open this Project and choose one under Folders";
    if (project.workspace) {
      const extra = Math.max(0, roots.length - 1);
      return extra ? `${project.workspace} · +${extra} more folder${extra === 1 ? "" : "s"}` : project.workspace;
    }
    return `${roots.length} folder${roots.length === 1 ? "" : "s"}`;
  }

  function projectNeedsSetup(project) {
    if (!project?.workspace && !(project?.access?.rootCount > 0)) return true;
    if (project.imageSource?.kind === "base") return true;
    return false;
  }

  function boundaryState(project) {
    if (!state.platform.macOS || !state.platform.room) return { label: "Protection unavailable", cls: "unavailable" };
    if (projectNeedsSetup(project)) return { label: "Needs setup", cls: "setup" };
    return { label: "Ready", cls: "ready" };
  }

  function currentImageSource(projectName = selectedProject) {
    const project = state?.contexts?.[projectName];
    return project?.imageSource || { kind: "custom", label: "Sandbox image" };
  }

  function isBaseRoomImage(projectName = selectedProject) {
    return currentImageSource(projectName).kind === "base";
  }

  function baseImageSetupReadiness() {
    const apiGate = globalThis.BumperLaunchGate;
    if (apiGate?.baseImageSetupReadiness) return apiGate.baseImageSetupReadiness();
    return {
      status: "setup",
      label: "Sandbox image setup",
      detail: "Safe base image intentionally has no AI CLIs. Build the recommended image or choose your own.",
    };
  }

  function preflightKey(agentId, workspace, projectName = selectedProject) {
    const project = state?.contexts?.[projectName];
    return [projectName || "", workspace || "", project?.room?.image || "", project?.room?.egress || "", agentId].join("\u0000");
  }

  function roomReadiness(agentId, workspace, projectName = selectedProject) {
    const agent = agents.find((item) => item.id === agentId);
    const ws = workspace ?? state?.contexts?.[projectName]?.workspace ?? "";
    if (!agent?.roomCommand?.length) return { status: "unmapped", label: "No Sandbox command", detail: "No Sandbox command is mapped for this tool." };
    if (!state.platform.room) return { status: "unavailable", label: "Sandbox unavailable", detail: "Apple container is not available on this Mac." };
    if (!ws) return { status: "waiting", label: "Choose workspace", detail: "Choose a workspace before checking this image." };
    const cached = roomPreflightCache.get(preflightKey(agentId, ws, projectName));
    if (cached) return cached;
    if (isBaseRoomImage(projectName)) return baseImageSetupReadiness();
    return { status: "pending", label: "Queued image check", detail: "Bumper will check this Sandbox image before launch." };
  }

  function ensureRoomPreflightStatuses(projectName = selectedProject, workspace, options = {}) {
    if (!state?.platform?.room || !projectName || !workspace) return;
    if (isBaseRoomImage(projectName)) return;
    const mode = options.mode === "selected" ? "selected" : "all";
    const gate = globalThis.BumperLaunchGate;
    if (mode === "selected" && gate?.shouldAutoPreflightOnHome && !gate.shouldAutoPreflightOnHome(currentImageSource(projectName).kind)) {
      return;
    }
    const targets = mode === "selected"
      ? agents.filter((agent) => agent.id === selectedAgent && agent.roomCommand?.length)
      : agents.filter((agent) => agent.roomCommand?.length);
    for (const agent of targets) {
      const key = preflightKey(agent.id, workspace, projectName);
      if (roomPreflightCache.has(key)) continue;
      roomPreflightCache.set(key, { status: "checking", label: "Checking image…", detail: "Checking whether the selected Sandbox image contains this CLI." });
      api("/api/room/preflight", { method: "POST", body: JSON.stringify({ agentId: agent.id, context: projectName, workspace }) })
        .then((data) => {
          const ok = !!(data.available && data.ok);
          roomPreflightCache.set(key, {
            status: ok ? "ready" : "missing",
            label: ok ? "Ready in image" : "Missing in image",
            detail: data.detail || "Sandbox image check finished.",
          });
        })
        .catch((error) => {
          roomPreflightCache.set(key, { status: "missing", label: "Check failed", detail: error.message });
        })
        .finally(() => {
          if (route === "project" && projectSection === "overview") renderProjectOverview();
          if (route === "project" && projectSection === "ai") renderProjectAi();
        });
    }
  }

  function shellQuote(value) {
    const text = String(value ?? "");
    return `'${text.replace(/'/g, "'\"'\"'")}'`;
  }

  function cliCommandFor(agentId, projectName = selectedProject) {
    const agent = agents.find((item) => item.id === agentId);
    const cmd = agent?.roomCommand?.[0] || agent?.id || "claude";
    return projectName ? `bumper -p ${shellQuote(projectName)} ${cmd}` : `bumper ${cmd}`;
  }

  function renderShell() {
    // No permanent sidebar readiness chip — normal is silent.
    // Missing Sandbox runtime still uses the main fatal banner; Settings shows Sandbox status.
    const roomOk = state.platform.macOS && state.platform.room;
    const banner = $("#fatal-banner");
    banner.classList.toggle("hidden", roomOk || route === "setup");
    const containerMissing = state.platform.macOS && !state.platform.room;
    $("#fatal-title").textContent = !state.platform.macOS ? "Protection unavailable" : "Apple container not installed";
    $("#fatal-message").textContent = !state.platform.macOS
      ? "The Sandbox boundary requires macOS with Apple container. Bumper will not claim a protected session without it."
      : "Bumper runs every protected session in a sealed room (Apple container). Install it once, then relaunch Bumper.";
    $("#fatal-actions").classList.toggle("hidden", !containerMissing);
  }

  async function chooseFolder(callback) {
    try {
      const result = await api("/api/pick-folder", { method: "POST" });
      if (result.dir) callback(result.dir.replace(/\/$/, ""));
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function bindWorkspaceAccess(projectName, folder, options = {}) {
    const name = projectName || selectedProject;
    const path = String(folder || "").replace(/\/$/, "");
    if (!name || !path) return false;
    try {
      const result = await api("/api/access/workspace", {
        method: "POST",
        body: JSON.stringify({ context: name, workspace: path }),
      });
      await refresh(false);
      if (options.quiet) return true;
      if (result.bindsHome) toast("Access bound to your home folder — a very large share. Prefer a project folder.", true);
      else toast(`Access root set for ${name}.`);
      return true;
    } catch (error) {
      toast(error.message, true);
      return false;
    }
  }

  function cloneProject(project = {}) {
    return {
      readPaths: [...(project.readPaths || [])],
      writePaths: [...(project.writePaths || [])],
      denyReadPaths: [...(project.denyReadPaths || [])],
      denyWritePaths: [...(project.denyWritePaths || [])],
      commands: { ...(project.commands || {}) },
      native: { allow: [...(project.native?.allow || [])], deny: [...(project.native?.deny || [])] },
      loginProfiles: { ...(project.loginProfiles || {}) },
      autoApprove: project.autoApprove === true,
      development: structuredClone(project.development || {
        preview: { enabled: true },
        docker: { enabled: true },
      }),
      gitConnectionId: project.gitConnectionId || "",
      mcpBindings: Object.fromEntries((project.mcpBindings || []).map((b) => [b.integrationId, b.connectionId])),
      appliedPermissionSetup: project.appliedPermissionSetup || "",
      room: {
        enabled: true,
        image: project.room?.image || "docker.io/library/alpine:3.20",
        // Carry the allowlist through: cloneProject feeds every tab's Save
        // payload, so dropping these here would silently clear the Project's
        // allowed sites whenever the user saved Folders, AI or Git.
        egress: normalizeEgress(project.room?.egress),
        egressTemplates: [...(project.room?.egressTemplates || [])],
        egressHosts: [...(project.room?.egressHosts || [])],
        workspaceShare: project.room?.workspaceShare || "whole",
        shareSubpaths: [...(project.room?.shareSubpaths || [])],
        shareEntries: (project.room?.shareEntries || []).map((entry) => ({
          path: entry.path,
          access: entry.access === "read-only" ? "read-only" : "read-write",
        })),
        doors: [...(project.room?.doors || [])],
      },
    };
  }

  /** In-memory Folders draft for the open Project page (Apply commits via API). */
  let folderDraft = null;
  /** In-memory MCP bindings draft (integrationId → connectionId). */
  let mcpBindingDraft = null;

  function defaultFolderDraft(project = {}) {
    const folders = project.folders?.draft;
    if (folders) {
      return {
        editor: folders.editor || "simple",
        workspaceAccess: folders.workspaceAccess === "read-only" ? "read-only" : "read-write",
        workspaceShare: folders.workspaceShare === "selected" ? "selected" : "whole",
        entries: (folders.entries || []).map((e) => ({
          path: e.path,
          access: e.access === "read-only" ? "read-only" : "read-write",
        })),
        extraReadPaths: [...(folders.extraReadPaths || project.readPaths || [])],
        extraWritePaths: [...(folders.extraWritePaths || project.writePaths || [])],
      };
    }
    return {
      editor: "simple",
      workspaceAccess: project.mode === "read-only" ? "read-only" : "read-write",
      workspaceShare: project.room?.workspaceShare === "selected" ? "selected" : "whole",
      entries: (project.room?.shareEntries || []).map((e) => ({
        path: e.path,
        access: e.access === "read-only" ? "read-only" : "read-write",
      })),
      extraReadPaths: [...(project.readPaths || [])],
      extraWritePaths: [...(project.writePaths || [])],
    };
  }

  function ensureFolderDraft(project) {
    if (!folderDraft || folderDraft._project !== selectedProject) {
      folderDraft = { ...defaultFolderDraft(project), _project: selectedProject };
    }
    return folderDraft;
  }

  /** Comparable snapshot of folder policy — used to enable Apply only when dirty. */
  function folderDraftFingerprint(draft) {
    const entries = (draft?.entries || [])
      .map((e) => `${e.path}\0${e.access === "read-only" ? "ro" : "rw"}`)
      .sort();
    const reads = [...(draft?.extraReadPaths || [])].map(String).sort();
    const writes = [...(draft?.extraWritePaths || [])].map(String).sort();
    return JSON.stringify({
      share: draft?.workspaceShare === "selected" ? "selected" : "whole",
      access: draft?.workspaceAccess === "read-only" ? "ro" : "rw",
      entries,
      reads,
      writes,
    });
  }

  function isFolderDraftDirty(draft, project) {
    return folderDraftFingerprint(draft) !== folderDraftFingerprint(defaultFolderDraft(project));
  }

  function sandboxDemoHtml() {
    const results = sandboxDemoResult?.results || [];
    const passed = results.filter((result) => result.contained).length;
    const stateClass = results.length && passed === results.length ? "verified" : sandboxDemoBusy ? "running" : "";
    const rows = results.length
      ? results.map((result) => `<div class="demo-proof-row ${result.contained ? "pass" : "fail"}"><span>${result.contained ? "✓" : "✗"}</span><div><b>${esc(result.title)}</b><small>${esc(result.evidence)}</small></div></div>`).join("")
      : sandboxDemoResult?.available === false
        ? `<div class="demo-unavailable"><b>Live demo unavailable</b><small>${esc(sandboxDemoResult.detail || "Apple container is not ready on this Mac.")}</small></div>`
        : '<div class="demo-visual"><span class="demo-ai"><i data-lucide="bot"></i>AI</span><span class="demo-arrow">→</span><span class="demo-wall">Sandbox wall</span><span class="demo-blocked">× Your Mac</span></div>';
    return `<article class="live-demo-card panel ${stateClass}">
      <div class="live-demo-copy">
        <span class="eyebrow">20-second live demo</span>
        <h2>Watch a real sandbox stop an escape</h2>
        <p>Bumper creates a disposable sample folder — never one of yours — then tests the host disk, read-only files, network, and DNS in a real Apple container Sandbox.</p>
      </div>
      <div class="demo-proof-list">${sandboxDemoBusy ? '<p class="compose-note">Starting the room and testing the walls…</p>' : rows}</div>
      <div class="live-demo-actions">
        ${results.length ? `<span class="demo-score">${passed}/${results.length} walls held</span>` : '<span class="demo-score">No Project required</span>'}
        <button type="button" class="${results.length ? "secondary" : "primary"} run-sandbox-demo" ${sandboxDemoBusy ? "disabled" : ""}><i data-lucide="${results.length ? "rotate-cw" : "play"}"></i>${results.length ? "Run again" : "See it work"}</button>
        ${results.length && passed === results.length ? '<button type="button" class="primary" data-go="create"><i data-lucide="plus"></i>Use my folder</button>' : ""}
      </div>
    </article>`;
  }

  async function runSandboxDemo() {
    if (sandboxDemoBusy) return;
    sandboxDemoBusy = true;
    if (route === "setup") renderSetup();
    else renderProjects();
    try {
      sandboxDemoResult = await api("/api/room/breakout", { method: "POST" });
      if (!sandboxDemoResult.available) toast(sandboxDemoResult.detail || "Sandbox runtime unavailable.", true);
      else if ((sandboxDemoResult.results || []).every((result) => result.contained)) toast("Every live escape attempt was contained.");
      else toast("A live check did not hold. Do not treat protection as verified.", true);
    } catch (error) {
      sandboxDemoResult = { available: false, detail: error.message, results: [] };
      toast(error.message, true);
    } finally {
      sandboxDemoBusy = false;
      if (route === "setup") renderSetup();
      else if (route === "projects") renderProjects();
    }
  }

  function wireSandboxDemo(root = document) {
    $$(".run-sandbox-demo", root).forEach((button) => button.addEventListener("click", runSandboxDemo));
  }

  function renderSetup() {
    const roomOk = state.platform.macOS && state.platform.room;
    const projectCount = Object.keys(state.contexts).length;
    const steps = [
      {
        id: "container",
        title: "Sandbox runtime",
        detail: roomOk
          ? "Apple container is ready."
          : "Install Apple container to run sealed Sandboxes.",
        status: roomOk ? "ready" : "blocked",
        action: roomOk ? null : { label: "Show install command", run: () => { $("#fatal-banner")?.classList.remove("hidden"); $("#fatal-copy")?.focus(); } },
      },
      {
        id: "cli",
        title: "The bumper command",
        detail: "Start tools with bumper in front — e.g. bumper claude.",
        status: "ready",
        action: { label: "Copy bumper status", run: async () => { try { await navigator.clipboard.writeText("bumper status"); toast("Copied: bumper status"); } catch { toast("Copy failed", true); } } },
      },
      {
        id: "project",
        title: "First Project",
        detail: projectCount
          ? `${projectCount} Project${projectCount === 1 ? "" : "s"} ready.`
          : "Choose one folder the AI may use.",
        status: projectCount ? "ready" : "blocked",
        action: projectCount
          ? { label: "Open Projects", run: () => { markSetupDone(); go("projects"); } }
          : { label: "Create First Project", run: () => go("create") },
      },
    ];
    $("#setup-steps").innerHTML = sandboxDemoHtml() + steps.map((step) => `
      <article class="setup-card ${esc(step.status)}">
        <div class="setup-card-mark" aria-hidden="true">${step.status === "ready" ? "✓" : "!"}</div>
        <div><b>${esc(step.title)}</b><p>${esc(step.detail)}</p></div>
        ${step.action ? `<button type="button" class="secondary setup-action" data-setup-action="${esc(step.id)}">${esc(step.action.label)}</button>` : ""}
      </article>`).join("") + `
      <div class="dialog-actions">
        <button type="button" class="tertiary" id="setup-skip">Continue to Projects</button>
        ${projectCount && roomOk ? '<button type="button" class="primary" id="setup-finish">Finish setup</button>' : ""}
      </div>`;
    $$("[data-setup-action]").forEach((button) => {
      const step = steps.find((item) => item.id === button.dataset.setupAction);
      button.addEventListener("click", () => step?.action?.run());
    });
    $("#setup-skip")?.addEventListener("click", () => { markSetupDone(); go("projects"); });
    $("#setup-finish")?.addEventListener("click", () => { markSetupDone(); go("projects"); });
    wireSandboxDemo($("#setup-steps"));
    wireGo($("#setup-steps"));
    icons();
  }

  function projectLastEventMs(project) {
    const ts = project?.lastEventAt;
    if (!ts) return 0;
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? ms : 0;
  }

  function projectLastEventLabel(project) {
    const ts = project?.lastEventAt;
    if (!ts || !Date.parse(ts)) return "";
    // Same relative helper as Events; absolute time in title for precision.
    return relative(ts);
  }

  function renderProjects() {
    const query = ($("#project-search")?.value || "").trim().toLowerCase();
    // Config object order is creation order — secondary sort after last Event.
    const order = Object.keys(state.contexts);
    const entries = Object.entries(state.contexts).filter(([name, project]) => {
      if (!query) return true;
      const gitNames = projectGitBindings(project).map((row) => row.fullName || "").join(" ");
      const mcpNames = (Array.isArray(project.mcpBindings) ? project.mcpBindings : [])
        .map((row) => `${row.connectionName || ""} ${row.integrationName || ""}`)
        .join(" ");
      return name.toLowerCase().includes(query)
        || (project.workspace || "").toLowerCase().includes(query)
        || (project.description || "").toLowerCase().includes(query)
        || gitNames.toLowerCase().includes(query)
        || mcpNames.toLowerCase().includes(query);
    }).sort(([nameA, projectA], [nameB, projectB]) => {
      const ta = projectLastEventMs(projectA);
      const tb = projectLastEventMs(projectB);
      if (ta !== tb) return tb - ta;
      return order.indexOf(nameA) - order.indexOf(nameB);
    });
    $("#project-list").innerHTML = entries.length
      ? entries.map(([name, project]) => {
        const boundary = boundaryState(project);
        // Only tools this Project actually uses — listing all five said nothing.
        const signedIn = agents.filter((agent) =>
          toolSignedInForProject(project, agent.id) || project.loginProfiles?.[agent.id]);
        const tools = signedIn.length
          ? signedIn.map((agent) => agent.shortName).slice(0, 4).join(" · ")
          : "No tool signed in yet";
        // Bound GitHub repos are often the real identity of a Project (folder
        // names collide; owner/repo usually does not). Quiet fact, not a green chip.
        const gitSummary = projectGitRepositorySummary(project);
        const mcpSummary = projectMcpSummary(project);
        // Ready / Access N chips were always-on green noise: path is already under
        // the title, and Ready is the normal case. Only surface boundary when it
        // is not ready; tools stay as quiet secondary fact.
        const boundaryFact = boundary.cls !== "ready"
          ? `<span class="fact ${boundary.cls === "unavailable" ? "bad" : "warn"}"><i data-lucide="shield"></i>${esc(boundary.label)}</span>`
          : "";
        const lastLabel = projectLastEventLabel(project);
        const lastAbs = project.lastEventAt && Date.parse(project.lastEventAt)
          ? new Date(project.lastEventAt).toLocaleString()
          : "";
        return `<article class="list-row project-card open-project" data-project="${esc(name)}" tabindex="0" role="link" aria-label="Open ${esc(name)}">
          <div>
            <div class="project-title"><b>${esc(name)}</b></div>
            <div class="project-description">${esc(project.description || "No description")}</div>
            <div class="project-path" title="Folders used when matching this Mac folder for bumper">${esc(accessSummary(project))}</div>
            ${gitSummary ? `<div class="project-meta-line project-git" title="GitHub repositories bound to this Project"><i data-lucide="git-branch"></i><span>${esc(gitSummary)}</span></div>` : ""}
            ${mcpSummary ? `<div class="project-meta-line project-mcp" title="MCP connections bound to this Project"><i data-lucide="plug"></i><span>${esc(mcpSummary)}</span></div>` : ""}
          </div>
          <div class="project-facts">
            ${boundaryFact}
            <span class="fact"><i data-lucide="bot"></i>${esc(tools)}</span>
            ${lastLabel
              ? `<span class="fact" title="${esc(lastAbs)}"><i data-lucide="clock"></i>${esc(lastLabel)}</span>`
              : `<span class="fact muted-fact" title="No Events for this Project yet"><i data-lucide="clock"></i>No activity</span>`}
          </div>
          ${Object.keys(state.contexts).length > 1
            ? `<div class="project-actions">
            <button class="icon-button delete-project" data-project="${esc(name)}" title="Delete" type="button" aria-label="Delete ${esc(name)}"><i data-lucide="trash-2"></i></button>
          </div>`
            : `<div class="project-actions" aria-hidden="true"></div>`}
        </article>`;
      }).join("")
      : `<div class="projects-first-run">${sandboxDemoHtml()}<div class="panel empty-state"><p>Ready to contain your own AI?</p><button class="primary" type="button" data-go="create"><i data-lucide="plus"></i>Create First Project</button></div></div>`;
    $$(".open-project").forEach((card) => {
      const open = () => openProjectPage(card.dataset.project, "overview");
      card.addEventListener("click", (event) => {
        if (event.target.closest(".delete-project")) return;
        open();
      });
      card.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (event.target.closest(".delete-project")) return;
        event.preventDefault();
        open();
      });
    });
    $$(".delete-project").forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteProject(button.dataset.project);
    }));
    wireGo($("#project-list"));
    wireSandboxDemo($("#project-list"));
    icons();
  }

  /**
   * Write a Project section body and stamp which Project it belongs to.
   *
   * Section bodies live in the DOM and outlive the selection, so switching Projects
   * used to leave the previous Project's content in the inactive sections. If the next
   * render was deferred at all (double rAF, a slow /api/state, an in-flight refresh),
   * the stale body was visible under the new Project's title — Project A showing
   * Project B's AI tools. Fast is not a fix for wrong: the stamp lets
   * syncProjectSubnav() blank anything that does not belong to the current Project,
   * so a mismatch shows nothing instead of showing another Project's facts.
   */
  function setProjectSection(section, html) {
    const node = $(`#project-section-${section}`);
    if (!node) return null;
    node.innerHTML = html;
    node.dataset.project = selectedProject || "";
    return node;
  }

  /** Drop every section body — used when the selected Project changes. */
  function clearProjectSections() {
    PROJECT_SECTIONS.forEach((section) => {
      const node = $(`#project-section-${section}`);
      if (!node) return;
      node.innerHTML = "";
      delete node.dataset.project;
    });
  }

  function syncProjectSubnav() {
    $$(".subnav-item").forEach((button) => button.classList.toggle("active", button.dataset.projectSection === projectSection));
    PROJECT_SECTIONS.forEach((section) => {
      const node = $(`#project-section-${section}`);
      if (!node) return;
      // Never let another Project's body become visible, even for one frame.
      if (node.dataset.project !== undefined && node.dataset.project !== (selectedProject || "")) {
        node.innerHTML = "";
        delete node.dataset.project;
      }
      node.classList.toggle("active", section === projectSection);
    });
  }

  function renderProjectPage() {
    const project = effectiveProject();
    if (!project || !selectedProject) {
      go("projects");
      return;
    }
    $("#project-page-title").textContent = selectedProject;
    $("#project-page-subtitle").textContent = accessSummary(project);
    syncProjectSubnav();
    if (projectSection === "overview") renderProjectOverview();
    else if (projectSection === "folders") renderProjectFolders();
    else if (projectSection === "network") renderProjectNetwork();
    else if (projectSection === "development") renderProjectDevelopment();
    else if (projectSection === "ai") renderProjectAi();
    else if (projectSection === "git") renderProjectGit();
    else if (projectSection === "connections") renderProjectConnections();
  }

  function normalizeEgress(egress) {
    return egress === "open" || egress === "allowlist" ? egress : "blocked";
  }

  function networkLabel(egress) {
    if (egress === "open") return "Open — unrestricted";
    if (egress === "allowlist") return "Allowed sites only";
    return "Off — no network";
  }

  /** One-line label next to the choices — fact only, no lecture. */
  function networkModeNote(egress) {
    if (egress === "open") return "Full internet";
    if (egress === "allowlist") return "Only the sites you allow below";
    return "No internet";
  }

  /**
   * Off and Allowed-only are both real VM guarantees: Off has no network device,
   * and Allowed-only runs the room on a host-only network whose single reachable
   * address is this Mac's filtering proxy. Open is unrestricted (not a filter).
   * Long caveats live in Limits — not on this control.
   */
  function networkAssuranceBadge(egress) {
    if (egress === "open") {
      return '<span class="assurance neutral"><i data-lucide="globe"></i>Unfiltered by choice</span>';
    }
    if (egress === "allowlist") {
      return '<span class="assurance os"><i data-lucide="shield-check"></i>Allowed sites only</span>';
    }
    return '<span class="assurance os"><i data-lucide="box"></i>Isolated</span>';
  }

  function projectDevelopmentSessions(projectName = selectedProject) {
    return (state.developmentSessions || []).filter((session) =>
      session.projectName === projectName && session.live);
  }

  async function saveDevelopmentPreference(capability, enabled) {
    const project = effectiveProject();
    if (!project || !selectedProject) return;
    const development = structuredClone(project.development || {
      preview: { enabled: true },
      docker: { enabled: true },
    });
    development[capability] = { enabled };
    try {
      await api("/api/contexts", {
        method: "PUT",
        body: JSON.stringify({
          ...cloneProject(project),
          previous: selectedProject,
          name: selectedProject,
          development,
        }),
      });
      await refresh(false);
      toast(t("development.default_updated", {
        capability: t(capability === "preview" ? "development.preview" : "development.docker"),
        state: t(enabled ? "development.on" : "development.off"),
      }));
      renderProjectDevelopment();
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function setLiveDevelopmentCapability(sessionId, capability, enabled) {
    try {
      await api("/api/development/session-control", {
        method: "POST",
        body: JSON.stringify({ sessionId, capability, enabled }),
      });
      // The host brokers reconcile every 400 ms. Repaint after that boundary
      // change so closed mappings and stopped Engine state do not linger.
      await new Promise((resolve) => setTimeout(resolve, 450));
      await refresh(false);
      toast(t("development.session_updated", {
        capability: t(capability === "preview" ? "development.preview" : "development.docker"),
        state: t(enabled ? "development.on" : "development.off"),
      }));
      renderProjectDevelopment();
    } catch (error) {
      toast(error.message, true);
    }
  }

  function developmentLiveSessionsHtml(sessions) {
    if (!sessions.length) {
      return `<section class="git-live-sessions">
        <div class="git-live-heading"><div><h3>Live Sessions</h3>
          <p>Start <code>bumper -p ${esc(shellQuote(selectedProject))} &lt;cli&gt;</code> to open Preview ports and Docker status here.</p></div>
          <span class="git-live-count">0 live</span></div>
        <div class="git-live-empty">No running Session. Project defaults above apply to the next Session only.</div>
      </section>`;
    }
    const rows = sessions.map((session) => {
      const dockerDetail = session.dockerError
        ? t("development.failed", { error: session.dockerError })
        : session.dockerStatus === "ready"
          ? "Engine Sandbox ready"
          : session.dockerStatus === "starting"
            ? "Engine Sandbox starting…"
            : "Engine starts on the first docker command";
      const previewDetail = session.previewError
        ? session.previewError
        : t("development.live_ports", { count: (session.previewPorts || []).length });
      const previews = (session.previewPorts || []).map((mapping) => `
        <div class="connection-row">
          <div class="connection-icon"><i data-lucide="${mapping.source === "docker" ? "box" : "monitor-up"}"></i></div>
          <div class="connection-row-main">
            <b>${mapping.source === "docker" ? "Docker" : "Sandbox"} :${mapping.roomPort}</b>
            <p class="mono">${esc(mapping.url)}</p>
          </div>
          <div class="connection-row-actions">
            <button type="button" class="tertiary development-copy-preview" data-url="${esc(mapping.url)}">Copy</button>
            <button type="button" class="secondary development-open-preview" data-session="${esc(session.id)}" data-port="${mapping.hostPort}">Open</button>
          </div>
        </div>`).join("")
        || `<p class="fact-line muted">${session.previewEnabled ? "Waiting for a server in the Sandbox…" : "Local Preview is Off for this Session."}</p>`;
      return `<div class="git-live-row development-session-row" data-development-session="${esc(session.id)}">
        <div class="development-session-top">
          <div class="git-live-main">
            <div class="git-live-title"><span class="live-dot" aria-hidden="true"></span><b>${esc(session.agentName || session.agentId)}</b>
              <span class="muted mono">${esc(String(session.id || "").slice(0, 8))}</span></div>
            <p>${esc(t("development.started", { time: relative(session.startedAt) }))}</p>
          </div>
          <div class="git-live-actions development-session-switches">
            <label class="git-live-switch" title="${esc(previewDetail)}">
              <input type="checkbox" class="development-session-toggle" data-session="${esc(session.id)}" data-capability="preview" ${session.previewEnabled ? "checked" : ""}>
              <span class="switch-track" aria-hidden="true"></span><span>Preview</span>
            </label>
            <label class="git-live-switch" title="${esc(dockerDetail)}">
              <input type="checkbox" class="development-session-toggle" data-session="${esc(session.id)}" data-capability="docker" ${session.dockerEnabled ? "checked" : ""}>
              <span class="switch-track" aria-hidden="true"></span><span>Docker</span>
            </label>
          </div>
        </div>
        <div class="development-session-facts">
          <p class="fact-line"><span>Preview</span>${esc(previewDetail)}</p>
          <p class="fact-line"><span>Docker</span>${esc(dockerDetail)}</p>
        </div>
        <div class="connection-list development-preview-list">${previews}</div>
      </div>`;
    }).join("");
    return `<section class="git-live-sessions">
      <div class="git-live-heading"><div><h3>Live Sessions</h3>
        <p>Apply to the running Session immediately.</p></div>
        <span class="git-live-count">${sessions.length} live</span></div>
      <div class="git-live-list">${rows}</div>
    </section>`;
  }

  function renderProjectDevelopment() {
    const project = effectiveProject();
    if (!project) return;
    const preference = project.development || { preview: { enabled: true }, docker: { enabled: true } };
    const sessions = projectDevelopmentSessions();
    // Same shell as Network / Git / Connections: contentPanel + policy-section.
    // Defaults use Settings-style setting-row; live control reuses Git Live Sessions.
    setProjectSection("development", contentPanel({
      title: "Development",
      assurance: `<span class="assurance hook"><i data-lucide="key-round"></i>Controlled per Session</span>`,
      className: "policy-section",
      body: `
        <div class="settings-list">
          <div class="setting-row">
            <i data-lucide="monitor-up"></i>
            <div>
              <b>Local Preview</b>
              <p>Open Sandbox servers in the browser (loopback only).</p>
            </div>
            <label class="git-live-switch">
              <input type="checkbox" class="development-default-toggle" data-capability="preview" ${preference.preview?.enabled !== false ? "checked" : ""} aria-label="Local Preview default for new Sessions">
              <span class="switch-track" aria-hidden="true"></span>
            </label>
          </div>
          <div class="setting-row">
            <i data-lucide="box"></i>
            <div>
              <b>Docker</b>
              <p>Project-only Docker VM (not the Mac Docker socket).</p>
            </div>
            <label class="git-live-switch">
              <input type="checkbox" class="development-default-toggle" data-capability="docker" ${preference.docker?.enabled !== false ? "checked" : ""} aria-label="Docker default for new Sessions">
              <span class="switch-track" aria-hidden="true"></span>
            </label>
          </div>
        </div>
        <p class="compose-note">Defaults apply to new Sessions only.</p>
        ${developmentLiveSessionsHtml(sessions)}
        <details class="bind-extra">
          <summary>What Development does not cover</summary>
          <p class="fact-line">Native macOS/iOS builds, Xcode simulators, and Mac GUI previews need the host — not available inside a Sandbox.</p>
        </details>`,
    }));
    const root = $("#project-section-development");
    $$(".development-default-toggle", root).forEach((input) => input.addEventListener("change", () =>
      saveDevelopmentPreference(input.dataset.capability, input.checked)));
    $$(".development-session-toggle", root).forEach((input) => input.addEventListener("change", () =>
      setLiveDevelopmentCapability(input.dataset.session, input.dataset.capability, input.checked)));
    $$(".development-copy-preview", root).forEach((button) => button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.url);
        toast(t("development.preview_copied"));
      } catch {
        toast("Copy failed — select the URL manually.", true);
      }
    }));
    $$(".development-open-preview", root).forEach((button) => button.addEventListener("click", async () => {
      try {
        const result = await api("/api/development/open-preview", {
          method: "POST",
          body: JSON.stringify({ sessionId: button.dataset.session, hostPort: Number(button.dataset.port) }),
        });
        if (!result.opened) window.open(result.url, "_blank", "noopener");
      } catch (error) {
        toast(error.message, true);
      }
    }));
    icons();
  }

  /** Tool label for boundary copy — the selected tool, or a neutral subject. */
  /**
   * Is this tool signed in for the account *this* Project would mount?
   *
   * Deliberately not `agent.signedIn` from /api/agents: that list is fetched once per
   * refresh for whichever Project was selected then, so reading it while viewing a
   * different Project reported another Project's login state (Overview said
   * "Needs sign-in" while the AI tab said "Ready" for the same tool). `state.aiLogins`
   * is project-independent — tool × identity × credential-present — so pairing it with
   * this Project's own loginProfiles is correct no matter what was fetched when.
   */
  function toolSignedInForProject(project, agentId) {
    const account = project?.loginProfiles?.[agentId] || "default";
    return (state.aiLogins || []).some(
      (login) => login.agentId === agentId && login.identityId === account && login.persisted,
    );
  }

  function boundarySubject(project) {
    const inUse = agents.filter((agent) =>
      agent.roomCommand?.length
      && (Boolean(project?.loginProfiles?.[agent.id]) || toolSignedInForProject(project, agent.id)));
    return inUse.length === 1 ? (inUse[0].shortName || inUse[0].name || "The AI") : "The AI";
  }

  /** Coarse Project-wide summary. Per-repository truth lives on each binding. */
  function effectiveProjectGitAccess(project) {
    const until = Date.parse(project?.gitWriteUntil || "");
    const ceiling = project?.gitCapability || "none";
    if (ceiling === "read" && Number.isFinite(until) && until > Date.now()) return "write";
    return ceiling === "none" ? "none" : ceiling === "read" ? "read" : "write";
  }

  /** "owner/repo", or "owner/repo +2" once a Project spans several repositories. */
  function projectGitRepositorySummary(project) {
    const rows = projectGitBindings(project);
    if (!rows.length) return "";
    return rows.length === 1 ? rows[0].fullName : `${rows[0].fullName} +${rows.length - 1}`;
  }

  /** Bound MCP Connection names — same multi-cred identity as Library rows. */
  function projectMcpSummary(project) {
    const rows = Array.isArray(project?.mcpBindings) ? project.mcpBindings : [];
    if (!rows.length) return "";
    const names = rows
      .map((row) => row.connectionName || row.integrationName || row.connectionId || "")
      .filter(Boolean);
    if (!names.length) return "";
    return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
  }

  /**
   * The one sentence the whole product is about: what this tool can touch.
   * Everything below it on Overview is the same fact in more detail.
   */
  function boundaryClauses(project) {
    const subject = boundarySubject(project);
    const workspace = project.workspace || "";
    const access = project.effectiveMode === "read-only" ? "read" : "read and write";
    const gitAccess = effectiveProjectGitAccess(project);
    return [
      workspace
        ? `${subject} can ${access} ${workspace}.`
        : `${subject} has no folder yet — nothing is shared into the room.`,
      "Nothing else on this Mac exists inside the room.",
      project.room?.egress === "open"
        ? "It can reach the network."
        : project.room?.egress === "allowlist"
          ? "It can reach only the sites you allowed; everything else is unreachable."
          : "It has no network at all.",
      gitAccess === "none"
        ? "It can commit with git locally; this Project receives no Git token."
        : `GitHub permits "${gitCapabilityLabel(project.gitCapability)}" for ${projectGitRepositorySummary(project)}; every other repository is unreachable and repository rules still apply.`,
    ];
  }

  function boundarySentence(project) {
    return boundaryClauses(project).join(" ");
  }

  /** Each clause is its own text node so the locale overlay can translate it. */
  function boundarySentenceHtml(project) {
    return boundaryClauses(project).map((clause) => `<span>${esc(clause)}</span>`).join(" ");
  }

  /** Look up one assurance row by id — never invent a second classification. */
  function assuranceById(project, id) {
    return (project.assurance || []).find((item) => item.id === id) || null;
  }

  /** UI label for a profile id — never print raw internal "default" (F2/A9). */
  function aiAccountDisplayLabel(profileId) {
    if (!profileId || profileId === "default") return t("project.ai.account_existing");
    return profileId;
  }

  /**
   * Overview ledger: short values only (noun + value). No essays.
   * Classes ledger-allowed / ledger-denied stay for structure; copy is tight.
   */
  function renderPermissionLedger(project) {
    const workspace = project.workspace || "";
    const share = project.room?.workspaceShare === "selected" ? "selected" : "whole";
    const mode = project.effectiveMode === "read-only" ? "Look only" : "Can edit";
    const entries = project.room?.shareEntries || [];
    let folderAllowed;
    if (!workspace) folderAllowed = "No folder";
    else if (share === "selected") {
      folderAllowed = entries.length
        ? entries.map((e) => `${e.path} · ${e.access === "read-only" ? "Look only" : "Can edit"}`).join(", ")
        : "No folders shared";
    } else {
      folderAllowed = `Entire folder · ${mode}`;
    }
    const folderDenied = workspace
      ? (share === "selected" ? "Other project files · Not shared" : "Other Mac folders · Not shared")
      : "Nothing shared";
    // Keep a stable honesty phrase tests and Limits can still rely on.
    const folderDeniedFull = workspace
      ? "No other folder exists inside the room."
      : "Nothing shared";
    const folderAssurance = assuranceById(project, "workspace-door") || assuranceById(project, "shared-folders") || assuranceById(project, "sealed-room");

    const egress = normalizeEgress(project.room?.egress);
    const allowedGroupCount = (project.room?.egressTemplates || []).length
      + (project.room?.egressHosts || []).length;
    const networkAllowed = egress === "open"
      ? "Open · unfiltered"
      : egress === "allowlist"
        ? `${allowedGroupCount} allowed site group${allowedGroupCount === 1 ? "" : "s"} · filtered`
        : "Off · no network";
    const networkDenied = egress === "open"
      ? "Unfiltered"
      : egress === "allowlist"
        ? "Every other host"
        : "No internet";
    const networkAssurance = assuranceById(project, "egress");
    const developmentAllowed = [
      project.development?.preview?.enabled !== false ? "Local Preview" : "",
      project.development?.docker?.enabled !== false ? "Docker Engine Sandbox" : "",
    ].filter(Boolean).join(", ") || "Off";
    const developmentDenied = project.development?.preview?.enabled !== false
      || project.development?.docker?.enabled !== false
      ? "Session controls can revoke either capability immediately"
      : "No development broker for new Sessions";
    const developmentAssurance = { source: "broker" };

    // Phase 9-6 F1/F2: in-use instances only — never the full agent catalog or raw "default".
    // Same selection rule as renderProjectAi / src/room/ai-facts projectAiFactRows.
    const tools = agents.filter((agent) => {
      if (!agent.roomCommand?.length) return false;
      return Boolean(project.loginProfiles?.[agent.id]) || toolSignedInForProject(project, agent.id);
    });
    const toolParts = tools.map((agent) => {
      const account = aiAccountDisplayLabel(project.loginProfiles?.[agent.id]);
      const signedIn = toolSignedInForProject(project, agent.id);
      return `${agent.shortName} · ${account}${signedIn ? "" : " · Needs sign-in"}`;
    });
    const toolsAllowed = toolParts.length ? toolParts.join(", ") : "None set up";
    const toolsDenied = toolParts.length ? "" : "No AI tool in use";
    const sealed = assuranceById(project, "sealed-room");

    const gitAccess = effectiveProjectGitAccess(project);
    const gitSummary = projectGitRepositorySummary(project);
    const gitAllowed = gitAccess === "none"
      ? "Commit in room"
      : `${gitCapabilityLabel(project.gitCapability)} · ${gitSummary}`;
    const gitDenied = gitAccess === "write"
      ? "Repository rules still apply"
      : gitAccess === "read"
        ? "GitHub rejects pushes"
        : "No authenticated remote access";
    const gitAssurance = assuranceById(project, "git-credentials");

    const mcpBindings = project.mcpBindings || [];
    const mcpAllowed = mcpBindings.length
      ? mcpBindings.map((b) => `${b.integrationName} · ${b.connectionName}${b.ready ? "" : " · needs secret"}`).join(", ")
      : "None";
    const mcpDenied = mcpBindings.length
      ? "Runs on this Mac"
      : "No tools beyond the Sandbox";
    const mcpAssurance = assuranceById(project, "mcp-hub");

    // Fact surface only: Shared / Not shared. Enforcement tags (Isolated / Broker /
    // Not enforced yet) and a separate arrow button were noise — the whole row is the control.
    const row = ({ icon, title, allowed, denied, section, sectionLabel }) => `
      <button type="button" class="ledger-row" data-section="${esc(section)}" aria-label="${esc(sectionLabel)}">
        <div class="ledger-axis"><i data-lucide="${icon}"></i><b>${esc(title)}</b></div>
        <div class="ledger-body">
          <p class="ledger-allowed"><span>Shared</span>${esc(allowed)}</p>
          ${denied ? `<p class="ledger-denied"><span>Not shared</span>${esc(denied)}</p>` : ""}
        </div>
      </button>`;

    // folderDeniedFull kept in a data attribute so honesty phrasing remains in source for tests/docs.
    return `<div class="permission-ledger" aria-label="Permission ledger" data-folder-aside="${esc(folderDeniedFull)}">
      ${row({ icon: "folder", title: "Folders", allowed: folderAllowed, denied: folderDenied, section: "folders", sectionLabel: "Folders" })}
      ${row({ icon: "globe", title: "Network", allowed: networkAllowed, denied: networkDenied, section: "network", sectionLabel: "Network" })}
      ${row({ icon: "monitor-up", title: "Development", allowed: developmentAllowed, denied: developmentDenied, section: "development", sectionLabel: "Development" })}
      ${row({ icon: "bot", title: "AI tools", allowed: toolsAllowed, denied: toolsDenied, section: "ai", sectionLabel: "AI tools" })}
      ${row({ icon: "git-branch", title: "Git", allowed: gitAllowed, denied: gitDenied, section: "git", sectionLabel: "Git" })}
      ${row({ icon: "plug", title: "Connections", allowed: mcpAllowed, denied: mcpDenied, section: "connections", sectionLabel: "Connections" })}
    </div>`;
  }

  /** Short factual summary for the Create wizard — only choices made so far. */
  function renderCreateBoundarySummary({ workspace, access, egress }) {
    const folder = workspace
      ? `${workspace} · ${access === "read-only" ? "read only" : "read and write"}`
      : "No folder chosen yet.";
    const network = egress === "open" ? "Network on (unrestricted)" : "Network off (no network device)";
    return `<div class="create-boundary-summary">
      <div class="ledger-row ledger-row-static">
        <div class="ledger-axis"><i data-lucide="folder"></i><b>Folder</b></div>
        <div class="ledger-body"><p class="ledger-allowed">${esc(folder)}</p></div>
      </div>
      <div class="ledger-row ledger-row-static">
        <div class="ledger-axis"><i data-lucide="globe"></i><b>Network</b></div>
        <div class="ledger-body"><p class="ledger-allowed">${esc(network)}</p></div>
      </div>
    </div>`;
  }

  /** Auto-approve is only offered for tools with a flag verified in the Sandbox image. */
  function autoApproveSupported(agentId = selectedAgent) {
    return Boolean(agents.find((agent) => agent.id === agentId)?.autoApproveArgs?.length);
  }

  function inRoomCommandPreview(agentId, autoApprove) {
    const agent = agents.find((item) => item.id === agentId);
    const base = agent?.roomCommand?.join(" ") || agentId || "";
    const flags = autoApprove && autoApproveSupported(agentId) ? agent.autoApproveArgs.join(" ") : "";
    return flags ? `${base} ${flags}` : base;
  }

  async function setAutoApprove(next) {
    const project = effectiveProject();
    try {
      await api("/api/contexts", {
        method: "PUT",
        body: JSON.stringify({
          previous: selectedProject,
          name: selectedProject,
          description: project.description || "",
          workspace: project.workspace || "",
          mode: project.mode,
          inheritMode: project.inheritMode !== false,
          gitIgnored: project.gitIgnored || "visible",
          ...cloneProject(project),
          autoApprove: Boolean(next),
          repos: (project.repos || []).map((repo) => repo.repo || repo),
          allowedHosts: project.allowedHosts || [],
          backends: project.backends || [],
        }),
      });
      await refresh(false);
      toast(next ? t("project.ai.toast_approval_off") : t("project.ai.toast_approval_default"));
      if (route === "project" && projectSection === "ai") renderProjectAi();
      else if (route === "project" && projectSection === "overview") renderProjectOverview();
    } catch (error) {
      toast(error.message, true);
    }
  }

  /** Closed set — barrier / layer tags never free-text. */
  const PROOF_ENFORCER_LABEL = {
    microvm: "microVM",
    "readonly-mount": "read-only mount",
    absent: "not present",
  };

  /** Lucide icon names keyed by attempt.targetKind. */
  const PROOF_TARGET_ICON = {
    "host-fs": "monitor",
    workspace: "folder",
    "readonly-door": "folder-lock",
    network: "globe",
    credential: "key-round",
  };

  function aiProofPlanKey(projectName = selectedProject, project = effectiveProject()) {
    return `${projectName || ""}\0${projectBoundaryFingerprint(project || {})}`;
  }

  /**
   * Idle preview cards must come from the server plan — never a hand-copied
   * probe list in the renderer. Until the plan loads (or if it fails), return
   * an empty list: empty is honest, a guessed list is not.
   */
  function plannedProofProbes(projectName = selectedProject) {
    if (!projectName) return [];
    const project = state?.contexts?.[projectName] || effectiveProject();
    const key = aiProofPlanKey(projectName, project);
    const cached = aiProofPlanCache.get(key);
    if (cached?.status === "ready" && Array.isArray(cached.probes)) {
      return cached.probes.map((probe) => ({ ...probe, _idle: true }));
    }
    if (!cached) {
      aiProofPlanCache.set(key, { status: "loading", probes: [] });
      api(`/api/room/ai-proof/plan?context=${encodeURIComponent(projectName)}`)
        .then((data) => {
          // Drop the response if the boundary changed while the request was in flight.
          if (aiProofPlanKey(projectName) !== key) return;
          aiProofPlanCache.set(key, {
            status: "ready",
            probes: Array.isArray(data?.probes) ? data.probes : [],
          });
        })
        .catch(() => {
          if (aiProofPlanKey(projectName) !== key) return;
          aiProofPlanCache.set(key, { status: "error", probes: [] });
        })
        .finally(() => {
          if (route === "project" && projectSection === "overview") {
            if ($("#prove-it-results")) renderProveItBody();
          }
        });
    }
    return [];
  }

  function proofEnforcerLabel(enforcer) {
    return PROOF_ENFORCER_LABEL[enforcer] || "";
  }

  function proofTargetIcon(kind) {
    return PROOF_TARGET_ICON[kind] || "circle";
  }

  function proofLayerClass(result) {
    // Only not-yet-run cards may use idle grey. A completed check whose enforcer
    // is "absent" (e.g. host credentials missing) is a VM property, not "not run".
    if (result._idle || result.observed == null) return "idle";
    if (result.pass === false) return "bad";
    if (result.attempt?.enforcer === "microvm") return "vm";
    if (result.attempt?.enforcer === "readonly-mount") return "mount";
    if (result.attempt?.enforcer === "absent") return "vm";
    return "vm";
  }

  function proofCardClass(result) {
    if (result._idle || result.observed == null) return "idle";
    return result.pass ? "pass" : "fail";
  }

  function proofMark(result) {
    if (result._idle || result.observed == null) return "◌";
    return result.pass ? "✓" : "✗";
  }

  function proofLayerTag(result) {
    if (result._idle || result.observed == null) return "not run";
    const enforcer = result.attempt?.enforcer;
    // "absent" means two different stories: the thing is missing (good block),
    // or there is intentionally no barrier (allowed write / open network).
    if (enforcer === "absent") {
      return result.expect === "allowed" || result.observed === "allowed" ? "allowed" : "not present";
    }
    return proofEnforcerLabel(enforcer) || "—";
  }

  /**
   * Apple `container` prints the same boot progress on stderr for every fresh
   * room. That is real, but it is not the probe. Keep it labeled and secondary.
   */
  function isRoomBootLine(line) {
    return /^\[\d+\/\d+\]/.test(String(line).trim())
      || /^(Fetching|Unpacking|Starting)\b/i.test(String(line).trim());
  }

  function splitProbeOutput(stdout, stderr) {
    const outLines = String(stdout || "").split(/\r?\n/);
    const errLines = String(stderr || "").split(/\r?\n/);
    const probe = [];
    const boot = [];
    for (const line of [...outLines, ...errLines]) {
      if (!line.trim()) continue;
      if (isRoomBootLine(line)) boot.push(line);
      else probe.push(line);
    }
    return { probe, boot };
  }

  /** Verb for the at-a-glance line — derived from targetKind, never free-text inventing a path. */
  function proofTryVerb(kind) {
    return {
      "host-fs": "Read",
      workspace: "Write",
      "readonly-door": "Write",
      network: "Connect to",
      credential: "Find",
    }[kind] || "Reach";
  }

  /**
   * Short label for the right-hand node. The glance line always carries the full
   * absolute path / URL; the diagram only needs a scannable name.
   */
  function proofTargetShort(target) {
    if (!target) return "—";
    if (/^https?:\/\//i.test(target)) return target.replace(/^https?:\/\//i, "");
    const parts = String(target).split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : target;
  }

  /** Plain outcome words for the rail — name the result, not a nameless "here". */
  function proofVerdictLabel(result) {
    const idle = Boolean(result._idle) || result.observed == null;
    if (idle) return "not run";
    if (result.observed === "blocked") return result.pass ? "can't reach" : "can't reach (unexpected)";
    if (result.observed === "allowed") return result.pass ? "reached" : "reached (should not)";
    return "no result";
  }

  /**
   * The fact line: what absolute path/URL was tried, and whether it was reached.
   * Without a target this is not a result — refuse to paint a hollow ✓.
   */
  function proveGlance(result) {
    const target = proofTargetOf(result);
    const verb = proofTryVerb(result.attempt?.targetKind);
    const idle = Boolean(result._idle) || result.observed == null;
    if (!target) {
      return `<div class="chk-glance incomplete"><span class="try">Tried</span><span class="out bad">— no target recorded. Re-run the check.</span></div>`;
    }
    if (idle) {
      return `<div class="chk-glance">
        <div class="glance-row"><span class="try">Will try</span><code>${esc(target)}</code></div>
        <div class="glance-row out idle"><span class="try">${esc(verb)}</span><span>not run yet</span></div>
      </div>`;
    }
    let outcome;
    if (result.observed === "blocked") {
      outcome = result.pass ? "can't reach — as expected" : "can't reach — unexpected";
    } else if (result.observed === "allowed") {
      outcome = result.pass ? "reached — as expected" : "reached — should have been blocked";
    } else {
      outcome = "no clear result";
    }
    const outClass = result.pass ? "ok" : "bad";
    return `<div class="chk-glance">
      <div class="glance-row"><span class="try">Tried</span><code>${esc(target)}</code></div>
      <div class="glance-row out ${outClass}"><span class="try">${esc(verb)}</span><span>${esc(outcome)}</span></div>
    </div>`;
  }

  /** Fixed 3-slot attempt trace: actor → path → target. Geometry from observed; colour from pass. */
  function proveTrace(result) {
    const attempt = result.attempt || {};
    const target = proofTargetOf(result);
    const targetIcon = proofTargetIcon(attempt.targetKind);
    const enforcer = proofEnforcerLabel(attempt.enforcer);
    const idle = Boolean(result._idle) || result.observed == null;
    const observed = result.observed;
    const pass = result.pass === true;
    const fail = result.pass === false;
    const verdict = proofVerdictLabel(result);
    const short = proofTargetShort(target);

    let pathClass = "idle";
    let pathInner = "";
    let targetNodeClass = "unreached";

    if (idle) {
      pathClass = "idle";
      pathInner = `<span class="rail dead" style="left:0;right:0"></span><span class="verdict">${esc(verdict)}</span>`;
      targetNodeClass = "unreached";
    } else if (observed === "blocked") {
      // Rail stops at the barrier; target stays unreached. Colour follows pass, not "blocked".
      pathClass = fail ? "blocked leak" : "blocked";
      pathInner = `
        <span class="rail a" style="right:calc(50% + 13px)"></span>
        <span class="rail dead" style="left:calc(50% + 13px)"></span>
        <span class="barrier">✕${enforcer ? `<span class="barrier-tag">${esc(enforcer)}</span>` : ""}</span>
        <span class="verdict">${esc(verdict)}</span>`;
      targetNodeClass = "unreached";
    } else if (observed === "allowed") {
      pathClass = fail ? "leak" : "passed";
      pathInner = `
        <span class="rail a" style="left:0;right:0"></span>
        <span class="head"></span>
        <span class="verdict">${esc(verdict)}</span>`;
      targetNodeClass = "reached";
    } else {
      // observed === "unknown"
      pathClass = "unknown";
      pathInner = `<span class="rail dead" style="left:0;right:0"></span><span class="verdict">${esc(verdict)}</span>`;
      targetNodeClass = "unreached";
    }

    // Always show the full absolute path/URL under the short name when we have one.
    const full = target && target !== short
      ? `<small class="target-full" title="${esc(target)}">${esc(target)}</small>`
      : "";
    const aria = !target
      ? "No target recorded"
      : idle
        ? `Will try ${target}`
        : observed === "blocked"
          ? `Can't reach ${target}${enforcer ? ` (${enforcer})` : ""}`
          : observed === "allowed"
            ? `Reached ${target}`
            : `Attempt toward ${target}: unknown`;

    return `<div class="trace" role="img" aria-label="${esc(aria)}">
      <div class="node">
        <span class="glyph"><i data-lucide="bot"></i></span>
        <b>AI</b>
        <small>in room</small>
      </div>
      <div class="path ${pathClass}">${pathInner}</div>
      <div class="node ${targetNodeClass}">
        <span class="glyph"><i data-lucide="${esc(targetIcon)}"></i></span>
        <b>${esc(short)}</b>
        ${full}
      </div>
    </div>`;
  }

  function proveEvidence(result, image) {
    if (result._idle || result.observed == null) return "";
    const target = proofTargetOf(result);
    const expect = result.expect || "";
    const observed = result.observed || "";
    const expectTag = expect === "blocked" || expect === "allowed"
      ? `<span class="tag ${result.pass ? "ok" : "no"}">${esc(expect)}</span>`
      : esc(expect);
    const observedTag = observed === "unknown"
      ? `<span class="tag no">${esc(observed)}</span>`
      : `<span class="tag ${result.pass ? "ok" : "bad"}">${esc(observed)}</span>`;
    const matchNote = result.pass ? " match" : " mismatch";
    const cmd = Array.isArray(result.command) ? result.command.join(" ") : String(result.command || "");
    const { probe, boot } = splitProbeOutput(result.stdout, result.stderr);
    const duration = typeof result.durationMs === "number" ? `${result.durationMs}ms` : "";
    const rows = [];
    if (target) {
      rows.push(`<div class="ev-row"><dt>Tried</dt><dd><code>${esc(target)}</code></dd></div>`);
    }
    rows.push(
      `<div class="ev-row"><dt>Expect</dt><dd>${expectTag}</dd></div>`,
      `<div class="ev-row"><dt>Observed</dt><dd>${observedTag}${esc(matchNote)}</dd></div>`,
    );
    if (result.exitCode != null) {
      rows.push(`<div class="ev-row"><dt>Exit</dt><dd><code>${esc(String(result.exitCode))}</code>${duration ? ` · ${esc(duration)}` : ""}</dd></div>`);
    } else if (duration) {
      rows.push(`<div class="ev-row"><dt>Duration</dt><dd>${esc(duration)}</dd></div>`);
    }
    if (image) {
      rows.push(`<div class="ev-row"><dt>Image</dt><dd><code>${esc(image)}</code></dd></div>`);
    }
    if (!cmd) {
      return `<details>
        <summary>Command and raw result<span class="why">${esc(result.id || "")}</span></summary>
        <div class="evidence"><p class="compose-note">No command recorded — re-run the check.</p></div>
      </details>`;
    }
    // Probe stdout first (OUTCOME=…). Boot progress is real but identical every run.
    const probeBlock = `<pre class="term"><span class="cmd">$ ${esc(cmd)}</span>
<span class="out">${esc(probe.join("\n") || "(no probe stdout)")}</span></pre>`;
    const bootBlock = boot.length
      ? `<details class="boot-log">
          <summary>Sandbox boot log <span class="why">${boot.length} lines — same pattern every check, not the probe</span></summary>
          <pre class="term boot"><span class="out">${esc(boot.join("\n"))}</span></pre>
        </details>`
      : "";
    return `<details>
      <summary>Command and raw result<span class="why">${esc(result.id || "")}</span></summary>
      <div class="evidence">
        <dl>${rows.join("")}</dl>
        ${probeBlock}
        ${bootBlock}
      </div>
    </details>`;
  }

  function proveItRows(results, { image = "" } = {}) {
    if (!results?.length) return "";
    return `<div class="checks">${results.map((result) => {
      const card = proofCardClass(result);
      const layer = proofLayerClass(result);
      return `<article class="chk ${card}">
        <div class="chk-head">
          <span class="chk-mark" aria-hidden="true">${proofMark(result)}</span>
          <div class="chk-title">
            <b>${esc(result.title || result.id || "")}</b>
            ${result.description ? `<small>${esc(result.description)}</small>` : ""}
          </div>
          <span class="chk-layer ${layer}">${esc(proofLayerTag(result))}</span>
        </div>
        ${proveGlance(result)}
        ${proveTrace(result)}
        ${proveEvidence(result, image)}
      </article>`;
    }).join("")}</div>`;
  }

  function proofStamp({ idle = false, running = false, unavailable = false, stale = false, failed = 0, total = 0, checkedAt = "", image = "", durationMs = 0, detail = "" } = {}) {
    if (running) {
      return `<div class="stamp idle"><span>…</span><span class="grow"><b>Running in the real room</b> — first run boots the room and can take ~30s</span></div>`;
    }
    if (unavailable) {
      return `<div class="stamp fail"><span>!</span><span class="grow"><b>Nothing verified</b> — room runtime unavailable${detail ? `: ${esc(detail)}` : ""}</span></div>`;
    }
    if (idle) {
      return `<div class="stamp idle"><span>◌</span><span class="grow"><b>Not verified yet</b> — until you run it, the labels below are the plan, not a result</span></div>`;
    }
    if (stale) {
      return `<div class="stamp fail"><span>!</span><span class="grow"><b>Boundary changed since this run</b> — the result no longer describes the current configuration</span>${checkedAt ? `<code>${esc(relative(checkedAt))}</code>` : ""}</div>`;
    }
    const ok = failed === 0;
    const summary = ok
      ? `${total} check${total === 1 ? "" : "s"} matched what this page promises`
      : `${failed} of ${total} check${total === 1 ? "" : "s"} did not match`;
    const meta = [
      checkedAt ? relative(checkedAt) : "",
      image || "",
      durationMs > 0 ? `${(durationMs / 1000).toFixed(1)}s` : "",
    ].filter(Boolean).join(" · ");
    return `<div class="stamp ${ok ? "" : "fail"}">
      <span>${ok ? "✓" : "✗"}</span>
      <span class="grow"><b>${esc(summary)}</b>${failed ? ` <span class="stamp-fail-count">${failed} failed</span>` : ""}</span>
      ${meta ? `<code>${esc(meta)}</code>` : ""}
    </div>`;
  }

  function currentProof(project = effectiveProject()) {
    // Session memory only — reload starts clean. No localStorage.
    if (!lastDiagnostics || lastDiagnostics.context !== selectedProject) return null;
    if (lastDiagnostics.available !== false && !proofResultsComplete(lastDiagnostics.results || [])) {
      lastDiagnostics = null;
      return null;
    }
    return {
      ...lastDiagnostics,
      current: lastDiagnostics.fingerprint === projectBoundaryFingerprint(project),
      checkedAt: lastDiagnostics.checkedAt || new Date().toISOString(),
    };
  }

  function renderProveItBody() {
    const box = $("#prove-it-results");
    if (!box) return;
    const details = $("#prove-it-details");
    const status = $("#prove-it-status");
    const diag = currentProof();
    const image = diag?.image || "";

    if (proveItBusy) {
      if (details) {
        details.hidden = false;
        details.open = true;
      }
      if (status) status.textContent = "Testing the current boundary…";
      // Never keep the previous green/red cards while a run is in flight — a
      // success→success re-test would look like nothing happened.
      const plan = plannedProofProbes(selectedProject).map((r) => ({ ...r, _idle: true, observed: null, pass: undefined }));
      box.innerHTML = `${proofStamp({ running: true })}${proveItRows(plan)}`;
      $("#run-prove-it")?.setAttribute("disabled", "disabled");
      icons(box);
      return;
    }
    $("#run-prove-it")?.removeAttribute("disabled");

    if (!diag) {
      if (details) details.hidden = true;
      if (status) status.textContent = "Not tested yet";
      box.innerHTML = "";
      return;
    }

    if (details) details.hidden = false;
    if (diag.available === false) {
      if (status) status.textContent = "Sandbox unavailable";
      // Deliberate empty results — no room, no evidence. Do not render a fake pass.
      box.innerHTML = `${proofStamp({ unavailable: true, detail: diag.detail || "" })}
        <p class="compose-note">${esc(diag.detail || "Sandbox runtime unavailable.")} Nothing has been verified.</p>`;
      icons(box);
      return;
    }

    const results = diag.results || [];
    // Guard again: incomplete payload must not render as a green stamp.
    if (!proofResultsComplete(results)) {
      if (status) status.textContent = "Needs re-check";
      box.innerHTML = `${proofStamp({ idle: true })}
        <p class="compose-note">Previous run did not record what it tried. Press <b>Test the walls</b> again.</p>`;
      icons(box);
      return;
    }
    const failed = results.filter((result) => !result.pass).length;
    const totalMs = results.reduce((sum, result) => sum + (Number(result.durationMs) || 0), 0);
    const stale = diag.current === false;
    if (status) {
      status.textContent = stale
        ? "Needs re-check"
        : failed
          ? `${failed} check${failed === 1 ? "" : "s"} need attention`
          : `${results.length} check${results.length === 1 ? "" : "s"} matched`;
    }
    box.innerHTML = `${proofStamp({
      stale,
      failed,
      total: results.length,
      checkedAt: diag.checkedAt || "",
      image,
      durationMs: totalMs,
    })}${stale && results.length === 0 ? "" : proveItRows(results, { image })}
      ${!stale && failed
        ? `<p class="compose-note">${failed} check${failed === 1 ? "" : "s"} did not match what this page promises. Treat the boundary as unproven until ${failed === 1 ? "it does" : "they do"}.</p>`
        : ""}`;
    icons(box);
  }

  async function runProveIt() {
    const project = effectiveProject();
    if (!selectedProject || !project?.workspace) {
      toast("Bind a folder under Folders first.", true);
      openProjectPage(selectedProject || state.active, "folders");
      return;
    }
    if (proveItBusy) return;
    // Reset first so the UI leaves the previous result the moment the user clicks.
    forgetProof(selectedProject);
    proveItBusy = true;
    renderProveItBody();
    try {
      lastDiagnostics = await api("/api/room/ai-proof", {
        method: "POST",
        body: JSON.stringify({ context: selectedProject, workspace: project.workspace }),
      });
      lastDiagnostics.context = selectedProject;
      lastDiagnostics.checkedAt = new Date().toISOString();
      lastDiagnostics.fingerprint = projectBoundaryFingerprint(project);
      // Intentionally not persisted — reload should require a fresh run.
      await refresh(false);
    } catch (error) {
      toast(error.message, true);
    } finally {
      proveItBusy = false;
      if (route === "project" && projectSection === "overview") renderProjectOverview();
      else renderProveItBody();
    }
  }

  function renderProjectOverview() {
    const project = effectiveProject();
    const root = $("#project-section-overview");
    if (root) root.dataset.project = selectedProject || "";
    const boundary = boundaryState(project);
    const workspace = project.workspace || "";
    ensureRoomPreflightStatuses(selectedProject, workspace, { mode: "all" });
    const proof = currentProof(project);
    root.innerHTML = `
      <div class="stack overview-layout">
        <section class="panel content-panel overview-main policy-section">
          <div class="overview-head">
            <div><b>${esc(t("overview.what_ai_can_touch"))}</b><small>${boundarySentenceHtml(project)}</small></div>
            <em class="readiness-state ${esc(boundary.cls === "unavailable" ? "unavailable" : boundary.cls === "ready" ? "ready" : "setup")}">${esc(boundary.label)}</em>
          </div>
          ${renderPermissionLedger(project)}
          <div class="sandbox-actions-stack">
            <section class="sandbox-action proof-action">
              <div class="sandbox-action-head"><div><span class="eyebrow">Live verification</span><h2>Prove it in the real sandbox</h2></div><span class="assurance os"><i data-lucide="box"></i>Real Sandbox</span></div>
              <p>Try host escape, workspace access, network, and an unlisted Git push. Results last for this session only — a reload clears them.</p>
              <div class="proof-control-row">
                <button type="button" class="secondary" id="run-prove-it"><i data-lucide="shield-check"></i>Test the walls</button>
                <span id="prove-it-status" class="proof-status">${proof ? "Result from this session" : "Not tested yet"}</span>
              </div>
              <details id="prove-it-details" class="prove-results"${proof ? " open" : ""}>
                <summary>Verification results</summary>
                <div id="prove-it-results" class="prove-list"></div>
              </details>
            </section>
          </div>
          <div class="overview-limits">
            <button type="button" class="text-button" id="open-limits"><i data-lucide="circle-help"></i>Limits</button>
          </div>
          ${isBaseRoomImage() ? `<div class="room-setup-card setup"><div class="room-setup-copy"><b>Safe base Sandbox — setup required</b><p>Current image is an intentional unconfigured safe base: no AI CLIs are installed. Build Bumper's recommended AI Sandbox image once (does not download or build until you click).</p></div><div class="room-setup-actions"><button type="button" class="primary" id="build-room-image"><i data-lucide="package-plus"></i>Build AI Sandbox image</button></div></div>` : ""}
          <div id="overview-build-status"></div>
        </section>
      </div>`;
    renderProveItBody();
    $$(".permission-ledger .ledger-row").forEach((button) => button.addEventListener("click", () => {
      openProjectPage(selectedProject, button.dataset.section || "overview");
    }));
    $("#run-prove-it")?.addEventListener("click", runProveIt);
    $("#open-limits")?.addEventListener("click", openLimitsDialog);
    $("#build-room-image")?.addEventListener("click", buildRoomImage);
    icons();
  }

  /**
   * Every limit in one place. Per-page "not enforced yet" badges made the whole
   * product read as unfinished; the honesty is unchanged, the location is not.
   * Project-specific gaps come from the same assurance model as the detail rows.
   */
  function limitsForProject(project) {
    const fixed = [
      {
        title: "SSH git bypasses the credential broker",
        detail: "Scoped push credentials are an HTTPS-only guarantee. An SSH remote uses keys the room would need mounted — use HTTPS remotes for the scoping to mean anything.",
      },
      {
        title: "Commands are not classified inside the room",
        detail: "There is no shell allow/deny list. Safety comes from the folder and network boundary — what the command can reach, not what it is called.",
      },
      {
        title: "Bumper contains, it does not correct",
        detail: "Inside the shared folder the AI can do anything it wants, including deleting your work. Containment limits blast radius; it is not a review process or a backup.",
      },
    ];
    const dynamic = (project?.assurance || [])
      .filter((item) => item.source === "not-enforced")
      .map((item) => ({ title: item.label, detail: item.detail }));
    return [...dynamic, ...fixed];
  }

  function openLimitsDialog() {
    const dialog = $("#limits-dialog");
    if (!dialog) return;
    const project = effectiveProject();
    $("#limits-list").innerHTML = limitsForProject(project).map((item) => `
      <div class="limit-row">
        <i data-lucide="minus-circle"></i>
        <div><b>${esc(item.title)}</b><p>${esc(item.detail)}</p></div>
      </div>`).join("");
    icons(dialog);
    dialog.showModal();
  }

  async function buildRoomImage() {
    if (!selectedProject) return;
    const wasFailed = roomSetupStatus?.status === "failed";
    const project = effectiveProject();
    const alreadyRecommended = /bumper\/ai-room/.test(String(project?.room?.image || ""));
    const force = Boolean(wasFailed || alreadyRecommended);
    roomSetupStatus = { status: "building", log: [] };
    const status = $("#overview-build-status");
    if (status) status.innerHTML = '<p class="compose-note">Building image…</p>';
    try {
      const result = await api("/api/room/setup", { method: "POST", body: JSON.stringify({ context: selectedProject, force }) });
      if (!result.ok) {
        roomSetupStatus = { status: "failed", detail: result.detail || "Build did not complete.", failedTool: result.failedTool, hint: result.hint };
        toast(`${result.failedTool || "Sandbox image build"} failed.`, true);
        renderProjectOverview();
        return;
      }
      roomPreflightCache = new Map();
      aiProofPlanCache = new Map();
      roomSetupStatus = { status: "ready", image: result.image };
      await refresh();
      toast(`AI Sandbox image built: ${result.image}`);
    } catch (error) {
      roomSetupStatus = { status: "failed", detail: error.message };
      toast(error.message, true);
      renderProjectOverview();
    }
  }

  function renderPaths(container, model) {
    $(container).innerHTML = PATH_GROUPS.map(([key, label, icon]) => `<div class="path-group"><div class="path-group-head"><span><i data-lucide="${icon}"></i> <b>${label}</b></span><button type="button" class="icon-button add-path" data-key="${key}" title="Add folder"><i data-lucide="plus"></i></button></div>${model[key].length ? model[key].map((path, index) => `<div class="path-row"><span title="${esc(path)}">${esc(path)}</span><button type="button" class="remove-path" data-key="${key}" data-index="${index}" title="Remove"><i data-lucide="x"></i></button></div>`).join("") : '<div class="path-empty">None</div>'}</div>`).join("");
    $$(".add-path", $(container)).forEach((button) => button.addEventListener("click", () => chooseFolder((path) => {
      if (!editingProject[button.dataset.key].includes(path)) editingProject[button.dataset.key].push(path);
      renderPaths(container, editingProject);
    })));
    $$(".remove-path", $(container)).forEach((button) => button.addEventListener("click", () => {
      editingProject[button.dataset.key].splice(Number(button.dataset.index), 1);
      renderPaths(container, editingProject);
    }));
    icons();
  }

  function matrixCell(allowed, kind) {
    if (allowed) return `<span class="matrix-allow" title="${kind} allowed">✓ ${kind}</span>`;
    return `<span class="matrix-deny" title="${kind} blocked"><s>${kind}</s></span>`;
  }

  /** Matrix "Source" column in plain language (still maps to Inherited / Explicit / Override). */
  function matrixSourceLabel(source) {
    if (source === "Inherited") return "From parent";
    if (source === "Override") return "Override";
    return "You set";
  }

  function folderAccessLabel(access) {
    return access === "read-only" ? "Look only" : "Can edit";
  }

  /**
   * Absolute path → workspace-relative, or null if outside / invalid.
   * Empty string means the path is the workspace root itself.
   */
  function relativeToWorkspace(absPath, workspace) {
    const ws = String(workspace || "").replace(/\/+$/, "");
    const path = String(absPath || "").replace(/\/+$/, "");
    if (!ws || !path) return null;
    if (path === ws) return "";
    if (path.startsWith(`${ws}/`)) {
      const rel = path.slice(ws.length + 1);
      if (!rel || rel.split("/").includes("..")) return null;
      return rel;
    }
    return null;
  }

  /** List-first projection of FolderDraft (mirrors src/folders.ts shareRowsFromDraft). */
  function shareRowsFromDraft(draft) {
    const rows = [];
    if ((draft?.workspaceShare || "whole") === "whole") {
      rows.push({ kind: "project-root", access: draft.workspaceAccess === "read-only" ? "read-only" : "read-write" });
    } else {
      for (const entry of draft.entries || []) {
        if (!entry?.path) continue;
        rows.push({ kind: "inside", path: entry.path, access: entry.access === "read-only" ? "read-only" : "read-write" });
      }
    }
    const writes = new Set(draft.extraWritePaths || []);
    for (const hostPath of draft.extraWritePaths || []) {
      rows.push({ kind: "outside", hostPath, access: "read-write" });
    }
    for (const hostPath of draft.extraReadPaths || []) {
      if (writes.has(hostPath)) continue;
      rows.push({ kind: "outside", hostPath, access: "read-only" });
    }
    return sortShareRowsClient(rows);
  }

  function sortShareRowsClient(rows) {
    const root = rows.filter((r) => r.kind === "project-root");
    const inside = rows.filter((r) => r.kind === "inside").sort((a, b) => a.path.localeCompare(b.path));
    const outside = rows.filter((r) => r.kind === "outside").sort((a, b) => a.hostPath.localeCompare(b.hostPath));
    return [...root, ...inside, ...outside];
  }

  /** Write list rows back onto a mutable draft (mirrors folderDraftFromShareRows). */
  function applyShareRowsToDraft(draft, rows) {
    let hasRoot = false;
    let rootAccess = "read-write";
    const inside = [];
    const extraRead = [];
    const extraWrite = [];
    const seenInside = new Set();
    const seenOutside = new Set();
    for (const row of rows) {
      if (row.kind === "project-root") {
        hasRoot = true;
        rootAccess = row.access === "read-only" ? "read-only" : "read-write";
        continue;
      }
      if (row.kind === "inside") {
        const path = String(row.path || "").replace(/^\/+|\/+$/g, "");
        if (!path || path.split("/").includes("..") || seenInside.has(path)) continue;
        seenInside.add(path);
        inside.push({ path, access: row.access === "read-only" ? "read-only" : "read-write" });
        continue;
      }
      const host = String(row.hostPath || "").trim();
      if (!host || seenOutside.has(host)) continue;
      seenOutside.add(host);
      if (row.access === "read-write") extraWrite.push(host);
      else extraRead.push(host);
    }
    // R1: root mount and inside mounts are mutually exclusive.
    const keepInside = hasRoot ? [] : collapseInsideClient(inside);
    draft.workspaceShare = hasRoot ? "whole" : "selected";
    draft.editor = hasRoot ? "simple" : "advanced";
    draft.workspaceAccess = hasRoot
      ? rootAccess
      : keepInside.some((e) => e.access === "read-write")
        ? "read-write"
        : keepInside.length
          ? "read-only"
          : "read-write";
    draft.entries = keepInside;
    draft.extraReadPaths = extraRead;
    draft.extraWritePaths = extraWrite;
  }

  function collapseInsideClient(entries) {
    const sorted = [...entries].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
    const kept = [];
    for (const entry of sorted) {
      if (kept.some((p) => entry.path === p.path || entry.path.startsWith(`${p.path}/`))) continue;
      kept.push(entry);
    }
    return kept;
  }

  function classifyHostPathClient(absPath, workspace) {
    const rel = relativeToWorkspace(absPath, workspace);
    if (rel === "") return { kind: "project-root" };
    if (rel != null) return { kind: "inside", path: rel };
    const host = String(absPath || "").replace(/\/+$/, "");
    if (!host) return { kind: "invalid", reason: "Choose a folder." };
    if (!workspace) return { kind: "invalid", reason: "Set the project folder first." };
    return { kind: "outside", hostPath: host };
  }

  function addShareRowClient(rows, next) {
    const list = [...rows];
    if (next.kind === "project-root") {
      const dropped = list.some((r) => r.kind === "inside");
      const rest = list.filter((r) => r.kind !== "inside" && r.kind !== "project-root");
      rest.unshift({ kind: "project-root", access: next.access === "read-only" ? "read-only" : "read-write" });
      return { rows: sortShareRowsClient(rest), note: dropped ? "Subfolders are included in the project folder." : undefined };
    }
    if (next.kind === "inside") {
      if (list.some((r) => r.kind === "project-root")) {
        return {
          rows: list,
          error: "The project folder already includes this. Remove the project folder row first to share only some folders.",
        };
      }
      const path = String(next.path || "").replace(/^\/+|\/+$/g, "");
      if (!path || path.split("/").includes("..")) return { rows: list, error: "Choose a folder inside the project folder." };
      if (list.some((r) => r.kind === "inside" && r.path === path)) return { rows: list, error: "That folder is already shared." };
      if (list.some((r) => r.kind === "inside" && (path === r.path || path.startsWith(`${r.path}/`)))) {
        return { rows: list, error: "A parent of this folder is already shared — contents follow the parent." };
      }
      const filtered = list.filter((r) => !(r.kind === "inside" && r.path.startsWith(`${path}/`)));
      filtered.push({ kind: "inside", path, access: next.access === "read-only" ? "read-only" : "read-write" });
      return { rows: sortShareRowsClient(filtered) };
    }
    const host = String(next.hostPath || "").trim();
    if (!host) return { rows: list, error: "Choose a folder." };
    if (list.some((r) => r.kind === "outside" && r.hostPath === host)) return { rows: list, error: "That folder is already shared." };
    list.push({ kind: "outside", hostPath: host, access: next.access === "read-only" ? "read-only" : "read-write" });
    return { rows: sortShareRowsClient(list) };
  }

  /**
   * Everything else in the project (not listed above).
   * none = only listed folders exist (selected).
   * read-only / read-write = whole project mount; listed insides are cleared (no nested override).
   */
  function restOfProjectMode(draft) {
    if ((draft?.workspaceShare || "whole") === "whole") {
      return draft.workspaceAccess === "read-only" ? "read-only" : "read-write";
    }
    return "none";
  }

  function restModeLabel(mode) {
    if (mode === "read-write") return "Can edit";
    if (mode === "read-only") return "Look only";
    return "Not shared";
  }

  /** Explicit rows only (inside + outside). Project-root is represented by Everything else. */
  function explicitShareRows(draft) {
    return shareRowsFromDraft(draft).filter((r) => r.kind !== "project-root");
  }

  function setRestOfProject(draft, mode) {
    const outside = explicitShareRows(draft).filter((r) => r.kind === "outside");
    if (mode === "none") {
      // Keep insides if any; otherwise empty project-tree (user must add or leave empty until Apply).
      const insides = explicitShareRows(draft).filter((r) => r.kind === "inside");
      applyShareRowsToDraft(draft, [...insides, ...outside]);
      return;
    }
    // Whole project: drop insides (they are included under root).
    applyShareRowsToDraft(draft, [
      { kind: "project-root", access: mode === "read-only" ? "read-only" : "read-write" },
      ...outside,
    ]);
  }

  function accessPills(id, value, options) {
    // options: [{ value, label }]
    return `<div class="access-pills" data-access-id="${esc(id)}" data-value="${esc(value)}" role="group">
      ${options.map((opt) => `<button type="button" class="access-pill${opt.value === value ? " active" : ""}" data-value="${esc(opt.value)}">${esc(opt.label)}</button>`).join("")}
    </div>`;
  }

  /**
   * Single source-of-truth list: explicit folders + fixed "Everything else" row.
   * No Templates, no duplicate status panel, no mode toggle.
   */
  function renderFoldersTable(draft, workspace) {
    const rest = restOfProjectMode(draft);
    const explicit = explicitShareRows(draft);
    const twoWay = [
      { value: "read-only", label: "Look only" },
      { value: "read-write", label: "Can edit" },
    ];
    const threeWay = [
      { value: "none", label: "Not shared" },
      { value: "read-only", label: "Look only" },
      { value: "read-write", label: "Can edit" },
    ];

    const bodyRows = explicit.map((row, index) => {
      let title = "";
      let meta = "";
      let icon = "folder";
      if (row.kind === "inside") {
        title = row.path;
        meta = "In project";
      } else {
        title = row.hostPath;
        meta = "Outside project";
        icon = "folder-open";
      }
      return `<div class="folders-table-row" data-explicit-index="${index}">
        <div class="folders-table-path">
          <span class="folders-table-icon"><i data-lucide="${icon}"></i></span>
          <div class="folders-table-text">
            <b title="${esc(title)}">${esc(title)}</b>
            <small>${esc(meta)}</small>
          </div>
        </div>
        ${accessPills(`ex-${index}`, row.access, twoWay)}
        <button type="button" class="icon-button folders-row-remove" data-explicit-index="${index}" aria-label="Remove"><i data-lucide="x"></i></button>
      </div>`;
    }).join("");

    const emptyHint = !explicit.length && rest === "none"
      ? `<div class="folders-table-empty">No folders added. The AI sees nothing until you add a folder or set Everything else.</div>`
      : !explicit.length
        ? ""
        : "";

    return `<div class="folders-table" role="table" aria-label="Folders shared with the AI">
      <div class="folders-table-head" role="row">
        <span>Folder</span>
        <span>Access</span>
        <span class="folders-table-head-spacer" aria-hidden="true"></span>
      </div>
      <div class="folders-table-body">
        ${bodyRows}
        ${emptyHint}
        <div class="folders-table-row folders-table-rest" data-rest-row>
          <div class="folders-table-path">
            <span class="folders-table-icon muted"><i data-lucide="layers"></i></span>
            <div class="folders-table-text">
              <b>Everything else in the project</b>
              <small>${rest === "none" ? "Not in the room" : rest === "read-only" ? "Rest of project · look only" : "Rest of project · can edit"}</small>
            </div>
          </div>
          ${accessPills("rest", rest, threeWay)}
          <span class="folders-table-fixed" title="Always present"></span>
        </div>
      </div>
    </div>`;
  }

  function renderProjectFolders() {
    const project = effectiveProject();
    const draft = ensureFolderDraft(project);
    const presence = project.folders?.workspace || { status: project.workspace ? "ok" : "unset", path: project.workspace || "" };
    const running = project.folders?.runningSessions || [];
    const root = $("#project-section-folders");
    if (root) root.dataset.project = selectedProject || "";
    const missing = presence.status === "missing" || presence.status === "not-directory";
    draft.editor = draft.workspaceShare === "selected" ? "advanced" : "simple";
    const dirty = isFolderDraftDirty(draft, project);
    const sessionsBlock = running.length > 0;
    const applyDisabled = !dirty || sessionsBlock;
    const applyTitle = sessionsBlock
      ? "Stop running sessions before applying"
      : dirty
        ? "Save folder access for new sessions"
        : "No unsaved changes";
    const explainer = sessionsBlock
      ? `Stop sessions first: ${running.map((s) => s.agentName || s.id).join(", ")}`
      : dirty
        ? "Unsaved changes · new sessions only"
        : "No unsaved changes";

    root.innerHTML = contentPanel({
      title: "Folders",
      className: "policy-section folders-page",
      body: `
        ${missing ? `
          <div class="workspace-missing" role="alert">
            <div><b>Project folder not found</b><p>Locate the moved folder or remove this Project.</p><code>${esc(presence.path || project.workspace || "")}</code></div>
            <div class="workspace-missing-actions">
              <button type="button" class="primary" id="folders-locate"><i data-lucide="folder-open"></i>Locate folder</button>
              <button type="button" class="secondary" id="folders-remove-project">Remove Project</button>
            </div>
          </div>` : `
          <div class="folders-project-bar">
            <div class="folders-project-meta">
              <span class="folders-project-label">Project folder</span>
              <code class="folders-project-path" title="${esc(project.workspace || "")}">${esc(project.workspace || "—")}</code>
            </div>
            <button type="button" class="secondary compact" id="pick-folders-workspace"><i data-lucide="folder-open"></i>Locate</button>
          </div>`}

        <div class="folders-board">
          ${renderFoldersTable(draft, project.workspace)}
          <div class="folders-board-actions">
            <button type="button" class="secondary" id="folders-pick-share"><i data-lucide="plus"></i>Add folder</button>
          </div>
        </div>

        <div id="folders-diff" class="folder-diff hidden"></div>

        ${sessionsBlock ? `<p class="compose-note folders-stop-gate" role="status">Stop running sessions before Apply: ${running.map((s) => esc(s.agentName || s.id)).join(", ")}</p>` : ""}
        <div class="dialog-actions folders-footer">
          <span class="apply-explainer${dirty ? " dirty" : ""}" id="folders-apply-explainer">${esc(explainer)}</span>
          <button type="button" class="tertiary" id="folders-reset-draft" ${dirty ? "" : "disabled"} title="${dirty ? "Discard unsaved changes" : "Nothing to reset"}">Reset</button>
          <button type="button" class="primary" id="folders-apply" ${applyDisabled ? "disabled" : ""} title="${esc(applyTitle)}"><i data-lucide="check"></i>Apply</button>
        </div>`,
    });

    const wireAccessPills = (id, onChange) => {
      const group = $(`.access-pills[data-access-id="${id}"]`);
      if (!group) return;
      $$("button", group).forEach((button) => button.addEventListener("click", () => {
        onChange(button.dataset.value);
      }));
    };

    // Explicit folder access
    explicitShareRows(draft).forEach((row, index) => {
      wireAccessPills(`ex-${index}`, (value) => {
        const rows = shareRowsFromDraft(draft);
        // Map explicit index → full shareRows index (skip project-root if present)
        const full = rows.filter((r) => r.kind !== "project-root");
        if (!full[index]) return;
        full[index] = { ...full[index], access: value === "read-only" ? "read-only" : "read-write" };
        const rootRow = rows.find((r) => r.kind === "project-root");
        applyShareRowsToDraft(draft, rootRow ? [rootRow, ...full] : full);
        renderProjectFolders();
      });
    });

    wireAccessPills("rest", (value) => {
      const mode = value === "read-only" || value === "read-write" ? value : "none";
      const hadInsides = explicitShareRows(draft).some((r) => r.kind === "inside");
      setRestOfProject(draft, mode);
      if (mode !== "none" && hadInsides) {
        toast("Specific folders were cleared — Everything else already covers the project.");
      }
      renderProjectFolders();
    });

    $$(".folders-row-remove").forEach((button) => button.addEventListener("click", () => {
      const index = Number(button.dataset.explicitIndex);
      const full = shareRowsFromDraft(draft);
      const rootRow = full.find((r) => r.kind === "project-root");
      const explicit = full.filter((r) => r.kind !== "project-root");
      explicit.splice(index, 1);
      applyShareRowsToDraft(draft, rootRow ? [rootRow, ...explicit] : explicit);
      renderProjectFolders();
    }));

    $("#folders-pick-share")?.addEventListener("click", () => {
      if (!project.workspace) return toast("Set the project folder first.", true);
      chooseFolder((abs) => {
        const classified = classifyHostPathClient(abs, project.workspace);
        if (classified.kind === "invalid") return toast(classified.reason, true);
        if (classified.kind === "project-root") {
          // Picking project root = set Everything else to Can edit
          setRestOfProject(draft, "read-write");
          toast("Project folder shared as Can edit (Everything else).");
          renderProjectFolders();
          return;
        }
        if (classified.kind === "inside" && restOfProjectMode(draft) !== "none") {
          return toast("Set Everything else to Not shared before adding specific folders.", true);
        }
        const next = classified.kind === "inside"
          ? { kind: "inside", path: classified.path, access: "read-write" }
          : { kind: "outside", hostPath: classified.hostPath, access: "read-write" };
        const result = addShareRowClient(shareRowsFromDraft(draft), next);
        if (result.error) return toast(result.error, true);
        applyShareRowsToDraft(draft, result.rows);
        if (result.note) toast(result.note);
        renderProjectFolders();
      });
    });

    const locate = () => chooseFolder(async (path) => {
      folderDraft = null;
      await bindWorkspaceAccess(selectedProject, path);
      renderProjectFolders();
    });
    $("#pick-folders-workspace")?.addEventListener("click", locate);
    $("#folders-locate")?.addEventListener("click", locate);
    $("#folders-remove-project")?.addEventListener("click", () => deleteProject(selectedProject));
    $("#folders-reset-draft")?.addEventListener("click", () => {
      folderDraft = null;
      renderProjectFolders();
    });
    $("#folders-apply")?.addEventListener("click", applyFolders);
    icons();
  }

  function draftPayload() {
    const draft = folderDraft || defaultFolderDraft(effectiveProject());
    return {
      editor: draft.editor,
      workspaceAccess: draft.workspaceAccess,
      workspaceShare: draft.workspaceShare,
      entries: draft.entries || [],
      extraReadPaths: draft.extraReadPaths || [],
      extraWritePaths: draft.extraWritePaths || [],
    };
  }

  async function applyFolders() {
    const project = effectiveProject();
    const draft = ensureFolderDraft(project);
    if (!isFolderDraftDirty(draft, project)) {
      toast("No unsaved changes.");
      return;
    }
    const btn = $("#folders-apply");
    if (btn) btn.disabled = true;
    try {
      await api("/api/folders/apply", {
        method: "POST",
        body: JSON.stringify({ project: selectedProject, draft: draftPayload() }),
      });
      folderDraft = null;
      await refresh();
      toast("Saved. New sessions use the updated folders.");
      openProjectPage(selectedProject, "folders");
    } catch (error) {
      toast(error.message, true);
      // Re-enable if still dirty after failure.
      if (btn && isFolderDraftDirty(ensureFolderDraft(effectiveProject()), effectiveProject())) {
        btn.disabled = false;
      }
    }
  }

  /**
   * Allowed-site groups, in the user's terms.
   *
   * The vendor list comes from the host (state.egressTemplates) so the room's
   * proxy and this picker can never drift apart: a group shown here is exactly
   * the host set the proxy will admit.
   */
  function renderEgressGroups(selectedTemplates, extraHosts) {
    const templates = state.egressTemplates || {};
    const chosen = new Set(selectedTemplates || []);
    const rows = Object.entries(templates).map(([id, template]) => `
      <label class="check-row">
        <input type="checkbox" data-template="${esc(id)}"${chosen.has(id) ? " checked" : ""}>
        <span>
          <strong>${esc(template.label)}</strong>
          <em class="fact-line">${esc((template.hosts || []).join(", "))}</em>
        </span>
      </label>`).join("");
    return `
      <div class="field full" id="network-allowlist">
        <label>Allowed sites</label>
        <div class="check-list">${rows}</div>
        <label class="sub-label" for="network-extra-hosts">Other hosts</label>
        <textarea id="network-extra-hosts" rows="3" placeholder="api.example.com">${esc((extraHosts || []).join("\n"))}</textarea>
        <p class="fact-line">One host per line. A host also matches its subdomains.</p>
      </div>`;
  }

  function renderProjectNetwork() {
    const project = effectiveProject();
    editingProject = cloneProject(project);
    const egress = normalizeEgress(editingProject.room.egress);
    const root = $("#project-section-network");
    if (root) root.dataset.project = selectedProject || "";
    root.innerHTML = contentPanel({
      title: "Network",
      assurance: `<span id="network-assurance">${networkAssuranceBadge(egress)}</span>`,
      className: "policy-section",
      body: `
        <div class="field full">
          <label>Internet</label>
          <div id="network-egress" class="segmented" data-value="${egress}">
            <button data-value="blocked" type="button">Off</button>
            <button data-value="allowlist" type="button">Allowed only</button>
            <button data-value="open" type="button">Open</button>
          </div>
          <p class="fact-line" id="network-note">${esc(networkModeNote(egress))}</p>
        </div>
        ${renderEgressGroups(editingProject.room.egressTemplates, editingProject.room.egressHosts)}
        <div class="dialog-actions">
          <span class="apply-explainer">New sessions only</span>
          <button type="button" class="primary" id="save-network"><i data-lucide="check"></i>Save</button>
        </div>`,
    });
    const syncAllowlistVisibility = (value) => {
      const block = $("#network-allowlist");
      if (block) block.hidden = value !== "allowlist";
    };
    setSegment("#network-egress", egress);
    syncAllowlistVisibility(egress);
    $$("#network-egress button").forEach((button) => button.addEventListener("click", () => {
      const value = normalizeEgress(button.dataset.value);
      setSegment("#network-egress", value);
      $("#network-note").textContent = networkModeNote(value);
      syncAllowlistVisibility(value);
      const badge = $("#network-assurance");
      if (badge) badge.outerHTML = `<span id="network-assurance">${networkAssuranceBadge(value)}</span>`;
      icons();
    }));
    $("#save-network")?.addEventListener("click", saveNetwork);
    icons();
  }

  async function saveNetwork() {
    const project = effectiveProject();
    const egress = normalizeEgress($("#network-egress").dataset.value);
    editingProject = cloneProject(project);
    editingProject.room.egress = egress;
    editingProject.room.egressTemplates = egress === "allowlist"
      ? $$("#network-allowlist input[data-template]")
        .filter((input) => input.checked)
        .map((input) => input.dataset.template)
      : [];
    editingProject.room.egressHosts = egress === "allowlist"
      ? ($("#network-extra-hosts")?.value || "").split("\n").map((host) => host.trim()).filter(Boolean)
      : [];
    const payload = {
      previous: selectedProject,
      name: selectedProject,
      description: project.description || "",
      workspace: project.workspace || "",
      mode: project.mode,
      inheritMode: project.inheritMode !== false,
      gitIgnored: project.gitIgnored || "visible",
      ...editingProject,
      repos: (project.repos || []).map((repo) => repo.repo || repo),
      allowedHosts: [],
      backends: project.backends || [],
      loginProfiles: project.loginProfiles || {},
    };
    try {
      await api("/api/contexts", { method: "PUT", body: JSON.stringify(payload) });
      await refresh();
      toast("Network saved for new sessions.");
      openProjectPage(selectedProject, "network");
    } catch (error) {
      toast(error.message, true);
    }
  }

  /**
   * Official login docs per vendor — measured/verified 2026-07-25. Only tools whose
   * documentation URL was confirmed appear here; never guess a docs link.
   */
  const AI_LOGIN_DOCS = {
    claude: "https://docs.anthropic.com/en/docs/claude-code/iam",
    codex: "https://developers.openai.com/codex/auth",
    cursor: "https://cursor.com/docs/cli/reference/authentication",
    grok: "https://docs.x.ai/build/cli/reference",
  };

  /** `bumper -p <project> <alias>` for a tool, quoting the Project name when needed. */
  function aiLaunchCommand(agentId) {
    const alias = agentId === "antigravity" ? "agy" : agentId;
    const name = selectedProject || "";
    if (!name) return `bumper ${alias}`;
    const quoted = /[\s"']/.test(name) ? `'${String(name).replace(/'/g, `'\\''`)}'` : name;
    return `bumper -p ${quoted} ${alias}`;
  }

  /**
   * Project → AI tools.
   *
   * Detection is the teaching surface: what Bumper knows about each tool changes what
   * this page says. Signed-in tools are the main content; the rest collapse into one
   * row so five "not signed in" lines never read as "four things are broken"
   * (desire-first-surface §4). Login itself stays in the terminal — there is no browser
   * inside the room, so the GUI cannot run OAuth (terminal-login-canonical).
   *
   * The only setting here is picking among accounts that are **already signed in**:
   * that needs no OAuth and no naming, and which account a Project uses changes the
   * credential the Sandbox receives, so it belongs on the Project page.
   */
  function renderProjectAi() {
    const project = effectiveProject();
    const loginProfiles = { ...(project.loginProfiles || {}) };
    const roomAgents = agents.filter((a) => a.roomCommand?.length);
    const logins = state.aiLogins || [];
    const accountsFor = (agentId) => logins.filter((l) => l.agentId === agentId);

    const inUse = roomAgents.filter(
      (a) => Boolean(loginProfiles[a.id]) || toolSignedInForProject(project, a.id),
    );
    const inUseIds = new Set(inUse.map((a) => a.id));
    const notSignedIn = roomAgents.filter((a) => !inUseIds.has(a.id));
    const alsoOnHost = roomAgents.filter((a) => a.detected === true);

    const docsLink = (agent) => {
      const url = AI_LOGIN_DOCS[agent.id];
      if (!url) return "";
      // Name the vendor: these are their instructions, not Bumper's. What Bumper adds
      // is the command above and the paste-the-code detail, which the room requires.
      const label = t("project.ai.docs", { vendor: agent.shortName || agent.name || agent.id });
      return ` <a class="text-button ai-docs-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><i data-lucide="external-link"></i>${esc(label)}</a>`;
    };

    const commandChip = (agentId) => {
      const cmd = aiLaunchCommand(agentId);
      // A bare <code> gave no hint that clicking copies. Keep the monospace fact, add
      // an explicit copy affordance — no red "error-looking" snippet styling.
      return `<button type="button" class="command-chip" data-copy="${esc(cmd)}"
        title="${esc(t("project.ai.copy_command"))}"><code>${esc(cmd)}</code><i data-lucide="copy"></i></button>`;
    };

    const rows = inUse.map((agent) => {
      const bound = loginProfiles[agent.id];
      const label = aiAccountDisplayLabel(bound);
      const cmd = aiLaunchCommand(agent.id);
      // Offer a switch only when there is more than one signed-in account to pick.
      const options = accountsFor(agent.id).filter((l) => l.persisted);
      const picker = options.length > 1
        ? `<select class="ai-account-pick" data-agent="${esc(agent.id)}" aria-label="${esc(t("project.ai.account_for"))} ${esc(agent.shortName || agent.id)}">
            ${options.map((o) => `<option value="${esc(o.identityId)}"${o.identityId === (bound || "default") ? " selected" : ""}>${esc(aiAccountDisplayLabel(o.identityId))}</option>`).join("")}
          </select>`
        : "";
      return connectionRow({
        identity: `${agent.shortName || agent.name || agent.id} · ${label}`,
        target: "",
        statusHtml: `<span class="tool-auth signed">${esc(t("connection.status.ready"))}</span>`,
        actionsHtml: `${picker}${commandChip(agent.id)}`,
        className: "ai-fact-row",
      });
    }).join("");

    const pendingRows = notSignedIn.map((agent) => `
      <div class="ai-pending-row">
        <b>${esc(agent.shortName || agent.name || agent.id)}</b>
        ${commandChip(agent.id)}
        ${docsLink(agent)}
      </div>`).join("");

    const pending = notSignedIn.length
      ? `<details class="bind-extra ai-pending">
          <summary>${esc(t("project.ai.pending_summary", {
            count: String(notSignedIn.length),
            tools: notSignedIn.map((a) => a.shortName || a.id).join(", "),
          }))}</summary>
          <p class="fact-line">${esc(t("project.ai.login_flow"))}</p>
          ${pendingRows}
        </details>`
      : "";

    const hostNote = alsoOnHost.length
      ? `<details class="bind-extra ai-host-note">
          <summary>${esc(t("project.ai.host_summary", { tools: alsoOnHost.map((a) => a.shortName || a.id).join(", ") }))}</summary>
          <p class="fact-line">${esc(t("project.ai.host_detail"))}</p>
        </details>`
      : "";

    const autoApprove = project.autoApprove === true;
    const autoSupportedAny = agents.some((a) => autoApproveSupported(a.id));

    setProjectSection("ai", contentPanel({
      title: t("project.ai.title"),
      description: t("project.ai.desc_terminal"),
      className: "policy-section",
      body: `
        <div class="bound-list">${rows || `<p class="muted">${esc(t("project.ai.empty"))}</p>`}</div>
        ${pending}
        ${hostNote}
        ${autoSupportedAny ? `<details class="bind-extra">
          <summary>${esc(t("project.ai.approval_prompts"))}: ${autoApprove ? esc(t("project.ai.approval_off")) : esc(t("project.ai.tool_default"))}</summary>
          <label class="check-inline">
            <input type="checkbox" id="ai-auto-approve" ${autoApprove ? "checked" : ""}>
            <span>${esc(t("project.ai.skip_approval"))}</span>
          </label>
        </details>` : ""}`,
    }));

    $$("#project-section-ai .command-chip").forEach((node) => node.addEventListener("click", () => {
      const text = node.dataset.copy || node.textContent || "";
      navigator.clipboard?.writeText(text.trim());
      toast(t("project.ai.copied"));
    }));
    $$(".ai-account-pick").forEach((select) => select.addEventListener("change", async () => {
      const next = { ...(effectiveProject().loginProfiles || {}) };
      next[select.dataset.agent] = select.value;
      try {
        await putProjectPatch(selectedProject, { loginProfiles: next });
        toast(t("project.ai.account_switched", { account: aiAccountDisplayLabel(select.value) }));
        openProjectPage(selectedProject, "ai");
      } catch (error) {
        toast(error.message, true);
      }
    }));
    $("#ai-auto-approve")?.addEventListener("change", async (event) => {
      await setAutoApprove(event.target.checked);
      if (route === "project" && projectSection === "ai") renderProjectAi();
    });
    icons();
  }

  function renderGitWorkspaceBody(status) {
    if (!status) {
      return `<p class="empty-hint">Loading…</p>`;
    }
    const kind = status.kind || "missing";
    if (kind === "unbound" || kind === "missing") {
      return `
        <p class="fact-line">${esc(status.summary || "No project folder")}</p>
        <button type="button" class="secondary" id="git-goto-folders"><i data-lucide="folder"></i>Folders</button>`;
    }
    if (kind === "git-missing") {
      return `<p class="fact-line">${esc(status.summary || "git not found")}</p>`;
    }
    if (kind === "not-repo" || kind === "empty") {
      const guidance = status.hostGuidance || status.hostCommand || "";
      return `
        <p class="fact-line">${esc(status.summary || "Not a git repository")}</p>
        ${guidance ? `<div class="input-action"><input id="git-host-cli" readonly value="${esc(guidance)}"><button type="button" class="primary" id="copy-git-host-cli"><i data-lucide="copy"></i>Copy</button></div>` : ""}`;
    }
    const commits = (status.commits || []).map((c) =>
      `<li><code>${esc(c.sha)}</code> ${esc(c.subject)} <span class="muted">${esc(c.relativeDate)}</span></li>`
    ).join("") || "<li>No recent commits</li>";
    const counts = `${status.staged ?? 0} staged · ${status.unstaged ?? 0} unstaged · ${status.untracked ?? 0} untracked`;
    const upstreamLine = status.upstream
      ? (status.ahead === 0 ? `Up to date with ${status.upstream}` : `${status.ahead ?? "?"} ahead of ${status.upstream}`)
      : "No upstream";
    const command = status.hostCommand || "";
    return `
      <p class="git-status-line"><b>${esc(status.summary || "")}</b></p>
      <p class="fact-line">${esc(upstreamLine)} · ${esc(counts)}</p>
      ${command ? `<div class="input-action git-host-cmd"><input id="git-host-cli" readonly value="${esc(command)}"><button type="button" class="primary" id="copy-git-host-cli"><i data-lucide="copy"></i>Copy</button></div>` : ""}
      <details class="git-recent-details">
        <summary>Recent commits</summary>
        <ul class="git-commit-list">${commits}</ul>
      </details>`;
  }

  function wireGitHostCopy() {
    $("#copy-git-host-cli")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("#git-host-cli").value);
        toast("Command copied.");
      } catch {
        toast("Copy failed — select the command manually.", true);
      }
    });
    $("#git-goto-folders")?.addEventListener("click", () => openProjectPage(selectedProject, "folders"));
  }

  async function loadGitWorkspaceStatus() {
    if (!selectedProject) return null;
    try {
      return await api(`/api/git/workspace?context=${encodeURIComponent(selectedProject)}`);
    } catch (error) {
      return {
        kind: "missing",
        summary: error.message || "Could not read workspace git state.",
        hostGuidance: "Check that the Project folder still exists under Folders.",
        commits: [],
      };
    }
  }

  function githubRepositoryChoices() {
    return (state.githubApps || []).filter((app) => app.connected === true).flatMap((app) =>
      (app.repositories || []).map((repo) => ({
        ...repo,
        connectionId: repo.connectionId || app.id,
        appLabel: app.ownerLogin || app.slug || app.id,
        appConnected: app.connected === true,
      }))
    );
  }

  function githubRepositoryChoiceKey(repo) {
    return [repo.connectionId, repo.installationId, repo.id].join(":");
  }

  /**
   * The capability ladder, exactly as the host defines it.
   *
   * Never hard-code rungs here: the same descriptors drive the permission set
   * Bumper asks GitHub for, so a label written in the UI would be a second,
   * silently divergent source of truth about what the AI can do.
   */
  function gitCapabilityDescriptors() {
    return state.gitCapabilities || {};
  }

  function gitCapabilityLabel(capability) {
    return gitCapabilityDescriptors()[capability]?.label || capability || "No access";
  }

  function gitCapabilityOptions(selected, { includeNone = true } = {}) {
    return Object.values(gitCapabilityDescriptors())
      .filter((rung) => includeNone || rung.id !== "none")
      .map((rung) => `<option value="${esc(rung.id)}" ${rung.id === selected ? "selected" : ""}>${esc(rung.label)}</option>`)
      .join("");
  }

  function projectGitBindings(project) {
    return Array.isArray(project?.gitRepositories) ? project.gitRepositories : [];
  }

  /**
   * One row per bound repository.
   *
   * A Project routinely spans app + infra + docs, and those do not deserve the
   * same access — so the rung lives on the row, not on the Project.
   */
  function projectGitRepositoryRowsHtml(project) {
    const bindings = projectGitBindings(project);
    if (!bindings.length) {
      return `<p class="git-repo-empty">No repositories yet. Add one to grant access.</p>`;
    }
    return `<div class="git-repo-list">${bindings.map((row) => {
      const detail = gitCapabilityDescriptors()[row.capability]?.detail || "";
      const owner = (state.githubApps || []).find((app) => app.id === row.connectionId);
      return `<div class="git-repo-row" data-repository="${esc(row.fullName)}">
        <div class="git-repo-main">
          <b>${esc(row.fullName)}</b>
          <small>${esc(owner?.ownerLogin || owner?.slug || row.connectionId)}${owner?.connected === false ? " · key unavailable" : ""}</small>
          <em class="fact-line">${esc(detail)}</em>
        </div>
        <div class="git-repo-actions">
          <select class="git-repo-capability" data-repository="${esc(row.fullName)}" aria-label="Access for ${esc(row.fullName)}">
            ${gitCapabilityOptions(row.capability, { includeNone: false })}
          </select>
          <button type="button" class="tertiary git-repo-remove" data-repository="${esc(row.fullName)}">Remove</button>
        </div>
      </div>`;
    }).join("")}</div>`;
  }

  async function resolveProjectGitIntent(repository = projectGitIntentDraft) {
    projectGitIntentDraft = String(repository || "").trim();
    projectGitIntentResult = await api("/api/github/repository-intent", {
      method: "POST",
      body: JSON.stringify({ context: selectedProject, repository: projectGitIntentDraft }),
    });
    return projectGitIntentResult;
  }

  function projectGitIntentHtml(project) {
    const result = projectGitIntentResult;
    if (!result) {
      return `<div class="git-intent-result neutral"><b>Check access to continue</b><p>Local only — Bumper does not call GitHub until you connect or refresh in Library.</p></div>`;
    }
    if (result.status === "invalid") {
      return `<div class="git-intent-result error"><b>That is not a GitHub repository</b><p>${esc(result.error)}</p></div>`;
    }
    if (result.status === "owner-missing") {
      return `<div class="git-intent-result setup"><b>Add access for ${esc(result.intent.owner)}</b>
        <p>No personal or Organization connection for this owner exists on this Mac.</p>
        <button type="button" class="primary" id="git-intent-library">Add GitHub access</button></div>`;
    }
    if (result.status === "reconnect-required") {
      return `<div class="git-intent-result setup"><b>Reconnect ${esc(result.intent.owner)}</b>
        <p>The connection is listed, but its private App key is unavailable.</p>
        <button type="button" class="primary" id="git-intent-library">Reconnect in Library</button></div>`;
    }
    if (result.status === "repository-missing") {
      return `<div class="git-intent-result setup"><b>Allow ${esc(result.intent.fullName)}</b>
        <p>The owner is connected, but this repository is not in Bumper’s refreshed installation list. Manage repositories, then Refresh.</p>
        <button type="button" class="primary" id="git-intent-library">Manage in Library</button></div>`;
    }
    const match = result.selected;
    const existing = projectGitBindings(project).find(
      (row) => row.fullName.toLowerCase() === result.intent.fullName.toLowerCase(),
    );
    return `<div class="git-intent-result ready"><b>${existing ? "Already on this Project — update access?" : "Ready to add"}</b>
      <p>${esc(match.ownerLogin)} · provider-enforced token for ${esc(match.fullName)}</p>
      <div class="git-intent-bind">
        <label>What the AI may do<select id="git-intent-access">
          ${gitCapabilityOptions(existing?.capability || "read", { includeNone: false })}
        </select></label>
        <button type="button" class="primary" id="git-intent-use">${existing ? "Update access" : "Add to Project"}</button>
      </div></div>`;
  }

  function gitLiveSessionsHtml(project) {
    const sessions = (state.gitSessions || []).filter(
      (session) => session.projectName === selectedProject && session.live,
    );
    if (!sessions.length) {
      return `<details class="git-live-idle">
        <summary>Live Sessions · 0 running</summary>
        <p class="compose-note">Start <code>bumper -p ${esc(shellQuote(selectedProject))} &lt;cli&gt;</code> for a live Session.</p>
      </details>`;
    }
    const rows = sessions.map((session) => {
      const access = session.effectiveAccess || "none";
      // A temporary elevation only exists where the Project itself binds read.
      const elevatable = projectGitBindings(project).some((row) => row.capability === "read");
      const temporaryWrite = access === "write"
        && elevatable
        && Date.parse(session.writeUntil || "") > Date.now();
      const feedback = gitSessionFeedback.get(session.id);
      const heartbeat = Number.isFinite(Date.parse(session.heartbeatAt || ""))
        ? new Date(session.heartbeatAt).toLocaleTimeString()
        : "unknown";
      return `<div class="git-live-row" data-git-session="${esc(session.id)}">
        <div class="git-live-main">
          <div class="git-live-title"><span class="live-dot" aria-hidden="true"></span><b>${esc(session.agentName || session.agentId)}</b>
            <span class="git-access-badge ${esc(access)}">${esc(access === "write" ? "Write" : access === "read" ? "Read" : "Off")}</span></div>
          <p>${esc(session.repository || project.gitRepository || "No repository")} · heartbeat ${esc(heartbeat)} · <span class="mono">${esc(session.id.slice(0, 8))}</span></p>
          ${temporaryWrite ? `<p class="git-write-until">Write ends at ${esc(new Date(session.writeUntil).toLocaleTimeString())}</p>` : ""}
          ${feedback ? `<p class="git-session-feedback ${feedback.pending ? "pending" : "applied"}">${esc(feedback.message)}</p>` : ""}
        </div>
        <div class="git-live-actions">
          <label class="git-live-switch">
            <input type="checkbox" class="git-session-toggle" data-session-id="${esc(session.id)}" ${session.enabled ? "checked" : ""}>
            <span class="switch-track" aria-hidden="true"></span><span>Git access</span>
          </label>
          ${session.enabled && elevatable
            ? `<button type="button" class="secondary git-session-write" data-session-id="${esc(session.id)}" data-action="${temporaryWrite ? "read" : "write"}">${temporaryWrite ? "End Write" : "Write for 15 min"}</button>`
            : ""}
        </div>
      </div>`;
    }).join("");
    return `<section class="git-live-sessions">
      <div class="git-live-heading"><div><h3>Live Sessions</h3><p>Changes apply to one running Session immediately. Its prior token is revoked before another scope is issued.</p></div>
        <span class="git-live-count">${sessions.length} live</span></div>
      <div class="git-live-list">${rows}</div>
    </section>`;
  }

  function renderProjectGit() {
    const project = effectiveProject();
    const apps = state.githubApps || [];
    const repositories = githubRepositoryChoices();
    const bindings = projectGitBindings(project);
    // List-first multi-repo: never prefill the add form with an already-bound repo.
    if (bindings.length === 0) gitAddFormOpen = true;
    const formOpen = gitAddFormOpen || bindings.length === 0;
    const repositoryOptions = apps.map((app) => {
      const appRepos = repositories.filter((repo) => repo.connectionId === app.id);
      if (!appRepos.length) return "";
      const label = `${app.ownerLogin || app.slug || app.id}${app.connected ? "" : " — unavailable"}`;
      return `<optgroup label="${esc(label)}">${appRepos.map((repo) => {
        const key = githubRepositoryChoiceKey(repo);
        return `<option value="${esc(key)}">${esc(repo.fullName)}</option>`;
      }).join("")}</optgroup>`;
    }).join("");

    const addForm = formOpen ? `
      <div class="git-intent-card" id="git-add-form">
        <div class="git-add-form-head">
          <b>Add a repository</b>
          ${bindings.length ? `<button type="button" class="tertiary" id="git-add-cancel">Cancel</button>` : ""}
        </div>
        <div class="field full"><label for="git-repository-intent">GitHub repository URL</label>
          <div class="input-action"><input id="git-repository-intent" value="${esc(projectGitIntentDraft)}" placeholder="https://github.com/owner/repository" autocomplete="off">
            <button type="button" class="primary" id="git-intent-check">Check access</button></div>
        </div>
        <div id="git-intent-result">${projectGitIntentHtml(project)}</div>
        <details class="git-repository-browse"><summary>Or pick from repositories already visible to Bumper</summary>
          <div class="field full"><label>${esc(t("project.git.repository"))}</label>
            <select id="git-repository" ${repositories.length ? "" : "disabled"}><option value="">${esc(t("project.git.none"))}</option>${repositoryOptions}</select></div>
          <div class="field full"><label>What the AI may do</label><select id="git-access">
            ${gitCapabilityOptions("read", { includeNone: false })}</select></div>
          <button type="button" class="secondary" id="git-save-access" ${repositories.length ? "" : "disabled"}>Add selected repository</button>
        </details>
      </div>` : "";

    setProjectSection("git", contentPanel({
      title: "Git",
      className: "policy-section",
      body: `
        <section class="git-repo-section">
          <div class="git-repo-heading">
            <div>
              <h3>Repositories${bindings.length ? ` · ${bindings.length}` : ""}</h3>
            </div>
            ${formOpen ? "" : `<button type="button" class="secondary" id="git-add-open"><i data-lucide="plus"></i>Add repository</button>`}
          </div>
          ${projectGitRepositoryRowsHtml(project)}
          ${addForm}
        </section>
        ${gitLiveSessionsHtml(project)}
        <button type="button" class="tertiary" id="git-manage-access">Manage GitHub access in Library</button>
        <details class="bind-extra">
          <summary>Token lifetime and workflows</summary>
          <p class="fact-line">${esc(t("project.git.expiry"))}</p>
          <p class="fact-line">${esc(t("project.git.workflow"))}</p>
          <p class="fact-line">${esc(t("project.git.fact"))}</p>
        </details>`,
    }));

    $("#git-add-open")?.addEventListener("click", () => {
      gitAddFormOpen = true;
      projectGitIntentDraft = "";
      projectGitIntentResult = null;
      renderProjectGit();
    });

    $("#git-add-cancel")?.addEventListener("click", () => {
      gitAddFormOpen = false;
      projectGitIntentDraft = "";
      projectGitIntentResult = null;
      renderProjectGit();
    });

    const checkIntent = async () => {
      try {
        await resolveProjectGitIntent($("#git-repository-intent")?.value);
        // Re-render only the result panel would lose listeners; full paint is fine.
        gitAddFormOpen = true;
        renderProjectGit();
      } catch (error) {
        toast(error.message, true);
      }
    };
    $("#git-intent-check")?.addEventListener("click", checkIntent);
    $("#git-repository-intent")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void checkIntent();
      }
    });
    $("#git-intent-library")?.addEventListener("click", () => {
      const intent = projectGitIntentResult?.intent;
      if (!intent) return;
      openLibraryGitHubAccess({
        intent: {
          project: selectedProject,
          repository: intent.httpsUrl,
          owner: intent.owner,
          resolution: projectGitIntentResult,
        },
      });
    });
    /*
     * Every change to Git access goes through the whole binding list.
     * Sending one repository would replace the Project's other bindings, which
     * is exactly the bug the singular schema used to make unavoidable.
     */
    const saveBindings = async (bindingsNext, message, { clearAddForm = false } = {}) => {
      await putProjectPatch(selectedProject, { gitRepositories: bindingsNext });
      await refresh(false);
      toast(message);
      if (clearAddForm) {
        projectGitIntentDraft = "";
        projectGitIntentResult = null;
        // Keep form open so the user can add another immediately.
        gitAddFormOpen = true;
      }
      renderProjectGit();
    };
    const bindingsWith = (entry) => {
      const rest = projectGitBindings(effectiveProject())
        .filter((row) => row.fullName.toLowerCase() !== entry.fullName.toLowerCase());
      return [...rest, entry];
    };

    $("#git-intent-use")?.addEventListener("click", async () => {
      try {
        const match = projectGitIntentResult?.selected;
        if (!match) throw new Error("Check the repository again.");
        const existing = projectGitBindings(effectiveProject()).find(
          (row) => row.fullName.toLowerCase() === match.fullName.toLowerCase(),
        );
        await saveBindings(bindingsWith({
          fullName: match.fullName,
          connectionId: match.connectionId,
          installationId: Number(match.installationId),
          repositoryId: Number(match.repositoryId),
          capability: $("#git-intent-access")?.value || "read",
        }), existing
          ? `${match.fullName}: access updated.`
          : `${match.fullName} added. You can add another.`, { clearAddForm: !existing });
      } catch (error) {
        toast(error.message, true);
      }
    });
    $("#git-save-access")?.addEventListener("click", async () => {
      try {
        const choice = repositories.find((repo) => githubRepositoryChoiceKey(repo) === $("#git-repository").value);
        if (!choice) throw new Error("Choose a repository first.");
        await saveBindings(bindingsWith({
          fullName: choice.fullName,
          connectionId: choice.connectionId,
          installationId: Number(choice.installationId),
          repositoryId: Number(choice.id),
          capability: $("#git-access").value || "read",
        }), `${choice.fullName} added. You can add another.`, { clearAddForm: true });
      } catch (error) {
        toast(error.message, true);
      }
    });
    $$(".git-repo-capability").forEach((select) => select.addEventListener("change", async () => {
      const target = select.dataset.repository;
      try {
        await saveBindings(
          projectGitBindings(effectiveProject()).map((row) =>
            row.fullName === target ? { ...row, capability: select.value } : row),
          `${target}: ${gitCapabilityLabel(select.value)}.`,
        );
      } catch (error) {
        toast(error.message, true);
        renderProjectGit();
      }
    }));
    $$(".git-repo-remove").forEach((button) => button.addEventListener("click", async () => {
      const target = button.dataset.repository;
      button.disabled = true;
      try {
        await saveBindings(
          projectGitBindings(effectiveProject()).filter((row) => row.fullName !== target),
          `${target} removed. New Sessions cannot reach it.`,
        );
      } catch (error) {
        button.disabled = false;
        toast(error.message, true);
      }
    }));
    $("#git-manage-access")?.addEventListener("click", openLibraryGitHubAccess);
    $$(".git-session-toggle").forEach((input) => input.addEventListener("change", async () => {
      input.disabled = true;
      try {
        const result = await api("/api/github/session-access", {
          method: "POST",
          body: JSON.stringify({
            sessionId: input.dataset.sessionId,
            action: input.checked ? "enable" : "disable",
          }),
        });
        const label = result.access === "none" ? "Off" : result.access === "write" ? "Write" : "Read";
        gitSessionFeedback.set(input.dataset.sessionId, {
          pending: result.pending > 0,
          message: result.pending
            ? `Applied: ${label}. Remote revocation pending; expiry remains the hard limit.`
            : `Applied: ${label}. Prior token revoked.`,
        });
        await refresh(false);
        toast(result.pending ? `${label} applied; revocation pending.` : `${label} applied to this Session.`);
        renderProjectGit();
      } catch (error) {
        input.checked = !input.checked;
        input.disabled = false;
        toast(error.message, true);
      }
    }));
    $$(".git-session-write").forEach((button) => button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const result = await api("/api/github/session-access", {
          method: "POST",
          body: JSON.stringify({
            sessionId: button.dataset.sessionId,
            action: button.dataset.action,
          }),
        });
        const label = result.access === "write" ? "Write for 15 minutes" : "Read";
        gitSessionFeedback.set(button.dataset.sessionId, {
          pending: result.pending > 0,
          message: result.pending
            ? `Applied: ${label}. Remote revocation pending.`
            : `Applied: ${label}. Prior token revoked.`,
        });
        await refresh(false);
        toast(result.pending ? `${label} applied; revocation pending.` : `${label} applied to this Session.`);
        renderProjectGit();
      } catch (error) {
        button.disabled = false;
        toast(error.message, true);
      }
    }));
    icons();
  }

  async function saveGit() {
    const project = effectiveProject();
    const payload = {
      previous: selectedProject,
      name: selectedProject,
      description: project.description || "",
      workspace: project.workspace || "",
      mode: project.mode,
      inheritMode: project.inheritMode !== false,
      gitIgnored: project.gitIgnored || "visible",
      ...cloneProject(project),
      gitConnectionId: ($("#git-connection")?.value || "").trim(),
      allowedHosts: project.allowedHosts || [],
      backends: project.backends || [],
      loginProfiles: project.loginProfiles || {},
    };
    try {
      await api("/api/contexts", { method: "PUT", body: JSON.stringify(payload) });
      await refresh();
      toast("Git Connection label saved.");
      openProjectPage(selectedProject, "git");
    } catch (error) {
      toast(error.message, true);
    }
  }

  function statusPill(session) {
    return `<span class="status-pill ${session.status}">${esc(session.status)}</span>`;
  }

  function projectMismatch() {
    return (state.protectionMismatches || []).find((item) => item.context === selectedProject) || null;
  }

              function renderCreate() {
    const folder = $("#create-folder")?.value || "";
    const template = document.querySelector('input[name="create-template"]:checked')?.value || "Standard development";
    const existing = folder
      ? Object.entries(state.contexts).filter(([, project]) => project.workspace === folder || (project.access?.roots || []).includes(folder))
      : [];
    const box = $("#create-folder-existing");
    if (box) {
      if (existing.length) {
        box.classList.remove("hidden");
        box.innerHTML = `<p><b>Existing Projects use this folder</b></p><ul>${existing.map(([name]) => `<li>${esc(name)}</li>`).join("")}</ul><p class="compose-note">Creating another Project for the same folder is allowed — confirm intentionally.</p>`;
      } else {
        box.classList.add("hidden");
        box.innerHTML = "";
      }
    }
    if (!$("#create-name").value && folder) {
      const base = folder.replace(/\/$/, "").split("/").pop() || "Project";
      $("#create-name").value = base;
    }
    $$(".template-card").forEach((card) => {
      const input = card.querySelector('input[name="create-template"]');
      card.classList.toggle("selected", Boolean(input?.checked));
    });
    const readOnly = template === "Offline review";
    const networkOff = template !== "Standard development";
    const preview = $("#create-boundary-preview");
    if (preview) {
      preview.innerHTML = renderCreateBoundarySummary({
        workspace: folder,
        access: readOnly ? "read-only" : "read-write",
        egress: networkOff ? "blocked" : "open",
      });
    }
    const title = ($("#create-name")?.value || "").trim();
    if ($("#create-preview-title")) $("#create-preview-title").textContent = title || "Your new Project";
    icons();
  }

  async function createProject(event) {
    event.preventDefault();
    const workspace = $("#create-folder").value.trim();
    const name = $("#create-name").value.trim();
    const template = document.querySelector('input[name="create-template"]:checked')?.value || "Standard development";
    if (!workspace) return toast("Choose a folder first.", true);
    if (!name) return toast("Enter a Project name.", true);
    const existing = Object.keys(state.contexts).filter((key) => {
      const project = state.contexts[key];
      return project.workspace === workspace || (project.access?.roots || []).includes(workspace);
    });
    if (existing.length && !window.confirm(`Folder already used by: ${existing.join(", ")}.\n\nCreate another Project anyway?`)) return;
    const payload = {
      name,
      description: $("#create-description").value.trim(),
      workspace,
      mode: "read-write",
      inheritMode: false,
      gitIgnored: "visible",
      ...cloneProject({}),
      // The room is the boundary — new Projects start without the tool's own prompts.
      autoApprove: true,
      repos: [],
      allowedHosts: [],
      backends: [],
      loginProfiles: {},
    };
    try {
      await api("/api/contexts", { method: "POST", body: JSON.stringify(payload) });
      await bindWorkspaceAccess(name, workspace, { quiet: true });
      await api("/api/permission-setups/apply", {
        method: "POST",
        body: JSON.stringify({ name: template, project: name }),
      });
      selectedProject = name;
      rememberProject(name);
      markSetupDone();
      await refresh(false);
      toast(`Project ${name} created · ${template}.`);
      openProjectPage(name, "overview");
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function deleteProject(name) {
    if (!window.confirm(`Delete the project policy "${name}"? Session records remain.`)) return;
    try {
      await api("/api/contexts", { method: "DELETE", body: JSON.stringify({ name }) });
      if (selectedProject === name) selectedProject = null;
      await refresh();
      toast(`Project ${name} deleted.`);
      go("projects");
    } catch (error) {
      toast(error.message, true);
    }
  }

  function isGitNetworkTarget(target) {
    return /^git\s+\S+/i.test(String(target || "").trim());
  }

  function boundaryFixForEvent(event) {
    if (event.decision !== "blocked") return null;
    if (event.fixTab) {
      const section = event.fixTab === "connections" ? "git" : event.fixTab === "room" ? "network" : event.fixTab === "access" ? "folders" : "overview";
      return { section, label: event.fixLabel || "Open Project", note: NEW_SESSION_EFFECT };
    }
    if (event.surface === "network") {
      if (isGitNetworkTarget(event.target)) {
        return { section: "git", label: "Open Project → Git", note: NEW_SESSION_EFFECT };
      }
      return { section: "network", label: "Open Project → Network", note: NEW_SESSION_EFFECT };
    }
    if (event.surface === "sandbox") {
      return { section: "folders", label: "Open Project → Folders", note: NEW_SESSION_EFFECT };
    }
    return null;
  }

  function allowApplicability(surface, target, event) {
    if (surface === "network") {
      // Never turn a Git provider denial into a local allow rule. Scope changes
      // only through Project → Git and GitHub remains the enforcing party.
      if (isGitNetworkTarget(target)) {
        return {
          mode: "egress-guidance",
          note: "This Git result cannot become a local Allow rule. Choose the repository and token scope in Project → Git; GitHub enforces the upper bound.",
          navLabel: "Open Project → Git",
          section: "git",
        };
      }
      const fix = boundaryFixForEvent(event || { decision: "blocked", surface, target });
      return {
        mode: "egress-guidance",
        note: "Sandbox network/egress block. Allow cannot open the current Sandbox boundary. " + NEW_SESSION_EFFECT,
        navLabel: fix?.label || "Open Project → Network",
        section: fix?.section || "network",
      };
    }
    return {
      mode: "allow",
      button: "Allow as intent (new sessions)",
      hint: "Not enforced in Sandbox: edits native/hook intent for new sessions only. Does not open the current Sandbox filesystem or network boundary.",
      done: "Intent saved for new sessions (not Sandbox-enforced)",
    };
  }

  function openProjectSettingsFromEvent(button) {
    const name = button.dataset.context || selectedProject;
    const section = button.dataset.section || "overview";
    if (name) openProjectPage(name, section);
    else go("projects");
  }

  function eventActionsHtml(event) {
    const blocked = event.decision === "blocked" && (event.surface === "native" || event.surface === "network" || event.surface === "sandbox");
    const applicability = blocked ? allowApplicability(event.surface, event.target, event) : null;
    const fix = boundaryFixForEvent(event);
    let actionHtml = "";
    if (applicability?.mode === "allow") {
      actionHtml = `<button class="allow-button" data-context="${esc(event.context)}" data-surface="${esc(event.surface)}" data-target="${esc(event.target)}" title="${esc(applicability.hint)}" type="button">${esc(applicability.button)}</button><div class="allow-applicability">${esc(applicability.hint)}</div>`;
      const link = applicability.fix || fix;
      if (link) actionHtml += `<button type="button" class="text-button open-project-settings" data-context="${esc(event.context)}" data-section="${esc(link.section)}">${esc(link.label)}</button>`;
    } else if (applicability?.mode === "egress-guidance") {
      actionHtml = `<div class="allow-applicability egress-guidance">${esc(applicability.note)}</div><button type="button" class="text-button open-project-settings open-room-egress" data-context="${esc(event.context)}" data-section="${esc(applicability.section || "network")}">${esc(applicability.navLabel)}</button>`;
    } else if (fix && (event.decision === "blocked" || event.decision === "failed")) {
      actionHtml = `<div class="allow-applicability">${esc(fix.note)}</div><button type="button" class="text-button open-project-settings" data-context="${esc(event.context)}" data-section="${esc(fix.section)}">${esc(fix.label)}</button>`;
    }
    return actionHtml;
  }

  function eventRow(event) {
    const abnormal = event.decision === "failed";
    const actionHtml = eventActionsHtml(event);
    return `<div class="event-row ${abnormal ? "abnormal" : ""}" role="listitem">
      <span class="event-time">${time(event.ts)}</span>
      <span class="surface-tag" title="${esc(event.source || "")}">${esc(event.type || event.surface)}</span>
      <div>
        <div class="event-context">${esc(event.context || "Bumper")}</div>
        <div class="event-target">${esc(event.target)}</div>
        <div class="event-reason">${esc(event.reason)}</div>
        ${actionHtml}
      </div>
      <span class="decision ${esc(event.decision)}" aria-label="${esc(event.decision)}">${esc(event.decision)}</span>
    </div>`;
  }

  function eventsQueryParams() {
    // Glance view: keep grouping, but default window is recent (see #events-time).
    const query = new URLSearchParams({ limit: "100", grouped: "1" });
    const context = $("#events-context")?.value || "";
    const source = $("#events-source")?.value || "";
    const type = $("#events-type")?.value || "";
    const decision = $("#events-decision")?.value || "";
    const timeWindow = $("#events-time")?.value || "1h";
    if (context) query.set("context", context);
    if (source) query.set("source", source);
    if (type) query.set("type", type);
    if (decision) query.set("decision", decision);
    if (timeWindow === "1h") query.set("since", new Date(Date.now() - 3600000).toISOString());
    if (timeWindow === "24h") query.set("since", new Date(Date.now() - 86400000).toISOString());
    if (timeWindow === "7d") query.set("since", new Date(Date.now() - 7 * 86400000).toISOString());
    if (timeWindow === "30d") query.set("since", new Date(Date.now() - 30 * 86400000).toISOString());
    return query;
  }

  function syncEventsExportHref() {
    const query = eventsQueryParams();
    query.delete("grouped");
    query.delete("limit");
    const link = $("#export-events");
    if (link) link.href = `/api/events/export?${query}`;
  }

  function eventGroupRow(group) {
    // Grouping still collapses identical target/decision noise, but frequency
    // is not a product fact the glance view needs — no count badge.
    const abnormal = group.decision === "failed";
    const sample = group.events?.[0] || group;
    const actions = eventActionsHtml(sample);
    return `<div class="event-group ${abnormal ? "abnormal" : ""}" data-group-key="${esc(group.key)}" role="listitem">
      <div class="event-row event-group-head">
        <span class="event-time">${time(group.latestTs)}</span>
        <span class="surface-tag">${esc(group.type)} · ${esc(group.source)}</span>
        <div>
          <div class="event-context">${esc(group.context || "Bumper")}</div>
          <div class="event-target">${esc(group.target)}</div>
          <div class="event-reason">${esc(group.reason)}</div>
          ${actions}
        </div>
        <span class="decision ${esc(group.decision)}" aria-label="${esc(group.decision)}">${esc(group.decision)}</span>
      </div>
    </div>`;
  }

  function paintEventGroups(target, groups) {
    target.innerHTML = groups.length
      ? groups.map(eventGroupRow).join("")
      : `<div class="empty-state"><i data-lucide="list-tree"></i><p data-i18n="events.empty">${esc(t("events.empty"))}</p></div>`;
    $$(".allow-button", target).forEach((button) => button.addEventListener("click", () => allowEvent(button)));
    $$(".open-project-settings", target).forEach((button) => button.addEventListener("click", () => openProjectSettingsFromEvent(button)));
    finishPaint(target);
  }

  async function renderEvents() {
    const gen = ++eventsRenderGen;
    if (eventsAbort) eventsAbort.abort();
    eventsAbort = new AbortController();
    const { signal } = eventsAbort;
    const stillEvents = () => gen === eventsRenderGen && route === "events" && !signal.aborted;

    syncEventsExportHref();
    const target = $("#events-list");
    if (target) {
      target.innerHTML = `<div class="empty-state"><p data-i18n="events.loading">${esc(t("events.loading"))}</p></div>`;
      window.bumperApplyI18n?.(target);
    }
    const query = eventsQueryParams();
    try {
      const payload = await api(`/api/events?${query}`, { signal });
      if (!stillEvents()) return;
      // Yield so a pending nav click can leave Events before we touch the DOM heavily.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!stillEvents()) return;
      const groups = payload.groups || [];
      if (!stillEvents()) return;
      paintEventGroups(target, groups);
    } catch (error) {
      if (error?.name === "AbortError" || signal.aborted || !stillEvents()) return;
      toast(error.message, true);
    }
  }

  async function allowEvent(button) {
    try {
      // Network/git never show an Allow button; refuse if called anyway.
      if (button.dataset.surface === "network") {
        toast("This event cannot become a local Allow rule. Change Git scope in Project → Git or egress in Project → Network.", true);
        return;
      }
      const result = await api("/api/allow", { method: "POST", body: JSON.stringify(button.dataset) });
      const applicability = allowApplicability(button.dataset.surface, button.dataset.target);
      button.textContent = applicability.done || "Saved";
      button.disabled = true;
      toast(result.message || applicability.done || "Saved");
      await refresh(false);
    } catch (error) {
      toast(error.message, true);
    }
  }

  function renderLibrary() {
    if (libraryView === "github-access") {
      renderLibraryGitHubAccess();
      return;
    }
    if (libraryView === "git-connection-edit") {
      renderLibraryGitConnectionEdit();
      return;
    }
    if (libraryView === "git-connections") {
      renderLibraryGitConnections();
      return;
    }
    if (libraryView === "mcp-integration-edit") {
      renderLibraryMcpIntegrationEdit();
      return;
    }
    if (libraryView === "mcp-connection-edit") {
      renderLibraryMcpConnectionEdit();
      return;
    }
    if (libraryView === "mcp-integrations") {
      renderLibraryMcpIntegrations();
      return;
    }
    // Hub: whole-card open only (Open + Add were the same route). Preview what is
    // already registered so the destination is guessable before click.
    const github = libraryGitHubHomePreview();
    const mcp = libraryMcpHomePreview();
    $("#library-content").innerHTML = `
      ${libraryHomeCardHtml({
        key: "github",
        icon: "github",
        title: "GitHub access",
        countLabel: github.countLabel,
        lede: github.lede,
        bodyHtml: github.bodyHtml,
        ariaLabel: "Open GitHub access",
      })}
      ${libraryHomeCardHtml({
        key: "mcp",
        icon: "plug",
        title: t("library.mcpConnections"),
        countLabel: mcp.countLabel,
        lede: mcp.lede,
        bodyHtml: mcp.bodyHtml,
        ariaLabel: "Open MCP connections",
      })}`;
    $$(".library-home-card").forEach((card) => {
      const open = () => {
        if (card.dataset.library === "github") openLibraryGitHubAccess();
        else if (card.dataset.library === "mcp") openLibraryMcpIntegrations();
      };
      card.addEventListener("click", open);
      card.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      });
    });
    icons();
  }

  /** Shared shell for Library hub category cards (click = open category). */
  function libraryHomeCardHtml({ key, icon, title, countLabel, lede, bodyHtml, ariaLabel }) {
    const ledeHtml = lede ? `<p class="library-home-lede">${esc(lede)}</p>` : "";
    return `<article class="library-card panel content-panel library-home-card" data-library="${esc(key)}" tabindex="0" role="link" aria-label="${esc(ariaLabel)}">
      <div class="library-home-top">
        <div class="library-home-heading">
          <span class="library-home-icon" aria-hidden="true"><i data-lucide="${esc(icon)}"></i></span>
          <div>
            <b>${esc(title)}</b>
            <small class="library-home-count">${esc(countLabel)}</small>
          </div>
        </div>
        <i data-lucide="chevron-right" class="library-home-chevron" aria-hidden="true"></i>
      </div>
      ${ledeHtml}
      <div class="library-home-body">${bodyHtml}</div>
    </article>`;
  }

  /** Inventory lines for the GitHub hub card — owners and repo selection facts. */
  function libraryGitHubHomePreview() {
    const apps = state.githubApps || [];
    if (!apps.length) {
      return {
        countLabel: "Not set up yet",
        lede: "",
        bodyHtml: `<p class="library-home-empty">No owners yet. Open to connect.</p>`,
      };
    }
    const max = 4;
    const rows = apps.slice(0, max).map((app) => {
      const installations = app.installations || [];
      const account = app.ownerLogin || installations[0]?.accountLogin || "GitHub owner";
      const kind = app.ownerType || installations[0]?.accountType || "Account";
      const repoCount = (app.repositories || []).length;
      const selectsAll = installations.some((item) => item.repositorySelection === "all");
      const selection = selectsAll
        ? (repoCount ? `All repositories · ${repoCount} visible` : "All repositories")
        : (repoCount
          ? `${repoCount} selected repositor${repoCount === 1 ? "y" : "ies"}`
          : "No repositories loaded yet");
      const warn = app.connected === false ? " · Key unavailable" : "";
      return `<div class="library-home-row">
        <span class="library-home-row-id">${esc(account)}</span>
        <span class="library-home-row-meta">${esc(kind)} · ${esc(selection)}${esc(warn)}</span>
      </div>`;
    }).join("");
    const more = apps.length > max
      ? `<div class="library-home-more">+${apps.length - max} more</div>`
      : "";
    return {
      countLabel: `${apps.length} GitHub owner${apps.length === 1 ? "" : "s"}`,
      lede: "",
      bodyHtml: rows + more,
    };
  }

  /** Inventory lines for the MCP hub card — Connections first, Integrations as context. */
  function libraryMcpHomePreview() {
    const integrations = state.mcpIntegrations || [];
    const connections = state.mcpConnections || [];
    if (!connections.length && !integrations.length) {
      return {
        countLabel: "Not set up yet",
        lede: "",
        bodyHtml: `<p class="library-home-empty">No connections yet. Open to add one.</p>`,
      };
    }
    if (!connections.length) {
      const names = integrations
        .map((item) => item.name || item.id)
        .filter(Boolean);
      const shown = names.slice(0, 4);
      const rows = shown.map((name) => `<div class="library-home-row">
        <span class="library-home-row-id">${esc(name)}</span>
        <span class="library-home-row-meta">Type defined · no connection yet</span>
      </div>`).join("");
      const more = names.length > shown.length
        ? `<div class="library-home-more">+${names.length - shown.length} more</div>`
        : "";
      return {
        countLabel: `${integrations.length} tool type${integrations.length === 1 ? "" : "s"} · 0 connections`,
        lede: "",
        bodyHtml: `${rows}${more}<p class="library-home-empty">Open to add a Connection.</p>`,
      };
    }
    const max = 4;
    const rows = connections.slice(0, max).map((conn) => {
      const integ = integrations.find((item) => item.id === conn.integrationId);
      const identity = conn.name || conn.id;
      const target = integ?.name || conn.integrationId || "MCP";
      const status = connectionStatus("mcp", conn);
      const memo = conn.description ? ` · ${conn.description}` : "";
      const statusBit = status.key === "ready" ? "" : ` · ${status.label}`;
      return `<div class="library-home-row">
        <span class="library-home-row-id">${esc(identity)}</span>
        <span class="library-home-row-meta">${esc(target)}${esc(memo)}${esc(statusBit)}</span>
      </div>`;
    }).join("");
    const more = connections.length > max
      ? `<div class="library-home-more">+${connections.length - max} more</div>`
      : "";
    const integNote = integrations.length
      ? ` · ${integrations.length} integration${integrations.length === 1 ? "" : "s"}`
      : "";
    return {
      countLabel: `${connections.length} connection${connections.length === 1 ? "" : "s"}${integNote}`,
      lede: "",
      bodyHtml: rows + more,
    };
  }



  function openLibraryMcpAddPicker() {
    // Zero integrations: the type picker would be empty (only Cancel) — go create
    // the Integration (command + fields) first; Connection comes after.
    if (!(state.mcpIntegrations || []).length) {
      openLibraryMcpIntegrationEdit();
      return;
    }
    go("library", { libraryView: "mcp-integrations", keepLibrary: true });
    queueMicrotask(() => $("#mcp-add-picker")?.removeAttribute("hidden"));
  }

  async function resolveGitHubSetupIntent() {
    if (!githubSetupIntent) return null;
    githubSetupIntent.resolution = await api("/api/github/repository-intent", {
      method: "POST",
      body: JSON.stringify({
        context: githubSetupIntent.project,
        repository: githubSetupIntent.repository,
      }),
    });
    return githubSetupIntent.resolution;
  }

  function githubSetupIntentHtml() {
    if (!githubSetupIntent) return "";
    const result = githubSetupIntent.resolution;
    const status = result?.status || "owner-missing";
    const detail = status === "available" || status === "bound"
      ? "Access is ready. Continue to the Project to choose Read or Read and write."
      : status === "repository-missing"
        ? "Open Manage repositories for this owner, allow the repository, then press Refresh."
        : status === "reconnect-required"
          ? "The saved App key is unavailable. Create a replacement connection for this owner."
          : "Choose whether this owner is your personal account or an Organization.";
    return `<div class="github-setup-intent ${status}">
      <div><small>Repository requested by ${esc(githubSetupIntent.project || "Project")}</small>
        <b>${esc(result?.intent?.fullName || githubSetupIntent.repository)}</b><p>${esc(detail)}</p></div>
      <div class="github-setup-intent-actions">
        ${(status === "available" || status === "bound") ? '<button type="button" class="primary" id="github-intent-continue">Continue to Project</button>' : ""}
        <button type="button" class="tertiary" id="github-intent-cancel">Cancel</button>
      </div>
    </div>`;
  }

  function renderLibraryGitHubAccess() {
    const apps = state.githubApps || [];
    const intentOwner = githubSetupIntent?.owner?.toLowerCase() || "";
    const rows = apps.map((app) => {
      const installations = app.installations || [];
      const repositoryCount = (app.repositories || []).length;
      const selection = installations.some((item) => item.repositorySelection === "all")
        ? `All repositories · ${repositoryCount} currently visible`
        : `${repositoryCount} selected repositor${repositoryCount === 1 ? "y" : "ies"}`;
      const account = app.ownerLogin || installations[0]?.accountLogin || "GitHub owner";
      const kind = app.ownerType || installations[0]?.accountType || "Account";
      const status = githubRefreshStatus[app.id]
        || (app.lastRefreshedAt ? `Refreshed ${relative(app.lastRefreshedAt)}` : "Refresh to load repositories");
      const manageRepositoriesUrl = installations.find((item) => item.settingsUrl)?.settingsUrl
        || (app.slug ? `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new` : "");
      const appSettingsUrl = app.slug
        ? (String(kind).toLowerCase() === "organization" && account
          ? `https://github.com/organizations/${encodeURIComponent(account)}/settings/apps/${encodeURIComponent(app.slug)}`
          : `https://github.com/settings/apps/${encodeURIComponent(app.slug)}`)
        : "";
      // GitHub mark for the owner row — Bumper’s App badge is only for the upload help below.
      return `<div class="github-access-row ${intentOwner && account.toLowerCase() === intentOwner ? "intent-owner" : ""}">
        <div class="github-owner-icon" aria-hidden="true"><i data-lucide="github"></i></div>
        <div class="github-owner-main">
          <b>${esc(account)}</b>
          <p>${esc(kind)} · ${esc(selection)}</p>
          <small>${esc(app.slug || `App ${app.appId}`)} · ${esc(status)}${app.connected ? "" : " · Key unavailable"}</small>
        </div>
        <div class="github-owner-actions">
          ${appSettingsUrl ? `<button type="button" class="tertiary github-manage" data-url="${esc(appSettingsUrl)}">App settings</button>` : ""}
          ${manageRepositoriesUrl ? `<button type="button" class="tertiary github-manage" data-url="${esc(manageRepositoriesUrl)}">Manage repositories</button>` : ""}
          <button type="button" class="secondary github-refresh" data-id="${esc(app.id)}" ${githubRefreshBusy.has(app.id) ? "disabled" : ""}>${githubRefreshBusy.has(app.id) ? "Refreshing…" : "Refresh"}</button>
          <button type="button" class="tertiary github-disconnect" data-id="${esc(app.id)}" data-owner="${esc(account)}">Disconnect locally</button>
        </div>
      </div>`;
    }).join("");
    // Empty list, setup intent, or user clicked Add → show personal/org picker.
    // Otherwise only a single Add button so the list stays scannable.
    const addFormOpen = githubAddFormOpen || !apps.length || Boolean(githubSetupIntent);
    const addForm = addFormOpen
      ? `<div class="github-add-panel">
          <div class="github-add-panel-head">
            <div>
              <b>${apps.length ? "Add another GitHub owner" : "Add GitHub owner"}</b>
            </div>
            ${apps.length && !githubSetupIntent
              ? `<button type="button" class="tertiary" id="github-add-cancel">Cancel</button>`
              : ""}
          </div>
          <div class="github-account-types" role="radiogroup" aria-label="GitHub account type">
            <label class="${githubAddAccountType === "personal" ? "selected" : ""}"><input type="radio" name="github-account-type" value="personal" ${githubAddAccountType === "personal" ? "checked" : ""}>
              <span><b>My personal account</b><small>Uses the personal account currently signed in to GitHub.</small></span></label>
            <label class="${githubAddAccountType === "organization" ? "selected" : ""}"><input type="radio" name="github-account-type" value="organization" ${githubAddAccountType === "organization" ? "checked" : ""}>
              <span><b>An Organization</b><small>For repositories owned by a team or company. GitHub may ask an owner to approve.</small></span></label>
          </div>
          ${githubAddAccountType === "organization" ? `<div class="field full"><label for="github-owner">Organization name or GitHub URL</label>
            <input id="github-owner" autocomplete="off" value="${esc(githubSetupIntent?.owner || "")}" placeholder="my-org or https://github.com/my-org">
            <small>Bumper extracts the owner name; it does not contact GitHub while you type.</small></div>` : ""}
          <div class="github-add-actions">
            <button type="button" class="primary" id="github-add-owner" ${githubAddAccountType ? "" : "disabled"}><i data-lucide="plus"></i>${githubAddAccountType === "organization" ? "Add Organization access" : githubAddAccountType === "personal" ? "Add personal access" : "Choose an account type"}</button>
          </div>
          <div id="github-handoff"></div>
        </div>`
      : `<div class="github-add-collapsed">
          <button type="button" class="secondary" id="github-add-open"><i data-lucide="plus"></i>Add GitHub owner</button>
        </div>`;
    $("#library-content").innerHTML = `
      <article class="library-card panel content-panel library-card-wide">
        <div class="section-head"><div>${backLink({ id: "library-github-back", label: "Library" })}<h2>GitHub access</h2></div></div>
        ${githubSetupIntentHtml()}
        <div class="github-owner-list">${rows || `<div class="path-empty">No GitHub owners yet.</div>`}</div>
        ${addForm}
        <details class="bind-extra github-badge-section">
          <summary>GitHub App badge (optional)</summary>
          <p class="fact-line">After you create each App, upload this PNG in GitHub → App settings → Display information.</p>
          <div class="github-badge-preview">
            <div class="github-badge-preview-plate" title="How it looks on GitHub’s dark circle">
              <img src="/github-app-badge.svg" width="56" height="56" alt="Bumper mark: brackets and a centre dot, white on transparent">
            </div>
            <div class="github-badge-preview-copy">
              <b>White on transparent 200×200</b>
              <p>Looks blank on a white page — expected. GitHub supplies the dark circle.</p>
              <a class="secondary button-link" href="/github-app-badge.png" download="bumper-github-app-badge.png"><i data-lucide="download"></i>Download PNG</a>
            </div>
          </div>
        </details>
      </article>`;
    $("#library-github-back")?.addEventListener("click", () => go("library", { libraryView: "home" }));
    $("#github-add-open")?.addEventListener("click", () => {
      githubAddFormOpen = true;
      if (!githubAddAccountType) githubAddAccountType = "personal";
      renderLibraryGitHubAccess();
    });
    $("#github-add-cancel")?.addEventListener("click", () => {
      githubAddFormOpen = false;
      githubAddAccountType = "personal";
      renderLibraryGitHubAccess();
    });
    $("#github-intent-cancel")?.addEventListener("click", () => {
      const project = githubSetupIntent?.project;
      githubSetupIntent = null;
      githubAddAccountType = "personal";
      githubAddFormOpen = false;
      if (project && state.contexts[project]) openProjectPage(project, "git");
      else renderLibraryGitHubAccess();
    });
    $("#github-intent-continue")?.addEventListener("click", async () => {
      const project = githubSetupIntent?.project;
      const repository = githubSetupIntent?.repository || "";
      if (!project || !state.contexts[project]) return;
      projectGitIntentDraft = repository;
      await resolveProjectGitIntent(repository);
      githubSetupIntent = null;
      githubAddAccountType = "personal";
      githubAddFormOpen = false;
      openProjectPage(project, "git");
    });
    $$('input[name="github-account-type"]').forEach((radio) => radio.addEventListener("change", () => {
      githubAddAccountType = radio.value;
      githubAddFormOpen = true;
      renderLibraryGitHubAccess();
    }));
    $$(".github-manage").forEach((button) => button.addEventListener("click", () => {
      window.open(button.dataset.url, "_blank", "noopener");
    }));
    $$(".github-refresh").forEach((button) => button.addEventListener("click", async () => {
      const connectionId = button.dataset.id;
      githubRefreshBusy.add(connectionId);
      githubRefreshStatus[connectionId] = "Refreshing…";
      renderLibraryGitHubAccess();
      try {
        const result = await api("/api/github/installations/refresh", {
          method: "POST",
          body: JSON.stringify({ connectionId }),
        });
        await refresh(false);
        if (githubSetupIntent) await resolveGitHubSetupIntent();
        githubRefreshStatus[connectionId] = result.allRepositories
          ? `All repositories refreshed · ${result.repositories}`
          : `Selected repositories refreshed · ${result.repositories}`;
        toast(`Loaded ${result.repositories} GitHub repositories.`);
      } catch (error) {
        githubRefreshStatus[connectionId] = error.message;
        toast(error.message, true);
      } finally {
        githubRefreshBusy.delete(connectionId);
        renderLibraryGitHubAccess();
      }
    }));
    $$(".github-disconnect").forEach((button) => button.addEventListener("click", async () => {
      const owner = button.dataset.owner || "this owner";
      if (!window.confirm(`Disconnect ${owner} from this Mac? Projects bound to this connection will become No access. This does not uninstall the GitHub App.`)) return;
      try {
        const result = await api("/api/github/disconnect", {
          method: "POST",
          body: JSON.stringify({ connectionId: button.dataset.id }),
        });
        await refresh(false);
        if (result.pendingRevocations) {
          toast(`${result.pendingRevocations} token revocation(s) will be retried on next launch.`, true);
        } else {
          toast(`${owner} disconnected locally.`);
        }
        renderLibraryGitHubAccess();
      } catch (error) {
        toast(error.message, true);
      }
    }));
    $("#github-add-owner")?.addEventListener("click", async () => {
      try {
        const start = await api("/api/github/connect", {
          method: "POST",
          body: JSON.stringify({
            accountType: githubAddAccountType,
            organization: githubAddAccountType === "organization" ? ($("#github-owner")?.value || "").trim() : "",
            replaceConnectionId: githubSetupIntent?.resolution?.status === "reconnect-required"
              ? (githubSetupIntent.resolution.connections?.[0]?.id || "")
              : "",
          }),
        });
        window.open(start.startUrl, "_blank", "noopener");
        toast("GitHub setup started.");
        const slot = $("#github-handoff");
        if (slot) {
          slot.innerHTML = `<div class="setting-row"><i data-lucide="external-link"></i><div><b>GitHub setup link</b><p>If the browser did not open, copy this one-time link. It expires in one hour.</p></div><button type="button" class="secondary" id="github-handoff-copy">Copy link</button></div>`;
          slot.dataset.url = start.startUrl;
          $("#github-handoff-copy")?.addEventListener("click", async () => {
            try {
              await navigator.clipboard.writeText(slot.dataset.url);
              toast("GitHub setup link copied.");
            } catch {
              toast("Could not copy the link.", true);
            }
          });
          finishPaint(slot);
        }
      } catch (error) {
        toast(error.message, true);
      }
    });
    finishPaint($("#library-content"));
  }

  function renderLibraryGitConnections() {
    const choosing = libraryChooser?.kind === "git";
    const list = state.gitConnections || [];
    const chooser = libraryChooserBannerHtml();
    let listBody;
    if (!list.length) {
      listBody = emptyBindPanel({
        message: "No This Mac Git identities yet. Optional — these labels do not grant Sandbox access.",
        ctaLabel: "Create first",
        ctaId: "create-git-connection",
      });
    } else {
      const rows = list.map((c) => {
        const identity = c.identity || c.name || c.id;
        const target = c.host || c.provider || "git";
        const useBtn = choosing
          ? `<button type="button" class="primary use-git-connection" data-id="${esc(c.id)}">Use</button>`
          : "";
        return connectionRow({
          identity,
          target,
          statusHtml: connectionStatusHtml("git", c),
          actionsHtml: `
            ${useBtn}
            <button type="button" class="tertiary edit-git-connection" data-id="${esc(c.id)}">Open</button>
            <button type="button" class="tertiary delete-git-connection" data-id="${esc(c.id)}">Delete</button>`,
        });
      }).join("");
      listBody = `<div class="library-template-list connection-list">${rows}</div>
        <div class="bind-secondary-actions">
          <button type="button" class="secondary" id="create-git-connection"><i data-lucide="plus"></i>${esc(t("library.conn.add"))}</button>
        </div>`;
    }
    $("#library-content").innerHTML = `
      <article class="library-card panel content-panel library-card-wide">
        <div class="section-head"><div>${backLink({ id: "library-back", label: choosing ? `Back to ${libraryChooser.project}` : "Library" })}<h2>This Mac Git identities</h2><p>Host labels only. GitHub access for protected Sandboxs is managed separately.</p></div></div>
        ${chooser}
        ${listBody}
      </article>`;
    $("#library-back")?.addEventListener("click", () => {
      if (choosing && libraryChooser?.project) {
        const p = libraryChooser.project;
        libraryChooser = null;
        openProjectPage(p, "git");
      } else go("library", { libraryView: "home" });
    });
    wireLibraryChooserCancel("git");
    $("#create-git-connection")?.addEventListener("click", () => {
      openLibraryGitConnectionEdit({ returnTo: choosing ? libraryChooser.returnTo : "" });
    });
    $$(".use-git-connection").forEach((button) => button.addEventListener("click", () => {
      useLibraryItemForChooser("git", button.dataset.id);
    }));
    $$(".edit-git-connection").forEach((button) => button.addEventListener("click", () => {
      openLibraryGitConnectionEdit({ id: button.dataset.id, returnTo: choosing ? libraryChooser.returnTo : "" });
    }));
    $$(".delete-git-connection").forEach((button) => button.addEventListener("click", async () => {
      if (!window.confirm(`Delete label "${button.dataset.id}"?`)) return;
      try {
        await api("/api/git-connections", { method: "DELETE", body: JSON.stringify({ id: button.dataset.id }) });
        await refresh(false);
        toast("Label deleted.");
        renderLibraryGitConnections();
      } catch (error) {
        toast(error.message, true);
      }
    }));
    icons();
  }

  function renderLibraryGitConnectionEdit() {
    const edit = libraryGitEdit || {};
    const existing = edit.id || "";
    const catalog = (state.gitConnections || []).find((item) => item.id === existing);
    const provider = catalog?.provider || "github";
    const host = catalog?.host || (provider === "github" ? "github.com" : "");
    const identity = catalog?.identity || "";
    const name = catalog?.name || existing;
    const userName = catalog?.userName || "";
    const userEmail = catalog?.userEmail || "";
    const sshKeyPath = catalog?.sshKeyPath || "";
    $("#library-content").innerHTML = `
      <article class="library-card panel content-panel library-card-wide">
        ${backLink({ id: "library-git-back", label: "Git connections" })}
        <h2 style="margin:10px 0 6px">${existing ? `Connection “${esc(existing)}”` : "Add Git connection"}</h2>
        <p class="subtitle">Host settings for copy/paste push commands. No secret is stored; nothing is mounted into Sandboxs.</p>
        <div class="dialog-grid" style="margin-top:16px">
          <div class="field"><label for="git-conn-id">Id</label><input id="git-conn-id" maxlength="64" placeholder="work-github" value="${esc(existing)}" ${existing ? "readonly" : ""}></div>
          <div class="field"><label for="git-conn-name">Display name</label><input id="git-conn-name" maxlength="80" placeholder="Work GitHub" value="${esc(name)}"></div>
          <div class="field"><label for="git-conn-provider">Provider</label>
            <select id="git-conn-provider">
              ${["github", "gitlab", "bitbucket", "other"].map((p) => `<option value="${p}"${p === provider ? " selected" : ""}>${p}</option>`).join("")}
            </select>
          </div>
          <div class="field"><label for="git-conn-host">Host</label><input id="git-conn-host" placeholder="github.com" value="${esc(host)}"></div>
          <div class="field"><label for="git-conn-identity">Identity label</label><input id="git-conn-identity" placeholder="org or username" value="${esc(identity)}"></div>
          <div class="field"><label for="git-conn-user-name">Commit name</label><input id="git-conn-user-name" placeholder="Optional" value="${esc(userName)}"></div>
          <div class="field"><label for="git-conn-user-email">Commit email</label><input id="git-conn-user-email" placeholder="Optional" value="${esc(userEmail)}"></div>
          <div class="field full"><label for="git-conn-ssh-key">SSH key path on this Mac</label><input id="git-conn-ssh-key" placeholder="~/.ssh/id_ed25519" value="${esc(sshKeyPath)}">
            <small>Path only — never uploaded. Used for host copy commands; Bumper never reads or mounts the key.</small></div>
        </div>
        <p class="compose-note">${connectionStatusHtml("git", {})} — push runs on the host, not in the room.</p>
        <div class="dialog-actions">
          <button type="button" class="primary" id="git-conn-save">${existing ? "Save" : "Create connection"}</button>
        </div>
      </article>`;
    $("#library-git-back")?.addEventListener("click", openLibraryGitConnections);
    $("#git-conn-provider")?.addEventListener("change", () => {
      const p = $("#git-conn-provider").value;
      if (!$("#git-conn-host").value || ["github.com", "gitlab.com", "bitbucket.org"].includes($("#git-conn-host").value)) {
        $("#git-conn-host").value = p === "github" ? "github.com" : p === "gitlab" ? "gitlab.com" : p === "bitbucket" ? "bitbucket.org" : $("#git-conn-host").value;
      }
    });
    $("#git-conn-save")?.addEventListener("click", async () => {
      const id = $("#git-conn-id").value.trim();
      if (!id) return toast("Enter a connection id (e.g. work-github).", true);
      try {
        await api("/api/git-connections", {
          method: "POST",
          body: JSON.stringify({
            id,
            name: $("#git-conn-name").value.trim() || id,
            provider: $("#git-conn-provider").value,
            host: $("#git-conn-host").value.trim(),
            identity: $("#git-conn-identity").value.trim(),
            userName: $("#git-conn-user-name").value.trim(),
            userEmail: $("#git-conn-user-email").value.trim(),
            sshKeyPath: $("#git-conn-ssh-key").value.trim(),
          }),
        });
        await refresh(false);
        toast(existing ? "Connection updated." : `Connection “${id}” created.`);
        const returnTo = edit.returnTo
          ? (edit.returnTo.includes("select=")
            ? edit.returnTo.replace(/select=[^&]*/, `select=${encodeURIComponent(id)}`)
            : `${edit.returnTo}${edit.returnTo.includes("?") ? "&" : "?"}select=${encodeURIComponent(id)}`)
          : "";
        if (returnTo) await applyReturnToGitConnection(returnTo, id);
        else openLibraryGitConnections();
      } catch (error) {
        toast(error.message, true);
      }
    });
    icons();
  }

  function mcpBindingsMap(project) {
    const raw = project?.mcpBindings;
    if (Array.isArray(raw)) {
      return Object.fromEntries(raw.map((b) => [b.integrationId, b.connectionId]).filter(([a, b]) => a && b));
    }
    return { ...(raw || {}) };
  }

  /**
   * "What can the AI actually call?" — the only honest answer starts the real
   * MCP servers and runs their real tools through the same gateway the room
   * uses. Bindings and secret flags alone cannot tell the user that a tool is
   * blocked by this project's read-only mode.
   */
  function mcpPreviewPanelHtml(boundCount) {
    if (!boundCount) return "";
    return `<div class="mcp-preview">
      <div class="mcp-preview-head">
        <div>
          <b>What the AI can call</b>
          <small>Starts the connections and lists their real tools, decided by this project's mode.</small>
        </div>
        <button type="button" class="secondary" id="mcp-preview-run"><i data-lucide="list-checks"></i>Check now</button>
      </div>
      <div id="mcp-preview-out" class="mcp-preview-out" hidden></div>
    </div>`;
  }

  function mcpToolRowsHtml(tools) {
    return tools.map((tool) => {
      const badge = tool.allowed
        ? `<span class="tool-access ${tool.access === "write" ? "write" : "read"}">${esc(tool.access)}</span>`
        : `<span class="tool-access blocked">blocked</span>`;
      return `<div class="mcp-tool-row${tool.allowed ? "" : " is-blocked"}">
        <code>${esc(tool.name)}</code>
        ${badge}
        <small>${esc(tool.reason)}</small>
      </div>`;
    }).join("");
  }

  function wireMcpPreview() {
    const run = $("#mcp-preview-run");
    if (!run) return;
    run.addEventListener("click", async () => {
      const out = $("#mcp-preview-out");
      out.hidden = false;
      out.innerHTML = `<p class="fact-line">Starting connections…</p>`;
      run.disabled = true;
      try {
        const result = await api("/api/project/mcp-preview", {
          method: "POST",
          body: JSON.stringify({ project: selectedProject }),
        });
        const failed = Object.entries(result.failed || {});
        const failedHtml = failed.length
          ? `<div class="mcp-preview-failed">${failed.map(([name, why]) =>
              `<p class="fact-line"><i data-lucide="alert-circle"></i><span><b>${esc(name)}</b> did not start — ${esc(why)}</span></p>`).join("")}</div>`
          : "";
        const blocked = (result.tools || []).filter((tool) => !tool.allowed).length;
        const summary = result.tools?.length
          ? `${result.allowedCount} tool${result.allowedCount === 1 ? "" : "s"} available to the AI` +
            (blocked ? `, ${blocked} blocked by ${esc(result.mode)} mode` : "")
          : "No tools were offered by the bound connections.";
        out.innerHTML = `<p class="mcp-preview-summary">${summary}</p>
          ${failedHtml}
          <div class="mcp-tool-list">${mcpToolRowsHtml(result.tools || [])}</div>`;
      } catch (error) {
        out.innerHTML = `<p class="fact-line error-line">${esc(error.message)}</p>`;
      } finally {
        run.disabled = false;
        icons();
      }
    });
  }

  /**
   * Which CLIs actually receive the tools inside a room. Binding a connection
   * does not answer this: only Claude Code and Codex have a per-session MCP
   * flag Bumper is willing to use, and saying so is better than a silent gap.
   */
  function mcpDeliveryPanelHtml() {
    const rows = state.roomMcpDelivery || [];
    if (!rows.length) return "";
    const list = rows.map((row) => `<p class="fact-line${row.supported ? "" : " muted-line"}">
      <i data-lucide="${row.supported ? "check" : "minus"}"></i><span><b>${esc(row.name)}</b> — ${esc(row.detail)}</span>
    </p>`).join("");
    return `<details class="bind-extra mcp-delivery-details">
      <summary>Which AI tools receive these in the room</summary>
      ${list}
    </details>`;
  }

  function renderProjectConnections() {
    const project = effectiveProject();
    const integrations = state.mcpIntegrations || [];
    const connections = state.mcpConnections || [];
    const draft = mcpBindingsMap(project);
    const entries = Object.entries(draft);

    const rows = entries.map(([integrationId, connectionId]) => {
      const integ = integrations.find((i) => i.id === integrationId);
      const conn = connections.find((c) => c.id === connectionId);
      return connectionRow({
        identity: conn?.name || connectionId,
        target: `${integ?.name || integrationId} (MCP)`,
        statusHtml: connectionStatusHtml("mcp", conn || { hasAllRequiredSecrets: false }),
        actionsHtml: `
          <button type="button" class="tertiary change-mcp-bind" data-integration="${esc(integrationId)}">Change</button>
          <button type="button" class="tertiary remove-mcp-bind" data-integration="${esc(integrationId)}">Remove</button>`,
        className: "bound-row",
      });
    }).join("");

    const body = entries.length === 0
      ? emptyBindPanel({
          message: "No connections bound yet.",
          ctaLabel: "Choose from Library",
          ctaId: "mcp-choose-library",
        })
      : `<div class="bound-list">${rows}</div>
        <div class="bind-secondary-actions">
          <button type="button" class="secondary" id="mcp-bind-another"><i data-lucide="library"></i>Bind another</button>
        </div>`;

    const reach = entries.length
      ? `<p class="fact-line reach-note"><i data-lucide="alert-triangle"></i><span>A bound connection acts <b>outside</b> the Sandbox: its server runs on this Mac. Bind only what this Project should reach.</span></p>`
      : "";

    setProjectSection("connections", contentPanel({
      title: "Connections (MCP)",
      assurance: `<span class="assurance hook"><i data-lucide="key-round"></i>Checked on this Mac</span>`,
      className: "policy-section",
      body: `
        ${body}
        ${reach}
        ${mcpPreviewPanelHtml(entries.length)}
        ${mcpDeliveryPanelHtml()}
        <details class="bind-extra mcp-cli-details">
          <summary>Use from a client outside the Sandbox</summary>
          <p class="fact-line">MCP-only: on this path files, shell, and network are <b>not</b> Bumper-protected.</p>
          <code class="fact-line">bumper mcp connect --project ${esc(selectedProject)}</code>
        </details>`,
    }));

    wireMcpPreview();
    $("#mcp-choose-library")?.addEventListener("click", () => openLibraryToBind({ kind: "mcp" }));
    $("#mcp-bind-another")?.addEventListener("click", () => openLibraryToBind({ kind: "mcp" }));
    $$(".change-mcp-bind").forEach((button) => button.addEventListener("click", () => {
      openLibraryToBind({ kind: "mcp", integrationId: button.dataset.integration });
    }));
    $$(".remove-mcp-bind").forEach((button) => button.addEventListener("click", async () => {
      try {
        const next = mcpBindingsMap(effectiveProject());
        delete next[button.dataset.integration];
        await putProjectPatch(selectedProject, { mcpBindings: next });
        toast("Connection removed from this Project.");
        openProjectPage(selectedProject, "connections");
      } catch (error) {
        toast(error.message, true);
      }
    }));
    icons();
  }

  function renderLibraryMcpIntegrations() {
    // Connection-model: list = Connections only (type/Integration only in Add picker).
    const choosing = libraryChooser?.kind === "mcp";
    const integrations = state.mcpIntegrations || [];
    const connections = state.mcpConnections || [];
    const chooser = libraryChooserBannerHtml();
    const pickerOpts = integrations.map((i) => ({
      id: i.id,
      label: i.name || i.id,
      detail: [i.command, ...(i.args || [])].filter(Boolean).join(" ") || "Integration",
    }));

    let listBody;
    if (!connections.length && !integrations.length) {
      // Dead-end used to open an empty "Choose type" picker. First step is always Integration.
      listBody = emptyBindPanel({
        message: "Add a tool type, then a Connection with credentials.",
        ctaLabel: "Create Integration",
        ctaId: "create-mcp-integration",
      });
    } else if (!connections.length) {
      listBody = emptyBindPanel({
        message: "Tool types are ready. Add a Connection, or import from Cursor / Claude.",
        ctaLabel: "Add connection",
        ctaId: "create-mcp-connection",
      }) + `<div class="bind-secondary-actions">
          <button type="button" class="tertiary" id="create-mcp-integration">New Integration</button>
        </div>`;
    } else {
      const rows = connections.map((c) => {
        const integ = integrations.find((i) => i.id === c.integrationId);
        const identity = c.name || c.id;
        const memo = c.description ? ` · ${c.description}` : "";
        const target = `${integ?.name || c.integrationId || "MCP"} (MCP)${memo}`;
        const useBtn = choosing
          ? `<button type="button" class="primary use-mcp-connection" data-id="${esc(c.id)}">Use</button>`
          : "";
        return connectionRow({
          identity,
          target,
          statusHtml: connectionStatusHtml("mcp", c),
          actionsHtml: `
            ${useBtn}
            <button type="button" class="tertiary edit-mcp-connection" data-id="${esc(c.id)}" data-integration="${esc(c.integrationId)}">Open</button>`,
        });
      }).join("");
      listBody = `<div class="library-template-list connection-list">${rows}</div>
        <div class="bind-secondary-actions">
          <button type="button" class="secondary" id="create-mcp-connection"><i data-lucide="plus"></i>${esc(t("library.conn.add"))}</button>
          <button type="button" class="tertiary" id="create-mcp-integration">New Integration</button>
        </div>`;
    }

    const importBar = `<div class="mcp-import-bar">
      <b>Import</b>
      <button type="button" class="secondary mcp-import-source" data-source="cursor"><i data-lucide="download"></i>Cursor</button>
      <button type="button" class="secondary mcp-import-source" data-source="claude-code"><i data-lucide="download"></i>Claude Code</button>
      <button type="button" class="secondary mcp-import-source" data-source="claude-desktop"><i data-lucide="download"></i>Claude Desktop</button>
      <button type="button" class="tertiary" id="mcp-import-paste"><i data-lucide="clipboard-paste"></i>Paste JSON</button>
    </div>
    <div id="mcp-import-panel" class="mcp-import-panel hidden"></div>`;

    $("#library-content").innerHTML = `
      <article class="library-card panel content-panel library-card-wide">
        <div class="section-head"><div>${backLink({ id: "library-back", label: choosing ? `Back to ${libraryChooser.project}` : "Library" })}<h2>${esc(t("library.mcpConnections"))}</h2></div></div>
        ${chooser}
        ${importBar}
        <div id="mcp-add-picker" hidden>
          ${addConnectionPickerHtml({ kind: "mcp", options: pickerOpts, custom: true })}
        </div>
        ${listBody}
      </article>`;
    $("#library-back")?.addEventListener("click", () => {
      if (choosing && libraryChooser?.project) {
        const p = libraryChooser.project;
        libraryChooser = null;
        openProjectPage(p, "connections");
      } else go("library");
    });
    wireLibraryChooserCancel("connections");
    const showMcpPicker = () => {
      if (!integrations.length) {
        openLibraryMcpIntegrationEdit();
        return;
      }
      const el = $("#mcp-add-picker");
      if (el) el.hidden = false;
    };
    $("#create-mcp-connection")?.addEventListener("click", showMcpPicker);
    $("#create-mcp-integration")?.addEventListener("click", () => openLibraryMcpIntegrationEdit());
    $$("#mcp-add-picker .add-conn-cancel").forEach((b) => b.addEventListener("click", () => {
      const el = $("#mcp-add-picker");
      if (el) el.hidden = true;
    }));
    $$("#mcp-add-picker .add-conn-tile").forEach((button) => button.addEventListener("click", () => {
      const typeId = button.dataset.typeId;
      if (typeId === "__custom__" || !integrations.length) {
        openLibraryMcpIntegrationEdit();
        return;
      }
      openLibraryMcpConnectionEdit({
        integrationId: typeId,
        returnTo: choosing ? libraryChooser.returnTo : "",
      });
    }));
    $$(".edit-mcp-connection").forEach((button) => button.addEventListener("click", () => {
      openLibraryMcpConnectionEdit({
        id: button.dataset.id,
        integrationId: button.dataset.integration,
        returnTo: choosing ? libraryChooser.returnTo : "",
      });
    }));
    $$(".use-mcp-connection").forEach((button) => button.addEventListener("click", () => {
      useLibraryItemForChooser("mcp", button.dataset.id);
    }));
    $$(".mcp-import-source").forEach((button) => button.addEventListener("click", () => {
      void openMcpImportPreview(button.dataset.source);
    }));
    $("#mcp-import-paste")?.addEventListener("click", () => openMcpImportPaste());
    icons();
  }

  function mcpImportWorkspaceHint() {
    const project = effectiveProject();
    return project?.workspace || "";
  }

  function openMcpImportPaste() {
    const panel = $("#mcp-import-panel");
    if (!panel) return;
    panel.classList.remove("hidden");
    panel.innerHTML = `
      <div class="section-head"><div><h3>Paste mcpServers JSON</h3>
        <p class="compose-note"><code>{ "mcpServers": { "name": { "command", "args", "env" } } }</code></p></div>
        <button type="button" class="tertiary" id="mcp-import-cancel">Close</button></div>
      <div class="field full"><label for="mcp-import-json">JSON</label>
        <textarea id="mcp-import-json" rows="12" placeholder='{ "mcpServers": { … } }'></textarea></div>
      <div class="dialog-actions" style="border:0;padding:0">
        <button type="button" class="primary" id="mcp-import-parse-paste">Preview</button>
      </div>`;
    $("#mcp-import-cancel")?.addEventListener("click", () => panel.classList.add("hidden"));
    $("#mcp-import-parse-paste")?.addEventListener("click", async () => {
      try {
        await openMcpImportPreview("paste", { json: $("#mcp-import-json")?.value || "" });
      } catch (error) {
        toast(error.message, true);
      }
    });
    icons(panel);
  }

  async function openMcpImportPreview(source, extra = {}) {
    const panel = $("#mcp-import-panel");
    if (!panel) return;
    panel.classList.remove("hidden");
    panel.innerHTML = `<p class="compose-note">Looking for MCP configs…</p>`;
    try {
      const body = {
        source,
        workspace: mcpImportWorkspaceHint(),
        ...extra,
      };
      const preview = await api("/api/mcp-import/preview", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const candidates = preview.candidates || [];
      if (!candidates.length) {
        panel.innerHTML = `<p class="compose-note">No servers found${preview.path ? ` in <code>${esc(preview.path)}</code>` : ""}.</p>
          <button type="button" class="tertiary" id="mcp-import-cancel">Close</button>`;
        $("#mcp-import-cancel")?.addEventListener("click", () => panel.classList.add("hidden"));
        return;
      }
      const rows = candidates.map((c, index) => {
        if (c.skipReason) {
          return `<label class="check-row mcp-import-row skipped">
            <input type="checkbox" disabled>
            <span><strong>${esc(c.serverKey)}</strong>
              <em class="fact-line">${esc(c.skipReason)}</em></span></label>`;
        }
        return `<label class="check-row mcp-import-row">
          <input type="checkbox" class="mcp-import-pick" data-key="${esc(c.serverKey)}" checked>
          <span>
            <strong>${esc(c.suggestedName)}</strong>
            <em class="fact-line">${esc(c.command)} ${(c.args || []).join(" ")}</em>
            <em class="fact-line">${esc(c.suggestedDescription || "")}${c.secretKeys?.length ? ` · ${c.secretKeys.length} secret field(s)` : ""}</em>
            <input class="mcp-import-name" data-key="${esc(c.serverKey)}" value="${esc(c.suggestedName)}" aria-label="Name for ${esc(c.serverKey)}">
            <input class="mcp-import-desc" data-key="${esc(c.serverKey)}" value="${esc(c.suggestedDescription || "")}" placeholder="Memo / description" aria-label="Description for ${esc(c.serverKey)}">
          </span></label>`;
      }).join("");
      panel.innerHTML = `
        <div class="section-head"><div><h3>Import from ${esc(source === "paste" ? "paste" : source)}</h3>
          <p class="compose-note">${preview.path ? `Found <code>${esc(preview.path)}</code>. ` : ""}Choose servers. Same tool + different credentials becomes another Connection (not “name (2)”).</p></div>
          <button type="button" class="tertiary" id="mcp-import-cancel">Close</button></div>
        <div class="check-list mcp-import-list">${rows}</div>
        <div class="dialog-actions" style="border:0;padding-top:12px">
          <button type="button" class="primary" id="mcp-import-apply"><i data-lucide="check"></i>Import selected</button>
        </div>`;
      $("#mcp-import-cancel")?.addEventListener("click", () => panel.classList.add("hidden"));
      $("#mcp-import-apply")?.addEventListener("click", async () => {
        const keys = $$(".mcp-import-pick:checked").map((el) => el.dataset.key).filter(Boolean);
        if (!keys.length) return toast("Select at least one server.", true);
        const names = {};
        const descriptions = {};
        $$(".mcp-import-name").forEach((el) => { if (el.dataset.key) names[el.dataset.key] = el.value; });
        $$(".mcp-import-desc").forEach((el) => { if (el.dataset.key) descriptions[el.dataset.key] = el.value; });
        try {
          const result = await api("/api/mcp-import/apply", {
            method: "POST",
            body: JSON.stringify({
              source,
              workspace: mcpImportWorkspaceHint(),
              path: preview.path || "",
              json: extra.json || "",
              serverKeys: keys,
              names,
              descriptions,
            }),
          });
          await refresh(false);
          const n = result.imported ?? 0;
          toast(n ? `Imported ${n} connection${n === 1 ? "" : "s"}.` : "Nothing new imported.");
          renderLibraryMcpIntegrations();
        } catch (error) {
          toast(error.message, true);
        }
      });
      icons(panel);
    } catch (error) {
      panel.innerHTML = `<p class="compose-note" style="color:var(--danger)">${esc(error.message)}</p>
        <button type="button" class="tertiary" id="mcp-import-cancel">Close</button>`;
      $("#mcp-import-cancel")?.addEventListener("click", () => panel.classList.add("hidden"));
    }
  }

  function renderLibraryMcpIntegrationEdit() {
    const id = libraryMcpEdit?.id || "";
    const existing = (state.mcpIntegrations || []).find((item) => item.id === id);
    const fieldsText = (existing?.fields || [])
      .map((f) => `${f.key}|${f.label}|${f.secret ? "secret" : "value"}|${f.envKey || f.key}`)
      .join("\n");
    $("#library-content").innerHTML = `
      <article class="library-card panel content-panel library-card-wide">
        ${backLink({ id: "library-mcp-back", label: "MCP integrations" })}
        <h2>${existing ? "Edit" : "New"} Integration</h2>
        <p>Define how this tool is launched once. Connection forms use the fields below.</p>
        <div class="field"><label for="mcp-integ-id">Id</label><input id="mcp-integ-id" value="${esc(existing?.id || id)}" ${existing ? "readonly" : ""} placeholder="notion"></div>
        <div class="field"><label for="mcp-integ-name">Name</label><input id="mcp-integ-name" value="${esc(existing?.name || "")}" placeholder="Notion"></div>
        <div class="field"><label for="mcp-integ-command">Command</label><input id="mcp-integ-command" value="${esc(existing?.command || "npx")}" placeholder="npx"></div>
        <div class="field"><label for="mcp-integ-args">Args (one per line)</label><textarea id="mcp-integ-args" rows="3">${esc((existing?.args || []).join("\n"))}</textarea></div>
        <div class="field"><label for="mcp-integ-fields">Fields</label><textarea id="mcp-integ-fields" rows="5" placeholder="">${esc(fieldsText)}</textarea>
          <small>One field per line: key | label | secret or value | env var name. Example: api_key | API key | secret | NOTION_TOKEN. Secrets stay on this Mac only; other values are stored in Bumper settings.</small></div>
        <div class="dialog-actions"><button type="button" class="primary" id="save-mcp-integration"><i data-lucide="check"></i>Save</button></div>
      </article>`;
    $("#library-mcp-back")?.addEventListener("click", openLibraryMcpIntegrations);
    $("#save-mcp-integration")?.addEventListener("click", async () => {
      const fields = lines($("#mcp-integ-fields").value).map((line) => {
        const [key, label, kind, envKey] = line.split("|").map((part) => part.trim());
        return { key, label: label || key, secret: kind === "secret", envKey: envKey || key, required: true };
      }).filter((f) => f.key);
      try {
        const result = await api("/api/mcp-integrations", {
          method: "POST",
          body: JSON.stringify({
            id: $("#mcp-integ-id").value.trim(),
            name: $("#mcp-integ-name").value.trim(),
            command: $("#mcp-integ-command").value.trim(),
            args: lines($("#mcp-integ-args").value),
            transport: "stdio",
            fields,
          }),
        });
        await refresh(false);
        toast("Integration saved. Add a Connection with secrets next.");
        // New Integration is useless alone — land on Connection form for this type.
        openLibraryMcpConnectionEdit({
          integrationId: result.id,
          returnTo: libraryMcpEdit?.returnTo || "",
        });
      } catch (error) {
        toast(error.message, true);
      }
    });
    icons();
  }

  function renderLibraryMcpConnectionEdit() {
    const id = libraryMcpEdit?.id || "";
    const integrationId = libraryMcpEdit?.integrationId || "";
    const existing = (state.mcpConnections || []).find((item) => item.id === id);
    const integId = existing?.integrationId || integrationId;
    const integ = (state.mcpIntegrations || []).find((item) => item.id === integId);
    const integOptions = (state.mcpIntegrations || [])
      .map((item) => `<option value="${esc(item.id)}"${item.id === integId ? " selected" : ""}>${esc(item.name)}</option>`)
      .join("");
    const valueFields = (integ?.fields || []).filter((f) => !f.secret);
    const secretFields = (integ?.fields || []).filter((f) => f.secret);
    const valueInputs = valueFields.map((f) =>
      `<div class="field"><label for="mcp-val-${esc(f.key)}">${esc(f.label)}</label><input id="mcp-val-${esc(f.key)}" data-field="${esc(f.key)}" value="${esc(existing?.values?.[f.key] || "")}"></div>`
    ).join("");
    const secretInputs = secretFields.map((f) => {
      const has = existing?.secretFlags?.[f.key];
      // Empty field = not set; placeholder covers "already stored" — no (missing)/(stored) noise.
      return `<div class="field"><label for="mcp-sec-${esc(f.key)}">${esc(f.label)}</label>
        <div class="input-action">
          <input id="mcp-sec-${esc(f.key)}" data-field="${esc(f.key)}" type="password" placeholder="${has ? "Leave blank to keep current value" : ""}" autocomplete="off">
          ${has ? `<button type="button" class="tertiary clear-mcp-secret" data-field="${esc(f.key)}">Clear</button>` : ""}
        </div></div>`;
    }).join("");
    $("#library-content").innerHTML = `
      <article class="library-card panel content-panel library-card-wide">
        ${backLink({ id: "library-mcp-back", label: "MCP connections" })}
        <h2>${existing ? "Edit" : "New"} Connection</h2>
        <div class="field"><label for="mcp-conn-id">Id</label><input id="mcp-conn-id" value="${esc(existing?.id || id)}" ${existing ? "readonly" : ""} placeholder="work-notion"></div>
        <div class="field"><label for="mcp-conn-name">Name</label><input id="mcp-conn-name" value="${esc(existing?.name || "")}" placeholder="Work Notion"></div>
        <div class="field"><label for="mcp-conn-desc">Description <small>(memo)</small></label><input id="mcp-conn-desc" value="${esc(existing?.description || "")}" placeholder="e.g. Team wiki · imported from Cursor"></div>
        <div class="field"><label for="mcp-conn-integ">Integration</label><select id="mcp-conn-integ" ${existing ? "disabled" : ""}>${integOptions || '<option value="">Create an Integration first</option>'}</select></div>
        ${valueInputs || '<div class="path-empty">No non-secret fields on this Integration.</div>'}
        ${secretInputs || ""}
        <div class="dialog-actions"><button type="button" class="primary" id="save-mcp-connection"><i data-lucide="check"></i>Save</button></div>
      </article>`;
    $("#library-mcp-back")?.addEventListener("click", openLibraryMcpIntegrations);
    $("#mcp-conn-integ")?.addEventListener("change", () => {
      libraryMcpEdit = { kind: "connection", id, integrationId: $("#mcp-conn-integ").value, returnTo: libraryMcpEdit?.returnTo || "" };
      renderLibraryMcpConnectionEdit();
    });
    $$(".clear-mcp-secret").forEach((button) => button.addEventListener("click", async () => {
      try {
        await api("/api/mcp-connections/secret", { method: "DELETE", body: JSON.stringify({ id: existing.id, fieldKey: button.dataset.field }) });
        await refresh(false);
        toast("Secret cleared.");
        openLibraryMcpConnectionEdit({ id: existing.id, integrationId: integId });
      } catch (error) {
        toast(error.message, true);
      }
    }));
    $("#save-mcp-connection")?.addEventListener("click", async () => {
      const values = {};
      $$("#library-content input[data-field]:not([type=password])").forEach((input) => {
        values[input.dataset.field] = input.value;
      });
      try {
        const result = await api("/api/mcp-connections", {
          method: "POST",
          body: JSON.stringify({
            id: $("#mcp-conn-id").value.trim(),
            name: $("#mcp-conn-name").value.trim(),
            description: $("#mcp-conn-desc")?.value.trim() || "",
            integrationId: $("#mcp-conn-integ").value.trim(),
            values,
          }),
        });
        for (const input of $$("#library-content input[type=password][data-field]")) {
          const value = input.value.trim();
          if (!value) continue;
          await api("/api/mcp-connections/secret", {
            method: "POST",
            body: JSON.stringify({ id: result.id, fieldKey: input.dataset.field, value }),
          });
        }
        await refresh(false);
        toast("Connection saved.");
        const edit = libraryMcpEdit || {};
        const integ = $("#mcp-conn-integ").value.trim();
        if (edit.returnTo) {
          const returnTo = edit.returnTo.includes("select=")
            ? edit.returnTo.replace(/select=[^&]*/, `select=${encodeURIComponent(integ)}:${encodeURIComponent(result.id)}`)
            : `${edit.returnTo}${edit.returnTo.includes("?") ? "&" : "?"}select=${encodeURIComponent(integ)}:${encodeURIComponent(result.id)}`;
          await applyReturnToMcpConnection(returnTo, result.id);
        } else {
          openLibraryMcpConnectionEdit({ id: result.id, integrationId: integ });
        }
      } catch (error) {
        toast(error.message, true);
      }
    });
    icons();
  }

  function renderSettingsNav() {
    const nav = $("#settings-nav");
    if (!nav) return;
    nav.outerHTML = pageSubnav({
      id: "settings-nav",
      className: "settings-nav",
      ariaLabel: "Settings categories",
      dataAttr: "data-settings-cat",
      items: SETTINGS_CATEGORIES.map(([id, key]) => ({
        id,
        label: t(key),
        active: settingsCategory === id,
      })),
    });
    $$("[data-settings-cat]", $("#settings-nav")).forEach((button) => button.addEventListener("click", () => {
      settingsCategory = button.dataset.settingsCat;
      renderSettings();
    }));
  }

  function retentionSelect() {
    const current = state.prefs?.eventRetention || "7d";
    const options = [
      ["off", "settings.retention.off"],
      ["session", "settings.retention.session"],
      ["7d", "settings.retention.7d"],
      ["30d", "settings.retention.30d"],
    ];
    return `<select id="settings-retention" aria-label="${esc(t("settings.retention"))}">${
      options.map(([value, key]) => `<option value="${value}" ${current === value ? "selected" : ""}>${esc(t(key))}</option>`).join("")
    }</select>`;
  }

  function settingsLocationRow({ icon, title, detail, path, location }) {
    const reveal = state.capabilities?.revealLocations
      ? `<button type="button" class="secondary setting-location-reveal" data-location="${esc(location)}"><i data-lucide="folder-open"></i>Reveal</button>`
      : "";
    return `<div class="setting-row setting-location-row">
      <i data-lucide="${esc(icon)}"></i>
      <div><b>${esc(title)}</b><p>${esc(detail)}</p><code>${esc(path)}</code></div>
      <div class="setting-location-actions">
        <button type="button" class="tertiary setting-location-copy" data-path="${esc(path)}"><i data-lucide="copy"></i>Copy</button>
        ${reveal}
      </div>
    </div>`;
  }

  function bindSettingsLocationActions(content) {
    $$(".setting-location-copy", content).forEach((button) => button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.path || "");
        toast("Path copied.");
      } catch {
        toast("Copy failed — select the path manually.", true);
      }
    }));
    $$(".setting-location-reveal", content).forEach((button) => button.addEventListener("click", async () => {
      try {
        await api("/api/reveal-location", {
          method: "POST",
          body: JSON.stringify({ location: button.dataset.location }),
        });
      } catch (error) {
        toast(error.message, true);
      }
    }));
  }

  function renderSettings() {
    renderSettingsNav();
    const content = $("#settings-content");
    if (!content) return;
    const recovery = state.recovery || {};
    const backups = state.configBackups || [];
    const lang = (typeof window.bumperLang === "function" ? window.bumperLang() : "en") || "en";

    if (settingsCategory === "system") {
      const githubApps = state.githubApps || [];
      const repositoryCount = githubApps.reduce((sum, app) => sum + (app.repositories || []).length, 0);
      content.innerHTML = `
        <div class="setting-row"><i data-lucide="box"></i><div><b>Sandbox runtime</b><p>Apple container</p></div><span class="setting-value">${state.platform.room ? "Available" : "Not installed"}</span></div>
        ${settingsLocationRow({ icon: "file-json", title: "Policy configuration", detail: "Local config file", path: state.configPath, location: "config" })}
        <div class="setting-row"><i data-lucide="terminal"></i><div><b>Daily launch</b><p>From any terminal</p></div><span class="setting-value">bumper &lt;cli&gt;</span></div>
        <div class="settings-subsection"><b>GitHub access</b></div>
        <div class="setting-row"><i data-lucide="github"></i><div><b>${githubApps.length} connected GitHub owner${githubApps.length === 1 ? "" : "s"}</b><p>${repositoryCount} repositor${repositoryCount === 1 ? "y" : "ies"} visible</p></div><button type="button" class="secondary" id="github-manage-library">Manage in Library</button></div>`;
      $("#github-manage-library")?.addEventListener("click", openLibraryGitHubAccess);
    } else if (settingsCategory === "privacy") {
      const logins = state.aiLogins || [];
      const fmtBytes = (n) => {
        const v = Number(n) || 0;
        if (v < 1024) return `${v} B`;
        if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
        return `${(v / (1024 * 1024)).toFixed(1)} MB`;
      };
      const loginRows = logins.length
        ? logins.map((row) => {
            const label = row.identityId === "default"
              ? t("project.ai.account_existing")
              : (row.identityLabel || row.identityId);
            const used = (row.usedByProjects || []).length;
            const usedLabel = used === 0
              ? t("settings.privacy.used_none")
              : used === 1
                ? t("settings.privacy.used_one")
                : t("settings.privacy.used_n", { n: String(used) });
            return `<div class="setting-row ai-storage-row" data-key="${esc(row.key)}">
              <i data-lucide="bot"></i>
              <div>
                <b>${esc(row.shortName || row.agentName)} · ${esc(label)}</b>
                <p>${esc(usedLabel)} · ${esc(fmtBytes(row.storageBytes))}</p>
              </div>
              <button type="button" class="secondary ai-storage-delete" data-agent="${esc(row.agentId)}" data-identity="${esc(row.identityId)}" data-label="${esc(label)}">${esc(t("settings.privacy.delete"))}</button>
            </div>`;
          }).join("")
        : `<div class="setting-row"><i data-lucide="bot"></i><div><b>${esc(t("settings.privacy.ai_empty"))}</b><p>${esc(t("settings.privacy.ai_empty_help"))}</p></div><span class="setting-value">—</span></div>`;
      content.innerHTML = `
        <div class="setting-row"><i data-lucide="radio-tower"></i><div><b>Telemetry</b><p>Stays off on this Mac</p></div><span class="setting-value">Off</span></div>
        <div class="setting-row"><i data-lucide="scroll-text"></i><div><b data-i18n="settings.retention">${esc(t("settings.retention"))}</b><p data-i18n="settings.retention.help">${esc(t("settings.retention.help"))}</p></div>${retentionSelect()}</div>
        ${settingsLocationRow({ icon: "hard-drive", title: "Local evidence", detail: "Event metadata on this Mac", path: state.stateDir, location: "state" })}
        <div class="settings-subsection"><b>${esc(t("settings.privacy.ai_title"))}</b><p class="compose-note">${esc(t("settings.privacy.ai_help"))}</p></div>
        ${loginRows}`;
      $("#settings-retention")?.addEventListener("change", async (event) => {
        try {
          await api("/api/prefs", { method: "PUT", body: JSON.stringify({ eventRetention: event.target.value }) });
          await refresh(false);
          toast("Retention updated.");
          renderSettings();
        } catch (error) {
          toast(error.message, true);
        }
      });
      $$(".ai-storage-delete", content).forEach((button) => button.addEventListener("click", async () => {
        const agentId = button.dataset.agent;
        const identityId = button.dataset.identity;
        const label = button.dataset.label || identityId;
        if (!window.confirm(t("ai.remove.confirm", { tool: agentId, label }))) return;
        try {
          await api("/api/ai-logins", {
            method: "DELETE",
            body: JSON.stringify({ agentId, identityId }),
          });
          await refresh(false);
          toast(t("ai.remove.done", { tool: agentId }));
          renderSettings();
        } catch (error) {
          toast(error.message, true);
        }
      }));
    } else if (settingsCategory === "language") {
      content.innerHTML = `
        <div class="setting-row"><i data-lucide="languages"></i><div><b data-i18n="settings.language">${esc(t("settings.language"))}</b><p data-i18n="settings.language.help">${esc(t("settings.language.help"))}</p></div>
          <select id="settings-language" aria-label="${esc(t("settings.language"))}">
            <option value="en" ${lang === "en" ? "selected" : ""}>English</option>
            <option value="ja" ${lang === "ja" ? "selected" : ""}>日本語</option>
          </select>
        </div>`;
      $("#settings-language")?.addEventListener("change", (event) => {
        if (typeof window.setBumperLang === "function") window.setBumperLang(event.target.value);
      });
    } else if (settingsCategory === "updates") {
      content.innerHTML = `
        <div class="setting-row"><i data-lucide="refresh-cw"></i><div><b data-i18n="settings.help.fetch">${esc(t("settings.help.fetch"))}</b><p data-i18n="settings.help.note">${esc(t("settings.help.note"))}</p></div>
          <button type="button" class="secondary" id="settings-check-updates">Check</button>
        </div>
        <div class="setting-row"><i data-lucide="book-open"></i><div><b>Help</b><p>Local docs in this repository</p></div><span class="setting-value">docs/</span></div>`;
      $("#settings-check-updates")?.addEventListener("click", async () => {
        try {
          // Explicit user-triggered fetch only — never auto.
          const response = await fetch("https://api.github.com/repos/crostra/bumper/releases/latest", { headers: { Accept: "application/vnd.github+json" } });
          if (!response.ok) throw new Error(`Update check failed (${response.status})`);
          const data = await response.json();
          toast(data.tag_name ? `Latest release: ${data.tag_name}` : "No release metadata returned.");
        } catch (error) {
          toast(error.message || "Update check failed.", true);
        }
      });
    } else if (settingsCategory === "data") {
      const recoveryHtml = recovery.active
        ? `<div class="diag-gate" role="alert"><b data-i18n="settings.recovery">${esc(t("settings.recovery"))}</b><p>${esc(recovery.reason || "Config needs recovery.")}</p>
            <button type="button" class="secondary" id="clear-recovery">Dismiss after restore</button></div>`
        : `<div class="setting-row"><i data-lucide="shield"></i><div><b data-i18n="settings.recovery">${esc(t("settings.recovery"))}</b><p>Config is healthy</p></div><span class="setting-value">Idle</span></div>`;
      const backupRows = backups.length
        ? backups.map((b) => `<div class="setting-row"><i data-lucide="archive"></i><div><b>${esc(b.id)}</b><p>${new Date(b.mtimeMs).toLocaleString()} · ${b.size} bytes</p></div>
            <button type="button" class="secondary restore-backup" data-id="${esc(b.id)}">${esc(t("settings.restore"))}</button></div>`).join("")
        : '<div class="setting-row"><i data-lucide="archive"></i><div><b data-i18n="settings.backups">Config backups</b><p>Created on the next config save</p></div><span class="setting-value">None yet</span></div>';
      content.innerHTML = `${recoveryHtml}
        <div class="settings-subsection"><b data-i18n="settings.backups">${esc(t("settings.backups"))}</b></div>
        ${backupRows}
        <div class="settings-subsection"><b data-i18n="settings.uninstall">${esc(t("settings.uninstall"))}</b><p class="compose-note" data-i18n="settings.uninstall.never">${esc(t("settings.uninstall.never"))}</p></div>
        <div class="setting-row"><i data-lucide="trash-2"></i><div><b data-i18n="settings.uninstall.appOnly">${esc(t("settings.uninstall.appOnly"))}</b><p>Quit, then move the .app to Trash</p></div>
          <button type="button" class="secondary" id="uninstall-app-only">Plan</button></div>
        <div class="setting-row"><i data-lucide="folder-x"></i><div><b data-i18n="settings.uninstall.withData">${esc(t("settings.uninstall.withData"))}</b><p>Removes ~/.bumper only — not Project folders</p></div>
          <button type="button" class="secondary" id="uninstall-with-data">Plan</button></div>
        <pre id="uninstall-plan" class="diag-preview hidden"></pre>`;
      $("#clear-recovery")?.addEventListener("click", async () => {
        try {
          await api("/api/recovery/clear", { method: "POST", body: "{}" });
          await refresh(false);
          renderSettings();
        } catch (error) {
          toast(error.message, true);
        }
      });
      $$(".restore-backup", content).forEach((button) => button.addEventListener("click", async () => {
        if (!confirm(`Restore backup ${button.dataset.id}?`)) return;
        try {
          await api("/api/config/restore", { method: "POST", body: JSON.stringify({ id: button.dataset.id }) });
          await refresh();
          toast("Config restored from backup.");
        } catch (error) {
          toast(error.message, true);
        }
      }));
      const showPlan = async (includeLocalData) => {
        try {
          const plan = await api("/api/uninstall/plan", { method: "POST", body: JSON.stringify({ includeLocalData }) });
          const box = $("#uninstall-plan");
          if (box) {
            box.textContent = JSON.stringify(plan, null, 2);
            box.classList.remove("hidden");
          }
          if (includeLocalData && confirm("Delete local Bumper data now? Workspace folders will NOT be deleted.")) {
            const result = await api("/api/uninstall/execute", { method: "POST", body: JSON.stringify({ includeLocalData: true, confirm: true }) });
            toast(`Removed: ${(result.removed || []).join(", ") || "(nothing)"}`);
          } else if (!includeLocalData) {
            toast("App-only: quit Bumper and remove the .app. Local data kept.");
          }
        } catch (error) {
          toast(error.message, true);
        }
      };
      $("#uninstall-app-only")?.addEventListener("click", () => showPlan(false));
      $("#uninstall-with-data")?.addEventListener("click", () => showPlan(true));
    } else {
      content.innerHTML = `
        ${settingsLocationRow({ icon: "bug", title: "Technical logs", detail: "Local event log file", path: state.eventsPath, location: "events" })}`;
    }
    bindSettingsLocationActions(content);
    finishPaint(content);
  }

  function renderRoute() {
    if (!state) return;
    if (route === "setup") renderSetup();
    else if (route === "projects") renderProjects();
    else if (route === "create") renderCreate();
    else if (route === "project") renderProjectPage();
    else if (route === "events") {
      const prev = $("#events-context")?.value || "";
      $("#events-context").innerHTML = projectOptions(true, "");
      if (prev) $("#events-context").value = prev;
      // Ensure first option label uses semantic key when empty.
      const first = $("#events-context option[value='']");
      if (first) first.textContent = t("events.filter.project");
      syncEventsExportHref();
      renderEvents();
    } else if (route === "library") renderLibrary();
    else if (route === "settings") renderSettings();
    finishPaint(activeViewRoot());
  }

  function chooseInitialRoute() {
    const fromHash = parseHash();
    if (fromHash?.route === "project" && fromHash.project && state.contexts[fromHash.project]) {
      selectedProject = fromHash.project;
      projectSection = fromHash.section || "overview";
      go("project");
      return;
    }
    if (fromHash?.route === "settings") {
      go("settings", { settingsCategory: fromHash.settingsCategory || "system" });
      return;
    }
    if (fromHash?.route === "library") {
      if (fromHash.libraryView === "github-access") {
        go("library", { libraryView: "github-access", keepLibrary: true });
        return;
      }
      if (fromHash.libraryView === "git-connection-edit") {
        libraryGitEdit = {
          id: fromHash.gitConnectionId || "",
          returnTo: fromHash.returnTo || "",
        };
        go("library", { libraryView: "git-connection-edit", keepLibrary: true, gitEdit: libraryGitEdit });
        return;
      }
      if (fromHash.libraryView === "git-connections") {
        go("library", { libraryView: "git-connections", keepLibrary: true });
        return;
      }
      if (fromHash.libraryView === "mcp-integration-edit") {
        libraryMcpEdit = { kind: "integration", id: fromHash.mcpIntegrationId || "" };
        go("library", { libraryView: "mcp-integration-edit", keepLibrary: true, mcpEdit: libraryMcpEdit });
        return;
      }
      if (fromHash.libraryView === "mcp-connection-edit") {
        libraryMcpEdit = {
          kind: "connection",
          id: fromHash.mcpConnectionId || "",
          integrationId: fromHash.mcpIntegrationId || "",
          returnTo: fromHash.returnTo || "",
        };
        go("library", { libraryView: "mcp-connection-edit", keepLibrary: true, mcpEdit: libraryMcpEdit });
        return;
      }
      if (fromHash.libraryView === "mcp-integrations") {
        go("library", { libraryView: "mcp-integrations", keepLibrary: true });
        return;
      }
      go("library");
      return;
    }
    if (fromHash?.route && fromHash.route !== "project") {
      go(fromHash.route);
      return;
    }
    if (needsSystemSetup()) {
      go("setup");
      return;
    }
    const remembered = lastRememberedProject();
    if (remembered && state.contexts[remembered]) {
      openProjectPage(remembered, "overview");
      return;
    }
    if (state.active && state.contexts[state.active]) {
      openProjectPage(state.active, "overview");
      return;
    }
    go("projects");
  }

  function wireGo(root = document) {
    $$("[data-go]", root).forEach((button) => button.addEventListener("click", () => go(button.dataset.go)));
  }

  let pollFingerprint = "";

  // Route rebuild fingerprint — excludes today counts (badge-only; changes often while AI runs).
  function statePollFingerprint(nextState, nextAgents) {
    return JSON.stringify({
      active: nextState.active,
      platform: nextState.platform,
      contexts: nextState.contexts,
      permissionSetups: nextState.permissionSetups,
      authProfiles: nextState.authProfiles,
      gitConnections: nextState.gitConnections,
      mcpIntegrations: nextState.mcpIntegrations,
      mcpConnections: nextState.mcpConnections,
      githubApps: nextState.githubApps,
      gitSessions: (nextState.gitSessions || []).map((session) => [
        session.id,
        session.projectName,
        session.live,
        session.enabled,
        session.effectiveAccess,
        session.writeUntil,
      ]),
      agents: (nextAgents || []).map((agent) => [agent.id, agent.status, agent.authStatus]),
    });
  }

  async function refresh(render = true) {
    try {
      const nextAgentsP = selectedProject
        ? api(`/api/agents?context=${encodeURIComponent(selectedProject)}`)
        : api("/api/agents");
      const [nextState, nextAgents] = await Promise.all([api("/api/state"), nextAgentsP]);
      const fingerprint = statePollFingerprint(nextState, nextAgents);
      const changed = fingerprint !== pollFingerprint;
      pollFingerprint = fingerprint;
      const countsKey = `${nextState.counts?.blocked || 0}|${nextState.counts?.allowed || 0}`;
      const countsChanged = countsKey !== lastCountsKey;
      lastCountsKey = countsKey;
      state = nextState;
      agents = nextAgents;
      if (!selectedProject || !state.contexts[selectedProject]) selectedProject = state.active;
      renderShell();
      if (!bootRouted) {
        bootRouted = true;
        chooseInitialRoute();
        return;
      }
      // Polling must not rebuild the whole route every few seconds — that feels sluggish
      // (innerHTML + lucide + i18n TreeWalker). Full rebuild only when structural state changed.
      if (render && changed) {
        if (uiScrolling) deferredRouteRender = true;
        else scheduleRouteRender();
      } else if (render && !uiScrolling) {
        // Events: refresh when blocked/allowed counts move, not on every idle poll.
        if (route === "events" && countsChanged) renderEvents();
      }
    } catch (error) {
      toast(error.message, true);
    }
  }

  function openRenameProjectDialog() {
    if (!selectedProject) return;
    const dialog = $("#rename-project-dialog");
    const input = $("#rename-project-input");
    if (!dialog || !input) return;
    input.value = selectedProject;
    dialog.showModal();
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  async function renameSelectedProject(event) {
    event.preventDefault();
    if (!selectedProject) return;
    const input = $("#rename-project-input");
    const name = (input?.value || "").trim();
    if (!name || name === selectedProject) {
      $("#rename-project-dialog")?.close();
      return;
    }
    const previous = selectedProject;
    const project = effectiveProject();
    try {
      await api("/api/contexts", {
        method: "PUT",
        body: JSON.stringify({
          ...cloneProject(project),
          previous,
          name,
          description: project.description || "",
          workspace: project.workspace || "",
          mode: project.mode,
          inheritMode: project.inheritMode !== false,
          gitIgnored: project.gitIgnored || "visible",
          repos: (project.repos || []).map((repo) => repo.repo || repo),
          allowedHosts: project.allowedHosts || [],
          backends: project.backends || [],
          loginProfiles: project.loginProfiles || {},
        }),
      });
      $("#rename-project-dialog")?.close();
      await refresh(false);
      toast(t("project.rename.done", { name }));
      openProjectPage(name, projectSection);
    } catch (error) {
      toast(error.message, true);
      input?.focus();
    }
  }

  function bind() {
    document.addEventListener("scroll", noteUiScroll, { capture: true, passive: true });
    $$(".nav-item").forEach((button) => button.addEventListener("click", () => go(button.dataset.route)));
    wireGo();
    $$(".subnav-item").forEach((button) => button.addEventListener("click", () => {
      if (!selectedProject) return;
      openProjectPage(selectedProject, button.dataset.projectSection);
    }));
    $("#new-project")?.addEventListener("click", () => go("create"));
    $("#project-search")?.addEventListener("input", () => renderProjects());
    $("#create-project-form")?.addEventListener("submit", createProject);
    $$('input[name="create-template"]').forEach((input) => input.addEventListener("change", renderCreate));
    $("#create-name")?.addEventListener("input", renderCreate);
    $("#pick-create-folder")?.addEventListener("click", () => chooseFolder((path) => {
      $("#create-folder").value = path;
      renderCreate();
    }));
    $("#project-rename")?.addEventListener("click", openRenameProjectDialog);
    $("#rename-project-form")?.addEventListener("submit", renameSelectedProject);

    ["events-context", "events-source", "events-type", "events-decision", "events-time"].forEach((id) => {
      $(`#${id}`)?.addEventListener("change", () => {
        syncEventsExportHref();
        renderEvents();
      });
    });
    $("#fatal-copy")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("#fatal-command").textContent);
        toast("Install command copied.");
      } catch {
        toast("Copy failed — select the command manually.", true);
      }
    });
    $("#account-button")?.addEventListener("click", () => $("#account-dialog").showModal());
    $("#close-account")?.addEventListener("click", () => $("#account-dialog").close());
    $$("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
    window.addEventListener("hashchange", () => {
      const parsed = parseHash();
      if (!parsed || !state) return;
      if (parsed.route === "project") openProjectPage(parsed.project, parsed.section);
      else go(parsed.route);
    });
  }

  bind();
  refresh(true);
  // GitHub's manifest callback lands in the external browser. Returning to the
  // Mac app should paint the completed connection immediately, not after a
  // navigation or the next 10-second background poll.
  window.addEventListener("focus", async () => {
    await refresh(true);
    if (githubSetupIntent) {
      try {
        await resolveGitHubSetupIntent();
        if (route === "library" && libraryView === "github-access") renderLibraryGitHubAccess();
      } catch (error) {
        toast(error.message, true);
      }
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh(true);
  });
  // Background poll: fetch + shell. Full route rebuild only when fingerprint changes.
  setInterval(() => {
    if ($("dialog[open]")) return;
    if (document.hidden) return;
    if (uiScrolling) return;
    refresh(true);
  }, 10000);
})();
