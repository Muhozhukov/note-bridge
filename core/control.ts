export class Paused extends Error { constructor(){super('Синхронизация приостановлена');} }
export type Progress={phase:string;done:number;total:number;path?:string};
export type Control={check?:()=>void;progress?:(value:Progress)=>void};
/** Retry reads only. A timed-out write may already have committed remotely. */
export async function retryRead<T>(operation:()=>Promise<T>,check:()=>void=()=>{},delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))):Promise<T>{
  for(let attempt=0;;attempt++){
    check();
    try{return await operation();}catch(error){
      check();
      if(attempt>=2||!(error instanceof Error)||!(/timeout|timed out|network|fetch|соединен|сети|времени|HTTP (429|500|502|503|504)/i.test(error.message)))throw error;
      await delay(1000*2**attempt);
    }
  }
}
