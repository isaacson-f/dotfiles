# Agency intern pi extension

Project-local pi extension for delegating work to the installed `intern` CLI.

## What it adds

- `intern_new` tool for pi to create remote intern sessions
- `/intern-new` command for manual use inside pi
- `/intern-list` command to view active intern sessions

## Session types

`intern_new` now requires pi to choose one of two session types when creating a session:

- `research_slack`
  - research the codebase
  - do not open a PR
  - Slack the requester with the answer
- `pr_slack`
  - implement the change
  - create a fresh working branch
  - open a PR
  - Slack the requester with the PR link

The default wrapper is tailored to the chosen session type.

## Behavior

`intern_new` creates sessions from `main` by default. Pass `branch` only when the user explicitly asks for another base branch.

`intern_new` wraps the requested task with Agency-specific one-shot guidance by default:

- starts with a codebase exploration pass before changes
- reminds the intern to read `AGENTS.md`
- points it at relevant `.claude/skills/` docs
- asks it to treat implementation details in the request as hypotheses to verify against the current code
- asks it to keep scope tight and follow local patterns
- chooses either a research+Slack or branch/PR+Slack delivery mode
- asks it to run meaningful verification and report exact file paths changed

If you really want the raw prompt, pass `raw_prompt: true`.

## Example

Inside pi:

- `Use intern_new with session_type: research_slack to investigate the stale badge behavior and Slack me the answer`
- `Use intern_new with session_type: pr_slack to implement the flaky task generation fix, open a PR, and Slack me the PR link`
- `/intern-new`
- `/intern-list`

## Notes

- Sessions are created with `intern new --json`
- Repo defaults to the current git remote, falling back to `agency-inc/agency`
- Branch defaults to `main`, unless a different branch is explicitly requested
- The pi assistant should do lightweight local exploration before calling `intern_new` so prompts are self-contained without repeated user instructions
- After creation, the extension reports the session id and an `intern attach <id>` command
- Reload pi with `/reload` after editing the extension
