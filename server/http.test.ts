import { describe, expect, it } from 'vitest'
import { isAllowedOrigin, isBadRequest, parseCommandBody, parseStartBody } from './http.js'
import { GAME_CONFIG } from './config.js'

describe('isAllowedOrigin', () => {
  it('allows the local UI and no-Origin callers', () => {
    expect(isAllowedOrigin(undefined)).toBe(true)
    expect(isAllowedOrigin('http://localhost:3000')).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:3001')).toBe(true)
  })
  it('rejects other sites and ports', () => {
    expect(isAllowedOrigin('https://evil.example')).toBe(false)
    expect(isAllowedOrigin('http://localhost:8080')).toBe(false)
    expect(isAllowedOrigin('http://localhost.evil.example:3000')).toBe(false)
    expect(isAllowedOrigin('null')).toBe(false)
  })
})

describe('parseStartBody', () => {
  it.each(['nato', 'russia', 'china'])('accepts %s as the human faction', (f) => {
    expect(parseStartBody({ humanFaction: f, playerName: 'Aun' })).toEqual({ humanFaction: f, playerName: 'Aun' })
  })

  it.each(['NATO', 'usa', '', 'nato ', null, 42, ['nato'], '__proto__'])('rejects faction %j', (f) => {
    const r = parseStartBody({ humanFaction: f })
    expect(isBadRequest(r) && r.code).toBe('invalid_faction')
  })

  it('defaults a blank name to Commander and trims / caps the name', () => {
    expect(parseStartBody({ humanFaction: 'china', playerName: '   ' })).toMatchObject({ playerName: 'Commander' })
    expect(parseStartBody({ humanFaction: 'china' })).toMatchObject({ playerName: 'Commander' })
    const long = parseStartBody({ humanFaction: 'china', playerName: '  ' + 'x'.repeat(100) })
    expect(!isBadRequest(long) && long.playerName.length).toBe(GAME_CONFIG.maxPlayerNameLength)
  })

  it('keeps HTML-looking names as plain text (the UI renders with textContent)', () => {
    expect(parseStartBody({ humanFaction: 'nato', playerName: '<script>alert(1)</script>' }))
      .toMatchObject({ playerName: '<script>alert(1)</script>'.slice(0, GAME_CONFIG.maxPlayerNameLength) })
  })

  it('rejects a non-string name', () => {
    expect(isBadRequest(parseStartBody({ humanFaction: 'nato', playerName: { a: 1 } }))).toBe(true)
  })
})

describe('parseCommandBody', () => {
  const ok = { gameId: 'g1', turn: 1 }

  it('accepts a command and normalises whitespace', () => {
    expect(parseCommandBody({ ...ok, command: '  Attack \n Ukraine  ' })).toEqual({ ...ok, command: 'Attack Ukraine' })
  })

  it('accepts a quick strategy instead of a command', () => {
    expect(parseCommandBody({ ...ok, quick: 'defensive' })).toEqual({ ...ok, quick: 'defensive' })
    expect(isBadRequest(parseCommandBody({ ...ok, quick: 'nuke-everything' }))).toBe(true)
  })

  it('only passes through gameId, turn and command - never client-supplied state', () => {
    const r = parseCommandBody({ ...ok, command: 'Recruit infantry', humanFaction: 'china', score: 99999, orders: [{ action: 'nuke' }] })
    expect(r).toEqual({ ...ok, command: 'Recruit infantry' })
  })

  it('enforces the command length limit', () => {
    const r = parseCommandBody({ ...ok, command: 'a'.repeat(GAME_CONFIG.maxCommandLength + 1) })
    expect(isBadRequest(r) && r.code).toBe('command_too_long')
    expect(isBadRequest(parseCommandBody({ ...ok, command: 'a'.repeat(GAME_CONFIG.maxCommandLength) }))).toBe(false)
  })

  it.each(['', ' ', 'x', '🍕🍕🍕', '!!!', '...'])('refuses %j without a model call (422, turn not consumed)', (command) => {
    const r = parseCommandBody({ ...ok, command })
    expect(isBadRequest(r) && r.status).toBe(422)
  })

  it('requires a game id and an integer turn', () => {
    expect(isBadRequest(parseCommandBody({ turn: 1, command: 'hold' }))).toBe(true)
    expect(isBadRequest(parseCommandBody({ gameId: 'g', turn: '1', command: 'hold' }))).toBe(true)
    expect(isBadRequest(parseCommandBody({ gameId: 'g', turn: 1.5, command: 'hold' }))).toBe(true)
    expect(isBadRequest(parseCommandBody({ gameId: 'g', turn: 0, command: 'hold' }))).toBe(true)
    expect(isBadRequest(parseCommandBody(null))).toBe(true)
  })
})
