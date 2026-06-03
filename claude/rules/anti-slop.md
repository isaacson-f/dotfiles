# Anti-Slop Guidelines

## Comments

- Prefer well-named functions and variables over comments.
- If a comment is needed, keep it to one line max (except for tools, these need to be specific).
- Never write comments that restate what the code obviously does.
- Don't skip out on type checking through comments.

## Style

- No emojis anywhere in code, comments, or output.
- No excessive blank lines or decorative separators.

## Logging

- Only log critical errors and important state changes.
- No debug logging in production code.
- No verbose "Starting X..." / "Finished X" log spam.

## Over-Engineering

- Don't add features, refactor code, or make "improvements" beyond what was asked.
- A bug fix doesn't need surrounding code cleaned up.
- A simple feature doesn't need extra configurability.
- Don't create abstractions for things that are only used once.

## Backwards Compatibility

- Don't preserve backwards compatibility unless explicitly requested.
- Rewriting and replacing is preferred over shimming old behavior.
- Don't add deprecation warnings for code you're changing - just change it.
- Don't keep old function signatures "just in case".

## Defensive Coding

- Don't add error handling for scenarios that can't happen.
- Trust internal code and framework guarantees.
- Only validate at system boundaries (user input, external APIs).

## Unnecessary Abstractions

- Don't create helpers, utilities, or wrapper functions for one-time operations.
- Don't extract constants for values used once.
- Don't create config options for things that won't change.
- Don't design for hypothetical future requirements.
