import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { stateDir, stateFilePath } from "./paths.js";

interface State {
  activeContext?: string;
}

function readState(): State {
  const p = stateFilePath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as State;
  } catch {
    return {};
  }
}

function writeState(state: State): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(stateFilePath(), JSON.stringify(state, null, 2));
}

export function getActiveContext(defaultContext?: string): string | undefined {
  return process.env.BUMPER_CONTEXT ?? readState().activeContext ?? defaultContext;
}

export function setActiveContext(name: string): void {
  const state = readState();
  state.activeContext = name;
  writeState(state);
}
