import type { Board, BoardLine, SessionRow, Segment, Status } from '../types'

/** Colour means session state, never project. Only these four are verified with the built-in /color. */
export const STATUS_COLOR: Record<Status, string | undefined> = {
  yours: 'yellow', working: 'green', error: 'red', closed: 'blue', unknown: undefined,
}
const STATUS_TEXT: Record<Status, string> = { yours: '! YOU', working: '▶', error: '✗', closed: '✓', unknown: '?' }
export const LEGEND: { status: Status; label: string }[] = [
  { status: 'yours', label: 'your turn' }, { status: 'working', label: 'working' },
  { status: 'error', label: 'error/ctx≥80%' }, { status: 'closed', label: 'closed' },
]

/**
 * One status per session; bin/sessions row_status is the Python twin.
 * A background job writes state 'done' after EVERY reply (idle, your turn): only 'stopped'
 * or an explicit done marker means closed.
 */
export const rowStatus = (state: string | null | undefined, tasks?: number | null, percent?: number | null, closed?: boolean | null): Status => {
  const s = String(state ?? '').toLowerCase().replaceAll('_', '-')
  if (closed || s === 'stopped') return 'closed'
  if (/error|fail|crash/.test(s) || (typeof percent === 'number' && Number.isFinite(percent) && percent >= 80)) return 'error'
  if (/wait|input|permission|approval|blocked/.test(s)) return 'yours'
  if (/^(working|running|active)$/.test(s) || (typeof tasks === 'number' && tasks > 0)) return 'working'
  if (/^(done|idle|completed|complete|finished)$/.test(s)) return 'yours'
  return 'unknown'
}
export const statusOf = (row: SessionRow): Status => row.status ?? rowStatus(row.state, row.tasks, row.percent, row.closed)

export const groupRows = (rows: SessionRow[]): SessionRow[] => {
  const latest = new Map<string, number>()
  for (const row of rows) latest.set(row.projectId, Math.max(latest.get(row.projectId) ?? 0, row.lastWorkedAt ?? 0))
  return [...rows].sort((a,b) => (latest.get(b.projectId)! - latest.get(a.projectId)!) ||
    a.projectId.localeCompare(b.projectId) || (b.lastWorkedAt ?? 0) - (a.lastWorkedAt ?? 0) || a.id.localeCompare(b.id))
}

export const formatAge = (ms: number | null): string => {
  if (ms === null || !Number.isFinite(ms)) return '-'
  const minutes = Math.floor(Math.max(0,ms) / 60000)
  return minutes < 1 ? 'now' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes/60)}h` : `${Math.floor(minutes/1440)}d`
}

/** Plain text: colour is reserved for the session state. */
export const contextDisplay = (tokens: number | null, percent: number | null): Segment => {
  if (percent === null || !Number.isFinite(percent)) return {text: tokens === null ? '-' : tokens >= 1000 ? `${Math.round(tokens/1000)}k` : `${tokens}`,dim:true}
  return {text:`${Math.round(percent)}%${percent >= 80 ? ' new session?' : ''}`}
}
export const stateDisplay = (status: Status): Segment =>
  ({text:STATUS_TEXT[status],...(STATUS_COLOR[status] ? {color:STATUS_COLOR[status]} : {}),...(status === 'yours' ? {bold:true} : {}),...(status === 'closed' ? {dim:true} : {})})

/** The pane has a project column, so it drops the "<Short> · " prefix the built-in list needs. */
export const displayName = (name: string, short?: string): string => {
  const prefix = short ? `${short} · ` : ''
  return prefix && name.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()) && name.length > prefix.length ? name.slice(prefix.length) : name
}

export const clean = (text: string): string => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,' ')
const cellWidth = (c: string) => /\p{Mark}/u.test(c) ? 0 : ((c.codePointAt(0)! >= 0x1100 && /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}]/u.test(c)) ? 2 : 1)
const textWidth = (text: string) => Array.from(text).reduce((n,c)=>n+cellWidth(c),0)
export const fit = (text: string, width: number): string => {
  let result='', used=0
  for (const c of clean(text)) { const n=cellWidth(c); if (used+n > width) break; result+=c; used+=n }
  return result+' '.repeat(Math.max(0,width-used))
}
const started = (at: number | null, now: number) => {
  if (at === null) return '-'
  const date=new Date(at), today=new Date(now)
  const hm=`${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`
  return date.toDateString() === today.toDateString() ? `today ${hm}` : `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getMonth()]} ${String(date.getDate()).padStart(2,' ')} ${hm}`
}
const modelShort = (model: string) => /opus|sonnet|fable|haiku/i.exec(model)?.[0]?.toLowerCase() ?? (model || '-')

/** Cut segments so the whole line fits; a tiny pane may not even fit separators. */
const bound = (segments: Segment[], width: number): Segment[] => {
  let room=width
  return segments.map(segment=>{const text=fit(segment.text,Math.min(room,textWidth(segment.text))); room-=textWidth(text); return {...segment,text}})
}

/** The one legend line drawn above the rows: dot colour, colour name, meaning. */
export const legendLine = (width: number): BoardLine => ({key:'legend',segments:bound(LEGEND.flatMap((item,index)=>[
  ...(index ? [{text:' · ',dim:true}] : []),
  {text:'●',color:STATUS_COLOR[item.status]!},{text:` ${STATUS_COLOR[item.status]} ${item.label}`},
]),Math.max(1,Math.floor(width)))})

/** Keep every row in the scrollable tree; viewport height only controls headers. */
export const paneLines = (board: Board, columns: number, height: number): BoardLine[] => {
  const width=Math.max(1,Math.floor(columns)), rows=groupRows(board.rows)
  const groups=new Set(rows.map(row=>row.projectId))
  const headers=rows.length+groups.size+1 <= height && rows.every(row=>clean(row.projectName).length+4 <= width)
  const lines: BoardLine[]=[legendLine(width)]
  let previous: string | undefined
  const names=rows.map(row=>displayName(row.name,row.projectShort))
  // Columns: status dot, project tag, name, state, context, started, last worked, model.
  const nameWidth=Math.max(20,...names.map(textWidth))
  const projectWidth=Math.max(6,...rows.map(row=>(row.projectShort ?? row.projectName).length))
  const widths=[1,projectWidth,nameWidth,5,16,14,5,6]
  const gaps=widths.length-1
  const budget=Math.max(0,width-gaps)
  widths[2]!+=Math.max(0,budget-widths.reduce((a,b)=>a+b,0))
  // At small widths shrink text before status/context. Every column retains a cell where possible.
  for (const index of [5,7,1,6,2,3,4]) {
    const excess=widths.reduce((a,b)=>a+b,0)-budget
    if (excess <= 0) break
    widths[index]=Math.max(width < 16 ? 0 : 1,widths[index]!-excess)
  }
  rows.forEach((row,rowIndex)=>{
    if (headers && previous !== row.projectId) lines.push({key:`project:${row.projectId}`,segments:[{text:fit(`─ ${row.projectName} `,width).trimEnd(),dim:true}]})
    previous=row.projectId
    const status=statusOf(row), closed=status === 'closed'
    const dot: Segment={text:'●',...(STATUS_COLOR[status] ? {color:STATUS_COLOR[status]} : {}),...(closed ? {dim:true} : {})}
    const fields: Segment[]=[dot,{text:row.projectShort ?? row.projectName},{text:names[rowIndex]!},stateDisplay(status),contextDisplay(row.tokens,row.percent),
      {text:started(row.startedAt,board.at)},{text:formatAge(row.lastWorkedAt === null ? null : board.at-row.lastWorkedAt)},
      {text:modelShort(row.model)}]
    const segments=fields.flatMap((field,index)=>[...(index ? [{text:' '}] : []),{...field,...(closed ? {color:STATUS_COLOR.closed!,dim:true} : {}),text:fit(field.text,widths[index]!)}])
    lines.push({key:row.id,segments:bound(segments,width)})
  })
  return lines
}
