import {hash,type Entry} from './sync';

export type FileStamp={mtime:number;ctime:number;size:number};
export type LocalRecord=FileStamp&{hash:string;verifiedAt:number};
export const VERIFY_INTERVAL=7*24*60*60*1000;
const same=(a:FileStamp,b:FileStamp)=>a.mtime===b.mtime&&a.ctime===b.ctime&&a.size===b.size;

/** Metadata is a performance hint. Destructive operations must still verify bytes. */
export class LocalIndex {
  private generations=new Map<string,number>();
  constructor(public records:Record<string,LocalRecord>={}){}
  invalidate(path:string){delete this.records[path];this.generations.set(path,(this.generations.get(path)||0)+1);}
  invalidateTree(root:string){for(const path of new Set([...Object.keys(this.records),...this.generations.keys()]))if(path===root||path.startsWith(root+'/'))this.invalidate(path);}
  clear(){for(const path of Object.keys(this.records))this.invalidate(path);}
  prune(paths:Set<string>){for(const path of Object.keys(this.records))if(!paths.has(path))this.invalidate(path);}
  async inspect(path:string,stat:()=>FileStamp,read:()=>Promise<ArrayBuffer>,now=Date.now()){
    // Register before reading so folder renames invalidate in-flight reads, too.
    if(!this.generations.has(path))this.generations.set(path,0);
    const stamp={...stat()},cached=Object.hasOwn(this.records,path)?this.records[path]:undefined,generation=this.generations.get(path);
    const valid=cached&&/^[a-f0-9]{64}$/.test(cached.hash)&&Number.isFinite(cached.verifiedAt)&&cached.verifiedAt<=now&&now-cached.verifiedAt<VERIFY_INTERVAL;
    if(valid&&same(cached,stamp))return {entry:{path,hash:cached.hash} as Entry,hit:true,reason:'metadata',bytes:undefined as ArrayBuffer|undefined};
    const reason=!cached?'missing':!same(cached,stamp)?'changed':'audit';
    const bytes=await read(),checksum=await hash(bytes);
    if(!same(stamp,stat())||this.generations.get(path)!==generation||bytes.byteLength!==stamp.size)throw new Error('Файл изменился во время чтения: '+path);
    Object.defineProperty(this.records,path,{value:{...stamp,hash:checksum,verifiedAt:now},writable:true,enumerable:true,configurable:true});
    return {entry:{path,hash:checksum} as Entry,hit:false,reason,bytes};
  }
}
