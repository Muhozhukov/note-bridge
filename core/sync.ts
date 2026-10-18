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
  read(path: string): Promise<ArrayBuffer>;
  /** Implementations must reject if the current hash differs from expected. */
  write(path: string, bytes: ArrayBuffer, expected?: string): Promise<void>;
  conflict(path: string, bytes: ArrayBuffer, key: string): Promise<void>;
}
export interface Remote {
  scan(): Promise<Map<string,Entry>>;
  read(entry: Entry): Promise<ArrayBuffer>;
  /** Must conditionally update or fail closed; creates must detect duplicate paths. */
  write(path: string, bytes: ArrayBuffer, expected?: Entry): Promise<Entry>;
  snapshot(path: string, bytes: ArrayBuffer, source: string): Promise<void>;
}
export class SyncEngine {
  running = false;
  constructor(private local: Local, private remote: Remote, public baseline: Baseline,
    private checkpoint: (base: Baseline, event: Event)=>Promise<void>) {}
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
      const locals = await this.local.scan(); const remotes = await this.remote.scan();
      const paths = [...new Set([...locals.keys(),...remotes.keys(),...Object.keys(this.baseline)])].sort();
      const fold = new Map<string,string>();
      for (const path of paths) {
        if (!validPath(path)) throw new Error('Небезопасный или неподдерживаемый путь: '+path);
        const k = path.normalize('NFC').toLowerCase();
        if (fold.has(k) && fold.get(k)!==path) throw new Error('Конфликт регистра/Unicode: '+path);
        fold.set(k,path);
      }
      for (const path of paths) {
        const l=locals.get(path), r=remotes.get(path), b=this.baseline[path];
        const action=decide(b?.hash,l?.hash,r?.hash);
        if (dryRun) { if(action!=='none') await emit(path,action); continue; }
        if (action==='none') {
          if(l && r) this.baseline[path]={hash:l.hash,remoteId:r.id};
          else delete this.baseline[path];
          continue;
        }
        if (action==='local-deletion'||action==='remote-deletion') {
          // Alpha deliberately requires manual review of deletions and renames.
          await emit(path,action,'Удаление не распространено; требуется проверка.'); continue;
        }
        if (action==='upload') {
          const bytes=await this.local.read(path);
          if(await hash(bytes)!==l!.hash) throw new Error('Локальный файл изменился во время синка: '+path);
          await this.remote.snapshot(path,bytes,'local');
          if(r) await this.remote.snapshot(path,await this.remote.read(r),'remote-before-upload');
          const result=await this.remote.write(path,bytes,r);
          this.baseline[path]={hash:l!.hash,remoteId:result.id};
        } else {
          const bytes=await this.remote.read(r!);
          if(await hash(bytes)!==r!.hash) throw new Error('Удалённый файл изменился: '+path);
          await this.remote.snapshot(path,bytes,'remote');
          if(action==='conflict') {
            await this.remote.snapshot(path,await this.local.read(path),'local-conflict');
            await this.local.conflict(path,bytes,r!.hash);
            await emit(path,action,'Локальный оригинал сохранён; удалённая версия в Note Bridge Conflicts.');
            continue; // Do not advance baseline until the user resolves the conflict.
          }
          if(l) await this.remote.snapshot(path,await this.local.read(path),'local-before-download');
          await this.local.write(path,bytes,l?.hash);
          this.baseline[path]={hash:r!.hash,remoteId:r!.id};
        }
        await emit(path,action);
      }
      if(!dryRun) await emit('', 'complete');
      return events;
    } finally { this.running=false; }
  }
}
