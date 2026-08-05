/**
 * Shareable diagnostics without telemetry or credential material.
 *
 * The CLI gathers facts locally and prints this object only when the user asks.
 * Absolute home/workspace paths and common secret shapes are removed here, in
 * one place, so future support surfaces cannot accidentally diverge.
 */
import type { DoctorReport } from "./doctor.js";
import type {
  ProjectStatusAudit,
  ProjectStatusSession,
  ProjectStatusSnapshot,
} from "./cli-room.js";
import { projectStatusIssues } from "./cli-room.js";

export interface DiagnosticRedactionContext {
  home?: string;
  cwd?: string;
  configPath?: string;
}

export function redactDiagnosticText(
  value: string,
  context: DiagnosticRedactionContext = {},
): string {
  let text = String(value ?? "");
  const replacements = [
    [context.configPath, "<config>"],
    [context.cwd, "<cwd>"],
    [context.home, "~"],
  ] as const;
  for (const [from, to] of replacements) {
    if (!from || from.length <= 1) continue;
    text = text.split(from).join(to);
  }
  return text
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "<private-key-redacted>")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|sk(?:-ant)?-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[A-Z0-9]{16})\b/g, "<secret-redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer <redacted>")
    .replace(/([?&](?:access_token|api_key|token|key)=)[^&#\s]+/gi, "$1<redacted>")
    .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1<credentials-redacted>@")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email-redacted>")
    .replace(/\/Users\/[^/\s]+/g, "/Users/<user>")
    .replace(/\/(?:private\/)?var\/folders\/[^\s]+/g, "<temporary-path>")
    .replace(/\/tmp\/[^\s]+/g, "<temporary-path>");
}

export interface SupportBundleInput {
  bumperVersion: string;
  platform: string;
  osVersion: string;
  arch: string;
  nodeVersion: string;
  doctor: DoctorReport;
  project?: ProjectStatusSnapshot;
  sessions?: ProjectStatusSession[];
  audit?: ProjectStatusAudit;
  redaction?: DiagnosticRedactionContext;
  now?: Date;
}

export function buildSupportBundle(input: SupportBundleInput): Record<string, unknown> {
  const redact = (value: string) => redactDiagnosticText(value, input.redaction);
  const sessions = input.sessions ?? [];
  const project = input.project;
  return {
    kind: "bumper-support-bundle",
    generatedAt: (input.now ?? new Date()).toISOString(),
    privacy: "Generated locally on explicit request. No credential values or absolute user paths included.",
    bumper: input.bumperVersion,
    host: {
      platform: input.platform,
      osVersion: input.osVersion,
      arch: input.arch,
      node: input.nodeVersion,
    },
    readiness: {
      ready: input.doctor.ready,
      checks: input.doctor.checks.map((check) => ({
        id: check.id,
        status: check.status,
        detail: redact(check.detail),
        next: check.fix.map(redact),
      })),
    },
    project: project ? {
      name: redact(project.projectName),
      resolvedVia: project.source,
      status: projectStatusIssues(project).length ? "needs-attention" : "configured",
      sandboxEnabled: project.roomEnabled,
      network: project.egress,
      sharedFolders: project.accessRoots.length,
      writableFolders: project.accessRoots.filter((root) => root.access !== "read-only").length,
      image: redact(project.image),
      imageStatus: project.imageStatus,
      containerCli: project.container.usable ? "installed" : "unavailable",
      containerService: project.container.systemState,
      savedLoginCount: project.tools.filter((tool) => tool.authPersisted).length,
      runningSessionCount: sessions.length,
      today: input.audit ?? null,
      issues: projectStatusIssues(project).map((issue) => ({
        message: redact(issue.message),
        next: redact(issue.command),
      })),
    } : null,
  };
}
