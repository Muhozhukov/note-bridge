import {test} from 'node:test';import assert from 'node:assert/strict';
import {LocalIndex,VERIFY_INTERVAL} from '../core/local-index';
import {hash} from '../core/sync';
const bytes=new TextEncoder().encode('old').buffer;
const stamp={mtime:10,ctime:5,size:3};
test('persisted index avoids all content reads after cold restart for 1000 unchanged files',async()=>{
  const checksum=await hash(bytes),records=Object.fromEntries(Array.from({length:1000},(_,i)=>[i+'.md',{...stamp,hash:checksum,verifiedAt:100}]));
  const restarted=new LocalIndex(JSON.parse(JSON.stringify(records)));let reads=0;
  for(let i=0;i<1000;i++){const result=await restarted.inspect(i+'.md',()=>stamp,async()=>{reads++;return bytes;},101);assert.equal(result.hit,true);}
  assert.equal(reads,0);
});
test('only changed and new files are hashed; mtime, ctime and size all participate',async()=>{
  for(const changed of [{...stamp,mtime:11},{...stamp,ctime:6},{...stamp,size:4}]){
    const cache=new LocalIndex({'a.md':{...stamp,hash:await hash(bytes),verifiedAt:100}});let reads=0;
    const data=changed.size===4?new TextEncoder().encode('four').buffer:bytes;
    const r=await cache.inspect('a.md',()=>changed,async()=>{reads++;return data;},101);assert.equal(r.hit,false);assert.equal(r.reason,'changed');assert.equal(reads,1);
  }
});
test('weekly audit discovers edits with deliberately preserved metadata',async()=>{
  const cache=new LocalIndex({'a.md':{...stamp,hash:await hash(bytes),verifiedAt:100}}),edited=new TextEncoder().encode('new').buffer;
  const result=await cache.inspect('a.md',()=>stamp,async()=>edited,100+VERIFY_INTERVAL);assert.equal(result.reason,'audit');assert.equal(result.entry.hash,await hash(edited));
});
test('event invalidation and manual verification override unchanged metadata',async()=>{
  const cache=new LocalIndex({'a.md':{...stamp,hash:await hash(bytes),verifiedAt:100}});cache.invalidate('a.md');
  assert.equal((await cache.inspect('a.md',()=>stamp,async()=>bytes,101)).hit,false);cache.clear();assert.equal((await cache.inspect('a.md',()=>stamp,async()=>bytes,102)).hit,false);
});
test('folder invalidation includes in-flight reads with unchanged timestamps',async()=>{
  const cache=new LocalIndex();await assert.rejects(cache.inspect('folder/a.md',()=>stamp,async()=>{cache.invalidateTree('folder');return bytes;},100),/изменился/);assert.equal(cache.records['folder/a.md'],undefined);
});
test('pruning only follows a completed file enumeration',async()=>{
  const cache=new LocalIndex();await cache.inspect('a.md',()=>stamp,async()=>bytes,100);await cache.inspect('b.md',()=>stamp,async()=>bytes,100);cache.prune(new Set(['b.md']));assert.deepEqual(Object.keys(cache.records),['b.md']);
});
test('invalid cache checksum or future verification date is rehashed',async()=>{
  for(const record of [{...stamp,hash:'bad',verifiedAt:100},{...stamp,hash:await hash(bytes),verifiedAt:200}]){const cache=new LocalIndex({'a.md':record});assert.equal((await cache.inspect('a.md',()=>stamp,async()=>bytes,101)).hit,false);}
});
test('special JavaScript property names are stored as ordinary filenames',async()=>{const cache=new LocalIndex();await cache.inspect('__proto__',()=>stamp,async()=>bytes,100);assert.equal(Object.hasOwn(cache.records,'__proto__'),true);assert.equal((await cache.inspect('__proto__',()=>stamp,async()=>{throw Error('Unexpected read');},101)).hit,true);});
