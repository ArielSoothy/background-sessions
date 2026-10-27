import type { EngineInterface } from 'claude-code'
import { dataDir, enabled, SAFE_ID, readMarker, writeObject } from './settings'
import { safeName } from './rename'
export const DONE_COLOUR='blue'
export const hasDone=(name:string)=>name.trimEnd().endsWith('· done')
export const appendDone=(name:string)=>{const clean=safeName(name);return hasDone(clean) ? clean : `${clean} · done`}
export const stripDone=(name:string)=>safeName(hasDone(name) ? name.trimEnd().slice(0,-6) : name)
export const markerPath=(dir:string,id:string)=>`${dir}/done/${id}.json`
export async function markDone($:EngineInterface,id:string,reason='done-command'){
  const dir=await dataDir($)
  if(!dir || !SAFE_ID.test(id) || id !== await $.session.id() || !await enabled($,'done')) return false
  const marker=await readMarker($,id)
  return writeObject($,markerPath(dir,id),{at:await $.clock.now(),reason,...(typeof marker.suffixName === 'string' ? {suffixName:marker.suffixName} : {})})
}

/** All visible host changes use commands bound to the running session. */
export async function applyDone($:EngineInterface,id:string,name:string|null,rename:(name:string)=>Promise<void|boolean>){
  if(id !== await $.session.id() || !await enabled($,'done')) return
  const commands=await $.command.list()
  if(await enabled($,'color') && commands.some(c=>c.name === 'color')){
    await $.command.run({command:'color',args:DONE_COLOUR})
    if(await enabled($,'color')) await $.store.set(`color:${id}`,{set:DONE_COLOUR})
  }
  if(name && !hasDone(name) && !(await $.store.get(`rename:${id}`) as {disabled?:boolean}|null)?.disabled && await enabled($,'rename') && commands.some(c=>c.name === 'rename')){
    const suffixName=appendDone(name)
    if(await rename(suffixName) !== false) await writeObject($,markerPath((await dataDir($))!,id),{at:await $.clock.now(),reason:'done-command',suffixName})
  }
}

/** Python reads and clears the owned marker; the snapshot supplies the host name. */
export async function restoreDone($:EngineInterface,id:string,name:string|null,rename:(name:string)=>Promise<void|boolean>,closed=false){
  const dir=await dataDir($)
  if(!dir || !SAFE_ID.test(id) || id !== await $.session.id() || !await enabled($,'done')) return
  const marker=await readMarker($,id)
  if(!await writeObject($,markerPath(dir,id),{cleared:true,at:await $.clock.now()})) return
  if((closed || (name && hasDone(name))) && await enabled($,'done')) await $.store.delete(`color:${id}`)
  if(name && marker.suffixName === name && hasDone(name) && !(await $.store.get(`rename:${id}`) as {disabled?:boolean}|null)?.disabled && await enabled($,'rename')) await rename(stripDone(name))
}
