import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compare,assemble} from '../core/diff';
import {mergeVersions} from '../core/merge';
import {hash,type Local,type Remote,type Entry} from '../core/sync';
for(const [a,b] of [['',''],['','new\n'],['old\n',''],['a\r\nb\r\n','a\r\nc\r\n'],['same','same\n'],['a\nb\na\n','a\na\nb\n'],['Ремонт 🏠\nцена 1\n','Ремонт 🏠\nцена 2\n'],['\uFEFFfirst\n','\uFEFFchanged\n']]){
 test('reconstruct exact line endings and content '+JSON.stringify([a,b]),()=>{
  const parts=compare(a,b);for(const side of ['local','remote'] as const){const choices=new Map<number,'local'|'remote'>();parts.forEach((p,i)=>{if(p.kind==='change')choices.set(i,side);});assert.equal(assemble(parts,choices),side==='local'?a:b);}
 });
}
test('choose independent blocks from both devices',()=>{const parts=compare('head\nphone\nmiddle\nold\nend\n','head\nold\nmiddle\ndrive\nend\n');const changes=parts.map((p,i)=>p.kind==='change'?i:-1).filter(i=>i>=0);assert.equal(changes.length,2);assert.equal(assemble(parts,new Map([[changes[0],'local'],[changes[1],'remote']])),'head\nphone\nmiddle\ndrive\nend\n');});
test('unresolved blocks cannot be saved',()=>assert.throws(()=>assemble(compare('a','b'),new Map()),/каждого/));
test('large diff stops before unbounded allocation',()=>assert.throws(()=>compare('a\n'.repeat(2000),'b\n'.repeat(2000)),/много различий/));
test('oversized note stops before diff allocation',()=>assert.throws(()=>compare('x'.repeat(200001),'b'),/слишком большая/));
const bytes=(text:string)=>new TextEncoder().encode(text).buffer;
async function fixture(){
 let phone=bytes('phone'),drive=bytes('drive');const snapshots:ArrayBuffer[]=[];let changeDuringWrite=false;
 const l:Entry={path:'a.md',hash:await hash(phone)},r:Entry={path:'a.md',hash:await hash(drive),id:'id',version:'1'};
 const local:Local={scan:async()=>new Map(),read:async()=>phone,write:async(_p,data,expected)=>{if(changeDuringWrite)phone=bytes('new user edit');if(await hash(phone)!==expected)throw new Error('changed');phone=data;},conflict:async()=>{}};
 const remote:Remote={scan:async()=>new Map(),read:async()=>drive,snapshot:async(_p,b)=>{snapshots.push(b);},write:async(_p,b,expected)=>{assert.equal(expected?.hash,await hash(drive));drive=b;return {...r,hash:await hash(b)};}};
 return {local,remote,l,r,snapshots,phone:()=>new TextDecoder().decode(phone),drive:()=>new TextDecoder().decode(drive),change:()=>{changeDuringWrite=true;}};
}
test('merge backs up both originals and updates both sides',async()=>{const f=await fixture();const base=await mergeVersions('a.md','combined',f.local,f.remote,f.l,f.r);assert.equal(f.phone(),'combined');assert.equal(f.drive(),'combined');assert.equal(f.snapshots.length,2);assert.equal(base.hash,await hash(bytes('combined')));});
test('concurrent local edit survives partial merge; merged remote result is retained',async()=>{const f=await fixture();f.change();await assert.rejects(mergeVersions('a.md','combined',f.local,f.remote,f.l,f.r),/Итог сохранён в Drive/);assert.equal(f.phone(),'new user edit');assert.equal(f.drive(),'combined');assert.equal(f.snapshots.length,2);});
test('stale local or remote content blocks merged writes',async()=>{const f=await fixture();await assert.rejects(mergeVersions('a.md','combined',f.local,f.remote,{...f.l,hash:'stale'},f.r),/телефона изменился/);await assert.rejects(mergeVersions('a.md','combined',f.local,f.remote,f.l,{...f.r,hash:'stale'}),/Drive изменился/);assert.equal(f.drive(),'drive');assert.equal(f.phone(),'phone');assert.equal(f.snapshots.length,0);});
