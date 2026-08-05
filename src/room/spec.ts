import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Context, RoomDoor as ConfigRoomDoor } from "../types.js";
import type { Door, Egress, RoomSpec } from "./backend.js";
import { egressTemplateHosts } from "./egress-proxy.js";
import {
  configExtraDoors,
  doorsFromFolderDraft,
  draftFromContext,
} from "../folders.js";

function expand(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function normalizeRoomPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "/workspace";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function configDoor(door: ConfigRoomDoor): Door {
  return {
    hostPath: expand(door.hostPath),
    roomPath: normalizeRoomPath(door.roomPath),
    access: door.access,
  };
}

function uniqueDoors(doors: Door[]): Door[] {
  const seen = new Set<string>();
  const out: Door[] = [];
  for (const door of doors) {
    const key = `${door.hostPath}\0${door.roomPath}\0${door.access}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(door);
  }
  return out;
}

export { defaultRoomPathForHostPath } from "../folders.js";

/** Translate the project's egress choice into a capability-level Egress. */
function egressForRoom(room: Context["room"]): Egress {
  if (room.egress === "open") return { mode: "open" };
  if (room.egress === "allowlist") {
    const hosts = [
      ...new Set([
        ...egressTemplateHosts(room.egressTemplates ?? []),
        ...(room.egressHosts ?? []).map((h) => h.trim()).filter(Boolean),
      ]),
    ];
    return { mode: "allowlist", hosts };
  }
  return { mode: "blocked" };
}

/**
 * Project folder policy → RoomSpec doors.
 * Uses Folders draft mapping so UI claims match mounts (whole RW/RO, selected,
 * extra read/write paths). Explicit room.doors are appended.
 */
export function roomSpecForContext(context: Context, workspace: string): RoomSpec {
  const room = context.room;
  const draft = draftFromContext(context);
  const folderDoors = doorsFromFolderDraft(workspace, draft);
  // Legacy absolute doors on the project (outside the folder draft model).
  const legacyDoors = configExtraDoors(room.doors);
  return {
    image: room.image || "docker.io/library/alpine:3.20",
    doors: uniqueDoors([...folderDoors, ...legacyDoors]),
    egress: egressForRoom(room),
    workdir: "/workspace",
    dropCapabilities: true,
  };
}
