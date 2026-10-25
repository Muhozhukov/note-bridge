import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compactRenames} from '../core/changes';
test('folder plus 50 child notifications becomes one operation regardless of event order',()=>{
 const folder={from:'old',to:'new',folder:true};
 const children=Array.from({length:50},(_,i)=>({from:`old/${i}.md`,to:`new/${i}.md`,folder:false}));
 assert.deepEqual(compactRenames([...children,folder]),[folder]);
 assert.deepEqual(compactRenames([folder,...children]),[folder]);
});
test('nested folder notifications collapse but independent child rename survives',()=>{
 const parent={from:'old',to:'new',folder:true};
 const independent={from:'old/a.md',to:'new/renamed.md',folder:false};
 assert.deepEqual(compactRenames([parent,{from:'old/sub',to:'new/sub',folder:true},{from:'old/sub/a.md',to:'new/sub/a.md',folder:false},independent]),[parent,independent]);
});
test('unrelated moves and reserved identities are preserved without mutation',()=>{
 const queue=[{from:'a',to:'b',folder:true,id:'reserved'},{from:'another/a.md',to:'b/a.md',folder:false}];
 const before=JSON.stringify(queue);assert.deepEqual(compactRenames(queue),queue);assert.equal(JSON.stringify(queue),before);
});
