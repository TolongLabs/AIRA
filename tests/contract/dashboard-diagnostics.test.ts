import { describe, expect, it } from 'vitest'
import {
  createDashboardDiagnostics,
  normalizeBuildId,
  normalizeReason,
  normalizeRoute,
  normalizeStatus
} from '../../src/api/dashboard-diagnostics.js'
import type { Logger } from '../../src/records/logger.js'

interface LoggedCall {
  level: string
  event: string
  fields: Record<string, unknown>
}

function makeFakeLogger() {
  const calls: LoggedCall[] = []
  let childCalls = 0
  const record =
    (level: string) =>
    (event: string, fields: Record<string, unknown> = {}) => {
      calls.push({ level, event, fields: { ...fields } })
    }
  const inner: Logger = {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    child: () => {
      childCalls += 1
      return inner
    }
  }
  const logger: Logger = {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    child: () => {
      childCalls += 1
      return inner
    }
  }
  return { logger, calls, childCalls: () => childCalls }
}

function makeFakeClock(startIso = '2026-01-01T00:00:00.000Z') {
  let ms = Date.parse(startIso)
  return {
    now: () => new Date(ms),
    advance: (deltaMs: number) => {
      ms += deltaMs
    }
  }
}

const ALLOWED_KEYS = ['at', 'buildId', 'latencyMs', 'method', 'reason', 'requestId', 'route', 'status'].sort()

describe('dashboard diagnostics', () => {
  it('emits one redacted event with latency, timestamp and status through a logger child', () => {
    const fake = makeFakeLogger()
    const clock = makeFakeClock()
    const diagnostics = createDashboardDiagnostics({ logger: fake.logger, buildId: 'test-build-1', now: clock.now })
    const active = diagnostics.begin('health', 'GET')
    clock.advance(42)
    diagnostics.finish(active, { status: 200, reason: 'ok' })

    expect(fake.childCalls()).toBeGreaterThanOrEqual(1)
    expect(fake.calls).toHaveLength(1)
    const call = fake.calls[0] as LoggedCall
    expect(call.event).toBe('dashboard.request')
    expect(call.level).toBe('info')
    expect(Object.keys(call.fields).sort()).toEqual(ALLOWED_KEYS)
    expect(call.fields).toMatchObject({
      buildId: 'test-build-1',
      route: 'health',
      method: 'GET',
      status: 200,
      reason: 'ok',
      latencyMs: 42,
      at: '2026-01-01T00:00:00.000Z'
    })
    expect(typeof call.fields['requestId']).toBe('string')
    expect(JSON.stringify(call.fields)).not.toContain('http')
  })

  it('generates one unique request id per request', () => {
    const fake = makeFakeLogger()
    const clock = makeFakeClock()
    const diagnostics = createDashboardDiagnostics({ logger: fake.logger, buildId: 'b1', now: clock.now })
    const first = diagnostics.begin('chats', 'GET')
    const second = diagnostics.begin('chats', 'GET')
    expect(first.requestId).toMatch(/^[0-9a-f-]{8,64}$/i)
    expect(second.requestId).toMatch(/^[0-9a-f-]{8,64}$/i)
    expect(first.requestId).not.toBe(second.requestId)
  })

  it('validates the build id and never logs the raw value', () => {
    expect(normalizeBuildId('valid-build_1.2')).toBe('valid-build_1.2')
    expect(normalizeBuildId('has space')).toBe('unknown')
    expect(normalizeBuildId('')).toBe('unknown')
    expect(normalizeBuildId(undefined)).toBe('unknown')

    const fake = makeFakeLogger()
    const clock = makeFakeClock()
    const diagnostics = createDashboardDiagnostics({
      logger: fake.logger,
      buildId: 'bad id with spaces',
      now: clock.now
    })
    diagnostics.finish(diagnostics.begin('tools', 'GET'), { status: 200, reason: 'ok' })
    expect(fake.calls[0]?.fields['buildId']).toBe('unknown')
    expect(JSON.stringify(fake.calls)).not.toContain('bad id')
  })

  it('bounds volume per interval and counts dropped events', () => {
    const fake = makeFakeLogger()
    const clock = makeFakeClock()
    const diagnostics = createDashboardDiagnostics({
      logger: fake.logger,
      buildId: 'b1',
      now: clock.now,
      maxEventsPerInterval: 2,
      intervalMs: 1000
    })
    for (const route of ['health', 'chats', 'tools'] as const) {
      diagnostics.finish(diagnostics.begin(route, 'GET'), { status: 200, reason: 'ok' })
    }
    expect(fake.calls).toHaveLength(2)
    expect(diagnostics.stats()).toEqual({ emitted: 2, dropped: 1 })

    clock.advance(1000)
    diagnostics.finish(diagnostics.begin('memory', 'GET'), { status: 200, reason: 'ok' })
    expect(fake.calls).toHaveLength(3)
    expect(diagnostics.stats()).toEqual({ emitted: 3, dropped: 1 })
  })

  it('normalizes unknown routes, reasons and statuses to safe fixed values', () => {
    expect(normalizeRoute('nope')).toBe('unknown')
    expect(normalizeReason('nope')).toBe('unknown')
    expect(normalizeStatus(99)).toBe(500)
    expect(normalizeStatus('200')).toBe(500)

    const fake = makeFakeLogger()
    const clock = makeFakeClock()
    const diagnostics = createDashboardDiagnostics({ logger: fake.logger, buildId: 'b1', now: clock.now })
    const active = diagnostics.begin('nope' as unknown as 'health', 'GET')
    diagnostics.finish(active, { status: 99, reason: 'nope' as unknown as 'ok' })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.fields).toMatchObject({ route: 'unknown', status: 500, reason: 'unknown' })
    expect(fake.calls[0]?.level).toBe('error')
  })
})
