# Global Pi instructions

## Subagent routing

The user does not want to manually choose subagents or memorize the subagent taxonomy. Infer routing automatically.

Use subagents and interns proactively when they improve quality:

- Use `scout` for unfamiliar code, context gathering, locating implementations, mapping data flow, or understanding how something works.
- Use `researcher` for external docs, API behavior, current/recent facts, vendor documentation, or cited research.
- Use `planner` for concrete plans before non-trivial edits.
- Use `oracle` for risky decisions, architecture, migrations, hard bugs, security-sensitive changes, large refactors, or second opinions.
- Use `worker` for local implementation of an approved or clearly specified plan.
- Use `reviewer` for reviewing diffs, validating completed work, catching regressions, checking tests, or assessing whether something is ready to ship.
- Use `context-builder` for large, context-heavy tasks that need a durable handoff before planning.
- Use `intern_new` for remote Agency intern sessions when the user wants delegated work outside the current Pi session, Slack delivery, a PR opened by an intern, long-running implementation/research, or explicit "intern" wording.

Default routing patterns:

- For unfamiliar or broad implementation work: `scout` or `context-builder` → `planner` → stop for approval unless the user clearly asked to implement.
- For clear implementation work: `worker` → `reviewer`.
- For risky work: insert `oracle` before `worker`.
- For “is this ready”, “check this”, “review this”, or final validation after implementation: prefer fresh-context `reviewer` runs, often in parallel with different focus areas.
- For external docs/current facts: use `researcher` before relying on the fact.
- For remote delegation: use `intern_new` with `session_type: research_slack` for investigations that should end in Slack, or `session_type: pr_slack` for implementation that should open a fresh branch/PR and Slack the requester.

Behavior:

1. Classify the user request.
2. Decide whether delegation would materially improve quality.
3. If yes, choose the route and briefly announce it.
4. Proceed unless the routing choice changes scope, writes files when the user did not permit edits, incurs risky/destructive actions, or requires a product decision.
5. Synthesize subagent results for the user; do not dump raw output unless useful.

If a useful subagent has not been used recently in the session or global Pi usage state, actively raise it:

- After implementation or before final summary, suggest or run `reviewer` unless the user asked not to.
- Before risky decisions, suggest or run `oracle`.
- In unfamiliar code, suggest or run `scout`.
- For docs/current facts, suggest or run `researcher`.

The user should be able to say “route this appropriately” or simply state the task. Do not require them to know agent names, slash commands, subagent internals, or intern CLI details.
