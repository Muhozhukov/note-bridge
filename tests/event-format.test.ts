import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatDriveMetrics} from '../core/event-format';
test('metrics are readable and raw unknown properties stay out of UI',()=>{
 const rows=formatDriveMetrics(JSON.stringify({requests:5,readBytes:779,writeBytes:60,elapsedMs:2000,unknown:'hidden'}));
 assert.equal(rows.length,4);assert.match(rows[0],/5/);assert.match(rows[1],/779/);assert.match(rows[3],/не длительность/);assert.equal(rows.join('').includes('hidden'),false);
});
test('corrupt and invalid metrics do not crash history',()=>{
 for(const value of ['bad','null','{}','{"requests":-1}','{"requests":"5"}'])assert.equal(formatDriveMetrics(value).length,1);
 assert.match(formatDriveMetrics('{"requests":0}')[0],/0/);
});
