import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Board } from '../types'
const NOW=Date.UTC(2026,9,18,10)
const BOARD:Board={at:NOW,errors:[],rows:[{id:'session-1',job:'job-1',name:'build',rawName:'build',state:'awaiting-input',
 projectId:'alpha',projectName:'Alpha',projectShort:'Alpha',projectSource:'cwd',
 startedAt:NOW-3600000,lastWorkedAt:NOW-60000,model:'',contextUsed:null,window:null,percent:null,contextSource:'unknown'}]}
const start={cwd:'/test',surface:'terminal',isInteractive:true} as const
const complete={answer:'',durationMs:10,isAborted:false,turnId:'t',reason:'answer'} as const
const command=(name:string,args='')=>({command:name,args,origin:{kind:'composer'},presentation:{isFullscreen:true,columns:160}} as const)
const PANE={component:'Pane',requestId:'sessions',props:{title:'Sessions',isFocused:false,bodyColumns:100,placement:'dock',scroll:{offset:0,bodyRows:20},view:{}}} as const

/** All external effects are intercepted below the real plugin. Nothing touches host files. */
const setup=(on:On,env:Record<string,string>={})=>{
 const clock=mock.clock(on,{now:NOW});mock.env(on,{HOME:'/test-home',...env})
 const stored=new Map<string,unknown>(),files=new Map<string,string>()
 const writes:{path:string;text:string}[]=[],colors:string[]=[],names:string[]=[],registered:string[]=[],argvs:string[][]=[]
 let board=structuredClone(BOARD),shown=false,available=true,percent=26,fail=false,truncate=false
 let readonly=false
 let beforeList:(()=>Promise<void>)|undefined
 const disabled=new Set<string>()
 on('store.get',(_,e)=>({value:stored.get(e.key)}))
 on('store.set',(_,e)=>{stored.set(e.key,e.value);return {value:undefined}})
 on('store.delete',(_,e)=>{stored.delete(e.key);return {value:undefined}})
 on('store.keys',()=>({value:[...stored.keys()]}))
 on('session.start',(_,e)=>({cwd:e.cwd}));on('session.end',(_,e)=>({sessionId:e.sessionId}))
 on('turn.start',(_,e)=>({turnId:e.turnId}));on('turn.complete',()=>({text:''}))
 on('session.id',()=>({value:'session-1'}))
 on('session.model',()=>({value:'example-model'}))
 // This fixture follows the engine API; plugin records use contextUsed.
 on('session.usage',()=>({value:{startedAt:NOW,context:{tokens:26,window:100,percent},rateLimits:[]}}))
 on('fs.exists',(_,e)=>({value:files.has(e.path) || disabled.has(e.path.split('/').at(-1)!)}))
 on('command.register',(_,e)=>{registered.push(e.name);expect(e.immediate).toBe(true);return {value:{command:e.name}}})
 on('command.list',async()=>{const run=beforeList;beforeList=undefined;await run?.();return {value:available ? [{name:'color',description:'Set color',source:'builtin'},{name:'rename',description:'Rename',source:'builtin'}] : []}})
 on('command.run',{command:'color'},(_,e)=>{colors.push(e.args);return {text:'ok'}})
 on('command.run',{command:'rename'},(_,e)=>{names.push(e.args);board={...board,rows:board.rows.map(row=>row.id === 'session-1' ? {...row,name:e.args,rawName:e.args} : row)};return {text:'ok'}})
 on('ui.panes',()=>({value:shown?[{id:'sessions',title:'Sessions',isShown:true,isPlaced:true,isFocused:false}]:[]}))
 on('ui.open',()=>{shown=true;return {value:{isPlaced:true}}});on('ui.close',()=>{shown=false;return {value:undefined}})
 on('ui.log',()=>({value:undefined}))
 on('process.run',(_,e)=>{
  argvs.push([...e.argv]);
  if(e.argv[2] === '--read-marker'){
   const text=files.get(`${env.CLAUDE_CONFIG_DIR || '/test-home/.claude'}/background-sessions/done/${e.argv[3]}.json`) || '{}'
   return {value:{exitCode:0,stdout:text,stderr:'',isStdoutTruncated:false,isStderrTruncated:false}}
  }
  if(e.argv[2] === '--write-record'){
   const path=`${env.CLAUDE_CONFIG_DIR || '/test-home/.claude'}/background-sessions/${e.argv[3]}/${e.argv[4]}.json`,text=e.argv[5]!+'\n'
   if(!JSON.parse(text).cleared || files.has(path)){writes.push({path,text});files.set(path,text)}
   return {value:{exitCode:0,stdout:'{"written":true}',stderr:'',isStdoutTruncated:false,isStderrTruncated:false}}
  }
  expect(e.argv[0]).toBe('python3');expect(e.argv[1]?.endsWith('/bin/sessions')).toBe(true)
  expect(e.argv.slice(2)).toEqual(readonly || env.BACKGROUND_SESSIONS_READ_ONLY === '1' ? ['--json','--own-session','session-1','--read-only'] : ['--json','--own-session','session-1'])
  return {value:{exitCode:fail ? 1 : 0,stdout:JSON.stringify({...board,at:clock.now(),rows:board.rows.map(row=>{const marker=[...files.entries()].find(([p])=>p.endsWith(`/done/${row.id}.json`));return {...row,closed:row.closed || (!!marker && !JSON.parse(marker[1]).cleared)}})}),stderr:'',isStdoutTruncated:truncate,isStderrTruncated:false}}
 })
 return {clock,stored,files,writes,colors,names,registered,argvs,disabled,
  set beforeList(v:(()=>Promise<void>)|undefined){beforeList=v},
  set board(v:Board){board=v},set percent(v:number){percent=v},set available(v:boolean){available=v},set fail(v:boolean){fail=v},set truncate(v:boolean){truncate=v},set readonly(v:boolean){readonly=v}}
}

test('start reports numeric own usage, registers commands and prefixes the existing name',async($,on)=>{
 const w=setup(on);await $.session.start(start);await w.clock.advance(1)
 expect(w.registered).toEqual(['sessions','done'])
 expect(JSON.parse(w.writes.find(e=>e.path.includes('/usage/'))!.text)).toEqual({sessionId:'session-1',model:'example-model',contextUsed:26,window:100,percent:26,at:NOW})
 expect(w.colors).toEqual(['yellow']);expect(w.names).toEqual(['Alpha · build'])
 expect(w.writes.every(e=>e.path.startsWith('/test-home/.claude/background-sessions/'))).toBe(true)
})
test('subagent completion has no own-session side effects and repeated colour is deduplicated',async($,on)=>{
 const w=setup(on);await $.session.start(start);await w.clock.advance(1)
 const count=w.writes.length
 await $.turn.complete({...complete,agentId:'child'});await w.clock.advance(1)
 expect(w.writes.length).toBe(count)
 await $.turn.complete(complete);await w.clock.advance(1)
 expect(w.colors).toEqual(['yellow']);expect(w.names).toEqual(['Alpha · build'])
})
test('idle tasks, API failure and high context choose working and error colours',async($,on)=>{
 const w=setup(on);await $.session.start(start);await w.clock.advance(1)
 w.board={...BOARD,rows:[{...BOARD.rows[0]!,state:'done',tasks:2}]}
 await $.turn.complete(complete);await w.clock.advance(1)
 await $.turn.complete({...complete,reason:'error'});await w.clock.advance(1)
 w.board={...BOARD,rows:[{...BOARD.rows[0]!,state:'done',tasks:0}]}
 await $.turn.complete(complete);await w.clock.advance(1)
 w.percent=85;await $.turn.complete(complete);await w.clock.advance(1)
 expect(w.colors).toEqual(['yellow','green','red','yellow','red'])
})
test('manual colour and rename choices survive later automatic updates and hot reload',async($,on)=>{
 const w=setup(on);await $.session.start(start);await w.clock.advance(1)
 await $.command.run(command('color','red'));await $.command.run(command('rename','Custom'))
 await $.session.start(start);await w.clock.advance(1)
 await $.turn.complete(complete);await w.clock.advance(1)
 expect(w.colors).toEqual(['yellow','red']);expect(w.names).toEqual(['Alpha · build','Custom'])
})
test('file opt-outs and absent built-in commands stop automatic changes',async($,on)=>{
 const w=setup(on);w.disabled.add('no-color');w.disabled.add('no-rename')
 await $.session.start(start);await w.clock.advance(1)
 expect(w.colors).toEqual([]);expect(w.names).toEqual([])
 w.disabled.clear();w.available=false;await $.turn.complete(complete);await w.clock.advance(1)
 expect(w.colors).toEqual([]);expect(w.names).toEqual([])
 w.available=true;await $.turn.complete(complete);await w.clock.advance(1)
 expect(w.colors).toEqual(['yellow']);expect(w.names).toEqual(['Alpha · build'])
})
test('variable colour and rename opt-outs leave usage enabled',async($,on)=>{
 const w=setup(on,{BACKGROUND_SESSIONS_NO_COLOR:'1',BACKGROUND_SESSIONS_NO_RENAME:'1'})
 await $.session.start(start);await w.clock.advance(1)
 expect(w.colors).toEqual([]);expect(w.names).toEqual([]);expect(w.writes.filter(e=>e.path.includes('/usage/')).length).toBe(1)
})
test('read-only blocks persistent writes, pruning, automatic commands and /done',async($,on)=>{
 const w=setup(on,{BACKGROUND_SESSIONS_READ_ONLY:'1'});w.stored.set('rename:gone',{disabled:true})
 await $.session.start(start);await w.clock.advance(1)
 expect((await $.command.run(command('done'))).text).toBe('Done marking is disabled.')
 await $.command.run(command('color','red'));await $.command.run(command('rename','Custom'))
 await $.turn.complete(complete);await w.clock.advance(1)
 await $.session.end({sessionId:'session-1',reason:'quit'})
 expect(w.writes).toEqual([]);expect([...w.stored.keys()]).toEqual(['rename:gone'])
 expect(w.colors).toEqual(['red']);expect(w.names).toEqual(['Custom'])
})
test('alternate config root is used for all writes',async($,on)=>{
 const w=setup(on,{CLAUDE_CONFIG_DIR:'/custom'})
 await $.session.start(start);await w.clock.advance(1);await $.command.run(command('done'));await w.clock.advance(1)
 expect(w.writes.every(e=>e.path.startsWith('/custom/background-sessions/'))).toBe(true)
})
test('absolute config root enables file features without HOME',async($,on)=>{
 const w=setup(on,{HOME:'',CLAUDE_CONFIG_DIR:'/custom'})
 await $.session.start(start);await w.clock.advance(1)
 expect(w.writes.length > 0).toBe(true);expect(w.colors).toEqual(['yellow']);expect(w.names).toEqual(['Alpha · build'])
})
test('successful snapshots prune stale per-session store keys while preserving live and unrelated keys',async($,on)=>{
 const w=setup(on)
 for(const key of ['rename:gone','color:gone','task:gone','taskTries:gone','task:session-1','color:session-1','rename:job-1','unrelated']) w.stored.set(key,{manual:true})
 await $.session.start(start);await w.clock.advance(1)
 expect(w.stored.has('rename:gone')).toBe(false);expect(w.stored.has('color:gone')).toBe(false)
 expect(w.stored.has('task:gone')).toBe(false);expect(w.stored.has('taskTries:gone')).toBe(false);expect(w.stored.has('task:session-1')).toBe(false)
 expect(w.stored.has('rename:job-1')).toBe(true);expect(w.stored.has('unrelated')).toBe(true)
})
test('helper failures and truncated output show diagnostics and never prune stored state',async($,on)=>{
 const w=setup(on);w.fail=true;w.stored.set('rename:gone',{})
 await $.session.start(start);await w.clock.advance(1)
 expect(w.stored.has('rename:gone')).toBe(true)
 await $.command.run(command('sessions'))
 const ui=await $.ui.mount({plugin:'background-sessions',surface:'terminal',...PANE})
 expect(await ui.find({type:'Text',text:'Unable to read sessions; check Python and file permissions.'})).not.toBe(null)
 await ui.unmount()
 w.fail=false;w.truncate=true;await $.turn.complete(complete);await w.clock.advance(1)
 expect(w.stored.has('rename:gone')).toBe(true)
})
test('pane toggles, renders on both surfaces and polls only while visible',async($,on)=>{
 const w=setup(on);await $.session.start(start);await w.clock.advance(1)
 const baseline=w.argvs.length;await w.clock.advance(60000);expect(w.argvs.length).toBe(baseline)
 await $.command.run(command('sessions'))
 for(const surface of ['terminal','desktop'] as const){
  const ui=await $.ui.mount({plugin:'background-sessions',surface,...PANE})
  expect(await ui.find({type:'Text',text:'●'})).not.toBe(null)
  await w.clock.advance(20001);await ui.unmount()
 }
 expect(w.argvs.length > baseline).toBe(true)
 await $.command.run(command('sessions'));const hidden=w.argvs.length
 await w.clock.advance(60000);expect(w.argvs.length).toBe(hidden)
})
test('missing jobs render the empty board message',async($,on)=>{
 const w=setup(on);w.board={at:NOW,rows:[],errors:[]}
 await $.session.start(start);await w.clock.advance(1);await $.command.run(command('sessions'))
 const ui=await $.ui.mount({plugin:'background-sessions',surface:'terminal',...PANE})
 expect(await ui.find({type:'Text',text:'No background sessions.'})).not.toBe(null)
 await ui.unmount()
})
test('/done uses a marker and commands, a hot reload keeps it closed',async($,on)=>{
 const w=setup(on);await $.session.start(start);await w.clock.advance(1)
 await $.command.run(command('done'));await w.clock.advance(1)
 expect(w.colors.at(-1)).toBe('blue');expect(w.names.at(-1)).toBe('Alpha · build · done')
 const marker='/test-home/.claude/background-sessions/done/session-1.json'
 expect(JSON.parse(w.files.get(marker)!).cleared).toBe(undefined)
 await $.session.start(start);await w.clock.advance(1)
 expect(JSON.parse(w.files.get(marker)!).cleared).toBe(undefined)
})
test('startup reopens an own marker using commands and exit writes only a marker',async($,on)=>{
 const w=setup(on),marker='/test-home/.claude/background-sessions/done/session-1.json'
 w.files.set(marker,JSON.stringify({at:NOW,reason:'done-command',suffixName:'Alpha · build · done'}))
 w.board={...BOARD,rows:[{...BOARD.rows[0]!,name:'Alpha · build · done',rawName:'Alpha · build · done',closed:true}]}
 await $.session.start(start);await w.clock.advance(1)
 expect(JSON.parse(w.files.get(marker)!).cleared).toBe(true)
 expect(w.names[0]).toBe('Alpha · build')
 const names=w.names.length,colors=w.colors.length
 await $.session.end({sessionId:'session-1',reason:'quit'})
 expect(JSON.parse(w.files.get(marker)!).reason).toBe('session-end')
 expect(w.names.length).toBe(names);expect(w.colors.length).toBe(colors)
})

test('manual colour during an automatic command check cancels the pending automatic colour',async($,on)=>{
 const w=setup(on)
 w.beforeList=async()=>{await $.command.run(command('color','red'))}
 await $.session.start(start);await w.clock.advance(1)
 expect(w.colors).toEqual(['red'])
 expect(w.stored.get('color:session-1')).toEqual({manual:true})
})
test('manual rename during an automatic command check keeps the manual name',async($,on)=>{
 const w=setup(on,{BACKGROUND_SESSIONS_NO_COLOR:'1'})
 w.beforeList=async()=>{await $.command.run(command('rename','Custom'))}
 await $.session.start(start);await w.clock.advance(1)
 expect(w.names).toEqual(['Custom'])
 expect((w.stored.get('rename:session-1') as {disabled?:boolean}).disabled).toBe(true)
})

for(const session of [{...start,isInteractive:false}, {...start,surfaces:[],traits:['print']}]){
 test('noninteractive sessions never invoke the helper',async($,on)=>{
  const w=setup(on);await $.session.start(session);await w.clock.advance(1)
  await $.turn.complete(complete);await w.clock.advance(1)
  await $.session.end({sessionId:'session-1',reason:'quit'})
  expect(w.argvs).toEqual([]);expect(w.registered).toEqual([])
 })
}
test('failed helper collection backs off for ten minutes',async($,on)=>{
 const w=setup(on);w.fail=true
 await $.session.start(start);await w.clock.advance(1)
 const count=w.argvs.length
 await $.turn.complete(complete);await w.clock.advance(599998)
 expect(w.argvs.length).toBe(count)
 w.fail=false;await w.clock.advance(2);await $.turn.complete(complete);await w.clock.advance(1)
 expect(w.argvs.length > count).toBe(true)
})
test('startup preserves unowned done suffix and manually disabled renames',async($,on)=>{
 const w=setup(on);w.stored.set('rename:session-1',{disabled:true})
 w.files.set('/test-home/.claude/background-sessions/done/session-1.json',JSON.stringify({at:NOW,reason:'done-command',suffixName:'build · done'}))
 w.board={...BOARD,rows:[{...BOARD.rows[0]!,rawName:'build · done',name:'build · done'}]}
 await $.session.start(start);await w.clock.advance(1)
 expect(w.names).toEqual([])
})

test('exit and repeated done preserve suffix ownership for the next startup',async($,on)=>{
 const w=setup(on);await $.session.start(start);await w.clock.advance(1)
 await $.command.run(command('done'));await w.clock.advance(1)
 await $.command.run(command('done'));await w.clock.advance(1)
 await $.session.end({sessionId:'session-1',reason:'quit'})
 const marker=JSON.parse(w.files.get('/test-home/.claude/background-sessions/done/session-1.json')!)
 expect(marker.suffixName).toBe('Alpha · build · done')
})

test('automatic rename sanitizes host names before dispatch and done keeps the safe title',async($,on)=>{
 const w=setup(on)
 w.board={...BOARD,rows:[{...BOARD.rows[0]!,rawName:'build\x1b[31m\x07\u202e',projectShort:'Alpha\x1b[0m'}]}
 await $.session.start(start);await w.clock.advance(1)
 expect(w.names).toEqual(['Alpha · build'])
 await $.command.run(command('done'));await w.clock.advance(1)
 expect(w.names).toEqual(['Alpha · build','Alpha · build · done'])
})

test('unowned plugin-origin rename is refused while a manual unsafe name is passed unchanged',async($,on)=>{
 const w=setup(on);await $.session.start(start);await w.clock.advance(1)
 const unsafe='Custom\x07\u202e'
 await $.command.run({...command('rename',unsafe),origin:{kind:'plugin',name:'background-sessions'}})
 expect(w.names).toEqual(['Alpha · build'])
 await $.command.run(command('rename',unsafe))
 expect(w.names).toEqual(['Alpha · build',unsafe])
})


test('a visible mounted pane updates after a polled snapshot without remounting',async($,on)=>{
 const w=setup(on);await $.session.start(start);await w.clock.advance(1)
 await $.command.run(command('sessions'))
 const ui=await $.ui.mount({plugin:'background-sessions',surface:'terminal',...PANE})
 expect(!!await ui.find({type:'Text',text:'▶    '})).toBe(false)
 w.board={...BOARD,rows:[{...BOARD.rows[0]!,rawName:'Alpha · build',state:'working'}]}
 await w.clock.advance(20001)
 expect(!!await ui.find({type:'Text',text:'▶    '})).toBe(true)
 await ui.unmount()
})
