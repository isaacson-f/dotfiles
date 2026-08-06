# Frank's Dotfiles

Personal configuration for shells, Git, terminal tools, editors, and coding harnesses.

This repository intentionally tracks portable configuration only. Secrets, auth state,
tokens, databases, histories, local caches, and machine-specific runtime files are
excluded.

## Layout

- `home/`: files that live directly in `$HOME`
- `config/`: files that live under `$HOME/.config`
- `claude/`: Claude settings and user-authored rules
- `codex/`: Codex rules
- `templates/`: examples for secret or machine-specific files
- `bin/`: installation and maintenance scripts
- `Brewfile`: Homebrew-managed applications and command-line dependencies

## Install

From this repository, run:

```sh
./bin/install
```

The installer is idempotent. It:

1. Installs Homebrew noninteractively if it is absent, then loads `brew shellenv` for
   the current process.
2. Installs the `Brewfile` with `brew bundle install --no-upgrade`. The Brewfile owns
   Fish, Zsh, tmux, TPM, Git LFS, GitHub CLI, Node.js, Zed, Claude Code, and the other declared
   development tools.
3. Verifies that Homebrew's Git LFS executable is available. The tracked
   `.gitconfig` already contains the required LFS filter configuration, so the
   installer does not mutate global Git configuration.
4. Clones Oh My Zsh only when `~/.oh-my-zsh` is absent. Homebrew has no Oh My Zsh
   package, so this narrow Git clone is the one fallback. An existing installation is
   never updated or overwritten: it must be a Git checkout whose `origin` is the
   official `ohmyzsh/ohmyzsh` repository (SSH and HTTPS remotes are accepted).
5. Symlinks the tracked configuration files into `$HOME`.
6. Installs the tmux plugins declared in `tmux.conf` through Homebrew-managed TPM.

> **Warning:** A normal install can download software and may prompt for privileges
> while Homebrew is installed. Review the `Brewfile` before running it on a new
> machine.

Use a no-change preview first:

```sh
./bin/install --dry-run
```

`--dry-run` makes no filesystem changes and does not invoke Homebrew, Git cloning, or
macOS defaults. For isolated linking work or tests, use:

```sh
./bin/install --skip-brew --skip-oh-my-zsh
```

The installer only applies macOS keyboard repeat defaults when explicitly requested:

```sh
./bin/install --macos-defaults
```

### Existing files and backups

If a destination is not the exact expected symlink, the installer moves it under a
timestamped, path-preserving backup directory, for example:

```text
~/.dotfiles-backup/20260806-123456.A1b2C3/.config/zed/settings.json
~/.dotfiles-backup/20260806-123456.A1b2C3/.claude/settings.json
```

The random suffix makes each backup run unique, while preserving distinct files with
identical basenames. The installer refuses targets outside `$HOME`, refuses to follow
symlinked target parents, and never overwrites an existing backup.

## Add a New Config

1. Copy the file into the matching folder in this repo.
2. Add a `link_file` entry in `bin/install`.
3. Add its required software to `Brewfile` where Homebrew manages it.
4. Run `./bin/install --dry-run`, then `./bin/install`.
5. Review `git diff` before committing.

## Keep Out Of Git

Do not commit:

- `~/.ssh` private keys
- `~/.netrc`
- AWS credentials
- kube configs with tokens
- GitHub CLI `hosts.yml`
- gcloud databases
- editor or agent histories
- SQLite databases, caches, logs, and local session files

Use `templates/` for examples that need to be recreated per machine.
