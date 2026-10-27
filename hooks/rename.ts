export type RenameState = { projectId: string; lastSet?: string; prefix?: string; disabled?: boolean }
type Project = { projectId: string; projectShort?: string; projectName?: string; projectSource: string }

/** Strip complete terminal sequences before removing remaining control/format characters. */
export const safeName=(text:string):string=>text
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,'')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')
  .replace(/\x1b[ -/]*[@-~]/g,'')
  .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu,' ').replace(/\s+/g,' ').trim()

/** A cwd supplies the project prefix; the host's existing name supplies every other word. */
export const decideRename=(current:string|null,project:Project,previous:RenameState|null):{state:RenameState;name:string|null}=>{
  const state:RenameState={...previous,projectId:project.projectId}
  if(previous?.lastSet !== undefined && current !== null && current !== previous.lastSet) state.disabled=true
  const short=safeName(project.projectShort ?? project.projectName ?? '')
  if(state.disabled || current === null || !safeName(current) || project.projectSource === 'Other' || !short) return {state,name:null}
  const oldPrefix=previous?.prefix ? `${previous.prefix} · ` : ''
  const base=safeName(previous?.lastSet === current && oldPrefix && current.startsWith(oldPrefix) ? current.slice(oldPrefix.length) : current)
  const prefix=`${short} · `
  const desired=base.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()) ? base : `${prefix}${base}`
  return {state,name:desired === current ? null : desired}
}
