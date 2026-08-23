# dsh-factory-scheduler

Leader-elected Factory scheduling and the DSH execution adapter.

The scheduler renews a SQLite lease, recovers attempts only after their Session disappears from shared presence, activates due delayed/one-time/recurring automation, atomically claims dependency-ready tasks, and serializes each checkout path. Recurring isolated tasks reuse their latest retained managed checkout. `current`, managed `isolated`, and predecessor `reuse` lanes resolve through `ctx.worktrees`.

A task model override wins; otherwise dispatch resolves the project's concrete model before the shared Agent default. Project setup runs through `ctx.shell` before Agent publication. Every occurrence is an ordinary durable DSH Session visible in the main Session browser. The scheduler mounts the existing `ask_user_question` Consumer in every run scope even when the selected preset omits it.

A pending human question keeps the Agent non-idle, the current task nonterminal, and dependent nodes queued until the answer returns through DSH's question provider. The scheduler then waits for whole-Agent idle, flushes the Session, consumes `factory_finish`, and projects receipt-aware mutations before settlement. Connected tasks receive bounded predecessor summaries, artifacts, hashes, and hunks in their logged assignment. Recurring success/failure returns the task to Scheduled and leaves an unread Triage run. Blocked runs retain their Session and lane. Cleanup relies on Worktree dirty/live-session refusal.
