---
name: stow-dotfiles
description: Manage Frank's personal dotfiles repository and its idempotent installer. Use whenever the user asks to inspect, capture, sync, install, or update dotfiles, shell configuration, Git, tmux, Claude, Codex, Pi, Zed, SSH templates, or Homebrew-managed tools.
---

# Dotfiles

Use this skill for Frank's personal dotfiles and bootstrap configuration.

## Repository Facts

- Local repository: `~/code/dotfiles`
- Git remote: `git@github.com:isaacson-f/dotfiles.git`
- Expected remote name: `origin`
- Bootstrap script: `~/code/dotfiles/bin/install`
- Package manifest: `~/code/dotfiles/Brewfile`
- Install target: `$HOME`
- The repository uses an explicit, idempotent symlink installer. It is not currently organized as GNU Stow packages despite this skill's legacy name.

## Tracked Layout

- `home/`: files linked directly under `$HOME`
- `config/`: files linked under `$HOME/.config`
- `claude/`: Claude settings and rules
- `codex/`: Codex rules
- `pi/`: portable Pi settings, models, global instructions, extensions, and selected skills
- `templates/`: examples for machine-local or secret-bearing files
- `Brewfile`: Homebrew formulae, casks, and language packages
- `bin/install`: package bootstrap, safe backups, and symlink creation
- `tests/install.sh`: isolated installer regression coverage

## Safety Rules

1. Start by checking repository state and remotes:
   ```bash
   cd ~/code/dotfiles
   git status --short --branch
   git remote -v
   ```
2. Do not overwrite uncommitted user changes. Inspect existing diffs before editing modified files.
3. Never track secrets or machine-local runtime data, including:
   - `~/.pi/agent/auth.json`, `trust.json`, sessions, missions, backups, runtime, npm packages, histories, or router state
   - SSH private keys or known-hosts material
   - shell histories, tokens, credentials, caches, logs, or local databases
4. Do not run the real installer merely to validate code. Use its isolated tests and dry-run mode first.
5. Before applying links to the user's home directory, run:
   ```bash
   cd ~/code/dotfiles
   ./bin/install --dry-run
   ```
   Review every backup and link action. If unexpected conflicts appear, stop and ask before applying.
6. Do not run destructive Git operations, package cleanup, or remove backups without explicit approval.

## Inspect or Sync Workflow

1. Check status and remotes:
   ```bash
   cd ~/code/dotfiles
   git status --short --branch
   git remote -v
   ```
2. If remote freshness matters:
   ```bash
   git fetch origin
   git status --short --branch
   ```
   Use `git pull --ff-only` only when appropriate and never discard local edits.
3. Inspect the intended installation without changes:
   ```bash
   ./bin/install --dry-run
   ```
4. Validate repository behavior without touching the real home configuration:
   ```bash
   bash -n bin/install tests/install.sh
   tests/install.sh
   git diff --check
   ```
5. Apply only after review or explicit user approval:
   ```bash
   ./bin/install
   ```
   Use `--macos-defaults` only when the user explicitly wants the optional keyboard-repeat defaults.
6. Summarize package changes, links, backup location, uncommitted files, and anything requiring a restart or reload.

## Capturing New Configuration

1. Choose the matching repository area and preserve a clear source layout.
2. Copy only portable, user-authored configuration into the repository.
3. Add an explicit `link_file` entry in `bin/install` for the destination under `$HOME`.
4. Add Homebrew-manageable software to `Brewfile`; use a narrow, idempotent fallback only when Homebrew cannot provide it.
5. Extend `tests/install.sh` to verify the new link and repeat-run behavior.
6. Run the isolated tests, JSON or syntax validation appropriate to the file type, and `git diff --check`.
7. Do not apply links to live files unless requested; report what would be backed up and replaced.

## Pi Configuration Notes

The repository captures only these portable Pi resources:

- `pi/AGENTS.md` → `~/.pi/agent/AGENTS.md`
- `pi/settings.json` → `~/.pi/agent/settings.json`
- `pi/models.json` → `~/.pi/agent/models.json`
- `pi/extensions/` → `~/.pi/agent/extensions/`
- `pi/skills/` → `~/.pi/agent/skills/`

Pi credentials, package installations, sessions, runtime binaries, generated stores, and histories stay local. Package declarations in `settings.json` are reproducible configuration; installed package contents under `~/.pi/agent/npm/` are not.

After applying Pi extension, skill, or settings changes in an active Pi session, tell the user to run `/reload` to refresh the current TUI.
