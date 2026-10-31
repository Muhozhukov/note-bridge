import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Connection,BrokerError} from '../core/connection';
function setup(initial:any={},request:any=async()=>({status:202,data:{}})){
 let saved=structuredClone(initial),now=100;const changes:string[]=[];
 const c=new Connection({load:()=>saved,save:s=>saved=structuredClone(s),request,changed:()=>{changes.push('changed');},now:()=>now});
 return {c,saved:()=>saved,changes,time:(n:number)=>now=n};
}
const pending={session:'session',verifier:'secret',origin:'https://auth.test',expires:1000};
test('single start and automatic claim replace old expired credentials',async()=>{
 const s=setup({device:'old',expired:true},async(path:string)=>path==='/start'?{status:200,data:{session:'session',url:'https://auth.test/authorize?session=session'}}:{status:200,data:{deviceToken:'new'}});
 assert.equal(await s.c.start('code','https://auth.test','secret','challenge'),'https://auth.test/authorize?session=session');
 assert.equal(s.c.status,'authorizing');assert.equal(await s.c.poll('https://auth.test'),true);
 assert.equal(s.c.status,'connected');assert.deepEqual(s.saved(),{device:'new'});
});
test('pending response waits; restart restores pending proof; successful claim needs no button',async()=>{
 const s=setup({pending});await s.c.poll(pending.origin);assert.equal(s.c.status,'authorizing');
 const restored=setup(s.saved(),async()=>({status:200,data:{deviceToken:'device'}}));
 assert.equal(await restored.c.poll(pending.origin),true);assert.equal(restored.c.status,'connected');
});
test('network and service failures preserve credentials; confirmed 401 expires connection',async()=>{
 for(const error of [new Error('offline'),new BrokerError(429,'limit'),new BrokerError(500,'server')]){
 const s=setup({device:'device'},async()=>{throw error;});await assert.rejects(s.c.token());assert.equal(s.c.status,'connected');assert.equal(s.saved().device,'device');
 }
 const s=setup({device:'device'},async()=>{throw new BrokerError(401,'expired');});await assert.rejects(s.c.token(),/Сессия Google/);assert.equal(s.c.status,'expired');assert.equal(s.saved().expired,true);
});
test('claim transport failure retains pending login, expiry ends it',async()=>{
 const s=setup({pending},async()=>{throw new Error('offline');});await s.c.poll(pending.origin);assert.equal(s.c.status,'authorizing');s.time(1001);await s.c.poll(pending.origin);assert.equal(s.c.status,'disconnected');assert.match(s.c.message,/истекло/);
});
test('claim 410 asks for a fresh login; origin change cannot redeem old pending session',async()=>{
 const s=setup({pending},async()=>{throw new BrokerError(410,'expired');});await s.c.poll(pending.origin);assert.equal(s.c.status,'disconnected');
 let calls=0;const other=setup({pending},async()=>{calls++;});await other.c.poll('https://other.test');assert.equal(calls,0);assert.equal(other.c.status,'disconnected');
});
test('logout works even if server session expired or network unavailable',async()=>{
 for(const error of [new BrokerError(401,'expired'),new Error('offline')]){
 const s=setup({device:'device',expired:true},async()=>{throw error;});await s.c.logout();assert.deepEqual(s.saved(),{});assert.equal(s.c.status,'disconnected');
 }
});
test('cancelling an in-flight claim cannot reconnect user; issued device is revoked',async()=>{
 let resolve:any;const calls:string[]=[];const s=setup({pending},async(path:string)=>{calls.push(path);if(path==='/claim')return new Promise(r=>resolve=r);return {status:200,data:{}};});
 const poll=s.c.poll(pending.origin);s.c.cancel();resolve({status:200,data:{deviceToken:'late'}});await poll;assert.equal(s.c.status,'disconnected');assert.deepEqual(calls,['/claim','/disconnect']);
});
test('concurrent focus and polling ticks cannot consume the grant twice',async()=>{
 let resolve:any,calls=0;const s=setup({pending},async()=>{calls++;return new Promise(r=>resolve=r);});const first=s.c.poll(pending.origin);await s.c.poll(pending.origin);assert.equal(calls,1);resolve({status:200,data:{deviceToken:'new'}});await first;
});
