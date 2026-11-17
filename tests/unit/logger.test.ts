import { describe, expect, it } from 'vitest'
import { type LogLevel, createLogger } from '../../src/records/logger.js'
import { type RedactorSecrets, createRedactor, secretsFromEnv, shapeOf } from '../../src/records/redact.js'

function capture(level: LogLevel = 'debug', secrets: RedactorSecrets = []) {
  const lines: Record<string, unknown>[] = []
  const logger = createLogger({
    level,
    module: 'test',
    redactor: createRedactor({ secrets }),
    sink: (line) => lines.push(JSON.parse(line)),
    now: () => new Date('2026-01-02T03:04:05.000Z')
  })
  return { logger, lines }
}

describe('logger', () => {
  it('writes one JSON line with time, level, module, event and the turn id', () => {
    const { logger, lines } = capture()
    logger.child({ turnId: 't-1', module: 'turn' }).info('turn.admitted', { stageMs: 12 })
    expect(lines).toEqual([
      {
        time: '2026-01-02T03:04:05.000Z',
        level: 'info',
        module: 'turn',
        event: 'turn.admitted',
        turn_id: 't-1',
        stageMs: 12
      }
    ])
  })

  it('carries a job id for background work', () => {
    const { logger, lines } = capture()
    logger.child({ jobId: 'j-9' }).warn('job.retry')
    expect(lines[0]).toMatchObject({ job_id: 'j-9', level: 'warn' })
  })

  it('normalises legacy id fields without exposing duplicate aliases', () => {
    const { logger, lines } = capture()
    logger.warn('tool.failed', { turnId: 't-test' })
    logger.warn('memory.failed', { job: 'j-test' })
    expect(lines[0]).toMatchObject({ turn_id: 't-test' })
    expect(lines[0]).not.toHaveProperty('turnId')
    expect(lines[1]).toMatchObject({ job_id: 'j-test' })
    expect(lines[1]).not.toHaveProperty('job')
  })

  it('drops lines below the minimum level', () => {
    const { logger, lines } = capture('warn')
    logger.info('quiet')
    logger.debug('quiet')
    logger.warn('heard')
    logger.error('heard')
    expect(lines.map((line) => line['level'])).toEqual(['warn', 'error'])
  })

  it('does not lose an error passed to it', () => {
    const { logger, lines } = capture()
    const cause = new TypeError('inner fault')
    const error = Object.assign(new Error('outer fault', { cause }), { code: 'SQLITE_FULL' })
    logger.error('storage.write_failed', { error })
    const logged = lines[0]?.['error'] as Record<string, unknown>
    expect(logged['name']).toBe('Error')
    expect(logged['message']).toBe('outer fault')
    expect(logged['code']).toBe('SQLITE_FULL')
    expect(String(logged['stack'])).toContain('outer fault')
    expect(logged['cause']).toMatchObject({ name: 'TypeError', message: 'inner fault' })
  })

  it('cannot let a field replace a reserved key', () => {
    const { logger, lines } = capture()
    logger.info('real.event', { event: 'forged', level: 'debug', module: 'forged' })
    expect(lines[0]).toMatchObject({ event: 'real.event', level: 'info', module: 'test' })
  })

  it('survives a circular field', () => {
    const { logger, lines } = capture()
    const loop: Record<string, unknown> = { name: 'loop' }
    loop['self'] = loop
    logger.info('loop', { loop })
    expect(lines[0]?.['loop']).toEqual({ name: 'loop', self: '[circular]' })
  })
})

describe('redaction', () => {
  it('masks any value read from the environment file, wherever it appears', () => {
    const fake = ['invented', 'value', 'for', 'tests'].join('-')
    const secrets = secretsFromEnv(['MODEL_KEY', 'MISSING'], { MODEL_KEY: fake })
    const { logger, lines } = capture('debug', secrets)
    logger.error('model.auth', {
      header: `Bearer ${fake}`,
      error: new Error(`401 for ${fake}`)
    })
    const text = JSON.stringify(lines[0])
    expect(text).not.toContain(fake)
    expect(text).toContain('[secret]')
  })

  it('masks a 4-character secret', () => {
    const secret = 'abcd'
    const secrets = secretsFromEnv(['SHORT_KEY'], { SHORT_KEY: secret })
    const redactor = createRedactor({ secrets })
    expect(redactor.weak).toEqual([])
    expect(redactor.scrub(`token ${secret} here`)).toBe('token [secret] here')
    expect(createRedactor({ secrets: ['ecre', 'longer-secret'] }).scrub('longer-secret and ecre')).toBe(
      '[secret] and [secret]'
    )

    const { logger, lines } = capture('debug', secrets)
    logger.error('model.auth', { header: `Bearer ${secret}` })
    const text = JSON.stringify(lines[0])
    expect(text).not.toContain(secret)
    expect(text).toContain('[secret]')
  })

  it('does not mask a 3-character secret and reports its key name, never its value', () => {
    const value = 'xyz'
    const secrets = secretsFromEnv(['WEAK_KEY', 'EMPTY_KEY', 'MISSING_KEY'], { WEAK_KEY: value, EMPTY_KEY: '' })
    const redactor = createRedactor({ secrets })
    expect(redactor.scrub(`word ${value} stays`)).toBe(`word ${value} stays`)
    expect(redactor.weak).toEqual(['WEAK_KEY'])
    expect(redactor.weak).not.toContain(value)
  })

  it('replaces WhatsApp ids and phone numbers in free text with hashes', () => {
    const { logger, lines } = capture()
    logger.info('gateway.request', {
      chat: '000000000000000000@g.us',
      sender: '00000000000:12@s.whatsapp.net',
      note: 'call +00 000-000 0000 back'
    })
    const text = JSON.stringify(lines[0])
    expect(text).not.toMatch(/@g\.us|@s\.whatsapp\.net|000-000/)
    expect(lines[0]?.['chat']).toMatch(/^h:[0-9a-f]{12}$/)
  })

  it('hashes are stable, differ by value and change with the salt', () => {
    const plain = createRedactor()
    const salted = createRedactor({ salt: 'pepper' })
    expect(plain.hash('alice')).toBe(plain.hash('alice'))
    expect(plain.hash('alice')).not.toBe(plain.hash('bob'))
    expect(plain.hash('alice')).not.toBe(salted.hash('alice'))
  })

  it('leaves ordinary numbers and timestamps alone', () => {
    const { scrub } = createRedactor()
    expect(scrub('took 1500 ms at 2026-01-02T03:04:05.000Z, 12.5 usd')).toBe(
      'took 1500 ms at 2026-01-02T03:04:05.000Z, 12.5 usd'
    )
  })

  it('describes tool arguments by shape, not by value', () => {
    const shape = shapeOf({ text: 'private words', when: 1800, tags: ['a'], nested: { on: true, none: null } })
    expect(shape).toEqual({ text: 'string', when: 'number', tags: ['string'], nested: { on: 'boolean', none: 'null' } })
    expect(JSON.stringify(shape)).not.toContain('private words')
  })
})
