# Public release readiness

A Bumper release is ready to recommend broadly when all of the following are true:

1. A new user can create a Project, build the supported Sandbox image, and start at least one supported AI CLI.
2. The declared folder and network boundaries are verified by automated checks and a real Sandbox proof.
3. The published package or Mac app can be installed from its release asset with the stated prerequisites.
4. The product surface describes only enforced behavior and names its limits.
5. Users can export local events, restore configuration, remove Bumper-owned state, and find a feedback channel.

The current public baseline has automated tests and local unsigned packaging. Developer ID signing, Apple notarization, and a clean-user signed journey are pending before the DMG becomes the standard installation path. Until then, an unsigned DMG may only be offered as an explicitly labelled technical preview as described in [DISTRIBUTION.md](DISTRIBUTION.md).
