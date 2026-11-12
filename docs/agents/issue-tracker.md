# Issue tracker: GitHub

Issues and specs for this repo live in GitHub Issues at `rotimi-babalola/news-intelligenz`. Use the `gh` CLI from this clone.

## Conventions

- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --comments` and fetch labels.
- List: `gh issue list --state open --json number,title,body,labels,comments` with appropriate label and state filters.
- Comment: `gh issue comment <number> --body-file <file>`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The map is one issue; tickets are child issues.

- Map: an issue labelled `wayfinder:map` with Notes, Decisions-so-far, and Fog in its body.
- Child: link it as a GitHub sub-issue. If sub-issues are unavailable, add it to the map’s task list and put `Part of #<map>` in the child body. Use a `wayfinder:<type>` label.
- Blocking: use GitHub’s native issue dependencies. If unavailable, use a `Blocked by: #<n>` line in the child body.
- Frontier: take the first open, unassigned, unblocked child in map order.
- Claim: `gh issue edit <n> --add-assignee @me`.
- Resolve: comment with the answer, close the child, then add its context pointer to the map.
