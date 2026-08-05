import type { Config, Context } from "./types.js";

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Compile global defaults and project overrides into the immutable session policy. */
export function effectiveContext(config: Config, name: string): Context {
  const project = config.contexts[name];
  if (!project) throw new Error(`Unknown project: ${name}`);
  const global = config.globalPolicy;
  const projectAllow = new Set(project.native.allow);
  const projectDeny = new Set(project.native.deny);
  return {
    ...project,
    mode: project.inheritMode ? global.mode : project.mode,
    native: {
      allow: unique([...global.native.allow.filter((rule) => !projectDeny.has(rule)), ...project.native.allow]),
      deny: unique([...global.native.deny.filter((rule) => !projectAllow.has(rule)), ...project.native.deny]),
    },
    commands: { ...global.commands, ...project.commands },
    readPaths: unique([...global.readPaths, ...project.readPaths]),
    writePaths: unique([...global.writePaths, ...project.writePaths]),
    denyReadPaths: unique([...global.denyReadPaths, ...project.denyReadPaths]),
    denyWritePaths: unique([...global.denyWritePaths, ...project.denyWritePaths]),
    room: { ...project.room, enabled: true },
  };
}
