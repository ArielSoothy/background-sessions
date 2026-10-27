import { atom, read, update } from 'claude-code'
import type { CommandRunInput, EngineInterface, Register } from 'claude-code'
import type { Board } from '../types'
import { clean, fit, paneLines, rowStatus, STATUS_COLOR } from './board'
import { decideRename, safeName } from './rename'
import type { RenameState } from './rename'
import { applyDone, markDone, restoreDone } from './done'
import { dataDir, enabled, readOnly, SAFE_ID, writeObject, runHelper, helperFailed } from './settings'

const PANE='sessions'
const REFRESH_MS=20_000
const board=atom({plugin:'session-board',key:'board'} as const,null)
const BOOTED={plugin:'session-board',key:'booted'} as const
let running:Promise<Board>|null=null
let queued=false, active=false, ending=false, closing=false
let interactive=false
let lastError:boolean|null=null
let lastDrawn:number|null=null
let pendingRename:{name:string;manual:boolean}|null=null
const ownOrigin=(e:CommandRunInput)=>e.origin.kind === 'plugin' && e.origin.name === 'session-board'
const isManual=(value:unknown)=>!!value && typeof value === 'object' && (value as {manual?:unknown}).manual === true
const debug=async($:EngineInterface,message:string)=>{try{await $.ui.log(`session-board: ${message}`,{to:'debug'})}catch{/* Diagnostics cannot interrupt a session. */}}

/** Pruning is driven only by a successful, complete helper inventory. */
const pruneStore=async($:EngineInterface,current:Board)=>{
  if(await readOnly($) || !await dataDir($) || current.errors.length || current.inventoryComplete === false) return
  const live=new Set(current.rows.flatMap(row=>[row.id,row.job]))
  live.add(await $.session.id()) // The running foreground session may have no background job.
  for(const key of await $.store.keys()){
    const match=/^(?:color|rename|task|taskTries):(.+)$/.exec(key)
    const obsolete=/^(?:task|taskTries):/.test(key)
    if((obsolete || (match && !live.has(match[1]!))) && !await readOnly($)) await $.store.delete(key)
  }
}

/** One argv-based local process; overlapping callers share a snapshot. */
const refresh=($:EngineInterface):Promise<Board>=>running ??= (async()=>{
  const at=await $.clock.now()
  try{
    if(!await dataDir($)){
      const empty:Board={at,rows:[],errors:[]}
      await update($,board,()=>empty)
      return empty
    }
    const readonly=await readOnly($)
    const result=await runHelper($,['--json','--own-session',await $.session.id(),...(readonly ? ['--read-only'] : [])])
    if(!result) throw new Error('Helper failed')
    const value=JSON.parse(result.stdout) as Board
    if(!Number.isFinite(value.at) || !Array.isArray(value.rows) || !Array.isArray(value.errors) ||
      !value.rows.every(row=>row && typeof row.id === 'string' && typeof row.job === 'string' && typeof row.projectId === 'string' && typeof row.name === 'string' && typeof row.state === 'string' && typeof row.projectName === 'string' && typeof row.model === 'string')) {await helperFailed($);throw new Error('Invalid snapshot')}
    await update($,board,()=>value)
    await pruneStore($,value)
    return value
  }catch{
    await helperFailed($)
    const value:Board={at,rows:[],errors:['Unable to read sessions; check Python and file permissions.']}
    await update($,board,()=>value)
    return value
  }finally{running=null}
})()

const reportUsage=async($:EngineInterface)=>{
  const dir=await dataDir($)
  if(!interactive || !dir || await readOnly($)) return
  try{
    const id=await $.session.id()
    if(!SAFE_ID.test(id)) return
    const {context}=await $.session.usage()
    const finite=(value:unknown)=>typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
    if(finite(context.window) === null || context.window <= 0) return
    await writeObject($,`${dir}/usage/${id}.json`,{sessionId:id,model:clean(await $.session.model()),
      tokens:finite(context.tokens),window:context.window,percent:finite(context.percent),at:await $.clock.now()})
  }catch{await debug($,'Usage report could not be written.')}
}

const rename=async($:EngineInterface,name:string)=>{
  if(!await enabled($,'rename') || pendingRename?.manual || (await $.store.get(`rename:${await $.session.id()}`) as RenameState|null)?.disabled) return false
  const owned={name:safeName(name),manual:false}
  if(!owned.name) return false
  pendingRename=owned
  try{await $.command.run({command:'rename',args:owned.name});return !owned.manual}
  finally{if(pendingRename === owned) pendingRename=null}
}

const sync=async($:EngineInterface,current:Board)=>{
  if(ending || active || await readOnly($)) return
  const id=await $.session.id(),row=current.rows.find(one=>one.id === id)
  if(!row) return
  const closed=row.closed ?? false
  if(await enabled($,'color')){
    const key=`color:${id}`,previous=await $.store.get(key)
    let percent=row.percent
    try{const {context}=await $.session.usage();if(Number.isFinite(context.percent)) percent=context.percent}catch{/* Keep reported value. */}
    const status=rowStatus(lastError === null ? row.state : lastError ? 'error' : 'done',row.tasks,percent,closed)
    const color=STATUS_COLOR[status]
    if(color && !isManual(previous) && (!previous || (previous as {set?:string}).set !== color) && (await $.command.list()).some(c=>c.name === 'color')){
      if(ending || active || !await enabled($,'color') || isManual(await $.store.get(key))) return
      await $.command.run({command:'color',args:color})
      if(!isManual(await $.store.get(key)) && await enabled($,'color')) await $.store.set(key,{set:color})
    }
  }
  if(ending || active || closed || !await enabled($,'rename')) return
  const key=`rename:${id}`,previous=await $.store.get(key) as RenameState|null
  const decision=decideRename(row.rawName ?? null,row,previous)
  if(decision.name === null){if(await enabled($,'rename')) await $.store.set(key,decision.state);return}
  if(!(await $.command.list()).some(c=>c.name === 'rename')) return
  // Recheck the host name after asynchronous observation, before entering the command queue.
  const latest=(await refresh($)).rows.find(one=>one.id === id)
  if(ending || active || latest?.rawName !== row.rawName || (await $.store.get(key) as RenameState|null)?.disabled) return
  await rename($,decision.name)
  const disabled=(await $.store.get(key) as RenameState|null)?.disabled
  if(await enabled($,'rename')) await $.store.set(key,disabled ? {...decision.state,disabled:true} : {...decision.state,lastSet:decision.name,prefix:safeName(row.projectShort ?? row.projectName)})
}

const schedule=($:EngineInterface)=>{
  if(!interactive || queued) return
  queued=true
  $.clock.after(0,async()=>{
    try{const current=await refresh($);await sync($,current)}catch{await debug($,'Lifecycle refresh failed.')}
    finally{queued=false}
  })
}

export const register:Register=on=>{
  on('session.start',async($,e,next)=>{
    const mode=e as typeof e & {surfaces?:unknown[];traits?:string[]}
    interactive=e.isInteractive && mode.surfaces?.length !== 0 && !mode.traits?.includes('print')
    if(!interactive) return next(e)
    ending=false;active=false;lastError=null
    const result=await next(e)
    const reload=(await $.state.get(BOOTED)).value === true
    await $.state.set(BOOTED,true)
    if(!reload && !await readOnly($)){
      const current=await refresh($),id=await $.session.id()
      const own=current.rows.find(row=>row.id === id)
      closing=true
      try{await restoreDone($,id,own?.rawName ?? null,name=>rename($,name),own?.closed ?? false)}finally{closing=false}
      if(!await readOnly($) && !isManual(await $.store.get(`color:${id}`))) await $.store.delete(`color:${id}`)
    }
    await reportUsage($)
    schedule($)
    if(e.isInteractive){
      await $.command.register({name:'sessions',description:'Toggle the background Sessions pane',immediate:true})
      await $.command.register({name:'done',description:'Mark this session closed in the board',immediate:true})
      $.clock.every(REFRESH_MS,async()=>{
        if(lastDrawn !== null && (await $.ui.panes()).some(p=>p.id === PANE && p.isShown && p.isPlaced)) schedule($)
      })
    }
    return result
  })
  on('turn.start',async($,e,next)=>{if(e.agentId === undefined){active=true;ending=false}return next(e)})
  on('turn.complete',async($,e,next)=>{
    const result=await next(e)
    if(e.agentId === undefined){active=false;lastError=e.reason === 'error';await reportUsage($);schedule($)}
    return result
  })
  on('session.end',async($,e,next)=>{
    ending=true
    if(interactive && e.reason !== 'resume'){
      // Exit persists only the marker; no queued commands or direct host-file fallback.
      try{await markDone($,await $.session.id(),'session-end')}catch{await debug($,'Close marker could not be written.')}
    }
    return next(e)
  })
  on('command.run',{command:'color'},async($,e,next)=>{
    if(ownOrigin(e)){
      if(!await enabled($,'color') || (!closing && (ending || active || isManual(await $.store.get(`color:${await $.session.id()}`))))) return {text:''}
      return next(e)
    }
    if(!ownOrigin(e) && !await readOnly($) && await dataDir($)) await $.store.set(`color:${await $.session.id()}`,{manual:true})
    return next(e)
  }).catch(($,e,next)=>next.called || !ownOrigin(e) ? next(e) : {text:''})
  on('command.run',{command:'rename'},async($,e,next)=>{
    if(ownOrigin(e)){
      if(!await enabled($,'rename') || !pendingRename || pendingRename.manual || pendingRename.name !== e.args) return {text:''}
      if((await $.store.get(`rename:${await $.session.id()}`) as RenameState|null)?.disabled || (!closing && (ending || active))) return {text:''}
      return next({...e,args:safeName(e.args)})
    }
    if(pendingRename) pendingRename.manual=true
    if(!await readOnly($) && await dataDir($)){
      const id=await $.session.id(),key=`rename:${id}`
      const previous=await $.store.get(key) as RenameState|null
      await $.store.set(key,{...previous,projectId:previous?.projectId ?? '',disabled:true})
    }
    return next(e)
  }).catch(($,e,next)=>next.called || !ownOrigin(e) ? next(e) : {text:''})
  on('command.run',{command:'sessions'},async $=>{
    if((await $.ui.panes()).some(p=>p.id === PANE)){await $.ui.close({id:PANE});lastDrawn=null;return {text:'Sessions closed.'}}
    await $.ui.open({id:PANE,title:'Sessions'});return {text:'Sessions opened.'}
  })
  on('command.run',{command:'done'},async $=>{
    if(!interactive) return {text:'Done marking is disabled.'}
    const id=await $.session.id()
    if(!await markDone($,id)) return {text:'Done marking is disabled.'}
    $.clock.after(0,async()=>{
      try{
        const current=await refresh($)
        closing=true
        try{await applyDone($,id,current.rows.find(row=>row.id === id)?.rawName ?? null,name=>rename($,name))}finally{closing=false}
      }catch{await debug($,'Close commands could not be applied.')}
      schedule($)
    })
    return {text:'Marked closed in the board. Resume this session to reopen it.'}
  })
  on('ui.render',{component:'Pane',requestId:PANE},async($,e)=>{
    const {Box,Text}=$.ui.resolve(e)
    lastDrawn=await $.clock.now()
    const current=await read($,board)
    if(current === null || lastDrawn-current.at >= REFRESH_MS) schedule($)
    if(current === null) return <Text dimColor>Reading sessions…</Text>
    return <Box flexDirection="column">
      {paneLines(current,e.props.bodyColumns,e.props.scroll.bodyRows).map(line=><Text key={line.key} wrap="truncate-end">
        {line.segments.map((part,index)=><Text key={`${index}`} color={part.color} bold={part.bold} dimColor={part.dim}>{part.text}</Text>)}
      </Text>)}
      {current.rows.length === 0 && current.errors.length === 0 && <Text dimColor>No background sessions.</Text>}
      {current.errors.map((error,index)=><Text key={`error:${index}`} color="yellow">{fit(clean(error),e.props.bodyColumns)}</Text>)}
    </Box>
  })
}
