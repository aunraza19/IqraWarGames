/**
 * How an Action Assistant example is put into the orders box. Pure, so it is
 * unit-tested without a browser. Inserting never submits anything.
 *
 *   empty box            -> the example replaces it
 *   example already in   -> unchanged (no duplicate sentences)
 *   other text           -> appended as the next sentence, so a turn can be
 *                           composed from several examples
 *   would exceed the cap -> the example replaces the text (predictable, never truncated)
 */
export interface Insertion {
  text: string
  mode: 'set' | 'append' | 'unchanged' | 'replace'
}

export function insertTemplate(current: string, template: string, maxLength: number): Insertion {
  const cur = current.trim()
  const tpl = template.trim()
  if (!cur) return { text: tpl, mode: 'set' }
  if (cur.includes(tpl)) return { text: current, mode: 'unchanged' }
  const joined = `${/[.!?]$/.test(cur) ? cur : `${cur}.`} ${tpl}`
  if (joined.length <= maxLength) return { text: joined, mode: 'append' }
  return { text: tpl.slice(0, maxLength), mode: 'replace' }
}
