import {pool,type Control} from './control';
export type Action = 'none' | 'upload' | 'download' | 'conflict' | 'local-deletion' | 'remote-deletion';
/** Absence is not deletion unless a baseline exists. Never compare wall-clock dates. */
export function decide(base: string | undefined, local: string | undefined, remote: string | undefined): Action {
  if (local === remote) return 'none';
  if (base === undefined) return local === undefined ? 'download' : remote === undefined ? 'upload' : 'conflict';
  if (local === undefined) return 'local-deletion';
  if (remote === undefined) return 'remote-deletion';
  if (local === base) return 'download';
  if (remote === base) return 'upload';
  return 'conflict';
}
export async function hash(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2,'0')).join('');
}
export function validPath(path: string): boolean {
  return !!path && path.length <= 1000 && path.split('/').every(p => !!p && !p.startsWith('.') && !/[\\\x00-\x1f<>:"|?*]/.test(p) && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p)) && !path.startsWith('Note Bridge Conflicts/');
}
export type Entry = { path: string; hash: string; id?: string; version?: string };
export type Baseline = Record<string, {hash: string; remoteId?: string}>;
export type Event = { time: string; path: string; action: string; detail?: string };
export interface Local {
  scan(): Promise<Map<string,Entry>>;
  exists?(path:string):boolean;
  read(path: string): Promise<ArrayBuffer>;
  /** Implementations must reject if the current hash differs from expected. */
  write(path: string, bytes: ArrayBuffer, expected?: string): Promise<void>;
  move?(from:string,to:string,expected:string):Promise<void>;
  trash?(path:string,expected:string):Promise<void>;
  conflict(path: string, bytes: ArrayBuffer, key: string): Promise<void>;
}
export interface Remote {
  scan(): Promise<Map<string,Entry>>;
  read(entry: Entry): Promise<ArrayBuffer>;
  /** Must conditionally update or fail closed; creates must detect duplicate paths. */
  write(path: string, bytes: ArrayBuffer, expected?: Entry): Promise<Entry>;
  trash?(entry:Entry):Promise<void>;
  snapshot(path: string, bytes: ArrayBuffer, source: string): Promise<void>;
}
export class SyncEngine {
  running = false;
  constructor(private local: Local, private remote: Remote, public baseline: Baseline,
    private checkpoint: (base: Baseline, event: Event)=>Promise<void>, private control:Control={}, private deletions:{local?:Set<string>;remote?:Set<string>;conflicts?:Record<string,string>}={}) {}
  async run(dryRun = false): Promise<Event[]> {
    if (this.running) throw new Error('Синхронизация уже выполняется');
    this.running = true;
    const events: Event[] = [];
    const emit = async (path: string, action: string, detail?: string) => {
      const event = {time:new Date().toISOString(),path,action,detail}; events.push(event);
      if (!dryRun) await this.checkpoint(this.baseline,event);
    };
    try {
      // A failed/incomplete scan aborts before any writes. Metadata errors are not deletions.
      this.control.check?.();
      this.control.progress?.({phase:'Проверка локальных файлов',done:0,total:0});
      const locals = await this.local.scan();
      this.control.progress?.({phase:'Сканирование Google Drive',done:0,total:0});
      const remotes = await this.remote.scan();
      // Stable Drive IDs identify remote renames without copying file contents.
      if(!dryRun&&this.local.move){
        const byId=new Map([...remotes.values()].filter(e=>e.id).map(e=>[e.id!,e]));
        for(const [old,b] of Object.entries(this.baseline)){
          const moved=b.remoteId?byId.get(b.remoteId):undefined;
          if(!moved||moved.path===old||remotes.has(old))continue;
          if(this.baseline[moved.path])throw new Error('История целевого пути уже существует: '+moved.path);
          const l=locals.get(old);
          if(l){
            if(l.hash!==b.hash||locals.has(moved.path))throw new Error('Переименование в Drive конфликтует с локальными правками: '+old+' → '+moved.path);
            this.control.check?.();await this.local.move(old,moved.path,l.hash);
            locals.delete(old);locals.set(moved.path,{...l,path:moved.path});
          }
          this.baseline[moved.path]=b;delete this.baseline[old];await emit(moved.path,'rename',old);
        }
      }
      const paths = [...new Set([...locals.keys(),...remotes.keys(),...Object.keys(this.baseline)])].sort();
      const fold = new Map<string,string>();
      // Historical paths absent on both sides must not block a renamed folder.
      for (const path of new Set([...locals.keys(),...remotes.keys()])) {
        if (!validPath(path)) throw new Error('Небезопасный или неподдерживаемый путь: '+path);
        let prefix='';
        for(const part of path.split('/')){
          prefix=prefix?prefix+'/'+part:part;
          const k=prefix.normalize('NFC').toLowerCase();
          if(fold.has(k)&&fold.get(k)!==prefix)throw new Error('Конфликт регистра/Unicode: '+JSON.stringify(fold.get(k))+' и '+JSON.stringify(prefix)+'. Согласуйте имена на телефоне и в Drive.');
          fold.set(k,prefix);
        }
      }
      const total=paths.filter(p=>decide(this.baseline[p]?.hash,locals.get(p)?.hash,remotes.get(p)?.hash)!=='none').length;
      let done=0;
      this.control.progress?.({phase:'Синхронизация',done,total});
      await pool(paths,async(path)=>{
        this.control.check?.();
        const l=locals.get(path), r=remotes.get(path), b=this.baseline[path];
        const action=decide(b?.hash,l?.hash,r?.hash);
        if(action!=='none')this.control.progress?.({phase:dryRun?'Предпросмотр':'Синхронизация',done,total,path});
        const advance=()=>this.control.progress?.({phase:'Синхронизация',done:++done,total,path});
        if (dryRun) { if(action!=='none') await emit(path,action); if(action!=='none')advance(); return; }
        if (action==='none') {
          if(l && r) this.baseline[path]={hash:l.hash,remoteId:r.id};
          else delete this.baseline[path];
          return;
        }
        if (action==='local-deletion'||action==='remote-deletion') {
          if(action==='local-deletion'&&r&&r.hash===b?.hash&&r.id===b.remoteId&&this.deletions.local?.has(path)&&this.remote.trash){
            if(this.local.exists?.(path))throw new Error('Локальный файл появился перед удалением: '+path);
            await this.remote.trash(r);delete this.baseline[path];await emit(path,'resolution-trash-remote','Удаление передано автоматически: версия Drive не менялась');advance();return;
          }
          if(action==='remote-deletion'&&l&&l.hash===b?.hash&&b.remoteId&&this.deletions.remote?.has(b.remoteId)&&this.local.trash){
            await this.remote.snapshot(path,await this.local.read(path),'local-before-delete');await this.local.trash(path,l.hash);delete this.baseline[path];await emit(path,'resolution-trash-local','Удаление передано автоматически: локальная версия не менялась');advance();return;
          }
          // Unknown absence or concurrent edit needs explicit review.
          await emit(path,action,'Удаление не распространено; требуется проверка.'); advance(); return;
        }
        if (action==='upload') {
          const bytes=await this.local.read(path);
          if(await hash(bytes)!==l!.hash) throw new Error('Локальный файл изменился во время синка: '+path);
          // First upload already creates a durable copy; snapshot only before overwrite.
          if(r)await this.remote.snapshot(path,bytes,'local');
          if(r) await this.remote.snapshot(path,await this.remote.read(r),'remote-before-upload');
          const result=await this.remote.write(path,bytes,r);
          this.baseline[path]={hash:l!.hash,remoteId:result.id};
        } else {
          const fingerprint=l?.hash+'|'+r?.id+'|'+r?.hash;
          if(action==='conflict'&&this.deletions.conflicts?.[path]===fingerprint){await emit(path,action,'Ожидает решения; версии не изменились');advance();return;}
          const bytes=await this.remote.read(r!);
          if(await hash(bytes)!==r!.hash) throw new Error('Удалённый файл изменился: '+path);
          if(action==='conflict') {
            await this.remote.snapshot(path,bytes,'remote-conflict');
            await this.remote.snapshot(path,await this.local.read(path),'local-conflict');
            await this.local.conflict(path,bytes,r!.hash);
            if(this.deletions.conflicts)this.deletions.conflicts[path]=fingerprint;
            await emit(path,action,'Локальный оригинал сохранён; удалённая версия в Note Bridge Conflicts.');
            advance(); return; // Do not advance baseline until the user resolves the conflict.
          }
          if(l) await this.remote.snapshot(path,await this.local.read(path),'local-before-download');
          await this.local.write(path,bytes,l?.hash);
          this.baseline[path]={hash:r!.hash,remoteId:r!.id};
        }
        await emit(path,action); advance();
      },dryRun?1:3);

      this.control.check?.();
      if(!dryRun) await emit('', 'complete');
      this.control.progress?.({phase:'Завершено',done:total,total});
      return events;
    } finally { this.running=false; }
  }
}
