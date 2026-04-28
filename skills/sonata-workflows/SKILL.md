---
name: sonata-workflows
description: Implement and debug Sonata workflow steps, artifacts, child steps, blocking, and OpenCode bridge sessions correctly.
compatibility: opencode
---

## Operating Mode

- Start by discovering the Ops repo shape: read `config.json`, then inspect the configured workflow modules.
- Prefer direct file/tool inspection over assumptions from previous chat context.
- Make the smallest workflow change that preserves existing step IDs, artifact names, and task semantics.
- Treat step inputs as frozen snapshots. If needed context is absent from `ctx.inputs`, add an explicit input/artifact dependency rather than reaching for ambient repo state.
- Before finishing, verify the behavior with the narrowest useful command or test.

## Workflow Implementation

1. Read the workflow definition before editing: step IDs, titles, inputs, artifacts, `next`, `waitFor`, guards, and OpenCode config.
2. Keep artifact declarations and writes in sync. If a step writes data that another step consumes, declare the artifact and consume it through step inputs.
3. Use JSON artifacts for structured state and markdown artifacts for operator-readable analysis or reports.
4. Preserve required artifact checks. Do not bypass validation to make a step complete.
5. Use stable child `workKey` values for fan-out. Prefer durable IDs from the domain over array indices, generated labels, or free text.
6. For fan-in, inspect child statuses and required child artifacts before completing the parent.
7. If changing runtime semantics, transition behavior, artifact validation, or child-step behavior, add or update tests.

## Debugging Flow

1. Identify the task and step: `taskId`, `stepId`, `stepKey`, status, parent step, work key, and current root step.
2. Inspect active tasks when the project id is known: `sonata task list --project-id <projectId>`.
3. Inspect logs before changing state: `logs/tasks/<taskId>/workflow.log` and `logs/tasks/<taskId>/steps/<step>.log`.
4. For blocked steps, read the block payload and resume hint. Resume only after the missing operator or external input is available.
5. For waiting parents, determine the wait condition: `all_completed` requires every child to complete; `all_terminal` allows completed, failed, or cancelled terminal children.
6. For orphaned steps, prefer the supported retry path over manual state edits.
7. For failed steps, identify whether the failure came from workflow code, artifact validation, transition validation, OpenCode session setup, or a bridge tool call.
8. Do not manually edit Sonata database state unless the user explicitly asks for recovery surgery.

## OpenCode Step Contract

- Use Sonata bridge tools for artifact writes, blocking, custom tool calls, and step completion.
- Use the provided Sonata tool names exactly. Do not invent artifact paths, tool IDs, or completion APIs.
- Write all required artifacts before calling `sonata_complete_step`.
- Call `sonata_complete_step` exactly once and only claim completion if it succeeds.
- If autonomous progress is impossible, call `sonata_block_step` once with a specific code, message, details, and resume hint.
- For large JSON artifacts, stage JSON in `SONATA_OPS_ROOT/.sonata/staging/<taskId>/<stepId>/...` and pass the staged file path to the JSON artifact tool when supported.
- Never complete a parent step just because child work was spawned. Completion depends on the declared wait condition and guards.

## OpenCode Sessions

- Treat OpenCode session participation as separate from step semantics. Do not introduce autonomous/interactive step modes; use prompts to describe when the agent should consult the user or wait for confirmation.
- Configure default CLI joining with `opencode.session.join`: `auto` attaches immediately, `ask` prompts before attaching, and `background` starts or resumes the session without auto-attaching.
- `background` is not a deny policy. Any OpenCode-backed step with a stored session remains manually attachable as an escape hatch.
- Use `sonata step sessions --task-id <taskId>` to discover stored OpenCode sessions for a task.
- Use `sonata step attach <stepId> --task-id <taskId>` to manually join a stored OpenCode session.
- If a stored `opencodeBaseUrl` is stale, manual attach may fail. Do not assume Sonata can restart the OpenCode server unless that behavior has been explicitly implemented.
- When debugging OpenCode session behavior, inspect both the Sonata step state and the session metadata: `sessionId`, `opencodeBaseUrl`, status, parent step, and work key.

## Common Failure Patterns

- Missing required artifact: the step completed before writing all required artifacts, or the artifact name/kind does not match the declaration.
- Artifact kind mismatch: a markdown artifact was written through a JSON tool or the reverse.
- Write-once violation: a step attempted to rewrite an artifact declared with `once` semantics.
- Waiting parent stuck: children are blocked, failed, orphaned, or missing required artifacts for a completion guard.
- Fan-out duplicates: unstable `workKey` values caused duplicate or conflicting child steps.
- OpenCode bridge unavailable: the session started without required Sonata bridge tools or with incorrect environment variables.
- OpenCode session stale: the step has a stored `sessionId` and `opencodeBaseUrl`, but the OpenCode server is no longer reachable.
- Hidden context dependency: workflow code reads current repo state instead of declared invocation/artifact inputs, making retries and child steps inconsistent.

## Safety Rules

- Do not use destructive git, filesystem, or database commands as shortcuts for workflow recovery.
- Do not remove tests or loosen schemas to make a workflow pass.
- Do not add compatibility layers unless persisted data, existing Ops workflows, or a user requirement needs them.
- If a workflow change affects existing active tasks, call out the migration/retry implications before making broad edits.

## Verification

- For workflow type/API changes in Sonata, run `bun --cwd packages/workflow typecheck`.
- For core runtime changes in Sonata, run `bun --cwd packages/core typecheck` and the relevant `bun --cwd packages/core test` target.
- For CLI behavior changes in Sonata, run `bun --cwd packages/cli typecheck` and targeted CLI tests.
- For end-to-end workflow behavior in Sonata, run `bun turbo test --filter=@sonata/e2e`.
- For Ops workflow-only edits, run the narrowest available workflow or task test in that Ops repo and inspect the resulting logs/artifacts.
