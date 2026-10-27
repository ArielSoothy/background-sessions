import { expect, test } from 'claude-code/testing'
import { contextDisplay, displayName, formatAge, groupRows, LEGEND, legendLine, paneLines, rowStatus, stateDisplay, STATUS_COLOR } from '../hooks/board'
import { cases } from './fixtures/status-cases'
import type { SessionRow, Status } from '../types'
const row = (id: string, projectId: string, lastWorkedAt: number): SessionRow => ({
  id, job: id, name: id, state: 'working',
  projectId, projectName: projectId, projectSource: 'cwd',
  startedAt: 1000, lastWorkedAt, model: 'claude-opus-5-5', tokens: 262521,
  window: null, percent: null, contextSource: 'reported',
})
test('projects are contiguous, ordered by newest activity; rows newest first', () => {
  expect(groupRows([row('a1','a',4), row('b1','b',8), row('a2','a',10)]).map(x => x.id)).toEqual(['a2','a1','b1'])
})
test('age boundaries, missing dates and clock skew stay readable', () => {
  expect([null,-1000,0,60000,3599999,3600000,86400000].map(formatAge)).toEqual(['-','now','now','1m','59m','1h','1d'])
})

// The five meanings that used to collapse into "done".
test('reply finished: a background job in state done is waiting for you, not closed', () => {
  expect(rowStatus('done', 0, 30, false)).toBe('yours')
  expect(stateDisplay('yours')).toEqual({text:'! YOU',color:'yellow',bold:true})
})
test('task completed: an explicit done marker closes the session even while its process idles', () => {
  expect(rowStatus('done', 0, 30, true)).toBe('closed')
})
test('session closed: state stopped is closed without any marker', () => {
  expect(rowStatus('stopped', null, null, false)).toBe('closed')
  expect(stateDisplay('closed')).toEqual({text:'✓',color:'blue',dim:true})
})
test('resumed: a reopened session (marker cleared) shows its live state again', () => {
  expect(rowStatus('working', 0, 10, false)).toBe('working')
  expect(rowStatus('done', 0, 10, false)).toBe('yours')
})
test('interrupted: an aborted turn leaves the job idle, so it is your turn', () => {
  expect(rowStatus('done', 0, null, false)).toBe('yours')
})
test('blocked and permission waits are your turn even with tasks in flight; idle with tasks is working', () => {
  expect(rowStatus('blocked', 3, 20, false)).toBe('yours')
  expect(rowStatus('awaiting-input', 0, null, false)).toBe('yours')
  expect(rowStatus('done', 2, 20, false)).toBe('working')
})
test('errors and context at or above 80% are red; closed still wins', () => {
  expect(rowStatus('error', 0, null, false)).toBe('error')
  expect(rowStatus('working', 0, 80, false)).toBe('error')
  expect(rowStatus('working', 0, 79.9, false)).toBe('working')
  expect(rowStatus('stopped', 0, 95, false)).toBe('closed')
})
test('TypeScript rowStatus matches the Python helper on every generated case', () => {
  expect(cases.status.length > 100).toBe(true)
  for (const [state, tasks, percent, closed, expected] of cases.status as [string, number|null, number|null, boolean, Status][]) {
    expect(`${state}/${tasks}/${percent}/${closed}:${rowStatus(state, tasks, percent, closed)}`).toBe(`${state}/${tasks}/${percent}/${closed}:${expected}`)
  }
})
test('colour = state with only the four verified /color names', () => {
  expect(STATUS_COLOR).toEqual({yours:'yellow',working:'green',error:'red',closed:'blue',unknown:undefined})
})
test('one legend line names each colour and meaning, identical to the terminal legend', () => {
  const line = legendLine(200)
  expect(line.segments.map(s => s.text).join('')).toBe(cases.legend)
  expect(line.segments.map(s => s.text).join('')).toBe('● yellow your turn · ● green working · ● red error/ctx≥80% · ● blue closed')
  expect(line.segments.filter(s => s.text === '●').map(s => s.color)).toEqual(['yellow','green','red','blue'])
  expect(LEGEND.length).toBe(4)
  expect(legendLine(10).segments.map(s => s.text).join('').length <= 10).toBe(true)
})
test('context percent is plain text; colour is reserved for state', () => {
  for (const percent of [49,50,79,80]) expect(contextDisplay(1,percent).color).toBe(undefined)
  expect(contextDisplay(262521,null).text).toBe('263k')
  expect(contextDisplay(1,80).text).toBe('80% new session?')
  expect(contextDisplay(null,null).text).toBe('-')
})
test('the pane drops the project prefix only when the name has more after it', () => {
  expect(displayName('Alpha · build','Alpha')).toBe('build')
  expect(displayName('alpha · lower case','Alpha')).toBe('lower case')
  expect(displayName('Beta · x','Alpha')).toBe('Beta · x')
  expect(displayName('plain',undefined)).toBe('plain')
})
test('legend first, then one row per session; a short viewport and narrow panes still fit', () => {
  const rows=[row('one\n\u001b[31m','a',10),row('two','b',8)]
  for (const width of [12,40,80,160]) {
    const lines=paneLines({at:10000,rows,errors:[]},width,1)
    expect(lines.length).toBe(3)
    expect(lines[0]!.key).toBe('legend')
    for (const line of lines) {
      const text=line.segments.map(s=>s.text).join('')
      expect(text.length <= width).toBe(true)
      expect(/[\n\u001b]/.test(text)).toBe(false)
    }
  }
})
test('each row leads with a dot in its state colour and a plain project tag',()=>{
  const board={at:10000,errors:[],rows:[{...row('w','a',1),state:'working',projectShort:'Alpha',name:'Alpha · build'},{...row('y','a',2),state:'done'}]}
  const lines=paneLines(board,200,1)
  const working=lines.find(line=>line.key === 'w')!, yours=lines.find(line=>line.key === 'y')!
  expect(working.segments[0]).toEqual({text:'●',color:'green'})
  expect(working.segments[2]!.color).toBe(undefined)
  expect(working.segments[2]!.text.trim()).toBe('Alpha')
  expect(working.segments.map(s=>s.text).join('').includes('build')).toBe(true)
  expect(working.segments.map(s=>s.text).join('').includes('Alpha · Fix')).toBe(false)
  expect(yours.segments[0]!.color).toBe('yellow')
})
test('closed rows (stopped or marker) use dim blue across all their fields; idle done rows do not',()=>{
  for (const closedRow of [{...row('s','a',1),state:'stopped'},{...row('m','a',1),state:'done',closed:true}]) {
    const line=paneLines({at:10000,errors:[],rows:[closedRow]},200,1)[1]!
    for(const segment of line.segments.filter(segment=>segment.text.trim())){
      expect(segment.color).toBe('blue');expect(segment.dim).toBe(true)
    }
  }
  const idle=paneLines({at:10000,errors:[],rows:[{...row('d','a',1),state:'done'}]},200,1)[1]!
  expect(idle.segments.some(segment=>segment.color === 'blue')).toBe(false)
})
