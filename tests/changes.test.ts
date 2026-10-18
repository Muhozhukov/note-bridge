import {test} from 'node:test';
import assert from 'node:assert/strict';
import {remapBaseline,duplicateFolders} from '../core/changes';
import {pool} from '../core/control';
import type {Entry,Baseline} from '../core/sync';
const entries=(paths:Record<string,string>)=>new Map(Object.entries(paths).map(([path,hash])=>[path,{path,hash} as Entry]));
test('folder rename preserves remote identities and base content',()=>{const b:Baseline={'old/a.md':{hash:'a',remoteId:'id'},'other.md':{hash:'b'}};remapBaseline(b,'old','new');assert.deepEqual(b,{'new/a.md':{hash:'a',remoteId:'id'},'other.md':{hash:'b'}});});
test('rename baseline collision fails without mutation',()=>{const b:Baseline={'old/a.md':{hash:'a'},'new/a.md':{hash:'b'}};const before=JSON.stringify(b);assert.throws(()=>remapBaseline(b,'old','new'));assert.equal(JSON.stringify(b),before);});
test('only complete equal trees absent locally qualify as duplicates',()=>{
 const folders=new Map([['','root'],['old','o'],['new','n']]);const l=entries({'new/a.md':'a','new/b.md':'b'}),r=entries({'old/a.md':'a','old/b.md':'b','new/a.md':'a','new/b.md':'b'});
 assert.deepEqual(duplicateFolders(l,r,folders),[{from:'old',to:'new',count:2}]);
 r.set('old/unique.md',{path:'old/unique.md',hash:'unique'});assert.equal(duplicateFolders(l,r,folders).length,0);
 r.delete('old/unique.md');l.set('old/a.md',{path:'old/a.md',hash:'a'});assert.equal(duplicateFolders(l,r,folders).length,0);
});
test('different content prevents duplicate removal proposal',()=>{const l=entries({'new/a.md':'edit'}),r=entries({'old/a.md':'old','new/a.md':'old'});assert.equal(duplicateFolders(l,r,new Map([['old','o'],['new','n']])).length,0);});
test('pool limits concurrency and drains active work after failure',async()=>{
 let active=0,maximum=0,finished=0;const started:number[]=[];
 await assert.rejects(pool([0,1,2,3,4,5],async n=>{active++;maximum=Math.max(maximum,active);started.push(n);try{await new Promise(r=>setTimeout(r,n===0?1:10));if(n===0)throw new Error('stop');finished++;}finally{active--;}}),/stop/);
 assert.equal(maximum,3);assert.equal(active,0);assert.equal(finished,2);assert.deepEqual(started,[0,1,2]);
});
