import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { appendDone, stripDone, markerPath } from '../hooks/done'
import { markDone, restoreDone, applyDone } from '../hooks/register'

const world=()=>{
 const files=new Map<string,string>(),writes:string[]=[],commands:string[]=[],deleted:string[]=[]
 const env:Record<string,string>={HOME:'/test-home'}
 const $={
  plugin:{root:'/plugin'},
  env:{get:async(key:string)=>env[key]},session:{id:async()=>'session-1'},
  fs:{exists:async()=>false},
  process:{run:async(argv:string[])=>{
   if(argv[2] === '--read-marker') return {exitCode:0,stdout:files.get(`${env.CLAUDE_CONFIG_DIR || '/test-home/.claude'}/background-sessions/done/${argv[3]}.json`) || '{}',stderr:'',isStdoutTruncated:false,isStderrTruncated:false}
   const path=`${env.CLAUDE_CONFIG_DIR || '/test-home/.claude'}/background-sessions/${argv[3]}/${argv[4]}.json`
   writes.push(path);files.set(path,argv[5]!+'\n')
   return {exitCode:0,stdout:'{"written":true}',stderr:'',isStdoutTruncated:false,isStderrTruncated:false}
  }},
  store:{get:async()=>undefined,set:async()=>{},delete:async(key:string)=>{deleted.push(key)}},
  command:{list:async()=>[{name:'color'},{name:'rename'}],run:async(e:{command:string;args:string})=>{commands.push(`${e.command}:${e.args}`)}},
  clock:{now:async()=>1000},
 } as unknown as EngineInterface
 return {$,files,writes,commands,deleted,env}
}
test('done suffix appends once, strips controls and trims trailing whitespace',()=>{
 expect(appendDone('Build   ')).toBe('Build · done')
 expect(appendDone('Build · done  ')).toBe('Build · done')
 expect(appendDone('Build\x07')).toBe('Build · done')
 expect(stripDone('Alpha · Build · done  ')).toBe('Alpha · Build')
 expect(stripDone('done elsewhere')).toBe('done elsewhere')
})
test('done writes only an owned marker and dispatches supported own-session commands',async()=>{
 const w=world()
 expect(await markDone(w.$,'session-1')).toBe(true)
 expect(JSON.parse(w.files.get(w.writes[0]!)!).cleared).toBe(undefined)
 await applyDone(w.$,'session-1','Build')
 expect(w.writes.length).toBe(2)
 expect(w.commands).toEqual(['color:blue','rename:Build · done'])
 expect(JSON.parse(w.files.get(w.writes[0]!)!)).toEqual({at:1000,reason:'done-command',suffixName:'Build · done'})
})
test('a fresh resume clears only the own marker and renames through the local command helper',async()=>{
 const w=world()
 await markDone(w.$,'session-1')
 await applyDone(w.$,'session-1','Alpha · Build')
 w.commands.length=0
 await restoreDone(w.$,'session-1','Alpha · Build · done')
 expect(JSON.parse(w.files.get(w.writes.at(-1)!)!).cleared).toBe(true)
 expect(w.commands).toEqual(['rename:Alpha · Build'])
 expect(w.deleted).toEqual(['color:session-1'])
 expect(w.writes.every(p=>p.includes('/background-sessions/done/'))).toBe(true)
})
test('marker ids and commands cannot target other sessions',async()=>{
 const w=world()
 expect(await markDone(w.$,'../escape')).toBe(false)
 await applyDone(w.$,'other','Build')
 expect(w.commands).toEqual([])
 expect(w.writes).toEqual([])
})
test('read-only suppresses markers, store changes and commands including resume',async()=>{
 const w=world();await markDone(w.$,'session-1');w.writes.length=0
 w.env.BACKGROUND_SESSIONS_READ_ONLY='1'
 expect(await markDone(w.$,'session-1')).toBe(false)
 await restoreDone(w.$,'session-1','Build · done')
 await applyDone(w.$,'session-1','Build')
 expect(w.writes).toEqual([]);expect(w.deleted).toEqual([]);expect(w.commands).toEqual([])
})
test('absolute config directory works without HOME',async()=>{
 const w=world();w.env.CLAUDE_CONFIG_DIR='/custom'
 await markDone(w.$,'session-1')
 expect(w.writes).toEqual([markerPath('/custom/background-sessions','session-1')])
 delete w.env.HOME
 expect(await markDone(w.$,'session-1')).toBe(true)
})
test('startup never strips a suffix without an exact owned marker',async()=>{
 const w=world();await markDone(w.$,'session-1')
 await restoreDone(w.$,'session-1','Build · done')
 expect(w.commands).toEqual([])
})

test('a refused helper write is reported without running close commands',async()=>{
 const w=world()
 w.$.process.run=async()=>({exitCode:0,stdout:'{"written":false}',stderr:'',isStdoutTruncated:false,isStderrTruncated:false})
 expect(await markDone(w.$,'session-1')).toBe(false)
 expect(w.commands).toEqual([]);expect(w.writes).toEqual([])
})

test('an unavailable helper disables record writes without throwing into a user command',async()=>{
 const w=world()
 w.$.clock.now=async()=>1_000_000
 w.$.process.run=async()=>{throw new Error('unavailable')}
 expect(await markDone(w.$,'session-1')).toBe(false)
 expect(w.commands).toEqual([]);expect(w.writes).toEqual([])
})

