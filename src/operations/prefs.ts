/**
 * Local preferences. Small, but one of them is a privacy control: how long
 * event metadata is kept on this Mac, including "off".
 *
 * A GUI-only retention switch means a CLI-only user cannot turn off the local
 * record they never asked for, which is the wrong default for a tool whose
 * pitch is that nothing leaves the machine.
 */
import { readPrefs, writePrefs, type AppPrefs, type EventRetention } from "../prefs.js";
import { OperationError } from "./error.js";

export const RETENTION_VALUES: EventRetention[] = ["off", "session", "7d", "30d"];
export const LANGUAGE_VALUES = ["en", "ja"] as const;

export function describePrefs(): AppPrefs {
  return readPrefs();
}

export function retentionSentence(value: EventRetention): string {
  switch (value) {
    case "off": return "No event metadata is kept on this Mac.";
    case "session": return "Kept until Bumper next starts.";
    case "7d": return "Kept for 7 days, then dropped.";
    case "30d": return "Kept for 30 days, then dropped.";
  }
}

export function setPref(input: { key: string; value: string }): AppPrefs {
  const key = input.key.trim();
  if (key === "eventRetention") {
    if (!RETENTION_VALUES.includes(input.value as EventRetention)) {
      throw new OperationError("invalid", `Unknown retention "${input.value}".`, [
        `Values: ${RETENTION_VALUES.join(", ")}`,
      ]);
    }
    return writePrefs({ eventRetention: input.value as EventRetention });
  }
  if (key === "language") {
    if (!LANGUAGE_VALUES.includes(input.value as (typeof LANGUAGE_VALUES)[number])) {
      throw new OperationError("invalid", `Unknown language "${input.value}".`, [
        `Values: ${LANGUAGE_VALUES.join(", ")}`,
      ]);
    }
    return writePrefs({ language: input.value as (typeof LANGUAGE_VALUES)[number] });
  }
  throw new OperationError("invalid", `Unknown preference "${key}".`, [
    "Keys: eventRetention, language",
    "bumper prefs        # current values",
  ]);
}
