import {test} from 'node:test';import assert from 'node:assert/strict';
import {Journal,type JournalIO} from '../core/journal';
class Disk implements JournalIO{
 files=new Map<string,string>();fail='';
 async exists(p:string){return p==='state'||this.files.has(p);}async mkdir(_p:string){}
 async list(_p:string){return {files:[...this.files.keys()]};}
 async read(p:string){if(this.fail==='read')throw new Error('read failure');return this.files.get(p)!;}
 async write(p:string,v:string){this.files.set(p,this.fail==='write'?v.slice(0,12):v);if(this.fail==='write')throw new Error('power loss');}
 async rename(a:string,b:string){if(this.fail==='rename')throw new Error('power loss');this.files.set(b,this.files.get(a)!);this.files.delete(a);}
 async remove(p:string){if(this.fail==='cleanup')throw new Error('cleanup');this.files.delete(p);}
}
const reducer=(s:{values:number[]},r:number)=>s.values.push(r);
test('journal replays committed operations after restart and compacts only after snapshot commit',async()=>{
 const disk=new Disk(),j=new Journal(disk,'state',reducer);await j.load({values:[]});await j.snapshot({values:[]});await j.record(1);await j.record(2);
 const recovered=new Journal(disk,'state',reducer);assert.deepEqual(await recovered.load({values:[]}),{values:[1,2]});
 await recovered.snapshot({values:[1,2]});assert.equal([...disk.files.keys()].filter(p=>p.endsWith('.json')).length,1);
 await recovered.record(3);assert.deepEqual(await new Journal(disk,'state',reducer).load({values:[]}),{values:[1,2,3]});
});
for(const failure of ['write','read','rename'])test('interruption before intent commit prevents external effect: '+failure,async()=>{
 const disk=new Disk(),j=new Journal(disk,'state',reducer);await j.load({values:[]});await j.snapshot({values:[]});disk.fail=failure;let external=0;
 await assert.rejects(async()=>{await j.record(1);external++;});assert.equal(external,0);disk.fail='';assert.deepEqual(await new Journal(disk,'state',reducer).load({values:[]}),{values:[]});
});
test('failed snapshot cleanup retains a valid recoverable generation',async()=>{const disk=new Disk(),j=new Journal(disk,'state',reducer);await j.load({values:[]});await j.snapshot({values:[]});await j.record(1);disk.fail='cleanup';await j.snapshot({values:[1]});disk.fail='';assert.deepEqual(await new Journal(disk,'state',reducer).load({values:[]}),{values:[1]});});
test('corrupt committed records fail closed instead of forgetting an operation',async()=>{const disk=new Disk(),j=new Journal(disk,'state',reducer);await j.load({values:[]});await j.snapshot({values:[]});await j.record(1);const path=[...disk.files.keys()].find(p=>p.includes('-record'))!;disk.files.set(path,'{}');await assert.rejects(new Journal(disk,'state',reducer).load({values:[]}),/Повреждён/);});
test('1000 small records do not serialize the entire vault per operation',async()=>{
 const disk=new Disk();type State={values:number[];index:string[]};const j=new Journal<State,number>(disk,'state',(s,r)=>s.values.push(r));const state:State={values:[],index:Array.from({length:1000},(_,i)=>i+'a'.repeat(200))};await j.load(state);await j.snapshot(state);
 for(let i=0;i<1000;i++)await j.record(i);
 const recordBytes=[...disk.files].filter(([p])=>p.includes('-record')).reduce((n,[,s])=>n+s.length,0);assert.ok(recordBytes<200000);assert.equal((await new Journal<State,number>(disk,'state',(s,r)=>s.values.push(r)).load(state)).values.length,1000);
});
