# AGENTS.md

## Scope

This repository implements the durable Factory task graph as external DeepSeek Harness plugins. Keep protocol, persistence, scheduling, DSH execution, model tools, and browser presentation in their owning packages.

## Architecture

- `dsh-factory-protocol`: host-independent task, flow, recurring schedule, run, observation, and graph records.
- `dsh-factory-store`: persistence Service Definition.
- `dsh-factory-store-sqlite`: transactional document, presence, and scheduler-lease provider.
- `dsh-factory-domain`: state transitions and Typert Remote methods.
- `dsh-factory-scheduler`: dependency/lane/cron reconciliation and DSH Agent execution.
- `dsh-factory-tools`: model tools, explicit run completion, and the bundled Factory skill.
- `dsh-factory-client-ui`: Work, task card, all-run Triage, and workspace settings surface.
- The workspace root is the installable `dsh-factory` bundle.

Do not introduce a second agent loop, tool registry, session store, or React business store. Factory tasks and flows are durable Factory state; model-visible run input and completion remain logged in DSH Sessions. React owns only filters, selection, expansion, drafts, and viewport state.

## Safety

A checkout is one serialized writer lane. Never force-remove a worktree, delete dirty work, or release a lane while shared presence reports a live Session. Publishing remains an explicit task and cleanup cannot rewrite the flow outcome.

## Verification

Run `pnpm run check`. Browser screenshots additionally run `pnpm run test:e2e` after building the client bundle.
