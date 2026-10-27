import { safeName } from './rename'
export const DONE_COLOUR='blue'
export const hasDone=(name:string)=>name.trimEnd().endsWith('· done')
export const appendDone=(name:string)=>{const clean=safeName(name);return hasDone(clean) ? clean : `${clean} · done`}
export const stripDone=(name:string)=>safeName(hasDone(name) ? name.trimEnd().slice(0,-6) : name)
export const markerPath=(dir:string,id:string)=>`${dir}/done/${id}.json`
