# E2E Scenarios

`packages/e2e` holds permanent scenario fixtures that exercise Sonata through realistic workflow and runtime paths.

Current scenarios:

- `starlane-evacuation`: root-step fan-out, persisted waiting, wake-up, guarded fan-in, and final completion
- `aurelia-beacon-recovery`: OpenCode block, orphaning after session loss, retry in a fresh session, and completion through the bridge runtime

Fixtures are committed as templates under `fixtures/`, then copied into temp sandboxes during tests so runtime artifacts land in temporary `ops/tasks/` directories instead of dirtying the repo.

Useful commands:

- `bun --cwd packages/e2e test`
- `bun --cwd packages/e2e run typecheck`
- `bun --cwd packages/e2e run lint`
- `bun --cwd packages/e2e run format:check`
- `bun turbo test --filter=@sonata/e2e`
