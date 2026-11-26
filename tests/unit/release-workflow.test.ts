import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { tmpDir } from '../support/tmp.js'

interface Step {
  id?: string
  name?: string
  if?: string
  run?: string
}

const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
  on: Record<string, unknown>
  jobs: Record<string, { if?: string; concurrency?: { queue?: string }; steps: Step[] }>
}
const release = workflow.jobs['release']!
const promote = workflow.jobs['promote']!
const sha = 'b'.repeat(40)
const priorSha = 'a'.repeat(40)
const tag = 'v1.6.1'
const sourceDigest = `sha256:${'c'.repeat(64)}`
const otherDigest = `sha256:${'d'.repeat(64)}`

/** Execute the actual workflow shell steps, replacing every external command with a local fixture. */
function runStep(name: string, overrides: Record<string, string> = {}) {
  const step = promote.steps.find((entry) => entry.name === name)
  expect(step?.run, `missing workflow step: ${name}`).toBeDefined()
  const dir = tmpDir('aira-release-test-')
  const files = { output: join(dir, 'output'), calls: join(dir, 'calls') }
  for (const file of Object.values(files)) writeFileSync(file, '')
  writeFileSync(
    join(dir, 'gh'),
    `#!/bin/bash
set -eu
printf 'gh %s\\n' "$*" >> "$CALLS"
case "$1 $2" in
  'release view') printf '%s\\n' "$LATEST_TAG" ;;
  'api repos/TolongLabs/AIRA/commits/'*) printf '%s\\n' "$TAG_SHA" ;;
  'run list')
    if [[ "$CI_RESULT" == pending_once ]]; then
      if [[ $(grep -c '^gh run list' "$CALLS") == 1 ]]; then printf 'pending\\n'; else printf 'success\\n'; fi
    else printf '%s\\n' "$CI_RESULT"; fi ;;
  *) exit 99 ;;
esac
`,
    { mode: 0o700 }
  )
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
set -eu
printf 'docker %s\\n' "$*" >> "$CALLS"
case "$1 $2 $3" in
  'buildx imagetools inspect')
    if [[ "$WAIT_IMAGE" == true && $(grep -c '^docker buildx imagetools inspect' "$CALLS") == 1 ]]; then exit 1; fi
    if [[ "$4" == *:stable && "$BAD_DIGEST" == true ]]; then printf '"%s"\\n' "$OTHER_DIGEST"; else printf '"%s"\\n' "$SOURCE_DIGEST"; fi ;;
  'buildx imagetools create') ;;
  *) exit 99 ;;
esac
`,
    { mode: 0o700 }
  )
  writeFileSync(join(dir, 'sleep'), '#!/bin/bash\nprintf \'sleep %s\\n\' "$*" >> "$CALLS"\n', { mode: 0o700 })
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', step!.run!], {
    encoding: 'utf8',
    timeout: 5000,
    env: {
      PATH: `${dir}:${process.env['PATH']}`,
      GITHUB_EVENT_NAME: 'push',
      GITHUB_SHA: priorSha,
      GITHUB_OUTPUT: files.output,
      CALLS: files.calls,
      GH_REPO: 'TolongLabs/AIRA',
      CREATED_TAG: tag,
      CREATED_SHA: sha,
      LATEST_TAG: tag,
      TAG_SHA: sha,
      RELEASE_SHA: sha,
      TAG: tag,
      CI_RESULT: 'success',
      BAD_DIGEST: 'false',
      SOURCE_DIGEST: sourceDigest,
      OTHER_DIGEST: otherDigest,
      WAIT_IMAGE: 'false',
      ...overrides
    }
  })
  expect(result.error).toBeUndefined()
  return { exit: result.status, output: readFileSync(files.output, 'utf8'), calls: readFileSync(files.calls, 'utf8') }
}

describe('release promotion workflow', () => {
  it('accepts an earlier push run creating a later release and exposes a main-only retry', () => {
    expect(promote.if).not.toContain('github.sha')
    expect(promote.concurrency?.queue).toBe('max')
    expect(workflow.on).toHaveProperty('workflow_dispatch')
    expect(release.if).toContain('refs/heads/main')
    expect(release.steps.find((step) => step.id === 'rp')?.if).toContain("github.event_name == 'push'")
  })

  it('selects the exact published tag SHA on an earlier push and on manual retry', () => {
    for (const event of ['push', 'workflow_dispatch']) {
      const result = runStep('Resolve published release', { GITHUB_EVENT_NAME: event })
      expect(result.exit).toBe(0)
      expect(result.output).toContain(`sha=${sha}\n`)
      expect(result.output).toContain(`tag=${tag}\n`)
      expect(result.calls).toContain(`repos/TolongLabs/AIRA/commits/${tag}`)
      expect(result.output).not.toContain(priorSha)
    }
  })

  it('does not select a superseded automatic release or accept a moved tag', () => {
    const superseded = runStep('Resolve published release', { LATEST_TAG: 'v1.6.2' })
    expect(superseded.exit).toBe(0)
    expect(superseded.output).toBe('')
    expect(runStep('Resolve published release', { TAG_SHA: priorSha }).exit).not.toBe(0)
    expect(runStep('Resolve published release', { LATEST_TAG: 'v1.6.1-rc.1' }).exit).not.toBe(0)
  })

  it('waits for exact release main CI and refuses a failed run', () => {
    const success = runStep("Wait for the exact release commit's CI to pass")
    expect(success.exit).toBe(0)
    expect(success.calls).toContain(`--event push --branch main --commit ${sha}`)
    expect(success.calls).not.toContain(priorSha)
    const pending = runStep("Wait for the exact release commit's CI to pass", { CI_RESULT: 'pending_once' })
    expect(pending.exit).toBe(0)
    expect(pending.calls.match(/gh run list/g)).toHaveLength(2)
    expect(pending.calls).toContain('sleep 30')
    expect(runStep("Wait for the exact release commit's CI to pass", { CI_RESULT: 'failure' }).exit).not.toBe(0)
  })

  it('retags only the verified release SHA and confirms all three manifest digests', () => {
    const result = runStep('Tag the release', { WAIT_IMAGE: 'true' })
    expect(result.calls).toContain('sleep 15')
    expect(result.exit).toBe(0)
    expect(result.calls).toContain(
      `imagetools create --prefer-index=false -t ghcr.io/tolonglabs/aira:${tag} -t ghcr.io/tolonglabs/aira:v1.6 -t ghcr.io/tolonglabs/aira:stable ghcr.io/tolonglabs/aira@${sourceDigest}`
    )
    for (const alias of [tag, 'v1.6', 'stable'])
      expect(result.calls).toContain(`inspect ghcr.io/tolonglabs/aira:${alias}`)
    expect(runStep('Tag the release', { BAD_DIGEST: 'true' }).exit).not.toBe(0)
    const malformed = runStep('Tag the release', { SOURCE_DIGEST: 'unverified' })
    expect(malformed.exit).not.toBe(0)
    expect(malformed.calls).not.toContain('imagetools create')
    const stale = runStep('Tag the release', { LATEST_TAG: 'v1.6.2' })
    expect(stale.exit).toBe(0)
    expect(stale.calls).not.toContain('imagetools create')
    const moved = runStep('Tag the release', { TAG_SHA: priorSha })
    expect(moved.exit).not.toBe(0)
    expect(moved.calls).not.toContain('imagetools create')
  })
})
