/**
 * Pure launch readiness for the Home guided journey.
 * Single source used by the renderer (global) and Node behavioral tests (CJS).
 * UI must not re-implement this decision tree.
 */
(function (root) {
  "use strict";

  var ACTION_LABELS = {
    "install-container": "Show install steps",
    "choose-project": "Choose a project",
    "choose-workspace": "Choose workspace folder",
    "choose-tool": "Choose an AI tool",
    "build-image": "Build AI Sandbox image",
    "wait-image": "Wait for image check",
    "sign-in": "Sign in to tool",
    "open-project-settings": "Open project settings",
    launch: "Launch protected",
  };

  /**
   * Precise copy when the image row cannot run yet because workspace and/or tool
   * are missing. Avoid saying "workspace and tool" when only one is missing.
   * @param {string} workspace
   * @param {boolean} hasAgent
   * @param {boolean} agentMapped
   */
  function imagePrerequisiteDetail(workspace, hasAgent, agentMapped) {
    var missingWorkspace = !String(workspace || "").trim();
    var missingTool = !hasAgent || !agentMapped;
    if (missingWorkspace && missingTool) {
      return "Choose workspace and tool before checking the image.";
    }
    if (missingWorkspace) {
      return "Choose a workspace before checking the image.";
    }
    return "Choose a tool before checking the image.";
  }

  /**
   * Copy for intentional unconfigured safe-base images (default alpine, etc.).
   * Not a per-tool failure — CLIs are absent by design until Build.
   */
  var SAFE_BASE_IMAGE_DETAIL =
    "Safe base image intentionally has no AI CLIs. Build the recommended AI Sandbox image (installs claude, codex, cursor-agent, agy, grok) or choose your own image in settings.";

  var SAFE_BASE_LAUNCH_REASON =
    "Safe base image has no AI CLIs yet. Build the recommended AI Sandbox image first.";

  /**
   * Neutral Home agent-card readiness when the project still uses a plain base image.
   * Distinct from a preflight "missing" failure on a custom/recommended image.
   */
  function baseImageSetupReadiness() {
    return {
      status: "setup",
      label: "Sandbox image setup",
      detail: SAFE_BASE_IMAGE_DETAIL,
    };
  }

  /**
   * Whether Home should auto-run container preflight for agent cards.
   * Base images skip auto-preflight so five tools do not look "broken".
   * @param {string} imageKind - "base" | "recommended" | "custom"
   */
  function shouldAutoPreflightOnHome(imageKind) {
    return imageKind !== "base";
  }

  /**
   * @param {object} input
   * @param {boolean} input.macOS
   * @param {boolean} input.roomAvailable
   * @param {string|null|undefined} input.projectName
   * @param {string} input.workspace
   * @param {boolean} input.roomEnabled
   * @param {string|null|undefined} input.agentId
   * @param {boolean} input.agentMapped
   * @param {string} input.imageStatus
   * @param {string} [input.imageDetail]
   * @param {boolean} [input.authRelevant]
   * @param {boolean} [input.authPersisted]
   */
  function computeLaunchGate(input) {
    var workspace = String(input.workspace || "").trim();
    var hasProject = Boolean(input.projectName);
    var hasAgent = Boolean(input.agentId);
    var imageReady = input.imageStatus === "ready";
    var imageChecking = input.imageStatus === "checking" || input.imageStatus === "pending";
    var checklist = [];

    if (!input.macOS) {
      checklist.push({
        id: "container",
        label: "Apple container",
        status: "blocked",
        detail: "Sandbox requires macOS with Apple container.",
      });
    } else if (!input.roomAvailable) {
      checklist.push({
        id: "container",
        label: "Apple container",
        status: "blocked",
        detail: "Install Apple container, then relaunch Bumper.",
        actionLabel: ACTION_LABELS["install-container"],
        action: "install-container",
      });
    } else {
      checklist.push({
        id: "container",
        label: "Apple container",
        status: "ready",
        detail: "Apple container is available for Sandbox sessions.",
      });
    }

    checklist.push(
      hasProject
        ? {
            id: "project",
            label: "Project",
            status: "ready",
            detail: 'Using project “' + input.projectName + '”.',
          }
        : {
            id: "project",
            label: "Project",
            status: "blocked",
            detail: "Select a project to compile policy and workspace defaults.",
            actionLabel: ACTION_LABELS["choose-project"],
            action: "choose-project",
          },
    );

    if (hasProject) {
      if (!input.roomEnabled) {
        checklist.push({
          id: "room",
          label: "Sandbox backend",
          status: "blocked",
          detail: "Sandbox is disabled for this project. Open settings and save to enable it.",
          actionLabel: ACTION_LABELS["open-project-settings"],
          action: "open-project-settings",
        });
      } else {
        checklist.push({
          id: "room",
          label: "Sandbox backend",
          status: "ready",
          detail: "Sandbox backend is enabled for this project.",
        });
      }
    }

    checklist.push(
      workspace
        ? {
            id: "workspace",
            label: "Workspace",
            status: "ready",
            detail: workspace,
          }
        : {
            id: "workspace",
            label: "Workspace",
            status: "blocked",
            detail: "Choose the project folder the Sandbox may mount.",
            actionLabel: ACTION_LABELS["choose-workspace"],
            action: "choose-workspace",
          },
    );

    if (!hasAgent) {
      checklist.push({
        id: "tool",
        label: "AI tool",
        status: "blocked",
        detail: "Select which CLI runs inside the Sandbox.",
        actionLabel: ACTION_LABELS["choose-tool"],
        action: "choose-tool",
      });
    } else if (!input.agentMapped) {
      checklist.push({
        id: "tool",
        label: "AI tool",
        status: "blocked",
        detail: "This tool has no Sandbox command mapping.",
        actionLabel: ACTION_LABELS["choose-tool"],
        action: "choose-tool",
      });
    } else {
      checklist.push({
        id: "tool",
        label: "AI tool",
        status: "ready",
        detail: 'Tool “' + input.agentId + '” is mapped for Sandbox launch.',
      });
    }

    if (!input.macOS || !input.roomAvailable) {
      checklist.push({
        id: "image",
        label: "Sandbox image / CLI",
        status: "blocked",
        detail: "Cannot verify image until Apple container is available.",
      });
    } else if (!input.roomEnabled) {
      checklist.push({
        id: "image",
        label: "Sandbox image / CLI",
        status: "blocked",
        detail: "Enable Sandbox for this project before checking the image.",
      });
    } else if (!workspace || !hasAgent || !input.agentMapped) {
      var imagePrereqDetail = imagePrerequisiteDetail(workspace, hasAgent, input.agentMapped);
      checklist.push({
        id: "image",
        label: "Sandbox image / CLI",
        status: "blocked",
        detail: imagePrereqDetail,
      });
    } else if (imageChecking) {
      checklist.push({
        id: "image",
        label: "Sandbox image / CLI",
        status: "checking",
        detail: input.imageDetail || "Checking whether the selected image includes this CLI…",
        actionLabel: ACTION_LABELS["wait-image"],
        action: "wait-image",
      });
    } else if (imageReady) {
      checklist.push({
        id: "image",
        label: "Sandbox image / CLI",
        status: "ready",
        detail: input.imageDetail || "CLI is available in the selected Sandbox image.",
      });
    } else {
      var setupLike = input.imageStatus === "setup";
      checklist.push({
        id: "image",
        label: "Sandbox image / CLI",
        status: "blocked",
        detail:
          input.imageDetail ||
          (setupLike
            ? SAFE_BASE_IMAGE_DETAIL
            : "The selected image does not include this CLI (or the check failed)."),
        actionLabel: ACTION_LABELS["build-image"],
        action: "build-image",
      });
    }

    // Sign-in is optional and never blocks Launch. Only surface it when a
    // sign-in session is actually executable (workspace + Sandbox + mapped tool + image ready).
    var signInExecutable =
      input.authRelevant &&
      input.macOS &&
      input.roomAvailable &&
      input.roomEnabled &&
      Boolean(workspace) &&
      hasAgent &&
      input.agentMapped &&
      imageReady;
    if (signInExecutable) {
      checklist.push(
        input.authPersisted
          ? {
              id: "auth",
              label: "Sign-in",
              status: "ready",
              detail: "Persisted Sandbox auth door is present for this tool.",
            }
          : {
              id: "auth",
              label: "Sign-in",
              status: "optional",
              detail: "Sign in if the CLI needs a login. Launch still works; complete login in the session if needed.",
              actionLabel: ACTION_LABELS["sign-in"],
              action: "sign-in",
            },
      );
    }

    // First hard blocker wins for disabled reason + next action.
    var reason = "";
    var nextAction = null;

    if (!input.macOS) {
      reason = "Protection unavailable: Sandbox requires macOS with Apple container.";
    } else if (!input.roomAvailable) {
      reason = "Apple container is not installed. Protected launch cannot start.";
      nextAction = "install-container";
    } else if (!hasProject) {
      reason = "Choose a project before launching.";
      nextAction = "choose-project";
    } else if (!input.roomEnabled) {
      reason = "Sandbox is disabled for this project. Enable Sandbox in project settings.";
      nextAction = "open-project-settings";
    } else if (!workspace) {
      reason = "Choose a workspace folder before launching.";
      nextAction = "choose-workspace";
    } else if (!hasAgent) {
      reason = "Choose an AI tool before launching.";
      nextAction = "choose-tool";
    } else if (!input.agentMapped) {
      reason = "The selected tool has no Sandbox command. Choose another tool.";
      nextAction = "choose-tool";
    } else if (imageChecking) {
      reason = "Waiting for Sandbox image check to finish.";
      nextAction = "wait-image";
    } else if (!imageReady) {
      reason =
        input.imageDetail ||
        (input.imageStatus === "setup"
          ? SAFE_BASE_LAUNCH_REASON
          : "Sandbox image is not ready for this tool. Build or pick an image that includes the CLI.");
      nextAction = "build-image";
    }

    var canLaunch = reason === "";
    if (canLaunch) nextAction = "launch";

    // Blocked Launch row explains the hard reason only. Action buttons stay on
    // the prerequisite checklist row and beside the disabled Launch control —
    // never duplicated on this final row.
    checklist.push(
      canLaunch
        ? {
            id: "launch",
            label: "Launch",
            status: "ready",
            detail: "All hard prerequisites are met. Start a protected Sandbox session.",
            actionLabel: ACTION_LABELS.launch,
            action: "launch",
          }
        : {
            id: "launch",
            label: "Launch",
            status: "blocked",
            detail: reason,
          },
    );

    var protectionState = "setup";
    if (!input.macOS || !input.roomAvailable) protectionState = "unavailable";
    else if (canLaunch) protectionState = "ready";

    return {
      canLaunch: canLaunch,
      reason: reason,
      nextAction: nextAction,
      nextActionLabel: nextAction ? ACTION_LABELS[nextAction] : "",
      checklist: checklist,
      protectionState: protectionState,
    };
  }

  var api = {
    computeLaunchGate: computeLaunchGate,
    ACTION_LABELS: ACTION_LABELS,
    baseImageSetupReadiness: baseImageSetupReadiness,
    shouldAutoPreflightOnHome: shouldAutoPreflightOnHome,
    SAFE_BASE_IMAGE_DETAIL: SAFE_BASE_IMAGE_DETAIL,
    SAFE_BASE_LAUNCH_REASON: SAFE_BASE_LAUNCH_REASON,
  };
  root.BumperLaunchGate = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
