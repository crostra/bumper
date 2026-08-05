# `src/operations` — the single place a user intent is carried out

One exported function per user intent. `bumper network off` and the GUI's
Network control call **the same function**; they differ only in how the argv or
the request body reaches it, and how the result is printed.

## Why this layer exists

Before it, the GUI's write path was `saveContext(name, input: any)` — 248 lines
in `app.ts` typed by the *shape of an HTTP form*, not by the domain. A CLI that
wanted to change one field had two choices: rebuild the whole form blob, or
bypass `saveContext` and write config directly. The second is what actually
happens, and it silently drops whatever else the handler did — the GitHub token
revoke on a changed binding, the running-session guard on a folder change.

Two entry points that each carry their own copy of the rules is how the
maintenance cost doubles. So the rules live here, once.

## Rules

1. **No transport.** No `node:http`, no `req`/`res`, no argv parsing.
2. **No presentation.** No `console.*`, no `process.exit`. Return data; the
   adapter decides how it looks.
3. **Own the side effects.** Guards, revocation, and event logging belong
   *inside* the operation. If an adapter can forget it, it will.
4. **Fail with a code.** Throw `OperationError` with a machine-readable `code`
   and, where there is one, the `fix` commands. HTTP maps the code to a status;
   the CLI maps it to a next command.

Rules 1 and 2 are enforced by `test/operations-boundary.test.mjs`, not by
convention.

## Adapters

| Entry | File | Job |
|---|---|---|
| HTTP (GUI) | `src/app.ts` | body → operation → `code` to status |
| TTY (CLI)  | `src/cli.ts` | argv → operation → text + next command |

Domain modules (`project.ts`, `folders.ts`, `room/*`) stay pure and are called
*by* operations. Operations do not replace them; they compose them and own the
sequencing.
