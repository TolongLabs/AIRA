// Validates the pull request header shape against `.github/pull_request_template.md`.
// Run by `.github/workflows/pr-header.yml` on every non-draft pull request to `main`.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type PullRequest = {
  title: string
  author: string
  body: string
  files: string[] | null
}

const BOTS = new Set(['dependabot[bot]', 'github-actions[bot]'])
const RELEASE = /^chore\(main\): release\b/
const GENERATED = /^graphify-out\//
// Agent instructions live under docs/agents/ and root AGENTS.md/CLAUDE.md/GEMINI.md, so they are not exempt prose.
const PROSE = /^(?:docs\/(?!agents\/).*|(?!AGENTS\.md$|CLAUDE\.md$|GEMINI\.md$)[^/]+\.md)$/
const SENSITIVE = /^(?:\.github\/workflows\/|deploy\/|src\/storage\/migrations\/|src\/gateway\/|docs\/trd\/)/
const UI = /^site\/src\//

const FIELDS = ['Review', 'Action needed', 'Not tested', 'Door', 'Blast radius', 'Start at']

const COMMENT = /<!--[\s\S]*?-->/g
const FENCE_LINE = /^\s*(`{3,}|~{3,})(.*)$/
const IMAGE = /!\[[^\]]*\]\([^)\s]+\)|<img\b[^>]*\bsrc=/i
const IMAGE_TAG = /!\[[^\]]*\]\([^)\s]+\)|<img\b[^>]*>/gi
const TABLE = /^\|.*\|[ \t]*\n\|[\s:|-]+\|[ \t]*$/m
const BEFORE_AFTER = /^\|\s*Before\s*\|\s*After(?:&nbsp;)*\s*\|[ \t]*$/im
const NO_VISUAL = /^Visual:\s*none\b(.*)$/im
const ISSUE_LINK = /\b(?:Closes|Fixes|Refs)\s+(?:[\w.-]+\/[\w.-]+)?#\d+/i
const LINK_KEYWORD = /\b(?:Closes|Fixes|Refs)\s+(?:[\w.-]+\/[\w.-]+)?#\d*/gi
const LOCAL_IMAGE = /!\[[^\]]*\]\(\s*<?(?!https?:\/\/)[^)\s>]+|<img\b[^>]*\bsrc=["'](?!https?:\/\/)[^"'\s]+/i

type Section = { heading: string; text: string }

function stripCommentsAndFences(body: string): string {
  const withoutComments = body.replace(/\r\n?/g, '\n').replace(COMMENT, '')
  const lines: string[] = []
  let openFence: { char: string; length: number } | null = null
  for (const line of withoutComments.split('\n')) {
    const fence = FENCE_LINE.exec(line)
    if (fence?.[1]) {
      const marker = fence[1]
      const char = marker[0] ?? ''
      const trailing = fence[2] ?? ''
      if (openFence === null) {
        if (char === '`' && trailing.includes('`')) {
          lines.push(line)
          continue
        }
        openFence = { char, length: marker.length }
        continue
      }
      if (char === openFence.char && marker.length >= openFence.length && trailing.trim() === '') {
        openFence = null
        continue
      }
    }
    if (openFence === null) lines.push(line)
  }
  return lines.join('\n')
}

function sectionsOf(stripped: string): Section[] {
  const sections: Section[] = []
  for (const line of stripped.split('\n')) {
    const heading = /^## (.+?)\s*$/.exec(line)
    if (heading) sections.push({ heading: heading[1] ?? '', text: '' })
    else if (sections.length > 0) sections[sections.length - 1]!.text += `${line}\n`
  }
  return sections
}

function named(section: Section | undefined, heading: string): section is Section {
  return section?.heading.toLowerCase() === heading.toLowerCase()
}

function isExempt({ title, author, files }: PullRequest): boolean {
  if (BOTS.has(author) || RELEASE.test(title)) return true
  const changed = files?.filter((file) => !GENERATED.test(file))
  return changed !== undefined && changed.length > 0 && changed.every((file) => PROSE.test(file))
}

const FIELD_HEADER = /^\|\s*Field\s*\|\s*Answer\s*\|[ \t]*$/i
const FIELD_ROW = /^\|\s*\*\*([^*|]+?)\*\*\s*\|(.*)\|[ \t]*$/
const DELIMITER = /^\|[\s:|-]+\|[ \t]*$/

// Split out the fields table so it does not count as the summary visual.
function splitFields(summary: string): {
  lead: string
  rest: string
  answers: Map<string, string> | null
} {
  const lines = summary.split('\n')
  const header = lines.findIndex((line) => FIELD_HEADER.test(line))
  if (header === -1) return { lead: summary, rest: summary, answers: null }
  const answers = new Map<string, string>()
  let end = header + 1
  if (DELIMITER.test(lines[end] ?? '')) end++
  for (; end < lines.length; end++) {
    const row = FIELD_ROW.exec(lines[end] ?? '')
    if (!row) break
    answers.set((row[1] ?? '').trim().toLowerCase(), (row[2] ?? '').trim())
  }
  return {
    lead: lines.slice(0, header).join('\n'),
    rest: [...lines.slice(0, header), ...lines.slice(end)].join('\n'),
    answers
  }
}

function summaryProblems(text: string, files: string[] | null): string[] {
  const problems: string[] = []
  const { lead, rest: summary, answers } = splitFields(text)
  if (lead.replace(IMAGE_TAG, '').trim() === '') {
    problems.push('write one plain sentence under `## Summary`')
  }

  if (answers === null) {
    problems.push('add the `| Field | Answer |` table under `## Summary`')
  } else {
    for (const field of FIELDS) {
      if (!answers.get(field.toLowerCase())) {
        problems.push(`fill in the \`${field}\` row under \`## Summary\``)
      }
    }
  }

  const rawReview = answers?.get('review') ?? ''
  if (rawReview !== '') {
    const reviewWord = /^([A-Za-z-]+)\b/.exec(rawReview)?.[1]?.toLowerCase()
    if (reviewWord !== 'read' && reviewWord !== 'skim') {
      problems.push('`Review` must start with Read or Skim')
    } else if (reviewWord === 'skim' && files?.some((file) => SENSITIVE.test(file))) {
      problems.push('`Review` must be Read: this touches a contract, migration, gateway, deploy or workflow path')
    }
  }

  const none = NO_VISUAL.exec(summary)
  if (none) {
    if (!/^,\s*\S/.test(none[1] ?? '')) problems.push('write `Visual: none, <reason>`')
    return problems
  }
  if (files?.some((file) => UI.test(file))) {
    if (!BEFORE_AFTER.test(summary) || !IMAGE.test(summary)) {
      problems.push(
        'this changes site UI: add a `| Before | After |` table of images under `## Summary`, or write `Visual: none, <reason>`'
      )
    }
  } else if (!IMAGE.test(summary) && !TABLE.test(summary)) {
    problems.push(
      'add an image or a table under `## Summary`, or write `Visual: none, <reason>`. A code fence does not count'
    )
  }
  return problems
}

/** Validate the pull request header shape; returns an empty list when valid. */
export function checkPrHeader(pr: { title: string; author: string; body: string; files: string[] | null }): string[] {
  if (isExempt(pr)) return []
  const problems: string[] = []
  const stripped = stripCommentsAndFences(pr.body)
  const [summary, whatChanged] = sectionsOf(stripped)

  if (named(summary, 'Summary')) problems.push(...summaryProblems(summary.text, pr.files))
  else problems.push('start the body with `## Summary`')

  if (named(whatChanged, 'What Changed')) {
    const text = whatChanged.text
    if (!ISSUE_LINK.test(text)) problems.push('link the issue under `## What Changed`')
    if (text.replace(LINK_KEYWORD, '').replace(/[\s.,;:()[\]-]+/g, '') === '') {
      problems.push('write what changed under `## What Changed`')
    }
  } else {
    problems.push('follow `## Summary` with `## What Changed`')
  }

  if (/<details\b/i.test(stripped)) problems.push('remove the `<details>` block: nothing collapses')
  if (LOCAL_IMAGE.test(stripped)) {
    problems.push('an image path is still local: upload it with `gh pr create --attach` or `gh pr edit --attach`')
  }
  return problems
}

type PullRequestEvent = {
  pull_request: {
    number: number
    title: string
    body: string | null
    user: { login: string }
  }
}

function main(): void {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) {
    console.error('::error::GITHUB_EVENT_PATH is not set')
    process.exitCode = 1
    return
  }
  const event = JSON.parse(readFileSync(eventPath, 'utf8')) as PullRequestEvent
  const { number, title, body, user } = event.pull_request
  const args = ['pr', 'view', String(number), '--json', 'files']
  if (process.env.GITHUB_REPOSITORY) {
    args.push('--repo', process.env.GITHUB_REPOSITORY)
  }
  const raw = execFileSync('gh', args, { encoding: 'utf8' })
  const parsed = JSON.parse(raw) as { files: Array<{ path: string }> }
  const files = parsed.files.map((file) => file.path)
  const problems = checkPrHeader({
    title,
    author: user.login,
    body: body ?? '',
    files
  })
  if (problems.length === 0) {
    console.log('The pull request header is complete.')
    return
  }
  for (const problem of problems) console.log(`::error::${problem}`)
  process.exitCode = 1
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) main()
