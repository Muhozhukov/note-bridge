import {test} from 'node:test';
import assert from 'node:assert/strict';
import {autosyncDelay} from '../core/scheduling';
test('typing and five-second pauses defer the entire burst',()=>{
 const start=1000000;let deadline=start;
 for(let t=start;t<start+60000;t+=5000){deadline=t+autosyncDelay(t,t,0);assert.ok(deadline>t+5000);}
 assert.equal(deadline,start+55000+30000);
});
test('local inactivity does not bypass minimum interval, polling does not restart the idle clock',()=>{
 const start=1000000,lastEdit=start-1000;
 assert.equal(autosyncDelay(start+20000,lastEdit,start),40000);
 assert.equal(autosyncDelay(start+45000,lastEdit,start),15000);
 assert.equal(autosyncDelay(start+60000,lastEdit,start),1000);
});
