import { describe, expect, it } from 'vitest'
import { insertTemplate } from './prompt.js'

describe('insertTemplate', () => {
  it('fills an empty box', () => {
    expect(insertTemplate('', 'Attack the weakest nearby enemy territory.', 500)).toEqual({
      text: 'Attack the weakest nearby enemy territory.',
      mode: 'set',
    })
    expect(insertTemplate('   \n', 'Recruit more infantry.', 500).mode).toBe('set')
  })

  it('appends to what the player already wrote, as a new sentence', () => {
    expect(insertTemplate('Attack the weakest nearby enemy territory.', 'Recruit infantry if I can afford it.', 500).text)
      .toBe('Attack the weakest nearby enemy territory. Recruit infantry if I can afford it.')
    expect(insertTemplate('take ukraine', 'Fortify Western Europe.', 500).text).toBe('take ukraine. Fortify Western Europe.')
  })

  it('does not duplicate an example that is already there', () => {
    const r = insertTemplate('Fortify Western Europe. Research economy.', 'Fortify Western Europe.', 500)
    expect(r).toEqual({ text: 'Fortify Western Europe. Research economy.', mode: 'unchanged' })
  })

  it('replaces instead of overflowing the length limit', () => {
    const long = 'x'.repeat(480) + '.'
    expect(insertTemplate(long, 'Recruit more infantry.', 500)).toEqual({ text: 'Recruit more infantry.', mode: 'replace' })
  })

  it('keeps a hand-edited sentence intact when appending', () => {
    const edited = 'Attack Ukraine with my armor from Poland!'
    expect(insertTemplate(edited, 'Research military technology.', 500).text).toBe(`${edited} Research military technology.`)
  })
})
