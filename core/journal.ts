import {StorageFailure} from './control';
import {hash} from './sync';
export interface JournalIO {exists(path:string):Promise<boolean>;mkdir(path:string):Promise<void>;list(path:string):Promise<{files:string[]}>;read(path:string):Promise<string>;write(path:string,data:string):Promise<void>;rename(from:string,to:string):Promise<void>;remove(path:string):Promise<void>}
/** Immutable, checksummed records. No external side effect may precede an awaited commit. */
export class Journal<S,R>{
 private sequence=0;private queue:Promise<unknown>=Promise.resolve();private failed=false;
 constructor(private io:JournalIO,private dir:string,private apply:(state:S,record:R)=>void){}
 private async decode(path:string){const envelope=JSON.parse(await this.io.read(path));if(typeof envelope.payload!=='string'||await hash(new TextEncoder().encode(envelope.payload).buffer)!==envelope.hash)throw new Error('Повреждён журнал Note Bridge: '+path);return JSON.parse(envelope.payload) as {seq:number;kind:'snapshot'|'record';value:S|R};}
 async load(fallback:S):Promise<S>{
  if(!await this.io.exists(this.dir))await this.io.mkdir(this.dir);
  const files=(await this.io.list(this.dir)).files.filter(p=>/\/\d{12}-(snapshot|record)\.json$/.test(p)).sort();
  const latest=files.filter(p=>p.endsWith('-snapshot.json')).at(-1);let state=fallback;
  if(latest){const data=await this.decode(latest);state=data.value as S;this.sequence=data.seq;}
  for(const path of files){const seq=Number(path.split('/').at(-1)!.slice(0,12));if(seq<=this.sequence)continue;const data=await this.decode(path);if(data.seq!==this.sequence+1||data.kind!=='record')throw new Error('Разрыв журнала Note Bridge');this.apply(state,data.value as R);this.sequence=data.seq;}
  return state;
 }
 private commit(kind:'snapshot'|'record',value:S|R){
  // Serialize at invocation: later mutation cannot change a queued commit.
  const encoded=JSON.stringify(value);
  const task=this.queue.then(async()=>{
   if(this.failed)throw new StorageFailure('Запись журнала прервана; перезапустите Note Bridge');
   const seq=this.sequence+1,payload=JSON.stringify({seq,kind,value:JSON.parse(encoded)}),text=JSON.stringify({payload,hash:await hash(new TextEncoder().encode(payload).buffer)});
   const path=this.dir+'/'+String(seq).padStart(12,'0')+'-'+kind+'.json',temp=path+'.pending';
   try{await this.io.write(temp,text);if(await this.io.read(temp)!==text)throw new Error('Не удалось проверить журнал');await this.io.rename(temp,path);this.sequence=seq;}
   catch(e){this.failed=true;throw new StorageFailure('Ошибка записи журнала: '+String(e));}
   if(kind==='snapshot'){
    // The new snapshot is durable before removing superseded records. Cleanup is optional.
    for(const old of (await this.io.list(this.dir)).files)if(/\/\d{12}-(snapshot|record)\.json$/.test(old)&&Number(old.split('/').at(-1)!.slice(0,12))<seq)await this.io.remove(old).catch(()=>{});
   }
  });this.queue=task.catch(()=>{});return task;
 }
 record(value:R){return this.commit('record',value);}
 snapshot(value:S){return this.commit('snapshot',value);}
}
