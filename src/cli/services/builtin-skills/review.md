---
description: Review staged and unstaged changes for issues
---
Review the current uncommitted changes for potential issues. Steps:

1. Run `git diff` and `git diff --staged` to see all changes.
2. For each changed file, analyze:
   - Logic errors or bugs
   - Security issues (injection, XSS, hardcoded secrets)
   - Performance problems
   - Missing error handling
   - Style inconsistencies
3. Report findings organized by severity (errors > warnings > suggestions).
4. If no issues found, confirm the changes look good.

Be specific — reference file names and line numbers.

$ARGS
