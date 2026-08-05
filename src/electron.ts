import { app, BrowserWindow, Menu, Tray, nativeImage, shell } from "electron";
import { join, resolve } from "node:path";
import { ensureConfig, loadConfig } from "./config.js";
import { startApp, type AppHandle, type TerminalWindowRequest } from "./app.js";
import { ELECTRON_NAV, type RendererRoute } from "./electron-nav.js";
import { windowOpenAction } from "./electron-links.js";
import { terminalWindowFocusKey } from "./room/launch.js";

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let handle: AppHandle | null = null;
let quitting = false;

/** Fixed-size utility windows for sign-in / Room shell / debug attach. */
const terminalWindows = new Map<string, BrowserWindow>();

const TERMINAL_WIDTH = 960;
const TERMINAL_HEIGHT = 620;

function show(route?: RendererRoute): void {
  if (!window) return;
  window.show();
  window.focus();
  if (route) {
    // Only real top-level renderer routes (data-route=…) — never invent launch pages.
    window.webContents.executeJavaScript(`document.querySelector('[data-route=${JSON.stringify(route)}]')?.click()`)
      .catch(() => undefined);
  }
}

function openTerminalWindow(request: TerminalWindowRequest): { ok: true; focused: boolean; created: boolean; url: string } {
  if (!handle) throw new Error("Bumper app is not ready.");
  const key = terminalWindowFocusKey(request.sessionId, request.windowKey);
  const url = `${handle.url}/terminal.html?session=${encodeURIComponent(request.sessionId)}`;
  const existing = terminalWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    // If the same key now points at a different session id, reload.
    const current = existing.webContents.getURL();
    if (!current.includes(`session=${encodeURIComponent(request.sessionId)}`)) {
      void existing.loadURL(url);
    }
    return { ok: true, focused: true, created: false, url };
  }
  const termWin = new BrowserWindow({
    width: TERMINAL_WIDTH,
    height: TERMINAL_HEIGHT,
    minWidth: TERMINAL_WIDTH,
    maxWidth: TERMINAL_WIDTH,
    minHeight: TERMINAL_HEIGHT,
    maxHeight: TERMINAL_HEIGHT,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: request.title || "Bumper terminal",
    backgroundColor: "#111317",
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  termWin.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    if (/^https:\/\//.test(openUrl)) void shell.openExternal(openUrl);
    return { action: "deny" };
  });
  termWin.on("closed", () => {
    if (terminalWindows.get(key) === termWin) terminalWindows.delete(key);
  });
  termWin.once("ready-to-show", () => {
    termWin.show();
    termWin.focus();
  });
  terminalWindows.set(key, termWin);
  void termWin.loadURL(url);
  return { ok: true, focused: false, created: true, url };
}

function createMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { label: "File", submenu: [
      { label: "Open Projects", accelerator: "CmdOrCtrl+O", click: () => show(ELECTRON_NAV.openBumper) },
      { type: "separator" },
      { role: "close" },
    ] },
    { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createTray(): void {
  const trayPath = join(app.getAppPath(), "assets", "trayTemplate.png");
  const icon = nativeImage.createFromPath(trayPath);
  icon.setTemplateImage(true);
  tray = new Tray(icon.resize({ width: 18, height: 18 }));
  tray.setToolTip("Bumper");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Bumper", enabled: false },
    { type: "separator" },
    { label: "Open Projects", click: () => show(ELECTRON_NAV.openBumper) },
    { type: "separator" },
    { label: "Quit Bumper", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", () => show(ELECTRON_NAV.openBumper));
}

async function boot(): Promise<void> {
  const { config } = ensureConfig();
  const binPath = resolve(app.getAppPath(), "dist", "cli.js");
  handle = await startApp(config, () => loadConfig().config, binPath, {
    openTerminalWindow,
    revealPath: (path) => shell.showItemInFolder(path),
    openExternal: (url) => { void shell.openExternal(url); },
  });
  window = new BrowserWindow({
    width: 1240, height: 800, minWidth: 820, minHeight: 620,
    title: "Bumper", backgroundColor: "#f7f8fa", titleBarStyle: "hiddenInset",
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const action = windowOpenAction(url, handle ? new URL(handle.url).origin : "");
    if (action.kind === "terminal") {
      openTerminalWindow({
        sessionId: action.sessionId,
        windowKey: `session:${action.sessionId}`,
        title: "Bumper terminal",
      });
    } else if (action.kind === "external") {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.on("close", (event) => {
    if (!quitting) { event.preventDefault(); window?.hide(); }
  });
  window.once("ready-to-show", () => window?.show());
  await window.loadURL(handle.url);
  createMenu();
  createTray();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => show(ELECTRON_NAV.secondInstance));
  app.whenReady().then(boot).catch((error) => {
    console.error(`Bumper failed to start: ${(error as Error).stack ?? error}`);
    app.quit();
  });
  app.on("activate", () => show(ELECTRON_NAV.activate));
  app.on("before-quit", () => { quitting = true; });
  app.on("will-quit", () => {
    handle?.sessions.stopAll();
    for (const termWin of terminalWindows.values()) {
      try { if (!termWin.isDestroyed()) termWin.destroy(); } catch { /* ignore */ }
    }
    terminalWindows.clear();
  });
}
