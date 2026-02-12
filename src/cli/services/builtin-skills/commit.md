---
description: Stage changes, draft commit message, create commit
---
Create a git commit for the current changes. Follow these steps:

1. Run `git status` to see all modified and untracked files.
2. Run `git diff` to see staged and unstaged changes.
3. Run `git log --oneline -5` to see recent commit style.
4. Analyze the changes and draft a concise commit message that:
   - Summarizes the nature of changes (feature, fix, refactor, etc.)
   - Focuses on "why" not "what"
   - Follows the repository's existing commit message style
5. Stage relevant files (prefer specific files over `git add -A`).
6. Create the commit. Never skip hooks.
7. Show the result with `git log --oneline -1`.

Do NOT push to remote. Do NOT commit files that look like secrets (.env, credentials, etc.).

$ARGS
