# Contributing to Bumper

Thanks for considering a contribution.

## Before opening a pull request

1. Open an issue or Discussion for a substantial design change.
2. Keep a change focused on one observable user outcome.
3. Do not add credentials, generated release artifacts, local configuration, or personal paths.
4. Preserve Bumper's security language: describe only boundaries that are tested and enforced.

Run the relevant checks before sending a pull request:

```bash
npm test
npm run typecheck
```

On a compatible Apple Silicon Mac, VM-backed checks are available with `BUMPER_VM_TESTS=1 npm test`.

## Contributor terms

By submitting a contribution, you license it under the repository's Apache-2.0 license. Do not submit work that you do not have the right to license.

## Scope

The public repository contains the released client, its tests, and the documentation needed to use and review it. Product strategy, private experiments, and operational notes are intentionally out of scope for pull requests.
