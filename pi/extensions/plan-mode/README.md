# Plan Mode Extension

Read-only exploration mode for safe code analysis, followed by structured plan execution with reliable progress tracking.

## Features

- **Read-only tools**: Restricts plan mode tools to read, bash, grep, find, ls, ask-user
- **Bash allowlist**: Only read-only bash commands are allowed while planning
- **Plan extraction**: Extracts ordered tasks from `## Tasks (Ordered)` sections
- **Structured progress**: `plan_progress` updates completion state during execution
- **Progress tracking**: Widget shows completion, blocked, and remaining status during execution
- **Legacy fallback**: `[DONE:n]` markers are still parsed, but only as a backward-compatible fallback
- **Session persistence**: State survives session resume, including todos, execution mode, prior tools, last plan text, and clear-context execution state
- **Clear-context execution**: Start execution with prior planning/research messages removed from the model context
- **Question backtracking**: Clarification dialogs support returning to earlier questions

## Commands

- `/plan` - Toggle plan mode
- `/plan-execute-clear` - Clear context and execute the current plan
- `/todos` - Show current plan progress
- `Ctrl+Alt+P` - Toggle plan mode (shortcut)

## `plan_progress` Tool

`plan_progress` is an execution-only tool. It is enabled only while a plan is actively executing, alongside the normal tool set restored from before plan mode.

Actions:

- `list` - Show current plan steps and their state
- `complete` - Mark a finished step complete; requires `step`
- `block` - Mark a step blocked; requires `step` and should include `reason`
- `finish` - End execution explicitly, usually after all work is complete or execution must stop because one or more steps are blocked

During execution, the agent is instructed to call `plan_progress` immediately after completing each step, before moving on to the next step. This structured tool update is the primary source of truth for progress state.

## Usage

1. Enable plan mode with `/plan` or the `--plan` flag.
2. Ask the agent to analyze code and create a plan.
3. The agent should output a structured plan using these sections:

```
## Goal
One concise objective

## Tasks (Ordered)
1. First step description
2. Second step description
3. Third step description

## Relevant Files
- path/to/file1
- path/to/file2
```

4. Choose "clear context and execute plan" to execute with only the plan in model context, or "Execute the plan" to continue with the full current context.
5. During execution, the agent completes work step-by-step and calls `plan_progress` after each completed or blocked step.
6. The progress widget updates incrementally as `plan_progress` mutates plan state.
7. When all tasks are complete, execution mode is cleared and the progress widget is removed.

## How It Works

### Plan Mode (Read-Only)

- Only read-only tools are available.
- Bash commands are filtered through the allowlist.
- The agent asks clarifying questions first when needed, then creates the plan without making changes.
- The extension extracts actionable numbered items from `## Tasks (Ordered)` and filters out low-quality fragments such as headings, alternatives, vague validation labels, and malformed list items.

### Execution Mode

- Restores the tool set that was active before plan mode was enabled.
- Adds `plan_progress` while execution is active.
- Agent executes steps in order.
- `plan_progress` is the primary progress mechanism:
  - `complete` checks off steps and persists state.
  - `block` records blocked steps and reasons.
  - `finish` clears execution state consistently.
- A shared completion helper updates todos, refreshes UI/status, persists state, and detects all-complete plans.
- A shared finish helper clears execution mode, restores normal tools, removes the progress widget, and persists the cleared state.
- If the agent tries to end a turn while execution is still active and no structured progress update was recorded, a reconciliation prompt tells it to call `plan_progress` for completed or blocked steps before stopping.
- "clear context and execute plan" filters prior planning/research messages out of model context and starts implementation immediately.

### Legacy `[DONE:n]` Fallback

`[DONE:n]` markers are still parsed for backward compatibility with older prompts and sessions. They can still check off tasks when emitted, but they are secondary to `plan_progress` and should not be used as the primary execution flow.

### Command Allowlist

Safe commands (allowed):

- File inspection: `cat`, `head`, `tail`, `less`, `more`
- Search: `grep`, `find`, `rg`, `fd`
- Directory: `ls`, `pwd`, `tree`
- Git read: `git status`, `git log`, `git diff`, `git branch`
- Package info: `npm list`, `npm outdated`, `yarn info`
- System info: `uname`, `whoami`, `date`, `uptime`

Blocked commands:

- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`
- Package install: `npm install`, `yarn add`, `pip install`
- System: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`
