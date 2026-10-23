import {retryRead,type Control} from '../../core/control';
import type {RequestUrlParam, RequestUrlResponse} from 'obsidian';
import {hash,validPath,type Remote,type Entry} from '../../core/sync';
export const HISTORY='.note-bridge-history';
const API='https://www.googleapis.com/drive/v3/files';
const FOLDER='application/vnd.google-apps.folder';
type FileMeta={id:string;name:string;mimeType:string;version:string;sha256Checksum?:string;size?:string;trashed?:boolean;parents?:string[]};
const fields='id,name,mimeType,version,sha256Checksum,size,trashed,parents';
function quote(s:string){return s.replaceAll('\\','\\\\').replaceAll("'","\\'");}
function buffer(bytes:Uint8Array):ArrayBuffer{return bytes.slice().buffer;}
export type DriveIndex={deletedIds?:string[];historyId?:string;root:string;token:string;entries:Entry[];folders:[string,string][];folderMeta:[string,FileMeta][]};
export type WriteIntent={id:string;path:string;hash:string;expected?:Entry};
export type DriveHooks={pending:Record<string,WriteIntent>;history:Record<string,Entry>;intent:(key:string,value:WriteIntent|null)=>Promise<void>;savedHistory:(hash:string,entry:Entry)=>Promise<void>};
export class Drive implements Remote {
  hooks?:DriveHooks;
  onUnauthorized?:()=>void;
  metrics={requests:0,readBytes:0,writeBytes:0,elapsedMs:0};
  private entriesRef?:Entry[];private entriesById=new Map<string,Entry>();
  private positions=new Map<string,number>();private paths=new Map<string,Entry>();
  entryForPath(path:string){this.ensureEntryMaps();return this.paths.get(path);}
  private ensureEntryMaps(){if(this.index&&this.entriesRef!==this.index.entries){this.entriesRef=this.index.entries;this.entriesById=new Map(this.index.entries.map(e=>[e.id!,e]));this.positions=new Map(this.index.entries.map((e,i)=>[e.id!,i]));this.paths=new Map(this.index.entries.map(e=>[e.path,e]));}}
  private indexEntry(entry:Entry){
    if(!this.index)return;
    this.ensureEntryMaps();
    const pos=this.positions.get(entry.id!);
    if(pos===undefined){this.positions.set(entry.id!,this.index.entries.length);this.index.entries.push(entry);}else this.index.entries[pos]=entry;
    const old=this.entriesById.get(entry.id!);if(old)this.paths.delete(old.path);this.paths.set(entry.path,entry);this.entriesById.set(entry.id!,entry);
  }

  index?:DriveIndex;
  deletedIds=new Set<string>();
  async scan():Promise<Map<string,Entry>> {
    const previous=this.index;
    if(!previous||previous.root!==this.root)return this.rebuild();
    const changes=new Map<string,{fileId:string;removed?:boolean;file?:FileMeta}>();
    let token=previous.token,nextToken='';
    do {
      const q=new URLSearchParams({pageToken:token,pageSize:'1000',spaces:'drive',includeRemoved:'true',fields:`nextPageToken,newStartPageToken,changes(fileId,removed,file(${fields}))`});
      let response;try{response=await this.req({url:'https://www.googleapis.com/drive/v3/changes?'+q});}catch(e){if(String(e).includes('HTTP 410'))return this.rebuild();throw e;}
      const data=response.json;if(!Array.isArray(data.changes))throw new Error('Неполная лента изменений Drive');
      for(const change of data.changes)changes.set(change.fileId,change);
      token=data.nextPageToken||'';if(!token)nextToken=data.newStartPageToken||'';
    }while(token);
    if(!nextToken)throw new Error('Drive не вернул курсор изменений');
    const oldFolders=new Map(previous.folders),oldEntries=new Map(previous.entries.map(e=>[e.id!,e]));
    const folderIds=new Set(oldFolders.values()),oldFolderMeta=new Map(previous.folderMeta),nodes=new Map<string,FileMeta>();
    const parentFor=(path:string)=>oldFolders.get(path.split('/').slice(0,-1).join('/'));
    for(const [path,id] of oldFolders)if(path){const meta=oldFolderMeta.get(path);nodes.set(id,{...meta,id,name:path.split('/').at(-1)!,version:meta?.version||'',mimeType:FOLDER,parents:[parentFor(path)!]});}
    for(const e of previous.entries)nodes.set(e.id!,{id:e.id!,name:e.path.split('/').at(-1)!,version:e.version||'',mimeType:'application/octet-stream',sha256Checksum:e.hash,parents:[parentFor(e.path)!]});
    const deleted=new Set(previous.deletedIds||[]);
    for(const change of changes.values()){
      const f=change.file;
      if(change.fileId===this.root){if(change.removed||!f||f.trashed||f.mimeType!==FOLDER)throw new Error('Выбранная папка недоступна');continue;}
      if(change.removed||!f||f.trashed){
        if(f?.trashed){
          if(oldEntries.has(change.fileId))deleted.add(change.fileId);
          const oldPath=previous.folders.find(([,id])=>id===change.fileId)?.[0];
          if(oldPath)for(const e of previous.entries)if(e.path.startsWith(oldPath+'/'))deleted.add(e.id!);
        }
        nodes.delete(change.fileId);
      }else nodes.set(f.id,f);
    }
    const children=new Map<string,FileMeta[]>();
    for(const f of nodes.values())for(const parent of f.parents||[]){const list=children.get(parent)||[];list.push(f);children.set(parent,list);}
    const folders=new Map<string,string>([['',this.root]]),folderMeta=new Map<string,FileMeta>(),output=new Map<string,Entry>(),fold=new Map<string,string>(),visited=new Set<string>();
    const walk=async(id:string,prefix:string,depth:number,fresh=false)=>{
      if(depth>30)throw new Error('Слишком большая глубина папок');
      if(visited.has(id))throw new Error('Цикл в структуре Drive');visited.add(id);
      const list=fresh?await this.children(id):children.get(id)||[];
      const seen=new Set<string>();
      for(const f of list){
        if(f.trashed||f.name.startsWith('.')||f.name==='Note Bridge Conflicts')continue;
        const path=prefix?prefix+'/'+f.name:f.name;
        if(!validPath(path)||f.name.includes('/'))throw new Error('Неподдерживаемое имя Drive: '+path);
        if(seen.has(f.name))throw new Error('В Drive два объекта с одинаковым именем: '+path);seen.add(f.name);
        const normalized=path.normalize('NFC').toLowerCase();if(fold.has(normalized)&&fold.get(normalized)!==path)throw new Error('Конфликт регистра/Unicode: '+path);fold.set(normalized,path);
        if(f.mimeType===FOLDER){folders.set(path,f.id);folderMeta.set(path,f);await walk(f.id,path,depth+1,fresh||!folderIds.has(f.id));continue;}
        if(f.mimeType.startsWith('application/vnd.google-apps.')||Number(f.size)>this.maxBytes)throw new Error('Неподдерживаемый файл Drive: '+path);
        const old=oldEntries.get(f.id),entry:Entry={path,id:f.id,version:f.version,hash:f.sha256Checksum||(old?.version===f.version?old.hash:'')};
        if(!entry.hash){const bytes=await this.download(entry);entry.hash=await hash(bytes);if(this.cachedBytes+bytes.byteLength<=20*1024*1024){this.cache.set(entry.id!+'|'+entry.version,bytes);this.cachedBytes+=bytes.byteLength;}}
        deleted.delete(f.id);output.set(path,entry);
      }
    };
    await walk(this.root,'',0);
    this.folders=folders;this.folderMeta=folderMeta;
    this.deletedIds.clear();for(const id of deleted)this.deletedIds.add(id);
    this.index={...previous,token:nextToken,entries:[...output.values()],deletedIds:[...deleted],folders:[...folders],folderMeta:[...folderMeta]};
    return output;
  }
  async rebuild():Promise<Map<string,Entry>> {
    const token=(await this.req({url:'https://www.googleapis.com/drive/v3/changes/startPageToken'})).json.startPageToken;
    if(!token)throw new Error('Drive не вернул начальный курсор');
    const output=await this.fullScan();
    this.index={root:this.root,token,deletedIds:(this.index?.deletedIds||[]).filter(id=>![...output.values()].some(e=>e.id===id)),historyId:this.index?.historyId,entries:[...output.values()],folders:[...this.folders],folderMeta:[...this.folderMeta]};
    this.deletedIds.clear();for(const id of this.index.deletedIds||[])this.deletedIds.add(id);return output;
  }

  folders=new Map<string,string>(); historyId='';
  folderMeta=new Map<string,FileMeta>();
  private folderRequests=new Map<string,Promise<string>>();
  private cache=new Map<string,ArrayBuffer>(); private cachedBytes=0; scanned=0;
  constructor(public root:string,private getToken:()=>Promise<string>,private transport:(params:RequestUrlParam)=>Promise<RequestUrlResponse>,private maxBytes=10*1024*1024,private control:Control={}) {
    if(!/^[\w-]+$/.test(root)||root==='root')throw new Error('Укажите ID отдельной папки Drive, не корень диска');
    this.folders.set('',root);
  }
  private ids:string[]=[];private idRequest?:Promise<void>;
  async reserveId():Promise<string>{
    while(!this.ids.length){if(!this.idRequest)this.idRequest=(async()=>{const ids=(await this.req({url:API+'/generateIds?count=32&space=drive&type=files'})).json.ids;if(!Array.isArray(ids)||!ids.length)throw new Error('Drive не вернул ID операций');this.ids.push(...ids);})().finally(()=>{this.idRequest=undefined;});await this.idRequest;}
    return this.ids.pop()!;
  }
  async req(params:RequestUrlParam):Promise<RequestUrlResponse> {
    let refreshed=false;
    const execute=async():Promise<RequestUrlResponse>=>{
      this.control.check?.();
      const started=Date.now();this.metrics.requests++;if(params.body)this.metrics.writeBytes+=typeof params.body==='string'?new TextEncoder().encode(params.body).byteLength:params.body.byteLength;
      const response=await this.transport({...params,headers:{...params.headers,Authorization:'Bearer '+await this.getToken()},throw:false});
      this.metrics.elapsedMs+=Date.now()-started;this.metrics.readBytes+=response.arrayBuffer?.byteLength||0;
      if(response.status===401&&!refreshed&&this.onUnauthorized){refreshed=true;this.onUnauthorized();return execute();}
      if(response.status>=400){let reason='';try{reason=response.json?.error?.errors?.[0]?.reason||'';}catch{}throw new Error('Drive HTTP '+response.status+' '+reason+(response.status===412?' — файл изменился, повторите синк':''));}
      return response;
    };
    return (!params.method||params.method==='GET')?retryRead(execute,()=>this.control.check?.()):execute();
  }

  async meta(id:string){return this.req({url:API+'/'+encodeURIComponent(id)+'?fields='+fields});}
  async children(id:string,name?:string):Promise<FileMeta[]> {
    const found:FileMeta[]=[];let page='';
    do {
      const q=new URLSearchParams({q:`'${quote(id)}' in parents and trashed = false`+(name===undefined?'':` and name = '${quote(name)}'`),pageSize:'1000',fields:`nextPageToken,incompleteSearch,files(${fields})`});if(page)q.set('pageToken',page);
      const response=await this.req({url:API+'?'+q});
      const result=response.json as {nextPageToken?:string;incompleteSearch?:boolean;files:FileMeta[]};
      if(result.incompleteSearch||!Array.isArray(result.files))throw new Error('Неполный ответ Drive; синк остановлен');
      found.push(...result.files);page=result.nextPageToken||'';
    }while(page);return found;
  }
  async fullScan():Promise<Map<string,Entry>> {
    const root=(await this.meta(this.root)).json as FileMeta;
    if(root.mimeType!==FOLDER||root.trashed)throw new Error('Выбранная папка недоступна');
    const output=new Map<string,Entry>();this.folders=new Map([['',this.root]]);this.folderMeta.clear();this.scanned=0;
    const walk=async(id:string,prefix:string,depth:number)=>{
      if(depth>30)throw new Error('Слишком большая глубина папок');
      const seen=new Set<string>();
      for(const f of await this.children(id)) {
        if(!prefix&&f.name===HISTORY)continue;
        if(f.name.startsWith('.')||f.name==='Note Bridge Conflicts')continue;
        const path=prefix?prefix+'/'+f.name:f.name;
        if(seen.has(f.name))throw new Error('В Drive два объекта с одинаковым именем: '+JSON.stringify(path)+'. Уберите дубликат из синхронизируемой папки.');
        if(!validPath(path)||f.name.includes('/'))throw new Error('Неподдерживаемое имя Drive: '+JSON.stringify(path)+'. Проверьте пробел/точку в конце, символы / \\ : * ? \" < > | и служебные имена. Кириллица разрешена.');
        seen.add(f.name);
        if(f.mimeType===FOLDER){this.folders.set(path,f.id);this.folderMeta.set(path,f);await walk(f.id,path,depth+1);continue;}
        if(f.mimeType.startsWith('application/vnd.google-apps.'))throw new Error('Используйте обычные файлы, не Google Docs/ярлыки: '+path);
        if(Number(f.size)>this.maxBytes)throw new Error('Файл больше лимита 10 МБ: '+path);
        const entry:Entry={path,id:f.id,version:f.version,hash:f.sha256Checksum||''};
        if(!entry.hash){
          const bytes=await this.download(entry);entry.hash=await hash(bytes);
          if(this.cachedBytes+bytes.byteLength<=20*1024*1024){this.cache.set(entry.id!+'|'+entry.version,bytes);this.cachedBytes+=bytes.byteLength;}
        }
        this.control.progress?.({phase:'Сканирование Google Drive: найдено '+(++this.scanned),done:0,total:0,path});
        output.set(path,entry);
      }
    };
    await walk(this.root,'',0);return output;
  }
  async download(entry:Entry):Promise<ArrayBuffer> {
    // A strong checksum from the listing proves the bytes match the planned revision.
    // Keep version bracketing only for files without a checksum.
    if(entry.hash){
      const bytes=(await this.req({url:API+'/'+entry.id+'?alt=media'})).arrayBuffer;
      if(bytes.byteLength>this.maxBytes)throw new Error('Файл превышает лимит');
      if(await hash(bytes)!==entry.hash)throw new Error('Контрольная сумма Drive изменилась: '+entry.path);
      return bytes;
    }
    const before=(await this.meta(entry.id!)).json as FileMeta;
    if(before.version!==entry.version||before.trashed)throw new Error('Версия Drive изменилась: '+entry.path);
    if(Number(before.size)>this.maxBytes)throw new Error('Файл превышает лимит');
    const bytes=(await this.req({url:API+'/'+entry.id+'?alt=media'})).arrayBuffer;
    if(bytes.byteLength>this.maxBytes)throw new Error('Файл превышает лимит');
    const after=(await this.meta(entry.id!)).json as FileMeta;
    if(after.version!==entry.version||after.trashed)throw new Error('Drive изменился во время чтения');
    return bytes;
  }
  async read(entry:Entry){const key=entry.id+'|'+entry.version;const cached=this.cache.get(key);if(cached){this.cache.delete(key);this.cachedBytes-=cached.byteLength;}const bytes=cached||await this.download(entry);if(entry.hash&&await hash(bytes)!==entry.hash)throw new Error('Контрольная сумма Drive изменилась');return bytes;}
  async folder(name:string,parent:string):Promise<string>{
    const key=parent+'/'+name;const pending=this.folderRequests.get(key);if(pending)return pending;
    const request=this.ensureFolder(name,parent);this.folderRequests.set(key,request);
    try{return await request;}finally{this.folderRequests.delete(key);}
  }
  private async ensureFolder(name:string,parent:string):Promise<string> {
    const matches=(await this.children(parent,name)).filter(f=>f.name===name);
    if(matches.length>1||matches.some(f=>f.mimeType!==FOLDER))throw new Error('Конфликт папки '+name);
    if(matches[0])return matches[0].id;
    const key='folder|'+parent+'/'+name;let intent=this.hooks?.pending[key];
    if(this.hooks&&!intent){intent={id:await this.reserveId(),path:name,hash:''};await this.hooks.intent(key,intent);}
    const result=await this.req({url:API+'?fields=id',method:'POST',contentType:'application/json',body:JSON.stringify({name,mimeType:FOLDER,parents:[parent],...(intent?{id:intent.id}:{})})});
    // Concurrent devices may both create a folder. Stop rather than silently split the tree.
    const check=(await this.children(parent,name)).filter(f=>f.name===name);
    if(check.length!==1)throw new Error('Одновременное создание папки; устраните дубликаты в Drive');
    return result.json.id as string;
  }
  async parent(path:string):Promise<string>{
    const parts=path.split('/').slice(0,-1);let key='',parent=this.root;
    for(const part of parts){key=key?key+'/'+part:part;let id=this.folders.get(key);if(!id){id=await this.folder(part,parent);this.folders.set(key,id);}parent=id;}return parent;
  }
  async create(name:string,parent:string,bytes:ArrayBuffer,mimeType='application/octet-stream',id?:string,description?:string):Promise<FileMeta>{
    const boundary='nb_'+crypto.randomUUID();const enc=new TextEncoder();
    const head=enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({name,parents:[parent],mimeType,...(id?{id}:{}),...(description?{description}:{})})}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const tail=enc.encode(`\r\n--${boundary}--\r\n`);const data=new Uint8Array(head.length+bytes.byteLength+tail.length);
    data.set(head);data.set(new Uint8Array(bytes),head.length);data.set(tail,head.length+bytes.byteLength);
    const response=await this.req({url:'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields='+fields,method:'POST',contentType:'multipart/related; boundary='+boundary,body:buffer(data)});
    return response.json as FileMeta;
  }
  async write(path:string,bytes:ArrayBuffer,expected?:Entry):Promise<Entry>{
    if(bytes.byteLength>this.maxBytes)throw new Error('Файл превышает лимит');
    let result:FileMeta;
    const checksum=await hash(bytes),key=path+'|'+checksum;
    let intent=this.hooks?.pending[key];
    if(intent){
      // Recover successful writes whose response/checkpoint was lost. Never overwrite a newer revision.
      let existing:FileMeta|undefined;
      try{existing=(await this.meta(intent.id)).json;}catch(e){if(!String(e).includes('HTTP 404'))throw e;}
      if(existing&&!existing.trashed&&existing.name===path.split('/').at(-1)){
        const parent=this.folders.get(path.split('/').slice(0,-1).join('/'));
        if(parent&&existing.parents?.includes(parent)){
          const recovered:Entry={path,id:existing.id,version:existing.version,hash:existing.sha256Checksum||''};
          if(!recovered.hash)recovered.hash=await hash(await this.download(recovered));
          if(recovered.hash===checksum){this.indexEntry(recovered);return recovered;}
        }
      }
      if(existing&&!intent.expected)throw new Error('Зарезервированный файл изменён; требуется проверка: '+path);
    }
    if(!intent&&this.hooks){
      const id=expected?.id||await this.reserveId();
      if(!id)throw new Error('Drive не вернул ID операции');
      intent={id,path,hash:checksum,expected};await this.hooks.intent(key,intent);
    }
    if(expected){
      const current=await this.req({url:'https://www.googleapis.com/drive/v2/files/'+expected.id+'?fields=id,etag,version,labels(trashed)'});
      const meta=current.json as {version:string;etag?:string;labels?:{trashed?:boolean}};
      if(meta.version!==expected.version||meta.labels?.trashed)throw new Error('Drive изменился перед записью');
      const etag=meta.etag;
      // Never silently fall back to a blind overwrite. Live Drive validation is a release gate.
      if(!etag)throw new Error('Drive не вернул ETag: безопасная перезапись заблокирована');
      result=(await this.req({url:'https://www.googleapis.com/upload/drive/v2/files/'+expected.id+'?uploadType=media&fields=id,version',method:'PUT',headers:{'If-Match':etag},contentType:'application/octet-stream',body:bytes})).json as FileMeta;
    }else{
      const parent=await this.parent(path),name=path.split('/').at(-1)!;
      if((await this.children(parent,name)).some(f=>f.name===name))throw new Error('Файл уже появился в Drive: '+path);
      result=await this.create(name,parent,bytes,path.endsWith('.md')?'text/markdown':'application/octet-stream',intent?.id);
      if((await this.children(parent,name)).filter(f=>f.name===name).length!==1)throw new Error('Одновременное создание файла; обе копии сохранены в Drive');
    }
    const entry={path,id:result.id,version:result.version,hash:checksum};
    if(result.sha256Checksum){if(result.sha256Checksum!==entry.hash)throw new Error('Проверка записи не пройдена');}
    else {const saved=await this.read(entry);if(await hash(saved)!==entry.hash)throw new Error('Проверка записи не пройдена');}
    this.indexEntry(entry);
    return entry;
  }
  async patchChecked(id:string,version:string,body:Record<string,unknown>,query=''){
    const meta=(await this.req({url:'https://www.googleapis.com/drive/v2/files/'+id+'?fields=id,etag,version,labels(trashed)'})).json;
    if(meta.version!==version||meta.labels?.trashed||!meta.etag)throw new Error('Drive изменился; обновите список конфликтов');
    return this.req({url:'https://www.googleapis.com/drive/v2/files/'+id+'?fields=id,version'+query,method:'PATCH',headers:{'If-Match':meta.etag},contentType:'application/json',body:JSON.stringify(body)});
  }
  async rename(from:string,to:string,folder:boolean,files:Map<string,Entry>,expectedId?:string){
    if(!validPath(from)||!validPath(to)||to.startsWith(from+'/'))throw new Error('Недопустимое переименование');
    const source=folder?this.folderMeta.get(from):files.get(from);
    // Recover a completed rename whose response/checkpoint was lost.
    const target=folder?this.folderMeta.get(to):files.get(to);
    if(!source){if(target?.id===expectedId&&expectedId)return;throw new Error('Исходный путь Drive не найден: '+from);}
    if(expectedId&&source.id!==expectedId)throw new Error('Исходный объект Drive был заменён');
    if(target)throw new Error('Новый путь уже занят в Drive: '+to+'. Откройте «Конфликты и удаления».');
    const parent=await this.parent(to),oldParent=this.folders.get(from.split('/').slice(0,-1).join('/'))!;
    const matches=(await this.children(parent,to.split('/').at(-1))).filter(f=>f.name===to.split('/').at(-1)&&f.id!==source.id);
    if(matches.length)throw new Error('Новое имя уже занято в Drive: '+to);
    await this.patchChecked(source.id!,source.version!,{title:to.split('/').at(-1)},parent===oldParent?'':'&addParents='+encodeURIComponent(parent)+'&removeParents='+encodeURIComponent(oldParent));
  }
  async trash(entry:Entry){
    if(!entry.id||!entry.version)throw new Error('Нет версии для безопасного удаления');
    const key='trash|'+entry.id+'|'+entry.version;
    if(this.hooks?.pending[key]){
      const current=(await this.meta(entry.id)).json as FileMeta;
      if(current.trashed){this.removeEntry(entry.id);await this.hooks.intent(key,null);return;}
    }else if(this.hooks)await this.hooks.intent(key,{id:entry.id,path:entry.path,hash:entry.hash,expected:entry});
    await this.patchChecked(entry.id,entry.version,{labels:{trashed:true}});this.removeEntry(entry.id);
    if(this.hooks)await this.hooks.intent(key,null);
  }
  private removeEntry(id:string){
    this.ensureEntryMaps();if(!this.index)return;const pos=this.positions.get(id);if(pos===undefined)return;
    const old=this.index.entries[pos],last=this.index.entries.pop()!;
    if(pos<this.index.entries.length){this.index.entries[pos]=last;this.positions.set(last.id!,pos);}
    this.positions.delete(id);this.entriesById.delete(id);this.paths.delete(old.path);
  }
  /** Check every descendant, including unsupported/hidden files, before trashing a folder. */
  async treeStamp(id:string):Promise<string>{
    const rows:string[]=[];
    const walk=async(parent:string,depth:number)=>{if(depth>30)throw new Error('Слишком большая глубина');for(const f of await this.children(parent)){if(f.name.startsWith('.')||f.name==='Note Bridge Conflicts')throw new Error('В папке есть служебные файлы; проверьте её вручную');rows.push(JSON.stringify([f.id,f.name,f.version,f.mimeType]));if(f.mimeType===FOLDER)await walk(f.id,depth+1);else if(f.name.startsWith('.')||f.mimeType.startsWith('application/vnd.google-apps.'))throw new Error('В папке есть служебные/неподдерживаемые файлы; удалите её вручную после проверки');}};
    await walk(id,0);return rows.sort().join('\n');
  }
  private historyRequests=new Map<string,Promise<void>>();
  async snapshot(path:string,bytes:ArrayBuffer,source:string):Promise<void>{
    if(!this.hooks){await this.saveSnapshot(path,bytes,source);return;}
    const checksum=await hash(bytes);const pending=this.historyRequests.get(checksum);if(pending)return pending;
    const request=this.saveSnapshot(path,bytes,source,checksum);this.historyRequests.set(checksum,request);
    try{await request;}catch(e){this.historyRequests.delete(checksum);throw e;}
  }
  private async saveSnapshot(path:string,bytes:ArrayBuffer,source:string,checksum?:string){
    checksum=checksum||await hash(bytes);
    if(!this.historyId)this.historyId=this.index?.historyId||await this.folder(HISTORY,this.root);
    if(this.index)this.index.historyId=this.historyId;
    const known=this.hooks?.history[checksum];
    if(known){try{const f=(await this.meta(known.id!)).json as FileMeta;if(!f.trashed&&f.parents?.includes(this.historyId)&&f.sha256Checksum===checksum)return;}catch(e){if(!String(e).includes('HTTP 404'))throw e;}}
    const key='history|'+checksum;let intent=this.hooks?.pending[key];
    if(intent){try{const f=(await this.meta(intent.id)).json as FileMeta;if(!f.trashed&&f.parents?.includes(this.historyId)&&f.sha256Checksum===checksum){await this.hooks!.savedHistory(checksum,{path,id:f.id,version:f.version,hash:checksum});return;}}catch(e){if(!String(e).includes('HTTP 404'))throw e;}}
    if(this.hooks&&!intent){const id=await this.reserveId();if(!id)throw new Error('Drive не вернул ID снимка');intent={id,path,hash:checksum};await this.hooks.intent(key,intent);}
    const snapshot=await this.create(checksum+'.snapshot',this.historyId,bytes,'application/octet-stream',intent?.id,JSON.stringify({schema:2,time:new Date().toISOString(),path,source,hash:checksum}));
    if(snapshot.sha256Checksum&&snapshot.sha256Checksum!==checksum)throw new Error('Не совпала контрольная сумма снимка');
    if(this.hooks)await this.hooks.savedHistory(checksum,{path,id:snapshot.id,version:snapshot.version,hash:checksum});
  }
}
