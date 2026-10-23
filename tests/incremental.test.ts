import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Drive,type DriveIndex} from '../plugin/src/drive';
import type {RequestUrlResponse,RequestUrlParam} from 'obsidian';
const folder='application/vnd.google-apps.folder';
const entry={path:'a.md',id:'a',version:'1',hash:'old'};
function response(json:unknown,status=200):RequestUrlResponse{return {json,status,arrayBuffer:new ArrayBuffer(0),headers:{},text:JSON.stringify(json)};}
function setup(reply:(p:RequestUrlParam)=>RequestUrlResponse){
 const requests:RequestUrlParam[]=[];
 const d=new Drive('rootFolder',async()=>'token',async p=>{requests.push(p);return reply(p);});
 const index:DriveIndex={root:'rootFolder',token:'before',entries:[entry],folders:[['','rootFolder']],folderMeta:[]};d.index=index;
 return {d,index,requests};
}
const changed=(id='a',name='a.md',parents=['rootFolder'])=>({fileId:id,file:{id,name,parents,mimeType:'text/markdown',version:'2',sha256Checksum:'new'}});
test('one changed note uses changes only, without listing or downloading unchanged notes',async()=>{
 const {d,requests}=setup(()=>response({changes:[changed()],newStartPageToken:'after'}));
 d.index!.entries.push(...Array.from({length:1000},(_,i)=>({path:`${i}.md`,id:String(i),version:'1',hash:'same'})));
 const files=await d.scan();assert.equal(files.size,1001);assert.equal(files.get('a.md')?.hash,'new');assert.equal(requests.length,1);assert.match(requests[0].url,/changes\?/);assert.equal(d.index?.token,'after');
});
test('empty delta is one request and no contents reads',async()=>{const {d,requests}=setup(()=>response({changes:[],newStartPageToken:'after'}));assert.equal((await d.scan()).size,1);assert.equal(requests.length,1);});
test('all pages commit atomically; later page failure retains original index',async()=>{
 let n=0;const {d,index}=setup(()=>++n===1?response({changes:[changed()],nextPageToken:'page2'}):response({},403));
 await assert.rejects(d.scan(),/403/);assert.equal(d.index,index);assert.equal(d.index.token,'before');assert.equal(d.index.entries[0].hash,'old');
});
test('pagination applies both pages before advancing cursor',async()=>{
 let n=0;const {d}=setup(()=>response(++n===1?{changes:[changed()],nextPageToken:'page2'}:{changes:[changed('b','b.md')],newStartPageToken:'after'}));
 assert.equal((await d.scan()).size,2);assert.equal(n,2);assert.equal(d.index?.token,'after');
});
test('unrelated Drive and history changes do not trigger full listing',async()=>{
 const {d,requests}=setup(()=>response({changes:[changed('external','x.md',['elsewhere']),changed('snapshot','history.json',['history'])],newStartPageToken:'after'}));
 assert.equal((await d.scan()).get('a.md')?.hash,'old');assert.equal(requests.length,1);
});
test('explicit trash is distinguished from permission loss',async()=>{
 for(const trash of [true,false]){
 const c=trash?{...changed(),file:{...changed().file,trashed:true}}:{fileId:'a',removed:true};
 const {d}=setup(()=>response({changes:[c],newStartPageToken:'after'}));assert.equal((await d.scan()).size,0);assert.equal(d.deletedIds.has('a'),trash);
 }
});
test('file rename preserves ID without content transfer',async()=>{const {d}=setup(()=>response({changes:[changed('a','renamed.md')],newStartPageToken:'after'}));const files=await d.scan();assert.equal(files.has('a.md'),false);assert.equal(files.get('renamed.md')?.id,'a');});
test('replacement ordered before old removal is resolved by ID',async()=>{const {d}=setup(()=>response({changes:[changed('new','a.md'),{fileId:'a',removed:true}],newStartPageToken:'after'}));assert.equal((await d.scan()).get('a.md')?.id,'new');});
test('duplicate final paths fail without advancing cursor',async()=>{const {d,index}=setup(()=>response({changes:[changed('duplicate')],newStartPageToken:'after'}));await assert.rejects(d.scan(),/одинаковым/);assert.equal(d.index,index);});
test('new subtree lists only its descendants without rebuilding root',async()=>{
 const order:string[]=[];const {d}=setup(p=>{order.push(p.url);if(p.url.includes('changes?'))return response({changes:[{fileId:'sub',file:{id:'sub',name:'sub',mimeType:folder,parents:['rootFolder']}}],newStartPageToken:'after'});if(p.url.includes('startPageToken'))return response({startPageToken:'rebuild'});if(p.url.includes('/files/rootFolder'))return response({id:'rootFolder',mimeType:folder});return response({files:[]});});
 await d.scan();assert.equal(d.index?.token,'after');assert.equal(order.length,2);assert.ok(new URL(order[1]).searchParams.get('q')?.includes("'sub' in parents"));assert.equal(order.some(url=>url.includes('startPageToken')),false);
});
test('folder metadata change without rename does not rebuild',async()=>{const {d,requests}=setup(()=>response({changes:[{fileId:'sub',file:{id:'sub',name:'sub',version:'2',mimeType:folder,parents:['rootFolder']}}],newStartPageToken:'after'}));d.index!.folders.push(['sub','sub']);await d.scan();assert.equal(requests.length,1);});

test('missing final cursor fails without committing partial changes',async()=>{const {d,index}=setup(()=>response({changes:[changed()]}));await assert.rejects(d.scan(),/курсор/);assert.equal(d.index,index);});
test('expired cursor rebuilds instead of inferring every file was deleted',async()=>{const {d}=setup(p=>p.url.includes('changes?')?response({},410):p.url.includes('startPageToken')?response({startPageToken:'reset'}):p.url.includes('/files/rootFolder')?response({id:'rootFolder',mimeType:folder}):response({files:[]}));await d.scan();assert.equal(d.index?.token,'reset');assert.equal(d.deletedIds.size,0);});

test('trash evidence survives persisted cursor and subsequent empty changes',async()=>{
 const {d}=setup(()=>response({changes:[{...changed(),file:{...changed().file,trashed:true}}],newStartPageToken:'after'}));await d.scan();
 const saved=JSON.parse(JSON.stringify(d.index));const {d:restarted}=setup(()=>response({changes:[],newStartPageToken:'next'}));restarted.index=saved;await restarted.scan();assert.equal(restarted.deletedIds.has('a'),true);assert.deepEqual(restarted.index?.deletedIds,['a']);
});
test('folder rename updates descendants by parent ID with no listing or media reads',async()=>{
 const {d,requests}=setup(()=>response({changes:[{fileId:'sub',file:{id:'sub',name:'renamed',version:'2',mimeType:folder,parents:['rootFolder']}}],newStartPageToken:'after'}));
 d.index!.folders.push(['old','sub']);d.index!.entries=[{...entry,path:'old/a.md'}];
 const files=await d.scan();assert.equal(files.get('renamed/a.md')?.id,'a');assert.equal(files.has('old/a.md'),false);assert.equal(requests.length,1);
});
test('new nested tree is imported without touching existing sibling folders',async()=>{
 const {d,requests}=setup(p=>{if(p.url.includes('changes?'))return response({changes:[{fileId:'new',file:{id:'new',name:'new',version:'1',mimeType:folder,parents:['rootFolder']}}],newStartPageToken:'after'});const q=new URL(p.url).searchParams.get('q');assert.match(q||'',/'new' in parents/);return response({files:[changed('b','b.md',['new']).file]});});
 d.index!.folders.push(['existing','existing']);d.index!.entries.push({...entry,id:'old2',path:'existing/old.md'});
 const files=await d.scan();assert.ok(files.has('new/b.md'));assert.ok(files.has('existing/old.md'));assert.equal(requests.length,2);
});
test('folder removal through permission loss never creates deletion evidence for descendants',async()=>{const {d}=setup(()=>response({changes:[{fileId:'sub',removed:true}],newStartPageToken:'after'}));d.index!.folders.push(['sub','sub']);d.index!.entries=[{...entry,path:'sub/a.md'}];assert.equal((await d.scan()).size,0);assert.equal(d.deletedIds.size,0);});
test('explicit folder trash records deletion evidence for all known descendants',async()=>{const {d}=setup(()=>response({changes:[{fileId:'sub',file:{id:'sub',name:'sub',mimeType:folder,parents:['rootFolder'],trashed:true}}],newStartPageToken:'after'}));d.index!.folders.push(['sub','sub']);d.index!.entries=[{...entry,path:'sub/a.md'}];assert.equal((await d.scan()).size,0);assert.equal(d.deletedIds.has('a'),true);});
