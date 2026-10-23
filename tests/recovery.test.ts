import {test} from 'node:test';import assert from 'node:assert/strict';
import {Drive,type DriveHooks,type WriteIntent} from '../plugin/src/drive';import {hash,type Entry} from '../core/sync';import type {RequestUrlResponse} from 'obsidian';
const bytes=new TextEncoder().encode('new text').buffer;
function response(json:unknown,status=200):RequestUrlResponse{return {json,status,arrayBuffer:bytes,headers:{},text:JSON.stringify(json)};}
function hooks(){const pending:Record<string,WriteIntent>={},history:Record<string,Entry>={};const h:DriveHooks={pending,history,intent:async(k,v)=>{if(v)pending[k]=v;else delete pending[k];},savedHistory:async(k,e)=>{history[k]=e;delete pending['history|'+k];}};return h;}
test('lost create response is recovered by reserved ID without a second upload',async()=>{
 const h=hooks();let created=false,uploads=0;const checksum=await hash(bytes);
 const transport=async(p:{url:string;method?:string})=>{
  if(p.url.includes('generateIds'))return response({ids:['reserved']});
  if(p.method==='POST'){uploads++;created=true;throw new Error('Request timed out');}
  if(p.url.includes('/files/reserved?'))return created?response({id:'reserved',name:'a.md',parents:['vault'],version:'1',sha256Checksum:checksum}):response({},404);
  if(p.url.includes('alt=media'))return response({});
  return response({files:created?[{id:'reserved',name:'a.md'}]:[]});
 };
 const first=new Drive('vault',async()=>'token',transport);first.hooks=h;await assert.rejects(first.write('a.md',bytes),/timed out/);assert.equal(Object.keys(h.pending).length,1);
 const restarted=new Drive('vault',async()=>'token',transport);restarted.hooks=h;const saved=await restarted.write('a.md',bytes);assert.equal(saved.id,'reserved');assert.equal(uploads,1);
});
test('changed contents under reserved ID are never overwritten blindly',async()=>{
 const h=hooks(),checksum=await hash(bytes);h.pending['a.md|'+checksum]={id:'reserved',path:'a.md',hash:checksum};let writes=0;
 const d=new Drive('vault',async()=>'token',async p=>{if(p.method)writes++;return response({id:'reserved',name:'a.md',parents:['vault'],version:'2',sha256Checksum:'other'});});d.hooks=h;
 await assert.rejects(d.write('a.md',bytes),/изменён/);assert.equal(writes,0);
});
test('history stores one content blob with metadata and deduplicates repeated content',async()=>{
 const h=hooks();let uploads=0;const checksum=await hash(bytes);
 const d=new Drive('vault',async()=>'token',async p=>{if(p.url.includes('generateIds'))return response({ids:['reserved']});if(p.method==='POST'){uploads++;assert.match(new TextDecoder().decode(p.body as ArrayBuffer),/schema/);return response({id:'reserved',version:'1',sha256Checksum:checksum});}return response({files:[{id:'history',name:'.note-bridge-history',mimeType:'application/vnd.google-apps.folder'}]});});d.hooks=h;
 await d.snapshot('a.md',bytes,'old');await d.snapshot('b.md',bytes,'same');assert.equal(uploads,1);assert.equal(h.history[checksum].id,'reserved');
});
test('authorization rejection refreshes token once before retrying read',async()=>{let calls=0,refreshes=0;const d=new Drive('vault',async()=>'token',async()=>++calls===1?response({},401):response({id:'a'}));d.onUnauthorized=()=>refreshes++;await d.meta('a');assert.equal(calls,2);assert.equal(refreshes,1);});
