# Sonata

Sonata is a Bun + TypeScript monorepo for running workflow-driven tasks from a CLI.

## Quick start

```bash
bun install
bun dev
```

Useful commands:

- `bun --cwd packages/cli src/index.ts --help`
- `bun typecheck`
- `bun lint`
- `bun --cwd packages/core test`
- `bun turbo test --filter=@sonata/e2e`

## E2E scenarios

Permanent workflow scenario fixtures live in `packages/e2e`.

- `starlane-evacuation` covers fan-out, waiting, guarded fan-in, and completion
- `aurelia-beacon-recovery` covers block, orphan, retry, and fresh-session recovery

The committed fixtures are copied into temp sandboxes at test time, so runtime artifacts are written to temporary `ops/tasks/` directories rather than tracked files in the repo.

## Runtime logs

Sonata writes workflow log calls to the linked ops repo:

- `logs/tasks/<taskId>/workflow.log` for workflow-authored logs
- `logs/tasks/<taskId>/steps/<step>.log` for per-step workflow logs

Workflow steps and custom OpenCode tools can write workflow logs with `ctx.log.info()`, `ctx.log.warn()`, `ctx.log.error()`, or `ctx.log.debug()`.
