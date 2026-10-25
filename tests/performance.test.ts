import {test} from 'node:test';import assert from 'node:assert/strict';
import {PerformanceRun} from '../core/performance';
import {PerformanceLog} from '../core/performance-log';
import type {JournalIO} from '../core/journal';
const context={version:'test',platform:'mobile',trigger:'automatic',startup:true};
test('overlapping operations report wall time and summed time separately',()=>{
  let now=0;const run=new PerformanceRun(context,()=>now),a=run.begin('note_upload');now=10;const b=run.begin('note_upload');now=20;a(true,100);now=30;b(true,100);
  const report=run.report('success'),m=report.metrics.note_upload;assert.equal(m.totalMs,40);assert.equal(m.activeMs,30);assert.equal(report.wallMs,30);assert.equal(m.bytesPerSecond,200*1000/30);assert.equal(m.completed,2);
});
test('failed attempts retain duration and attempted bytes without inventing successful throughput',async()=>{
  let now=0;const run=new PerformanceRun(context,()=>now),end=run.begin('note_upload');now=20;end(false,0,100);
  await assert.rejects(run.measure('drive_check',async()=>{now=35;throw Error('secret file name');}));
  const report=run.report('error');assert.equal(report.metrics.note_upload.failed,1);assert.equal(report.metrics.note_upload.attemptedBytes,100);assert.equal(report.metrics.note_upload.bytesPerSecond,null);assert.equal(report.metrics.drive_check.totalMs,15);assert.ok(!JSON.stringify(report).includes('secret file'));
});
test('zero-duration operations never produce Infinity or NaN',()=>{const run=new PerformanceRun(context,()=>0),end=run.begin('note_download');end(true,42);end(true,42);const m=run.report('success').metrics.note_download;assert.equal(m.calls,1);assert.equal(m.bytesPerSecond,null);assert.equal(m.operationsPerSecond,null);});
test('latency sample remains bounded while totals cover all operations',()=>{let now=0;const run=new PerformanceRun(context,()=>now);for(let i=0;i<1000;i++){const end=run.begin('metadata');now++;end(true);}const m=run.report('success').metrics.metadata;assert.equal(m.calls,1000);assert.equal(m.sampleCount,256);assert.equal(m.totalMs,1000);assert.equal(m.activeMs,1000);assert.equal(m.p95Ms,1);});
class Disk implements JournalIO{
  files=new Map<string,string>();async exists(p:string){return p==='logs'||this.files.has(p);}async mkdir(_p:string){}async list(_p:string){return {files:[...this.files.keys()]};}async read(p:string){return this.files.get(p)!;}async write(p:string,text:string){this.files.set(p,text);}async rename(a:string,b:string){this.files.set(b,this.files.get(a)!);this.files.delete(a);}async remove(p:string){this.files.delete(p);}
}
test('unfinished run is marked interrupted with unknown duration after restart',async()=>{const disk=new Disk(),log=new PerformanceLog(disk,'logs'),run=new PerformanceRun(context);await log.save(run.report('running'));const data=await log.read();assert.equal(data.runs[0].outcome,'interrupted');assert.equal(data.runs[0].wallMs,null);assert.equal(data.runs[0].endedAt,null);assert.equal((await log.read(run.runId)).runs[0].outcome,'running');});
test('final report supersedes start marker and retention is bounded',async()=>{const disk=new Disk(),log=new PerformanceLog(disk,'logs',3);for(let i=0;i<5;i++){const run=new PerformanceRun(context),start=run.report('running');start.startedAt=new Date(1000*i).toISOString();await log.save(start);await log.save({...start,outcome:'success',endedAt:new Date(1000*i+100).toISOString(),wallMs:100});}const data=await log.read();assert.equal(data.runs.length,3);assert.ok(data.runs.every(r=>r.outcome==='success'));assert.equal(disk.files.size,3);});
test('corrupt diagnostic record does not prevent export of intact records',async()=>{const disk=new Disk(),log=new PerformanceLog(disk,'logs');await log.save(new PerformanceRun(context).report('success'));disk.files.set('logs/bad.json','broken');const data=await log.read();assert.equal(data.runs.length,1);assert.equal(data.unreadable,1);});
