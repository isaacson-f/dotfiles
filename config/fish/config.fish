if test -x /opt/homebrew/bin/brew
    eval (/opt/homebrew/bin/brew shellenv)
else if test -x /usr/local/bin/brew
    eval (/usr/local/bin/brew shellenv)
else if test -x /home/linuxbrew/.linuxbrew/bin/brew
    eval (/home/linuxbrew/.linuxbrew/bin/brew shellenv)
else if type -q brew
    eval (brew shellenv)
end

if test -x "$HOME/opt/anaconda3/bin/conda"
    eval "$HOME/opt/anaconda3/bin/conda" "shell.fish" "hook" $argv | source
end

if test "$TERM_PROGRAM" = "kiro"; and type -q kiro
    source (kiro --locate-shell-integration-path fish)
end
