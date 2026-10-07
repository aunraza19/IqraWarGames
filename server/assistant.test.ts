/**
 * Action Assistant: catalogue completeness, availability, lock reasons,
 * suggestions and the nuclear progression. Pure functions over game state -
 * no provider, no model calls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTION_HELP, CATEGORY_ORDER, MAX_SUGGESTIONS, STRATEGY_IDEAS, buildActionAssistant, getSuggestedActions, type ActionStatus } from './assistant.js'
import { ORDER_ACTIONS } from './orders.js'
import { orderSchema } from './ai.js'
import { GameEngine } from './engine.js'

let engine: GameEngine

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  engine = new GameEngine()
  engine.reset()
})

const assist = (fid: string) => buildActionAssistant(engine.state, fid)
const status = (fid: string, action: string) => assist(fid).actions.find((a) => a.action === action)!
const allTemplates = (s: ActionStatus) => [...s.templates, ...s.options.map((o) => o.template)]

describe('catalogue matches the engine', () => {
  it('has help for exactly the actions the engine resolves - nothing missing, nothing invented', () => {
    expect(Object.keys(ACTION_HELP).sort()).toEqual([...ORDER_ACTIONS].sort())
  })

  it('every advertised action is one the resolver implements and the interpreter schema can express', () => {
    const resolve = (engine as unknown as { resolveOrder: (f: string, o: unknown) => { description: string } }).resolveOrder.bind(engine)
    const schema = orderSchema({ units: ['u'], territories: ['t'], factions: ['f'] }) as { anyOf: { properties: { action: { enum: string[] } } }[] }
    const schemaActions = schema.anyOf.flatMap((v) => v.properties.action.enum)
    for (const action of Object.keys(ACTION_HELP)) {
      expect(resolve('nato', { action }).description, action).not.toMatch(/unknown action/)
      expect(schemaActions, action).toContain(action)
    }
    expect(resolve('nato', { action: 'sabotage' }).description).toMatch(/unknown action/) // tech-tree text only
  })

  it('every action has a label, an icon, a one-sentence description, a category and example prompts', () => {
    for (const [action, help] of Object.entries(ACTION_HELP)) {
      expect(help.label, action).toBeTruthy()
      expect(help.icon, action).toBeTruthy()
      expect(CATEGORY_ORDER).toContain(help.category)
      expect(help.description.length, action).toBeLessThan(160)
      expect(help.templates.length, action).toBeGreaterThan(0)
    }
  })

  it.each(['nato', 'russia', 'china'])('renders the full catalogue for %s with display names only - no internal ids', (fid) => {
    const a = assist(fid)
    expect(a.actions.map((s) => s.action)).toEqual([...ORDER_ACTIONS])
    const territoryIds = Object.keys(engine.state.map.territories)
    for (const s of a.actions) {
      for (const t of allTemplates(s)) {
        expect(t, `${fid}/${s.action}`).not.toMatch(/\b(nato|russia|china)-(inf|arm|art|merc)-\d+/)
        for (const id of territoryIds.filter((i) => i.includes('_'))) expect(t).not.toContain(id)
      }
      if (!s.available) expect(s.reason, `${fid}/${s.action}`).toBeTruthy()
    }
  })

  it('only nuclear actions are in the advanced group', () => {
    expect(Object.entries(ACTION_HELP).filter(([, h]) => h.advanced).map(([a]) => a).sort()).toEqual(['build_nuke', 'nuke'])
  })
})

describe('availability comes from the rules', () => {
  it('a contextual attack names a target the player can legally attack', () => {
    const attack = status('nato', 'attack')
    expect(attack.available).toBe(true)
    const named = Object.values(engine.state.map.territories).find((t) => attack.templates[0].includes(t.name))!
    expect(named.owner).not.toBe('nato')
  })

  it('explains each lock with the rule that blocks it', () => {
    const nato = engine.state.factions.nato
    nato.resources = { gold: 0, food: 0, iron: 0, influence: 0, knowledge: 0, uranium: 0 }
    nato.nukes = 0
    nato.tech.nuclear = 0
    expect(status('nato', 'fortify')).toMatchObject({ available: false, reason: 'Needs 2 iron (you have 0).' })
    expect(status('nato', 'recruit')).toMatchObject({ available: false })
    expect(status('nato', 'recruit').reason).toMatch(/^Not enough resources - infantry costs 2 gold \+ 1 iron/)
    expect(status('nato', 'research').reason).toMatch(/^Not enough knowledge - the cheapest research needs 5 \(you have 0\)/)
    expect(status('nato', 'hire_mercenary').reason).toBe('Costs 5 gold (you have 0).')
    expect(status('nato', 'spy').reason).toBe('Costs 1 influence (you have 0).')
    expect(status('nato', 'trade').reason).toBe('You have no resources to give.')
    expect(status('nato', 'build_nuke').reason).toBe('Research nuclear technology first.')
    expect(status('nato', 'nuke').reason).toBe('Research nuclear technology, then build a warhead.')
    expect(status('nato', 'break_alliance').reason).toBe('You have no alliance to break.')
    expect(status('nato', 'message').available).toBe(true)
  })

  it('locks unit types and tech tracks individually', () => {
    const recruit = status('china', 'recruit') // China: military tech 1
    expect(recruit.options.map((o) => [o.label, o.available, o.reason])).toEqual([
      ['Infantry', true, undefined],
      ['Armor', true, undefined],
      ['Artillery', false, 'Needs military tech 2.'],
    ])
    engine.state.factions.nato.tech.economic = 3
    const econ = status('nato', 'research').options.find((o) => o.label.startsWith('Economic'))!
    expect(econ).toMatchObject({ available: false, reason: 'Already at maximum level.' })
  })

  it('attack and move lock when a faction has no units', () => {
    engine.state.factions.russia.units = []
    expect(status('russia', 'attack')).toMatchObject({ available: false, reason: 'You have no units left.' })
    expect(status('russia', 'move')).toMatchObject({ available: false, reason: 'You have no units left.' })
  })

  it('oathbreakers are told why they cannot propose alliances', () => {
    engine.state.factions.china.oathbreaker = true
    expect(status('china', 'diplomacy')).toMatchObject({ available: false, reason: 'Oathbreakers can never form alliances.' })
  })

  it('nuclear progression: locked -> research -> build warhead -> explicit launch', () => {
    const russia = engine.state.factions.russia
    russia.nukes = 0
    russia.tech.nuclear = 0
    russia.resources = { gold: 40, food: 40, iron: 40, influence: 10, knowledge: 20, uranium: 20 }
    expect(status('russia', 'build_nuke')).toMatchObject({ available: false, reason: 'Research nuclear technology first.' })
    expect(status('russia', 'nuke').available).toBe(false)
    expect(status('russia', 'research').options.find((o) => o.label === 'Nuclear 1')!.available).toBe(true)

    engine.playOrders({ russia: [{ action: 'research', tech: 'nuclear' }] })
    expect(russia.tech.nuclear).toBe(1)
    expect(status('russia', 'build_nuke').available).toBe(true)
    expect(status('russia', 'nuke')).toMatchObject({ available: false, reason: 'You have no warheads - build one first.' })

    engine.playOrders({ russia: [{ action: 'build_nuke' }] })
    expect(russia.nukes).toBe(1)
    const launch = status('russia', 'nuke')
    expect(launch.available).toBe(true)
    expect(launch.templates[0]).toMatch(/^Launch a nuclear strike on /)
    expect(assist('russia').suggested).not.toContain('nuke')
  })
})

describe('suggestions', () => {
  it.each(['nato', 'russia', 'china'])(`%s gets 4-${MAX_SUGGESTIONS} available, non-nuclear suggestions`, (fid) => {
    const a = assist(fid)
    expect(a.suggested.length).toBeGreaterThanOrEqual(4)
    expect(a.suggested.length).toBeLessThanOrEqual(MAX_SUGGESTIONS)
    for (const action of a.suggested) {
      const s = a.actions.find((x) => x.action === action)!
      expect(s.available).toBe(true)
      expect(s.advanced).toBe(false)
    }
    expect(a.suggested).not.toContain('nuke')
    expect(a.suggested).not.toContain('build_nuke')
  })

  it('never suggests a nuke, even when it is the only thing left to do', () => {
    const statuses = Object.keys(ACTION_HELP).map((action) => ({ action, available: action === 'nuke' || action === 'build_nuke', advanced: !!ACTION_HELP[action as keyof typeof ACTION_HELP].advanced })) as ActionStatus[]
    expect(getSuggestedActions(statuses)).toEqual([])
  })

  it('leaves out actions that are not available right now', () => {
    engine.state.factions.nato.resources.iron = 0
    engine.state.factions.nato.resources.gold = 0
    const a = assist('nato')
    expect(a.suggested).not.toContain('fortify')
    expect(a.suggested).not.toContain('recruit')
  })

  it('strategy ideas are plain-English multi-action prompts that never ask for nuclear weapons', () => {
    expect(STRATEGY_IDEAS.length).toBeGreaterThanOrEqual(4)
    for (const s of STRATEGY_IDEAS) expect(s.template).not.toMatch(/nucle|nuke|warhead/i)
    for (const help of Object.values(ACTION_HELP).filter((h) => !h.advanced)) {
      for (const t of help.templates) expect(t).not.toMatch(/nucle|nuke|warhead/i)
    }
  })
})
