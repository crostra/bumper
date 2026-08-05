/**
 * The one error type operations throw.
 *
 * An operation cannot know whether its caller is an HTTP handler or a terminal,
 * so it must not choose a status code or a sentence. It states *what kind* of
 * failure this is, and — when there is one — the command that fixes it. The
 * adapter maps `code` to a 400/404/409 or to stderr plus a next step.
 */
export type OperationErrorCode =
  /** The named Project / connection / record does not exist. */
  | "not-found"
  /** The caller's input is malformed or contradictory. */
  | "invalid"
  /** Valid input, but the current state forbids it (running session, live token). */
  | "conflict";

export class OperationError extends Error {
  readonly code: OperationErrorCode;
  /** Commands the user can run to get unstuck. Printed by the CLI adapter. */
  readonly fix: string[];

  constructor(code: OperationErrorCode, message: string, fix: string[] = []) {
    super(message);
    this.name = "OperationError";
    this.code = code;
    this.fix = fix;
  }
}

export function isOperationError(error: unknown): error is OperationError {
  return error instanceof OperationError;
}

/** HTTP status for an operation failure. Used by the app.ts adapter. */
export function statusForOperationError(error: OperationError): number {
  switch (error.code) {
    case "not-found": return 404;
    case "conflict": return 409;
    case "invalid": return 400;
  }
}
