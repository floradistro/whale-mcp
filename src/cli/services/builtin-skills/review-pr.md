---
description: Review a pull request by number
---
Review pull request #$1. Steps:

1. Run `gh pr view $1` to get PR details and description.
2. Run `gh pr diff $1` to get the full diff.
3. Analyze the changes for:
   - Logic errors or bugs
   - Security issues
   - Performance problems
   - Missing tests
   - Style inconsistencies
   - Whether the PR description accurately reflects the changes
4. Provide a structured review with:
   - Summary of what the PR does
   - Issues found (organized by severity)
   - Suggestions for improvement
   - Overall assessment (approve / request changes / needs discussion)

$ARGS
