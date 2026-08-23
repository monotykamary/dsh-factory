# dsh-factory

Durable task dependency graphs and recurring Agent work scheduled onto serialized repository checkout lanes for DeepSeek Harness.

Factory is a labeller and control plane over the ordinary DSH Session workflow. Human creation stays on New Session through one compact Task/Flow selector after Full access. Task is the default: it sends normally, then automatic Agent observation captures the live Session in its workspace's Emerging work. Task's nested Run later option instead consumes the blank composer into an idempotent draft without starting the Session. Flow consumes the composer to create a first node or place a parallel, sequential, or always-run finalizer node in an existing nonterminal flow. A consumed submission clears the shared draft/images and redirects to the exact task card, where the user can edit, schedule, or queue it. Optional title/description generation settles independently.

The Factory application presents Emerging work first, followed by graph-ordered named flows, Linear-compatible priority/status controls, issue-style task cards, searchable dependencies, one-shot and recurring schedules, all-run Triage, generated metadata, and safe local Git worktrees. A running task's discussion is one chronological feed backed by its DSH Session: posted messages lead pending steering and queued prompts, Queue and Steer are explicit, and users can move, edit, or remove queued rows until the Agent claims them. Pasted images use the shared Session thumbnail gallery and fullscreen lightbox in drafts, pending prompts, posted messages, and Factory notes. Task detail and exact-run Triage also scan the owning checkout's `.artifacts` directory for images and videos, present them in the same 64px horizontally paged rail, and open one fullscreen carousel across the run's media so isolated parallel worktrees remain independently reviewable. Neutral Lucide relationship nodes and same-color branch rails become a blue running spinner, green completed check, or red abrupt-failure cross as work advances. Model skills can still create task/dependency graphs directly and group the relationship-complete set.

Recurring tasks remain **Scheduled** between occurrences and retain each success or failure as an unread Triage result; ordinary task runs and observed Sessions enter the same inbox when terminal. Recurring tasks never become task-level complete. Workspace settings own execution/title models, resettable title and description instructions, title-generation opt-out, checkout/base ref, and setup script. Scheduler-launched occurrences remain ordinary durable DSH Sessions in the main Session browser.

## Install

Published bundle:

```sh
dsh plugin --profile web add dsh-factory
```

Local checkout:

```sh
pnpm install
pnpm run check
pnpm run install:local -- --profile web --skip-build
```

Restart the selected profile after installation. Factory appears as an additive Sidebar application and stores SQLite under the DSH home.

## Visual review

Store local desktop and mobile browser captures under `.artifacts/screenshots/`. These review artifacts are intentionally excluded from Git and the published package. Run `pnpm run test:e2e` against an assembled Factory web profile after browser-facing changes.

## Architecture

[`docs/architecture.md`](docs/architecture.md) defines New Session intake, durable authority, direct flow composition, recurring scheduling and Triage, metadata settlement, checkout lanes, Agent execution, cleanup, and browser-state ownership.
