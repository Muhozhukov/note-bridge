import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Drive} from '../plugin/src/drive';
import {hash} from '../core/sync';
import type {RequestUrlResponse,RequestUrlParam} from 'obsidian';
function response(json:unknown,status=200,arrayBuffer=new ArrayBuffer(0)):RequestUrlResponse{return {json,status,arrayBuffer,headers:{},text:JSON.stringify(json)};}
test('paginated listings must read every page',async()=>{let calls=0;const d=new Drive('folder',async()=>'token',async p=>{calls++;return response(calls===1?{files:[{id:'a'}],nextPageToken:'page2'}:{files:[{id:'b'}]});});assert.equal((await d.children('folder')).length,2);assert.equal(calls,2);});
test('incomplete Drive listing fails closed',async()=>{const d=new Drive('folder',async()=>'token',async()=>response({files:[],incompleteSearch:true}));await assert.rejects(d.children('folder'),/Неполный/);});
test('conditional upload includes exact etag and verifies downloaded content',async()=>{const bytes=new TextEncoder().encode('new').buffer;const calls:RequestUrlParam[]=[];const d=new Drive('folder',async()=>'token',async p=>{calls.push(p);if(p.url.includes('/drive/v2/files/')&&!p.url.includes('/upload/'))return response({id:'f',etag:'"v1"',version:'1'});if(p.method==='PUT')return response({id:'f',version:'2'});if(p.url.endsWith('?alt=media'))return response({},200,bytes);return response({id:'f',version:'2',size:'3'});});const result=await d.write('a.md',bytes,{path:'a.md',id:'f',version:'1',hash:'old'});assert.equal(result.hash,await hash(bytes));const write=calls.find(p=>p.method==='PUT');assert.equal(write?.headers?.['If-Match'],'"v1"');assert.equal(write?.headers?.Authorization,'Bearer token');});
test('no ETag means no overwrite',async()=>{let writes=0;const d=new Drive('folder',async()=>'token',async p=>{if(p.method==='PUT')writes++;return response({id:'f',version:'1'});});await assert.rejects(d.write('a.md',new ArrayBuffer(0),{id:'f',path:'a.md',version:'1',hash:'old'}),/ETag/);assert.equal(writes,0);});
test('precondition failure is surfaced, not retried as blind write',async()=>{let writes=0;const d=new Drive('folder',async()=>'token',async p=>{if(p.method==='PUT'){writes++;return response({},412);}return response({id:'f',version:'1',etag:'"1"'});});await assert.rejects(d.write('a.md',new ArrayBuffer(0),{id:'f',path:'a.md',version:'1',hash:'old'}),/412/);assert.equal(writes,1);});
test('checksum downloads need one read, reject changed content',async()=>{
 const bytes=new TextEncoder().encode('body').buffer;let calls=0;
 const d=new Drive('folder',async()=>'token',async()=>{calls++;return response({},200,bytes);});
 const e={path:'Ремонт квартиры/План.md',id:'f',version:'1',hash:await hash(bytes)};
 await d.read(e);assert.equal(calls,1);
 await assert.rejects(d.read({...e,hash:'wrong'}),/сумма/);
});
test('transient GET failure retries; timed-out writes never retry',async()=>{
 let calls=0;const d=new Drive('folder',async()=>'token',async()=>{calls++;if(calls===1)return response({},503);return response({});});
 await d.req({url:'https://example.com'});assert.equal(calls,2);
 let writes=0;const w=new Drive('folder',async()=>'token',async()=>{writes++;throw new Error('Request timed out');});
 await assert.rejects(w.req({url:'https://example.com',method:'POST'}),/timed out/);assert.equal(writes,1);
});
test('hashless scan caches verified bytes instead of downloading twice',async()=>{
 const bytes=new TextEncoder().encode('body').buffer;let media=0;
 const d=new Drive('folder',async()=>'token',async p=>{
  if(p.url.includes('alt=media')){media++;return response({},200,bytes);}
  if(p.url.includes('pageSize'))return response({files:[{id:'f',name:'Ремонт квартиры.md',version:'1',mimeType:'text/markdown',size:'4'}]});
  return response(p.url.includes('/folder?')?{mimeType:'application/vnd.google-apps.folder'}:{version:'1',size:'4'});
 });
 const scan=await d.fullScan();await d.read(scan.get('Ремонт квартиры.md')!);assert.equal(media,1);
});
test('folder rename patches title with ETag and never uploads contents',async()=>{
 const calls:RequestUrlParam[]=[];const d=new Drive('root-folder',async()=>'token',async p=>{calls.push(p);if(p.url.includes('pageSize'))return response({files:[]});if(p.method==='PATCH')return response({id:'old-id',version:'2'});return response({id:'old-id',version:'1',etag:'"v1"'});});
 d.folderMeta.set('old',{id:'old-id',name:'old',mimeType:'application/vnd.google-apps.folder',version:'1'});d.folders.set('old','old-id');
 await d.rename('old','new',true,new Map(),'old-id');const patch=calls.find(p=>p.method==='PATCH')!;assert.deepEqual(JSON.parse(patch.body as string),{title:'new'});assert.equal(patch.headers?.['If-Match'],'"v1"');assert.equal(calls.some(p=>p.url.includes('/upload/')),false);
});
test('trash rejects changed revision without deleting',async()=>{let writes=0;const d=new Drive('folder',async()=>'token',async p=>{if(p.method==='PATCH')writes++;return response({version:'2',etag:'"2"'});});await assert.rejects(d.trash({id:'id',version:'1',path:'a.md',hash:'x'}),/изменился/);assert.equal(writes,0);});
test('concurrent writes share folder creation',async()=>{let creates=0;let created=false;const d=new Drive('folder',async()=>'token',async p=>{if(p.method==='POST'){creates++;created=true;return response({id:'child'});}await new Promise(r=>setTimeout(r,1));return response({files:created?[{id:'child',name:'same',mimeType:'application/vnd.google-apps.folder'}]:[]});});assert.deepEqual(await Promise.all([d.folder('same','folder'),d.folder('same','folder'),d.folder('same','folder')]),['child','child','child']);assert.equal(creates,1);});
test('lost rename response can be recovered by target identity',async()=>{const d=new Drive('folder',async()=>'token',async()=>{throw new Error('No request needed');});d.folderMeta.set('new',{id:'same',name:'new',mimeType:'application/vnd.google-apps.folder',version:'2'});await d.rename('old','new',true,new Map(),'same');await assert.rejects(d.rename('old','new',true,new Map(),'other'),/не найден/);});
