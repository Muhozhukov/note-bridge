import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decide,hash,validPath,SyncEngine,type Local,type Remote,type Entry,type Baseline} from '../core/sync';
const bytes=(s:string)=>new TextEncoder().encode(s).buffer;
const cases:[string|undefined,string|undefined,string|undefined,string][]=[
 [undefined,undefined,'r','download'],[undefined,'l',undefined,'upload'],[undefined,'l','r','conflict'],
 ['a','a','a','none'],['a','b','a','upload'],['a','a','b','download'],['a','b','b','none'],
 ['a','b','c','conflict'],['a',undefined,'a','local-deletion'],['a','a',undefined,'remote-deletion'],
 ['a',undefined,'b','local-deletion'],['a','b',undefined,'remote-deletion'],['a',undefined,undefined,'none']
];
for(const [b,l,r,want] of cases)test(`decision ${b}/${l}/${r}`,()=>assert.equal(decide(b,l,r),want));
for(const path of ['../secret','.obsidian/data.json','a/../../b','a\\b','CON.md','a//b','a/','a:b','a.','Note Bridge Conflicts/a.md'])test('reject path '+path,()=>assert.equal(validPath(path),false));
test('Unicode and spaces accepted',()=>assert.ok(validPath('Проекты/План поездки.md')));
class Memory implements Remote {
  files=new Map<string,ArrayBuffer>(); backups:ArrayBuffer[]=[];conflicts=new Map<string,ArrayBuffer>();failScan=false;beforeWrite?:()=>void;
  constructor(files:Record<string,string>){for(const [p,s]of Object.entries(files))this.files.set(p,bytes(s));}
  async scan(){if(this.failScan)throw new Error('Network failure');const m=new Map<string,Entry>();for(const [path,b] of this.files)m.set(path,{path,id:path,hash:await hash(b)});return m;}
  async read(path:string|Entry){const p=typeof path==='string'?path:path.path;const b=this.files.get(p);if(!b)throw new Error('Missing');if(typeof path!=='string'&&await hash(b)!==path.hash)throw new Error('Changed');return b;}
  async write(path:string,b:ArrayBuffer,expected?:string|Entry){this.beforeWrite?.();const current=this.files.get(path);const h=current?await hash(current):undefined;const want=typeof expected==='string'?expected:expected?.hash;if(h!==want)throw new Error('Changed');this.files.set(path,b);return {path,id:path,hash:await hash(b)};}
  async conflict(path:string,b:ArrayBuffer,key:string){this.conflicts.set(path+key,b);}
  async snapshot(_path:string,b:ArrayBuffer){this.backups.push(b);}
}
// Adapt write return type for the Local interface without weakening production contracts.
function local(m:Memory):Local{return {scan:()=>m.scan(),read:p=>m.read(p),write:async(p,b,e)=>{await m.write(p,b,e);},conflict:(p,b,k)=>m.conflict(p,b,k)};}
async function base(s:string):Promise<Baseline>{return {'a.md':{hash:await hash(bytes(s))}};}
test('first empty device downloads rather than deletes',async()=>{const l=new Memory({}),r=new Memory({'a.md':'remote'});const e=new SyncEngine(local(l),r,{},async()=>{});await e.run();assert.equal(new TextDecoder().decode(l.files.get('a.md')),'remote');});
test('offline edits conflict; both originals preserved; repeated sync deduplicates copy',async()=>{const l=new Memory({'a.md':'local'}),r=new Memory({'a.md':'remote'});const baseline=await base('old');const e=new SyncEngine(local(l),r,baseline,async()=>{});await e.run();await e.run();assert.equal(l.conflicts.size,1);assert.equal(new TextDecoder().decode(l.files.get('a.md')),'local');assert.equal(new TextDecoder().decode(r.files.get('a.md')),'remote');assert.equal(baseline['a.md'].hash,await hash(bytes('old')));});
test('network failure cannot trigger writes or deletions',async()=>{const l=new Memory({'a.md':'local'}),r=new Memory({});r.failScan=true;const e=new SyncEngine(local(l),r,await base('old'),async()=>{});await assert.rejects(e.run());assert.equal(l.files.size,1);assert.equal(r.files.size,0);assert.equal(r.backups.length,0);});
test('remote concurrent edit rejects upload after snapshots',async()=>{const l=new Memory({'a.md':'local'}),r=new Memory({'a.md':'old'});r.beforeWrite=()=>r.files.set('a.md',bytes('external'));const e=new SyncEngine(local(l),r,await base('old'),async()=>{});await assert.rejects(e.run());assert.equal(new TextDecoder().decode(r.files.get('a.md')),'external');assert.equal(r.backups.length,2);});
test('local edit during download is preserved',async()=>{const l=new Memory({'a.md':'old'}),r=new Memory({'a.md':'remote'});l.beforeWrite=()=>l.files.set('a.md',bytes('typed'));const e=new SyncEngine(local(l),r,await base('old'),async()=>{});await assert.rejects(e.run());assert.equal(new TextDecoder().decode(l.files.get('a.md')),'typed');});
test('dry run leaves baseline, files and history untouched',async()=>{const l=new Memory({'a.md':'new'}),r=new Memory({'a.md':'old'});const b=await base('old');const original=JSON.stringify(b);let checkpoints=0;const e=new SyncEngine(local(l),r,b,async()=>{checkpoints++;});assert.equal((await e.run(true))[0].action,'upload');assert.equal(checkpoints,0);assert.equal(r.backups.length,0);assert.equal(JSON.stringify(b),original);});
test('case collision stops entire run before writes',async()=>{const l=new Memory({'Note.md':'a'}),r=new Memory({'note.md':'b'});await assert.rejects(new SyncEngine(local(l),r,{},async()=>{}).run(),/регистр/);assert.equal(r.backups.length,0);});
test('deletions remain pending and do not resurrect files',async()=>{const l=new Memory({}),r=new Memory({'a.md':'old'});const e=new SyncEngine(local(l),r,await base('old'),async()=>{});const events=await e.run();assert.equal(events[0].action,'local-deletion');assert.equal(l.files.size,0);assert.equal(r.files.size,1);});
