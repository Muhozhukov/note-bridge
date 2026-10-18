import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../auth-service/src/index';
import {random,digest,seal,unseal,equal} from '../auth-service/src/crypto';
const origin='https://note-bridge-auth.pravoepredserdie.workers.dev';
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec(readFileSync('auth-service/schema.sql','utf8'));
 const prepare=(sql:string)=>({bind:(...args:(string|number)[])=>({first:async()=>db.prepare(sql).get(...args)||null,run:async()=>db.prepare(sql).run(...args)}),first:async()=>db.prepare(sql).get()||null,run:async()=>db.prepare(sql).run()});
 // Test adapter uses real SQLite SQL/RETURNING semantics; deployment still needs D1 validation.
 // @ts-expect-error Deliberately partial D1 fake: exercises only prepare/bind/first/run against real SQLite.
 const DB: D1Database = {prepare};
 const env:Env={DB,PUBLIC_ORIGIN:origin,GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',ALLOWED_EMAIL:'owner@example.com',PAIRING_CODE:random(),TOKEN_ENCRYPTION_KEY:random()};
 // Test origin uses a real-looking hostname so production setup checks remain active.
 Object.defineProperty(env,'PUBLIC_ORIGIN',{value:'https://auth.example.com'});
 const post=(path:string,data:unknown={},token?:string)=>worker.fetch(new Request('https://auth.example.com'+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(data)}),env);
 return {db,env,post};
}
test('authenticated encryption rejects tampering and wrong key',async()=>{const k=random();const s=await seal('refresh-secret',k);assert.equal(await unseal(s,k),'refresh-secret');await assert.rejects(unseal(s,random()));const [iv,cipher]=s.split('.');await assert.rejects(unseal(iv+'.'+(cipher[0]==='A'?'B':'A')+cipher.slice(1),k));});
test('constant time helper verifies equality',async()=>{assert.ok(await equal('abc','abc'));assert.equal(await equal('abc','abd'),false);});
test('unconfigured service fails closed',async()=>{const {env}=fixture();env.GOOGLE_CLIENT_SECRET='';const response=await worker.fetch(new Request('https://auth.example.com/start',{method:'POST'}),env);assert.equal(response.status,503);});
test('pairing and input guards',async()=>{const {post,env}=fixture();assert.equal((await post('/start',{pairingCode:'wrong',challenge:random()})).status,403);assert.equal((await post('/start',{pairingCode:env.PAIRING_CODE,challenge:'bad'})).status,400);assert.equal((await post('/start',{blob:'x'.repeat(5000)})).status,413);});
test('authorization URL carries PKCE/state and secure browser binding',async()=>{const {post,env}=fixture();const verifier=random();const started=await (await post('/start',{pairingCode:env.PAIRING_CODE,challenge:await digest(verifier)})).json() as {session:string;url:string};const redirect=await worker.fetch(new Request(started.url),env);assert.equal(redirect.status,302);const u=new URL(redirect.headers.get('location')!);assert.equal(u.hostname,'accounts.google.com');assert.equal(u.searchParams.get('state'),started.session);assert.equal(u.searchParams.get('code_challenge_method'),'S256');assert.match(redirect.headers.get('set-cookie')!,/Secure; HttpOnly; SameSite=Lax/);assert.equal((await worker.fetch(new Request('https://auth.example.com/callback?state='+started.session+'&code=fake'),env)).status,403);});
test('claim requires device verifier and grants exactly once',async()=>{const {post,env,db}=fixture();const verifier=random();const start=await (await post('/start',{pairingCode:env.PAIRING_CODE,challenge:await digest(verifier)})).json() as {session:string};assert.equal((await post('/claim',{session:start.session,verifier:random()})).status,410);assert.equal((await post('/claim',{session:start.session,verifier})).status,202);db.prepare("UPDATE sessions SET status='ready',encrypted_refresh=? WHERE id=?").run(await seal('refresh',env.TOKEN_ENCRYPTION_KEY),start.session);const results=await Promise.all([post('/claim',{session:start.session,verifier}),post('/claim',{session:start.session,verifier})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,410]);const good=results.find(r=>r.status===200)!;const grant=await good.json() as {deviceToken:string};assert.equal((await post('/disconnect',{},grant.deviceToken)).status,200);assert.equal((await post('/token',{},grant.deviceToken)).status,401);assert.equal(db.prepare('SELECT count(*) AS n FROM devices').get()!.n,0);});
test('expired session cannot be redeemed',async()=>{const {post,env,db}=fixture();const verifier=random();const start=await (await post('/start',{pairingCode:env.PAIRING_CODE,challenge:await digest(verifier)})).json() as {session:string};db.prepare('UPDATE sessions SET expires=0 WHERE id=?').run(start.session);assert.equal((await post('/claim',{session:start.session,verifier})).status,410);});
test('Google callback, encrypted persistence and device token refresh',async t=>{
 const {env,db,post}=fixture();
 t.mock.method(globalThis,'fetch',async(input:string|URL|Request)=>{
   const url=String(input);
   if(url.includes('userinfo'))return new Response(JSON.stringify({email:'owner@example.com',email_verified:true}));
   return new Response(JSON.stringify({access_token:'access',refresh_token:'sensitive-refresh',expires_in:3600,scope:'openid email https://www.googleapis.com/auth/drive'}));
 });
 const verifier=random();const start=await (await post('/start',{pairingCode:env.PAIRING_CODE,challenge:await digest(verifier)})).json() as {session:string};
 const callback=new Request('https://auth.example.com/callback?state='+start.session+'&code=google-code',{headers:{Cookie:'nb_state='+start.session}});
 assert.equal((await worker.fetch(callback,env)).status,200);
 const stored=db.prepare('SELECT encrypted_refresh FROM sessions').get()!.encrypted_refresh as string;assert.ok(!stored.includes('sensitive-refresh'));assert.equal(await unseal(stored,env.TOKEN_ENCRYPTION_KEY),'sensitive-refresh');
 const claim=await (await post('/claim',{session:start.session,verifier})).json() as {deviceToken:string};
 const token=await post('/token',{},claim.deviceToken);assert.equal(token.status,200);assert.deepEqual(await token.json(),{accessToken:'access',expiresIn:3600});
 assert.equal((await post('/token',{},claim.deviceToken)).status,429);
});
test('wrong Google account is denied and session destroyed',async t=>{
 const {env,db,post}=fixture();t.mock.method(globalThis,'fetch',async(input:string|URL|Request)=>new Response(JSON.stringify(String(input).includes('userinfo')?{email:'someone-else@example.com',email_verified:true}:{access_token:'access',refresh_token:'refresh',expires_in:3600,scope:'https://www.googleapis.com/auth/drive'})));
 const verifier=random();const start=await (await post('/start',{pairingCode:env.PAIRING_CODE,challenge:await digest(verifier)})).json() as {session:string};
 const response=await worker.fetch(new Request('https://auth.example.com/callback?state='+start.session+'&code=code',{headers:{Cookie:'nb_state='+start.session}}),env);
 assert.equal(response.status,403);assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get()!.n,0);
});
