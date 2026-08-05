/**
 * "Is a Session running for this Project?" — answered the same way for both
 * entry points.
 *
 * This matters because the answer gates boundary edits. The GUI used to ask its
 * own `SessionManager.list()`, which only knows about sessions the GUI started;
 * a `bumper claude` running in a terminal was invisible to it, so Folders could
 * be changed out from under a live Sandbox.
 *
 * Both entry points already write a git Session lease on launch
 * (`sessions.ts` and `cli-room.ts`), so the lease directory is the shared
 * truth. The GUI's in-memory list is still merged in because legacy Seatbelt
 * sessions never take a lease.
 */
import { listGitSessionLeases } from "../git-session-lease.js";
import type { FolderSessionRef } from "../folders.js";

/** Live Sessions from the lease store — visible to the GUI and the CLI alike. */
export function leaseSessionRefs(): FolderSessionRef[] {
  try {
    return listGitSessionLeases()
      .filter((lease) => lease.live)
      .map((lease) => ({
        id: lease.id,
        context: lease.projectName,
        agentName: lease.agentName,
        status: "running" as const,
      }));
  } catch {
    // No lease directory yet means nothing has ever launched.
    return [];
  }
}

/** Merge session sources, preferring the first mention of an id. */
export function mergeSessionRefs(...lists: FolderSessionRef[][]): FolderSessionRef[] {
  const byId = new Map<string, FolderSessionRef>();
  for (const list of lists) {
    for (const ref of list ?? []) {
      if (!byId.has(ref.id)) byId.set(ref.id, ref);
    }
  }
  return [...byId.values()];
}
