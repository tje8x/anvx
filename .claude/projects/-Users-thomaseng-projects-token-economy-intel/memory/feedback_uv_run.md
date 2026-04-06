---
name: Use uv run python not bare python
description: Always use 'uv run python' to execute Python in this project — bare python/python3 are intercepted by pyenv and use wrong version
type: feedback
---

Always use `uv run python` for ALL Python execution in this project. Never use bare `python` or `python3` commands.

**Why:** pyenv intercepts bare python/python3 and defaults to 3.11.9, but this project requires 3.12+. `uv run python` correctly resolves to the project's Python version.

**How to apply:** Any time you need to run Python code (tests, syntax checks, one-off scripts, verification commands), use `uv run python`. This applies to terminal commands only — don't change shebang lines or import statements.
