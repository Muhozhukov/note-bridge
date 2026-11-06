import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve('branding-site/public');
test('branding pages have titles, mobile viewport and valid same-site links',()=>{
 for(const page of ['index.html','privacy/index.html','terms/index.html']){
   const html=readFileSync(resolve(root,page),'utf8');
   assert.match(html,/<title>[^<]+<\/title>/);assert.match(html,/name="viewport"/);assert.doesNotMatch(html,/<script\b/i);
   for(const match of html.matchAll(/href="(\/[^"#]*)"/g)){
     const path=match[1];assert.ok(existsSync(resolve(root,'.'+path+(path.endsWith('/')?'index.html':''))),page+': '+path);
   }
 }
 const home=readFileSync(resolve(root,'index.html'),'utf8');assert.match(home,/href="\/privacy\/"/);assert.match(home,/href="\/terms\/"/);
});
test('Firebase configuration publishes only static public files',()=>{
 const config=JSON.parse(readFileSync('branding-site/firebase.json','utf8'));
 assert.equal(config.hosting.public,'public');assert.equal(config.functions,undefined);assert.equal(config.firestore,undefined);
 assert.ok(config.hosting.headers[0].headers.some((h:{key:string})=>h.key==='Content-Security-Policy'));
});
