export class StorageFailure extends Error {}
export class Paused extends Error { constructor(){super('Синхронизация приостановлена');} }
export type Progress={phase:string;done:number;total:number;path?:string};
export type Control={check?:()=>void;progress?:(value:Progress)=>void};
/** Retry reads only. A timed-out write may already have committed remotely. */
export async function retryRead<T>(operation:()=>Promise<T>,check:()=>void=()=>{},delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))):Promise<T>{
  for(let attempt=0;;attempt++){
    check();
    try{return await operation();}catch(error){
      check();
      if(attempt>=4||!(error instanceof Error)||!(/timeout|timed out|network|fetch|соединен|сети|времени|HTTP (429|500|502|503|504)|rateLimitExceeded|userRateLimitExceeded/i.test(error.message)))throw error;
      await delay(Math.min(16000,1000*2**attempt)+Math.floor(Math.random()*250));
    }
  }
}
/** Stop scheduling after first failure, but drain active work before releasing the lock. */
export async function pool<T>(items:T[],work:(item:T)=>Promise<void>,limit=3){
 let next=0,failed=false,error:unknown;
 const worker=async()=>{while(!failed&&next<items.length){const item=items[next++];try{await work(item);}catch(e){if(!failed){failed=true;error=e;}}}};
 await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));if(failed)throw error;
}
