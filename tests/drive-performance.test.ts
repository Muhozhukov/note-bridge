import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Drive} from '../plugin/src/drive';
import {PerformanceRun} from '../core/performance';
const run=()=>new PerformanceRun({version:'test',platform:'test',trigger:'test',startup:false});
const response=(json:unknown,arrayBuffer=new ArrayBuffer(0))=>({json,arrayBuffer,status:200,headers:{},text:JSON.stringify(json)});
test('upload and verification payloads have separate telemetry',async()=>{
 const bytes=new TextEncoder().encode('new').buffer;
 const d=new Drive('folder',async()=>'token',async p=>{
  if(p.url.includes('/drive/v2/files/')&&!p.url.includes('/upload/'))return response({id:'f',etag:'"v1"',version:'1'});
  if(p.method==='PUT')return response({id:'f',version:'2'});
  if(p.url.endsWith('?alt=media'))return response({},bytes);
  return response({id:'f',version:'2',size:'3'});
 });d.telemetry=run();
 await d.write('a.md',bytes,{path:'a.md',id:'f',version:'1',hash:'old'});
 const report=d.telemetry.report('success');
 assert.equal(report.metrics.note_upload.successfulBytes,3);
 assert.equal(report.metrics.verification_download.successfulBytes,3);
 assert.equal(report.metrics.note_upload.completed,1);
 assert.equal(report.metrics.authorization.failed,0);
});
test('failed upload records attempted payload but not successful bytes',async()=>{
 const d=new Drive('folder',async()=>'token',async()=>{throw new Error('timeout secret');});d.telemetry=run();
 await assert.rejects(d.req({url:'https://example.com',method:'POST'},'note_upload',42));
 const report=d.telemetry.report('error');
 assert.equal(report.metrics.note_upload.failed,1);
 assert.equal(report.metrics.note_upload.attemptedBytes,42);
 assert.equal(report.metrics.note_upload.successfulBytes,0);
 assert.equal(JSON.stringify(report).includes('timeout secret'),false);
});
