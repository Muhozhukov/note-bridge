import {hash,type Local,type Remote,type Entry} from './sync';
/** Commit remote first; keep the baseline unchanged unless both writes succeed. */
export async function mergeVersions(path:string,text:string,local:Local,remote:Remote,l:Entry,r:Entry){
 const original=await local.read(path);if(await hash(original)!==l.hash)throw new Error('Текст телефона изменился');
 const bytes=new TextEncoder().encode(text).buffer;
 if(bytes.byteLength>10*1024*1024)throw new Error('Результат превышает лимит 10 МиБ');
 const remoteOriginal=await remote.read(r);
 if(await hash(remoteOriginal)!==r.hash)throw new Error('Текст Drive изменился');
 await remote.snapshot(path,original,'before-merge-local');await remote.snapshot(path,remoteOriginal,'before-merge-remote');
 const saved=await remote.write(path,bytes,r);
 try{await local.write(path,bytes,l.hash);}catch(e){throw new Error('Итог сохранён в Drive, но телефон не обновлён: '+String(e)+'. Локальный текст сохранён. Закройте сравнение и обновите список; не повторяйте сохранение вслепую.');}
 return {hash:await hash(bytes),remoteId:saved.id};
}
