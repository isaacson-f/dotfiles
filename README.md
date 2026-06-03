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
- `bin/`: install and maintenance scripts

## Install

From this repository:

```sh
./bin/install
```

The installer creates symlinks from this repo into `$HOME`. If a destination already
exists and is not the expected symlink, it is moved to:

```text
~/.dotfiles-backup/YYYYMMDD-HHMMSS/
```

## Add A New Config

1. Copy the file into the matching folder in this repo.
2. Add a `link_file` entry in `bin/install`.
3. Run `./bin/install`.
4. Review `git diff` before committing.

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
