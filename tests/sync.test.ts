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
test('stale baseline case does not block new active path',async()=>{
 const l=new Memory({}),r=new Memory({'ремонт квартиры/План.md':'new'});
 const b:Baseline={'Ремонт квартиры/План.md':{hash:'old'}};
 await new SyncEngine(local(l),r,b,async()=>{}).run();
 assert.equal(l.files.size,1);assert.equal(b['Ремонт квартиры/План.md'],undefined);
});
test('case collision in ancestor directories fails before writes',async()=>{
 const l=new Memory({'Ремонт/a.md':'a'}),r=new Memory({'ремонт/b.md':'b'});
 await assert.rejects(new SyncEngine(local(l),r,{},async()=>{}).run(),/регистр/);assert.equal(l.files.size,1);assert.equal(r.files.size,1);
});
test('first import creates no redundant Drive snapshots and reports progress',async()=>{
 const l=new Memory({}),r=new Memory({'a.md':'one','b.md':'two'});const progress: {done:number;total:number}[]=[];
 await new SyncEngine(local(l),r,{},async()=>{},{progress:p=>progress.push(p)}).run();
 assert.equal(r.backups.length,0);assert.ok(progress.some(p=>p.done===1&&p.total===2));assert.equal(progress.at(-1)?.done,2);
});
test('pause preserves checkpoints and resume skips downloaded files',async()=>{
 const l=new Memory({}),r=new Memory({'a.md':'one','b.md':'two','c.md':'three','d.md':'four','e.md':'five'});const b:Baseline={};let paused=false;
 const {Paused}=await import('../core/control');
 await assert.rejects(new SyncEngine(local(l),r,b,async()=>{paused=true;},{check:()=>{if(paused)throw new Paused();}}).run(),Paused);
 const finished=l.files.size;assert.ok(finished>=1&&finished<=3);assert.equal(Object.keys(b).length,finished);let downloads=0;const write=l.write.bind(l);l.write=async(...args)=>{downloads++;return write(...args);};
 await new SyncEngine(local(l),r,b,async()=>{}).run();assert.equal(downloads,5-finished);assert.equal(l.files.size,5);
});
test('remote rename follows stable ID locally without reupload',async()=>{
 const l=new Memory({'old/a.md':'same'}),r=new Memory({'new/a.md':'same'});const b:Baseline={'old/a.md':{hash:await hash(bytes('same')),remoteId:'stable'}};
 const remote:Remote={scan:async()=>new Map([['new/a.md',{path:'new/a.md',id:'stable',hash:await hash(bytes('same'))}]]),read:e=>r.read(e),write:async()=>{throw new Error('Unexpected upload');},snapshot:async()=>{throw new Error('Unexpected snapshot');}};
 const adapter=local(l);adapter.move=async(from,to,expected)=>{assert.equal(await hash(l.files.get(from)!),expected);l.files.set(to,l.files.get(from)!);l.files.delete(from);};
 await new SyncEngine(adapter,remote,b,async()=>{}).run();assert.equal(l.files.has('old/a.md'),false);assert.equal(l.files.has('new/a.md'),true);assert.equal(b['new/a.md'].remoteId,'stable');
});
test('remote rename with local edits fails without moving or uploading',async()=>{
 const l=new Memory({'old.md':'edited'}),r=new Memory({'new.md':'old'});const b:Baseline={'old.md':{hash:await hash(bytes('old')),remoteId:'stable'}};
 r.scan=async()=>new Map([['new.md',{path:'new.md',id:'stable',hash:await hash(bytes('old'))}]]);
 const adapter=local(l);let moved=false;adapter.move=async()=>{moved=true;};
 await assert.rejects(new SyncEngine(adapter,r,b,async()=>{}).run(),/конфликтует/);assert.equal(moved,false);assert.equal(l.files.has('old.md'),true);
});
test('first upload creates no redundant history snapshot',async()=>{const l=new Memory({'a.md':'new'}),r=new Memory({});await new SyncEngine(local(l),r,{},async()=>{}).run();assert.equal(r.backups.length,0);assert.equal(r.files.size,1);});

test('recorded local deletion trashes unchanged baseline version automatically',async()=>{
 const l=new Memory({}),r=new Memory({'a.md':'old'}),b=await base('old');b['a.md'].remoteId='a.md';let trashed=0;
 const remote:Remote={scan:()=>r.scan(),read:e=>r.read(e),write:(...a)=>r.write(...a),snapshot:(...a)=>r.snapshot(a[0],a[1]),trash:async()=>{trashed++;r.files.delete('a.md');}};
 const events=await new SyncEngine(local(l),remote,b,async()=>{},{},{local:new Set(['a.md'])}).run();assert.equal(trashed,1);assert.equal(b['a.md'],undefined);assert.equal(events[0].action,'resolution-trash-remote');
});
test('recorded deletion conflicts with newer remote content or replaced ID',async()=>{
 for(const changed of ['content','id']){const l=new Memory({}),r=new Memory({'a.md':changed==='content'?'new':'old'}),b=await base('old');b['a.md'].remoteId=changed==='id'?'other':'a.md';
 const remote:Remote={scan:()=>r.scan(),read:e=>r.read(e),write:(...a)=>r.write(...a),snapshot:async()=>{},trash:async()=>{throw new Error('Must not delete');}};
 const events=await new SyncEngine(local(l),remote,b,async()=>{},{},{local:new Set(['a.md'])}).run();assert.equal(events[0].action,'local-deletion');}
});
test('recreated local file prevents automatic remote deletion',async()=>{
 const l=new Memory({}),r=new Memory({'a.md':'old'}),b=await base('old');b['a.md'].remoteId='a.md';const adapter=local(l);adapter.exists=()=>true;
 const remote:Remote={scan:()=>r.scan(),read:e=>r.read(e),write:(...a)=>r.write(...a),snapshot:async()=>{},trash:async()=>{throw new Error('Must not delete');}};
 await assert.rejects(new SyncEngine(adapter,remote,b,async()=>{},{},{local:new Set(['a.md'])}).run(),/появился/);
});
test('unchanged unresolved conflict does not upload repeated snapshots',async()=>{
 const l=new Memory({'a.md':'local'}),r=new Memory({'a.md':'remote'});const b=await base('old'),conflicts={};
 await new SyncEngine(local(l),r,b,async()=>{},{},{conflicts}).run();const n=r.backups.length;
 const events=await new SyncEngine(local(l),r,b,async()=>{},{},{conflicts}).run();assert.equal(r.backups.length,n);assert.equal(events[0].action,'conflict');
});

test('explicit remote trash removes only unchanged local version and preserves a snapshot',async()=>{
 for(const edited of [false,true]){
 const l=new Memory({'a.md':edited?'edited':'old'}),r=new Memory({}),b=await base('old');b['a.md'].remoteId='a.md';const adapter=local(l);let removed=0;
 adapter.trash=async(p,h)=>{assert.equal(await hash(l.files.get(p)!),h);l.files.delete(p);removed++;};
 const events=await new SyncEngine(adapter,r,b,async()=>{},{},{remote:new Set(['a.md'])}).run();
 assert.equal(removed,edited?0:1);assert.equal(events[0].action,edited?'remote-deletion':'resolution-trash-local');assert.equal(r.backups.length,edited?0:1);
 }
});
