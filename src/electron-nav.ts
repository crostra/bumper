/**
 * Electron menu/tray navigation targets only.
 * Must resolve to real renderer `data-route` values — never invent pages.
 * Startup route (last Project Overview vs Projects) is chosen in the renderer.
 */

export const RENDERER_ROUTES = [
  "projects",
  "events",
  "library",
  "settings",
] as const;

export type RendererRoute = (typeof RENDERER_ROUTES)[number];

/** Menu/tray open Bumper — Projects list; renderer may redirect to last Overview. */
export const ELECTRON_NAV = {
  openBumper: "projects",
  activate: "projects",
  secondInstance: "projects",
} as const satisfies Record<string, RendererRoute>;
