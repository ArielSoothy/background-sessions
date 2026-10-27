import { expect, test } from 'claude-code/testing'
import { decideRename, safeName } from '../hooks/rename'
const project={projectId:'alpha',projectShort:'Alpha',projectSource:'cwd' as const}
test('prefix retains the existing host name',()=>{
 expect(decideRename('build',project,null).name).toBe('Alpha · build')
 expect(decideRename('Alpha · build',project,null).name).toBe(null)
})
test('project changes replace only a prefix previously managed by this plugin',()=>{
 const first=decideRename('build',project,null)
 const previous={...first.state,lastSet:first.name!,prefix:'Alpha'}
 expect(decideRename(first.name,{...project,projectId:'beta',projectShort:'Beta'},previous).name).toBe('Beta · build')
})
test('manual names disable subsequent automatic prefix updates',()=>{
 const previous={projectId:'alpha',lastSet:'Alpha · build',prefix:'Alpha'}
 const result=decideRename('Custom',project,previous)
 expect(result.state.disabled).toBe(true)
 expect(result.name).toBe(null)
})
test('missing names, unknown projects and empty labels are left alone',()=>{
 expect(decideRename(null,project,null).name).toBe(null)
 expect(decideRename('build',{...project,projectSource:'Other'},null).name).toBe(null)
 expect(decideRename('build',{...project,projectShort:''},null).name).toBe(null)
})
test('rename strips ANSI sequences, terminal controls and invisible formatting',()=>{
 expect(safeName('\x1b[31mBuild\x1b[0m\n\x00\u202e')).toBe('Build')
 expect(safeName('a\x1b]0;title\x07b')).toBe('ab')
 expect(decideRename('build\n\x1b[31mnow',{...project,projectShort:'Alpha\x07'},null).name).toBe('Alpha · build now')
})
