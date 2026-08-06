#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
INSTALL="$REPO_DIR/bin/install"
TEST_ROOT="$(mktemp -d)"
HOME="$TEST_ROOT/home"
MOCK_BIN="$TEST_ROOT/mock-bin"
SYSTEM_PATH="$PATH"
export HOME
export PATH="$MOCK_BIN:$SYSTEM_PATH"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_file() {
  [[ -f "$1" ]] || fail "expected file: $1"
}

assert_dir() {
  [[ -d "$1" ]] || fail "expected directory: $1"
}

assert_link() {
  local target="$1" source="$2"
  [[ -L "$target" ]] || fail "expected symlink: $target"
  [[ "$(readlink "$target")" == "$source" ]] \
    || fail "unexpected link target for $target: $(readlink "$target")"
}

mkdir -p "$MOCK_BIN"
: > "$TEST_ROOT/operations.log"

# Codex is owned by Homebrew cask. An npm declaration collides with an existing
# cask-owned /opt/homebrew/bin/codex and fails with npm EEXIST.
grep -qx 'cask "codex"' "$REPO_DIR/Brewfile" \
  || fail 'Codex is not declared as a Homebrew cask'
grep -qx 'cask "ghostty"' "$REPO_DIR/Brewfile" \
  || fail 'Ghostty is not declared as a Homebrew cask'
if grep -qx 'npm "@openai/codex"' "$REPO_DIR/Brewfile"; then
  fail 'Codex must not also be installed through npm'
fi
for command in brew git curl defaults; do
  cat > "$MOCK_BIN/$command" <<EOF
#!/usr/bin/env bash
printf '%s\\n' '$command' >> '$TEST_ROOT/operations.log'
exit 99
EOF
  chmod +x "$MOCK_BIN/$command"
done

# A full dry run must not invoke package, network, Git, or macOS-default commands,
# and it must not create a target HOME.
"$INSTALL" --dry-run > "$TEST_ROOT/dry-run.out"
[[ ! -e "$HOME" ]] || fail 'dry run created HOME'
[[ ! -s "$TEST_ROOT/operations.log" ]] || fail 'dry run invoked an external operation'
grep -q 'would run: brew bundle install' "$TEST_ROOT/dry-run.out" \
  || fail 'dry run did not describe Brewfile installation'
grep -q 'would clone:' "$TEST_ROOT/dry-run.out" \
  || fail 'dry run did not describe Oh My Zsh clone'

# Skip provisioners to exercise only the symlink and backup behavior.
"$INSTALL" --skip-brew --skip-oh-my-zsh > "$TEST_ROOT/first-run.out"
assert_link "$HOME/.zshrc" "$REPO_DIR/home/.zshrc"
assert_link "$HOME/.zprofile" "$REPO_DIR/home/.zprofile"
assert_link "$HOME/.zshenv" "$REPO_DIR/home/.zshenv"
assert_link "$HOME/.gitconfig" "$REPO_DIR/home/.gitconfig"
assert_link "$HOME/.config/tmux/tmux.conf" "$REPO_DIR/config/tmux/tmux.conf"
assert_dir "$HOME/.local/share/tmux/resurrect"
assert_link "$HOME/.config/zed/settings.json" "$REPO_DIR/config/zed/settings.json"
assert_link "$HOME/.config/git/ignore" "$REPO_DIR/config/git/ignore"
assert_link "$HOME/.config/gh/config.yml" "$REPO_DIR/config/gh/config.yml"
assert_link "$HOME/.claude/settings.json" "$REPO_DIR/claude/settings.json"
assert_link "$HOME/.claude/rules/code-style.md" "$REPO_DIR/claude/rules/code-style.md"
assert_link "$HOME/.claude/rules/anti-slop.md" "$REPO_DIR/claude/rules/anti-slop.md"
assert_link "$HOME/.codex/rules/default.rules" "$REPO_DIR/codex/rules/default.rules"
assert_link "$HOME/.pi/agent/AGENTS.md" "$REPO_DIR/pi/AGENTS.md"
assert_link "$HOME/.pi/agent/settings.json" "$REPO_DIR/pi/settings.json"
assert_link "$HOME/.pi/agent/models.json" "$REPO_DIR/pi/models.json"
assert_link "$HOME/.pi/agent/extensions" "$REPO_DIR/pi/extensions"
assert_link "$HOME/.pi/agent/skills" "$REPO_DIR/pi/skills"

"$INSTALL" --skip-brew --skip-oh-my-zsh > "$TEST_ROOT/second-run.out"
grep -q "ok: $HOME/.zshrc" "$TEST_ROOT/second-run.out" \
  || fail 'second run did not recognize expected symlink'
grep -q "ok: $HOME/.local/share/tmux/resurrect" "$TEST_ROOT/second-run.out" \
  || fail 'second run did not recognize expected tmux resurrect directory'
[[ ! -e "$HOME/.dotfiles-backup" ]] || fail 'second run created an unnecessary backup'

# Files with the same basename must retain their HOME-relative paths in backups.
rm "$HOME/.claude/settings.json" "$HOME/.config/zed/settings.json" "$HOME/.pi/agent/settings.json"
printf 'claude settings\n' > "$HOME/.claude/settings.json"
printf 'zed settings\n' > "$HOME/.config/zed/settings.json"
printf 'pi settings\n' > "$HOME/.pi/agent/settings.json"
"$INSTALL" --skip-brew --skip-oh-my-zsh > "$TEST_ROOT/backup-run.out"

backup_root="$(find "$HOME/.dotfiles-backup" -mindepth 1 -maxdepth 1 -type d -print -quit)"
[[ -n "$backup_root" ]] || fail 'backup directory was not created'
assert_file "$backup_root/.claude/settings.json"
assert_file "$backup_root/.config/zed/settings.json"
assert_file "$backup_root/.pi/agent/settings.json"
grep -qx 'claude settings' "$backup_root/.claude/settings.json" \
  || fail 'Claude backup content changed'
grep -qx 'zed settings' "$backup_root/.config/zed/settings.json" \
  || fail 'Zed backup content changed'
grep -qx 'pi settings' "$backup_root/.pi/agent/settings.json" \
  || fail 'Pi backup content changed'
assert_link "$HOME/.claude/settings.json" "$REPO_DIR/claude/settings.json"
assert_link "$HOME/.config/zed/settings.json" "$REPO_DIR/config/zed/settings.json"
assert_link "$HOME/.pi/agent/settings.json" "$REPO_DIR/pi/settings.json"

# A second replacement run in the same second must use another unique backup
# directory rather than overwriting the first run's files.
rm "$HOME/.claude/settings.json" "$HOME/.config/zed/settings.json"
printf 'claude settings second run\n' > "$HOME/.claude/settings.json"
printf 'zed settings second run\n' > "$HOME/.config/zed/settings.json"
"$INSTALL" --skip-brew --skip-oh-my-zsh > "$TEST_ROOT/second-backup-run.out"
backup_count="$(find "$HOME/.dotfiles-backup" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
[[ "$backup_count" == 2 ]] || fail "expected two unique backup roots, found $backup_count"
grep -Rlx 'claude settings second run' "$HOME/.dotfiles-backup" >/dev/null \
  || fail 'second-run Claude backup was not preserved'
grep -Rlx 'zed settings second run' "$HOME/.dotfiles-backup" >/dev/null \
  || fail 'second-run Zed backup was not preserved'

# Refuse to follow a symlinked parent that could redirect a managed target.
unsafe_home="$TEST_ROOT/unsafe-home"
outside_home="$TEST_ROOT/outside-home"
mkdir -p "$unsafe_home" "$outside_home"
ln -s "$outside_home" "$unsafe_home/.config"
if HOME="$unsafe_home" "$INSTALL" --skip-brew --skip-oh-my-zsh > "$TEST_ROOT/unsafe.out" 2>&1; then
  fail 'installer accepted a symlinked target parent'
fi
[[ ! -e "$outside_home/tmux/tmux.conf" ]] \
  || fail 'installer wrote through a symlinked target parent'

# Refuse a symlinked backup root before moving an existing target.
backup_home="$TEST_ROOT/backup-symlink-home"
backup_outside="$TEST_ROOT/backup-outside"
mkdir -p "$backup_home" "$backup_outside"
printf 'keep me\n' > "$backup_home/.zshrc"
ln -s "$backup_outside" "$backup_home/.dotfiles-backup"
if HOME="$backup_home" "$INSTALL" --skip-brew --skip-oh-my-zsh > "$TEST_ROOT/backup-symlink.out" 2>&1; then
  fail 'installer accepted a symlinked backup root'
fi
grep -qx 'keep me' "$backup_home/.zshrc" \
  || fail 'installer changed a target despite unsafe backup root'
[[ -z "$(find "$backup_outside" -mindepth 1 -print -quit)" ]] \
  || fail 'installer wrote through a symlinked backup root'

# Exercise the Homebrew-managed path without package or network operations.
export TEST_OPERATIONS_LOG="$TEST_ROOT/operations.log"
export TEST_TPM_PREFIX="$TEST_ROOT/tpm-prefix"
export TEST_TMUX_PREFIX="$TEST_ROOT/tmux-prefix"
mkdir -p "$TEST_TPM_PREFIX/share/tpm/bin" "$TEST_TMUX_PREFIX/bin"
cat > "$MOCK_BIN/brew" <<'EOF'
#!/usr/bin/env bash
printf 'brew %s\n' "$*" >> "$TEST_OPERATIONS_LOG"
case "$1" in
  shellenv)
    printf 'export PATH=%q\n' "$PATH"
    ;;
  bundle)
    ;;
  --prefix)
    case "${2:-}" in
      tpm) printf '%s\n' "$TEST_TPM_PREFIX" ;;
      tmux) printf '%s\n' "$TEST_TMUX_PREFIX" ;;
      *) exit 98 ;;
    esac
    ;;
  *) exit 97 ;;
esac
EOF
cat > "$MOCK_BIN/git" <<'EOF'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "$TEST_OPERATIONS_LOG"
if [[ "$*" == 'lfs version' ]]; then
  printf 'git-lfs/3.test\n'
  exit 0
fi
exit 96
EOF
cat > "$TEST_TPM_PREFIX/share/tpm/bin/install_plugins" <<'EOF'
#!/usr/bin/env bash
printf 'tpm install_plugins %s\n' "$TMUX_PLUGIN_MANAGER_PATH" >> "$TEST_OPERATIONS_LOG"
[[ "$TMUX_PLUGIN_MANAGER_PATH" == "$HOME/.config/tmux/plugins/" ]]
EOF
cat > "$TEST_TMUX_PREFIX/bin/tmux" <<'EOF'
#!/usr/bin/env bash
printf 'tmux %s\n' "$*" >> "$TEST_OPERATIONS_LOG"
EOF
chmod +x "$MOCK_BIN/brew" "$MOCK_BIN/git" \
  "$TEST_TPM_PREFIX/share/tpm/bin/install_plugins" "$TEST_TMUX_PREFIX/bin/tmux"
: > "$TEST_OPERATIONS_LOG"
"$INSTALL" --skip-oh-my-zsh > "$TEST_ROOT/brew-managed-run.out"
grep -q '^brew bundle install ' "$TEST_OPERATIONS_LOG" \
  || fail 'Brewfile installation was not invoked'
grep -qx 'git lfs version' "$TEST_OPERATIONS_LOG" \
  || fail 'Git LFS availability was not verified'
grep -qx "tmux start-server ; set-environment -g TMUX_PLUGIN_MANAGER_PATH $HOME/.config/tmux/plugins/" "$TEST_OPERATIONS_LOG" \
  || fail 'tmux server was not configured with the XDG plugin path'
grep -qx "tpm install_plugins $HOME/.config/tmux/plugins/" "$TEST_OPERATIONS_LOG" \
  || fail 'TPM plugin installation did not use the XDG plugin path'
! grep -q 'git lfs install' "$TEST_OPERATIONS_LOG" \
  || fail 'installer mutated global Git LFS configuration'

printf 'install tests passed\n'
