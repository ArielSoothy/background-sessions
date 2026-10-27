import type { EngineInterface } from 'claude-code'
export const SAFE_ID=/^[A-Za-z0-9_-]+$/
export async function readOnly($:EngineInterface){return await $.env.get('SESSION_BOARD_READ_ONLY') === '1'}

/** HOME is required only for the default root or tilde expansion. */
export async function configRoot($:EngineInterface):Promise<string|null>{
  const home=await $.env.get('HOME')
  const validHome=home?.startsWith('/') && !home.includes('\0') ? home : null
  let root=await $.env.get('CLAUDE_CONFIG_DIR') || (validHome ? `${validHome}/.claude` : '')
  if(root === '~' || root.startsWith('~/')){if(!validHome) return null;root=validHome+root.slice(1)}
  if(!root.startsWith('/') || root.includes('\0')) return null
  const parts:string[]=[]
  for(const part of root.split('/')){if(part === '..') parts.pop();else if(part && part !== '.') parts.push(part)}
  return '/'+parts.join('/')
}
export async function dataDir($:EngineInterface){const root=await configRoot($);return root ? `${root}/session-board` : null}

/** Python owns descriptor-based file writes; the engine has no no-follow write primitive. */
export async function writeObject($:EngineInterface,path:string,value:unknown){
  const dir=await dataDir($)
  if(!dir || await readOnly($) || !path.startsWith(`${dir}/`)) return false
  const relative=path.slice(dir.length+1)
  const match=/^(usage|done)\/([A-Za-z0-9_-]+)\.json$/.exec(relative)
  if(!match) return false
  try{
    const result=await runHelper($,['--write-record',match[1]!,match[2]!,JSON.stringify(value)])
    if(!result) return false
    const written=(JSON.parse(result.stdout) as {written?:unknown}).written === true
    if(!written) await helperFailed($)
    return written
  }catch{return false}
}
export async function enabled($:EngineInterface,feature:'color'|'rename'|'done'){
  const dir=await dataDir($)
  if(dir === null || await readOnly($)) return false
  const optOut=feature === 'color' ? await $.env.get('SESSION_BOARD_NO_COLOR') : feature === 'rename' ? await $.env.get('SESSION_BOARD_NO_RENAME') : await $.env.get('SESSION_BOARD_NO_DONE')
  return optOut !== '1' && !await $.fs.exists(`${dir}/no-${feature}`)
}

let retryAfter=0
export async function helperFailed($:EngineInterface){
  const now=await $.clock.now()
  if(now >= retryAfter) retryAfter=now+600_000
}
/** Collection and record writes share a cooldown when Python fails. */
export async function runHelper($:EngineInterface,args:string[]){
  if(await $.clock.now() < retryAfter) return null
  try{
    const result=await $.process.run(['python3',`${$.plugin.root}/bin/sessions`,...args],{timeoutMs:5000})
    if(result.exitCode !== 0 || result.isStdoutTruncated) throw new Error('Helper failed')
    JSON.parse(result.stdout)
    return result
  }catch{await helperFailed($);return null}
}
export async function readMarker($:EngineInterface,id:string):Promise<{suffixName?:string}>{
  if(!SAFE_ID.test(id)) return {}
  const result=await runHelper($,['--read-marker',id])
  if(!result) return {}
  const value=JSON.parse(result.stdout)
  return value && typeof value === 'object' ? value : {}
}
