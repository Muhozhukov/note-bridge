export type Outcome='running'|'success'|'issues'|'error'|'paused'|'interrupted';
export type Metric={calls:number;completed:number;failed:number;successfulBytes:number;attemptedBytes:number;totalMs:number;activeMs:number;maxMs:number;bytesPerSecond:number|null;operationsPerSecond:number|null;p50Ms:number|null;p95Ms:number|null;sampleCount:number};
type Bucket={calls:number;completed:number;failed:number;successfulBytes:number;attemptedBytes:number;totalMs:number;maxMs:number;samples:number[];intervals:[number,number][]};
export type PerformanceReport={schema:1;runId:string;startedAt:string;endedAt:string|null;version:string;platform:string;trigger:string;startup:boolean;outcome:Outcome;wallMs:number|null;counters:Record<string,number>;metrics:Record<string,Metric>;rates:{localFilesPerSecond:number|null;driveIndexEntriesPerSecond:number|null;driveChangesPerSecond:number|null}};
function activeTime(intervals:[number,number][]){let result=0,end=-Infinity;for(const [a,b] of [...intervals].sort((x,y)=>x[0]-y[0])){result+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}return result;}
/** Monotonic clocks; overlapping requests are not counted twice in throughput. */
export class PerformanceRun {
  private start:number;private buckets=new Map<string,Bucket>();
  readonly counters:Record<string,number>={};readonly runId=crypto.randomUUID();readonly startedAt=new Date().toISOString();
  constructor(private context:{version:string;platform:string;trigger:string;startup:boolean},private clock=()=>performance.now()){this.start=clock();}
  count(key:string,n=1){this.counters[key]=(this.counters[key]||0)+n;}
  begin(name:string){
    const start=this.clock();let done=false;
    return (success:boolean,bytes=0,attemptedBytes=bytes)=>{
      if(done)return;done=true;const end=this.clock(),duration=Math.max(0,end-start);
      const b=this.buckets.get(name)||{calls:0,completed:0,failed:0,successfulBytes:0,attemptedBytes:0,totalMs:0,maxMs:0,samples:[],intervals:[]};
      b.calls++;if(success){b.completed++;b.successfulBytes+=bytes;}else b.failed++;
      b.attemptedBytes+=attemptedBytes;b.totalMs+=duration;b.maxMs=Math.max(b.maxMs,duration);b.samples.push(duration);if(b.samples.length>256)b.samples.shift();
      b.intervals.push([start,end]);
      this.buckets.set(name,b);
    };
  }
  async measure<T>(name:string,fn:()=>Promise<T>,size?:(value:T)=>number){const end=this.begin(name);try{const value=await fn();end(true,size?.(value)||0);return value;}catch(e){end(false);throw e;}}
  report(outcome:Outcome):PerformanceReport{
    const metrics:Record<string,Metric>={};
    for(const [name,b] of this.buckets){const activeMs=activeTime(b.intervals),samples=[...b.samples].sort((a,c)=>a-c);metrics[name]={calls:b.calls,completed:b.completed,failed:b.failed,successfulBytes:b.successfulBytes,attemptedBytes:b.attemptedBytes,totalMs:b.totalMs,activeMs,maxMs:b.maxMs,bytesPerSecond:activeMs>0&&b.successfulBytes>0?b.successfulBytes*1000/activeMs:null,operationsPerSecond:activeMs>0?b.completed*1000/activeMs:null,p50Ms:samples.length?samples[Math.ceil(samples.length*.5)-1]:null,p95Ms:samples.length?samples[Math.ceil(samples.length*.95)-1]:null,sampleCount:samples.length};}
    const rate=(count:number,ms:number|undefined)=>count>0&&ms&&ms>0?count*1000/ms:null;
    return {schema:1,runId:this.runId,startedAt:this.startedAt,endedAt:outcome==='running'?null:new Date().toISOString(),...this.context,outcome,wallMs:Math.max(0,this.clock()-this.start),counters:{...this.counters},metrics,rates:{localFilesPerSecond:rate(this.counters.local_files,metrics.local_check?.activeMs),driveIndexEntriesPerSecond:rate(this.counters.drive_index_entries,metrics.drive_check?.activeMs),driveChangesPerSecond:rate(this.counters.drive_changes_received,metrics.drive_check?.activeMs)}};
  }
}
