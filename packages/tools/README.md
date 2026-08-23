# dsh-factory-tools

Model-facing Consumers of the Factory domain plus a bundled `factory` Skill.

Global tools list complete workspace settings, tasks, standard/inbox flows, recurring run history, and live Sessions. They create draft or recurring tasks, create explicit flows from same-workspace task ids, start draft flows, update task fields/dependencies, set metadata instructions, sink or attach live Sessions, comment, and apply lifecycle actions. `factory_create_task` exposes finalizer roles and five-field cron recurrence; no stored-template tool or hard deletion exists.

The bundled skill directs the model to list before mutation, create graph nodes and dependency edges explicitly, group the relationship-complete set with `factory_create_flow`, inherit workspace policy unless an override is required, and preserve optional revisions. In an assigned run, an answerable human dependency goes through `ask_user_question` before `factory_finish`; the model waits for the answer, continues and verifies the work, then submits one terminal report in a later model step. A same-step completion report is rejected before it reaches the scheduler. `blocked` is reserved for intervention a direct question cannot resolve. The scheduler commits the buffered completion report after whole-turn idle.
