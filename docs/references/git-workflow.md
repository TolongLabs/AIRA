# Git Workflow

Every change to this repository travels the same path: a branch, small commits, a pull request, a review, resolved
conversations, a rebase merge, and a deleted branch. Nothing reaches `main` any other way.

Names follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) everywhere they appear — commit
subjects, issue titles, and pull request titles — so that one glance at any of the three tells you what kind of change
it is.

Contents:

1. [The loop](#the-loop)
2. [Issues](#issues)
3. [Naming](#naming)
4. [What enforces what](#what-enforces-what)
5. [Secrets](#secrets)
6. [Setting it up](#setting-it-up)

## The Loop

1. **Branch.** `git switch -c <type>/<short-description>` off an up-to-date `main`.
2. **Commit small.** One reason to change per commit, and every commit builds on its own. A commit that needs the word
   "and" in its subject is two commits.
3. **Push the branch.** `git push -u origin HEAD`. Pushing to `main` is refused by the pre-push hook.
4. **Open a pull request.** `gh pr create --fill-first`, then check the title. Not `--fill`: on a branch with more than
   one commit that takes the title from the branch name, which the title check rejects. `--fill-first` takes it from the
   first commit, which may not describe the whole branch, so pass `--title` when it does not. The body follows
   `.github/pull_request_template.md`, and `scripts/pr-header.ts` checks it.
5. **Review.** No approval is required (see the ruleset below). Review still looks at the diff and at the commit
   history, because the history is what lands.
6. **Resolve.** Every review conversation must be marked resolved before merging.
7. **Merge and delete.** Rebase merge, then the branch deletes itself.

## Issues

Every issue has an assignee. Whoever opens it picks the right person; `.github/workflows/assign-issues.yml` only catches
a miss when an issue opens or reopens unassigned.

## Naming

### Commits

```text
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

The type is one of `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, or `test`. The
scope is an optional noun naming the part of the codebase you touched, in parentheses. The description is a short summary
in the imperative, lower case, with no trailing period.

A breaking change takes a `!` before the colon, and explains itself in the body or in a `BREAKING CHANGE:` footer:

```text
feat(api)!: drop the v1 response envelope

BREAKING CHANGE: responses are now the bare object. Callers reading
`body.data` should read `body` instead.
```

### Branches

`<type>/<short-description>`, using the same types as commits — for example `fix/expired-refresh-tokens` or
`docs/git-workflow`. The branch name is not machine-checked; it is a courtesy to whoever reads the branch list.

### Issues and Pull Requests

Both use the commit format. An issue describes the change you want as though you were committing it:
`fix(auth): expired refresh tokens are accepted`. Neither becomes a commit subject: this repository rebase-merges, so
the commits land exactly as written and the pull request title is discarded. The title is linted anyway, because it is
what the pull request list, the notification, and the reviewer see first.

## What Enforces What

| Where                                 | What it blocks                                                     |
| ------------------------------------- | ------------------------------------------------------------------ |
| The `main` ruleset                    | A merge that skips a step of [the loop](#the-loop)                 |
| `.husky/commit-msg`                   | A commit whose message is not conventional                         |
| `.husky/pre-push`                     | A push straight to the default branch                              |
| `.github/workflows/ci.yml` `check`    | A failing test, a type error, a lint error or an unformatted tree  |
| `.github/workflows/ci.yml` `site`     | A site that does not build                                         |
| `.github/workflows/ci.yml` `scan`     | A secret in the history (gitleaks)                                 |
| `.github/workflows/ci.yml` `image`    | An image that does not build or cannot be pulled anonymously       |
| `.github/workflows/ci.yml` `deploy`   | Nothing; on a push to `main` it deploys, and rolls back on failure |
| `.github/workflows/assign-issues.yml` | An unassigned issue — assigns the author or owner                  |
| `.github/workflows/pr-header.yml`     | A pull request missing its header or visual                        |
| `.github/pull_request_template.md`    | Nothing; it reminds you                                            |
| `.github/ISSUE_TEMPLATE/`             | Blank issues, and titles with no type                              |

The ruleset is what turns the workflows into merge gates. It is a repository setting rather than a file, it covers
`main`, and nobody is on its bypass list, admins included. A pull request merges only with:

- no approval: the maintainers' agents open and merge pull requests from one account, so a required approval would
  stop every merge (owner's decision, 17 Nov 2026);
- every review conversation resolved;
- a rebase merge, the only method it allows, onto a linear history;
- passing **check**, **site**, **scan**, **image**, **images-ok** and **PR header** checks. `deploy` is not
  required: it runs only on a push to `main`.

Commit messages are checked only by the local hook; no workflow lints them or the pull request title.

It also refuses a push straight to `main`, a force push, and deleting the branch.

The local hooks and the workflows share one rule set, `commitlint.config.mjs`, so they cannot drift apart. The hooks are
the fast feedback; the workflows are the part that cannot be skipped with `--no-verify`.

## Secrets

Always store secrets as
[GitHub secrets](https://docs.github.com/en/actions/concepts/security/secrets),
never in the repository: not in a commit, a pull request, an issue, or a workflow file. `.env` stays untracked, and only
`.env.example`, which holds placeholders, is committed. A workflow reads a secret as `${{ secrets.NAME }}`.

## Release Pull Requests

release-please opens and updates the release pull request. A pull request opened with the workflow's own
`GITHUB_TOKEN` starts no workflow, so its required checks never run and it cannot merge. `release.yml` therefore mints a
token from the TolongLabs release GitHub App (`actions/create-github-app-token`) and gives it to release-please. The
App's id is the repository variable `RELEASE_APP_ID`, and its private key is the secret `RELEASE_APP_PRIVATE_KEY`. With
either unset, the workflow falls back to `GITHUB_TOKEN`, and a user must push one empty commit to the release branch to
start the checks.

The App needs, on this repository only: contents read and write, pull requests read and write, issues read and write.

The ruleset sets `require_extra_approval_for_unattributed_changes` to `false`. A release pull request's commits come
from a bot, not a user, and with the setting on it needs an approval no agent account can give (owner's decision, 18 Nov
2026).

## Setting It Up

Local hooks install themselves:

```sh
bun install
```

The knowledge graph in `graphify-out/` is refreshed deliberately rather than on every commit:

```sh
bun run graph
```

Committing no longer needs [graphify](https://github.com/graphify-labs/graphify), but querying the graph does, and
`bun install` does not provide it. Install it once:

```sh
uv tool install graphifyy
```

The merge settings are applied once, by someone with admin on the repository. They make rebase the only merge method and
delete branches after merge:

```sh
gh api -X PATCH 'repos/TolongLabs/AIRA' --silent \
  -F delete_branch_on_merge=true \
  -F allow_auto_merge=true \
  -F allow_rebase_merge=true \
  -F allow_squash_merge=false \
  -F allow_merge_commit=false
```

The ruleset on `main` is created the same way, once. The integration id `15368` is GitHub Actions, the app that reports
every required check:

```sh
gh api -X POST 'repos/TolongLabs/AIRA/rulesets' --silent --input - <<'EOF'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] }
  },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "require_extra_approval_for_unattributed_changes": false,
        "allowed_merge_methods": ["rebase"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "check", "integration_id": 15368 },
          { "context": "site", "integration_id": 15368 },
          { "context": "scan", "integration_id": 15368 },
          { "context": "image", "integration_id": 15368 },
          { "context": "images-ok", "integration_id": 15368 },
          { "context": "PR header", "integration_id": 15368 }
        ]
      }
    }
  ]
}
EOF
```

To change it later, send the same body with `PUT` to `repos/TolongLabs/AIRA/rulesets/<id>`, taking the id from
`gh api 'repos/TolongLabs/AIRA/rulesets'`, rather than creating a second one.
