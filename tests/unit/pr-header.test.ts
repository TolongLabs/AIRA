import { describe, expect, it } from 'vitest'
import { checkPrHeader, type PullRequest } from '../../scripts/pr-header.js'

const FULL_BODY = `<!-- template comment -->

## Summary

Added the pull request header check.

| Field | Answer |
| --- | --- |
| **Review** | Skim |
| **Action needed** | None |
| **Not tested** | Live GitHub webhook payload |
| **Door** | two-way |
| **Blast radius** | CI workflow only; no service restart |
| **Start at** | \`scripts/pr-header.ts\` (150 lines) |

![flow](https://example.invalid/header-flow.svg)

## What Changed

Added header validation script and unit tests.

Closes #42

## Why

Reviewers need scope and blast radius at the top.

## Verification

\`bun run test\` passed.

- [x] Tests added or updated
- [ ] Owning \`docs/trd/\` module updated if a contract changed
- [ ] \`docs/DECISIONS.md\` updated if a decision changed
- [x] No private data in the diff
`

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    title: 'ci: enforce pull request header',
    author: 'contributor',
    body: FULL_BODY,
    files: ['src/app.ts'],
    ...overrides
  }
}

describe('checkPrHeader', () => {
  describe('passing cases', () => {
    it('accepts a complete pull request body with an uploaded image', () => {
      expect(checkPrHeader(makePr())).toEqual([])
    })

    it('accepts a results table as the visual and Read review on sensitive paths', () => {
      const body = FULL_BODY.replace('| **Review** | Skim |', '| **Review** | Read — touches gateway |').replace(
        '![flow](https://example.invalid/header-flow.svg)',
        '| Suite | Result |\n| --- | --- |\n| Unit | 12 passed |'
      )
      expect(checkPrHeader(makePr({ body, files: ['src/gateway/server.ts'] }))).toEqual([])
    })

    it('accepts Visual: none with a reason', () => {
      const body = FULL_BODY.replace(
        '![flow](https://example.invalid/header-flow.svg)',
        'Visual: none, pure type cleanup'
      )
      expect(checkPrHeader(makePr({ body }))).toEqual([])
    })

    it('accepts a Before/After image table or Visual: none when site/src/ changes', () => {
      const beforeAfter = [
        '| Before | After |',
        '| --- | --- |',
        '| ![before](https://example.invalid/before.png) | ![after](https://example.invalid/after.png) |'
      ].join('\n')
      const withTable = FULL_BODY.replace('![flow](https://example.invalid/header-flow.svg)', beforeAfter)
      expect(checkPrHeader(makePr({ body: withTable, files: ['site/src/pages/settings.tsx'] }))).toEqual([])

      const withNone = FULL_BODY.replace(
        '![flow](https://example.invalid/header-flow.svg)',
        'Visual: none, state type rename only'
      )
      expect(checkPrHeader(makePr({ body: withNone, files: ['site/src/lib/api.ts'] }))).toEqual([])
    })

    it('exempts docs-only pull requests while ignoring graphify-out/', () => {
      expect(
        checkPrHeader(
          makePr({
            body: '',
            files: [
              'docs/PRD.md',
              'docs/trd/system.md',
              'docs/references/git-workflow.md',
              'README.md',
              'graphify-out/graph.json'
            ]
          })
        )
      ).toEqual([])
    })

    it('exempts release-please and bot pull requests regardless of body', () => {
      expect(checkPrHeader(makePr({ title: 'chore(main): release 0.2.0', body: '' }))).toEqual([])
      expect(checkPrHeader(makePr({ author: 'dependabot[bot]', body: '' }))).toEqual([])
      expect(checkPrHeader(makePr({ author: 'github-actions[bot]', body: '' }))).toEqual([])
    })

    it('strips HTML comments and fenced code before checking, and accepts Fixes or Refs links', () => {
      const body = `${FULL_BODY.replace('Closes #42', 'Fixes org/repo#9')}\n\n\`\`\`markdown\n## Fake Heading\n<details><summary>log</summary></details>\n![local](./local.png)\n\`\`\`\n<!-- <details>ignored</details> ![ignored](./ignored.png) -->\n`
      expect(checkPrHeader(makePr({ body }))).toEqual([])

      const withRefs = FULL_BODY.replace('Closes #42', 'Refs #101')
      expect(checkPrHeader(makePr({ body: withRefs }))).toEqual([])
    })

    it('accepts a valid body when changed files are null', () => {
      expect(checkPrHeader(makePr({ files: null }))).toEqual([])
    })
  })

  describe('failing cases', () => {
    it('does not exempt agent instruction files or root agent entrypoints', () => {
      for (const file of ['docs/agents/coding-guidelines.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
        expect(checkPrHeader(makePr({ body: '', files: [file] })).length).toBeGreaterThan(0)
      }
    })

    it('requires ## Summary as the first section', () => {
      const body = '## What Changed\n\nDid something.\n\nCloses #1\n'
      expect(checkPrHeader(makePr({ body }))).toContain('start the body with `## Summary`')
    })

    it('requires a plain sentence before the fields table under ## Summary', () => {
      const withoutLead = FULL_BODY.replace('Added the pull request header check.\n\n', '')
      expect(checkPrHeader(makePr({ body: withoutLead }))).toContain('write one plain sentence under `## Summary`')

      const imageOnlyLead = FULL_BODY.replace(
        'Added the pull request header check.',
        '![top](https://example.invalid/top.png)'
      )
      expect(checkPrHeader(makePr({ body: imageOnlyLead }))).toContain('write one plain sentence under `## Summary`')
    })

    it('requires the | Field | Answer | table under ## Summary', () => {
      const withoutTable = FULL_BODY.replace(/\| Field \| Answer \|[\s\S]*?\| \*\*Start at\*\*[^\n]*\n/, '')
      expect(checkPrHeader(makePr({ body: withoutTable }))).toContain(
        'add the `| Field | Answer |` table under `## Summary`'
      )
    })

    it('requires every one of the six fields to be filled', () => {
      const fields = [
        ['Review', 'Skim'],
        ['Action needed', 'None'],
        ['Not tested', 'Live GitHub webhook payload'],
        ['Door', 'two-way'],
        ['Blast radius', 'CI workflow only; no service restart'],
        ['Start at', '`scripts/pr-header.ts` (150 lines)']
      ] as const
      for (const [name, value] of fields) {
        const commentedOut = FULL_BODY.replace(`| **${name}** | ${value} |`, `| **${name}** | <!-- fill me --> |`)
        expect(checkPrHeader(makePr({ body: commentedOut }))).toContain(
          `fill in the \`${name}\` row under \`## Summary\``
        )
      }
    })

    it('requires Review to start with Read or Skim', () => {
      for (const bad of ['Quick', 'Readonly', '?']) {
        const body = FULL_BODY.replace('| **Review** | Skim |', `| **Review** | ${bad} |`)
        expect(checkPrHeader(makePr({ body }))).toContain('`Review` must start with Read or Skim')
      }
    })

    it('refuses Skim when a sensitive path changes', () => {
      const sensitivePaths = [
        ['.github/workflows/ci.yml'],
        ['deploy/compose.yml'],
        ['src/storage/migrations/0009_example.sql'],
        ['src/gateway/server.ts'],
        ['src/app.ts', 'docs/trd/system.md']
      ]
      for (const files of sensitivePaths) {
        expect(checkPrHeader(makePr({ files }))).toContain(
          '`Review` must be Read: this touches a contract, migration, gateway, deploy or workflow path'
        )
      }
    })

    it('requires a visual outside fenced code blocks under ## Summary', () => {
      const noVisual = FULL_BODY.replace(
        '![flow](https://example.invalid/header-flow.svg)',
        '```text\n| col |\n| --- |\n| val |\n```\n'
      )
      expect(checkPrHeader(makePr({ body: noVisual }))).toContain(
        'add an image or a table under `## Summary`, or write `Visual: none, <reason>`. A code fence does not count'
      )
    })

    it('requires a reason after Visual: none', () => {
      for (const bad of ['Visual: none', 'Visual: none,   ']) {
        const body = FULL_BODY.replace('![flow](https://example.invalid/header-flow.svg)', bad)
        expect(checkPrHeader(makePr({ body }))).toContain('write `Visual: none, <reason>`')
      }
    })

    it('requires a Before/After image table or Visual: none when site/src/ changes', () => {
      const plainImageProblems = checkPrHeader(makePr({ files: ['site/src/styles.css'] }))
      expect(plainImageProblems).toContain(
        'this changes site UI: add a `| Before | After |` table of images under `## Summary`, or write `Visual: none, <reason>`'
      )

      const textOnlyTable = FULL_BODY.replace(
        '![flow](https://example.invalid/header-flow.svg)',
        '| Before | After |\n| --- | --- |\n| old text | new text |'
      )
      expect(checkPrHeader(makePr({ body: textOnlyTable, files: ['site/src/components/ui.tsx'] }))).toContain(
        'this changes site UI: add a `| Before | After |` table of images under `## Summary`, or write `Visual: none, <reason>`'
      )
    })

    it('requires ## What Changed right after ## Summary', () => {
      const body = FULL_BODY.replace('## What Changed', '## Why')
      expect(checkPrHeader(makePr({ body }))).toContain('follow `## Summary` with `## What Changed`')
    })

    it('requires an issue number in ## What Changed', () => {
      const missingNumber = FULL_BODY.replace('Closes #42', 'Closes #')
      expect(checkPrHeader(makePr({ body: missingNumber }))).toContain('link the issue under `## What Changed`')
    })

    it('requires prose beyond the issue link in ## What Changed', () => {
      const linkOnly = FULL_BODY.replace('Added header validation script and unit tests.\n\nCloses #42', 'Closes #42.')
      expect(checkPrHeader(makePr({ body: linkOnly }))).toContain('write what changed under `## What Changed`')
    })

    it('rejects <details> blocks', () => {
      const body = `${FULL_BODY}\n<details>\n<summary>Output</summary>\nok\n</details>\n`
      expect(checkPrHeader(makePr({ body }))).toContain('remove the `<details>` block: nothing collapses')
    })

    it('rejects local image paths', () => {
      for (const img of ['![x](./a.png)', '![x](a.png)', '<img src="./a.png" alt="x">']) {
        const body = FULL_BODY.replace('![flow](https://example.invalid/header-flow.svg)', img)
        expect(checkPrHeader(makePr({ body }))).toContain(
          'an image path is still local: upload it with `gh pr create --attach` or `gh pr edit --attach`'
        )
      }
    })
  })
})
