import type {PerformanceReport} from './performance';
import type {JournalIO} from './journal';
/** Separate local diagnostic files, never part of the synchronization index. */
export class PerformanceLog {
  constructor(private io:JournalIO,private dir:string,private limit=200){}
  private name(r:PerformanceReport){return r.startedAt.replace(/[:.]/g,'-')+'_'+r.runId;}
  async save(r:PerformanceReport){
    if(!await this.io.exists(this.dir))await this.io.mkdir(this.dir);
    const base=this.dir+'/'+this.name(r),path=base+(r.outcome==='running'?'.running.json':'.json');
    await this.io.write(path,JSON.stringify(r));
    if(r.outcome!=='running'&&await this.io.exists(base+'.running.json'))await this.io.remove(base+'.running.json');
    const files=(await this.io.list(this.dir)).files.filter(p=>/\.json$/.test(p)).sort();
    for(const old of files.slice(0,Math.max(0,files.length-this.limit)))await this.io.remove(old);
  }
  async read(activeRunId?:string){
    if(!await this.io.exists(this.dir))return {runs:[] as PerformanceReport[],unreadable:0};
    const runs=new Map<string,PerformanceReport>();let unreadable=0;
    for(const path of (await this.io.list(this.dir)).files.filter(p=>p.endsWith('.json')).sort()){
      try{const r=JSON.parse(await this.io.read(path)) as PerformanceReport;if(r.schema!==1||typeof r.runId!=='string'||!r.metrics)throw new Error('Invalid report');
        if(r.outcome==='running'&&r.runId!==activeRunId){r.outcome='interrupted';r.wallMs=null;r.endedAt=null;}
        const existing=runs.get(r.runId);if(!existing||existing.outcome==='running'||existing.outcome==='interrupted')runs.set(r.runId,r);
      }catch{unreadable++;}
    }
    return {runs:[...runs.values()].sort((a,b)=>a.startedAt.localeCompare(b.startedAt)),unreadable};
  }
}
