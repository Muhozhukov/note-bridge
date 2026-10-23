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
export type DriveIndex={root:string;token:string;entries:Entry[];folders:[string,string][];folderMeta:[string,FileMeta][]};
export class Drive implements Remote {
  index?:DriveIndex;
  deletedIds=new Set<string>();
  async scan():Promise<Map<string,Entry>> {
    const previous=this.index;
    if(!previous||previous.root!==this.root)return this.rebuild();
    this.folders=new Map(previous.folders);this.folderMeta=new Map(previous.folderMeta);
    const output=new Map(previous.entries.map(e=>[e.id!,e]));
    const byId=new Map(previous.entries.map(e=>[e.id,e]));
    const parents=new Map(previous.folders.map(([p,id])=>[id,p]));
    let token=previous.token, nextToken='', structural=false;
    const deleted=new Set<string>();
    do {
      const q=new URLSearchParams({pageToken:token,pageSize:'1000',spaces:'drive',includeRemoved:'true',fields:`nextPageToken,newStartPageToken,changes(fileId,removed,file(${fields}))`});
      let response;
      try{response=await this.req({url:'https://www.googleapis.com/drive/v3/changes?'+q});}
      catch(e){if(String(e).includes('HTTP 410'))return this.rebuild();throw e;}
      const data=response.json;
      if(!Array.isArray(data.changes))throw new Error('Неполная лента изменений Drive');
      for(const change of data.changes){
        const old=byId.get(change.fileId), f=change.file as FileMeta|undefined;
        if(change.fileId===this.root){if(change.removed||!f||f.trashed||f.mimeType!==FOLDER)throw new Error('Выбранная папка недоступна');continue;}
        const parent=f?.parents?.find(id=>parents.has(id));
        if(parents.has(change.fileId)){
          const oldPath=parents.get(change.fileId)!,prefix=parent===undefined?undefined:parents.get(parent);
          const newPath=prefix===undefined?undefined:prefix?prefix+'/'+f?.name:f?.name;
          if(change.removed||!f||f.trashed||newPath!==oldPath)structural=true;
          else this.folderMeta.set(oldPath,f);
          continue;
        }
        if(f?.mimeType===FOLDER&&parent!==undefined&&!f.name.startsWith('.')&&f.name!=='Note Bridge Conflicts'){structural=true;continue;}
        if(!old&&parent===undefined)continue;
        if(old)output.delete(change.fileId);
        if(change.removed||!f||f.trashed||parent===undefined){if(old&&f?.trashed)deleted.add(change.fileId);continue;}
        if(f.name.startsWith('.')||f.name==='Note Bridge Conflicts')continue;
        const prefix=parents.get(parent)!,path=prefix?prefix+'/'+f.name:f.name;
        if(!validPath(path)||f.name.includes('/'))throw new Error('Неподдерживаемое имя Drive: '+path);
        if(f.mimeType.startsWith('application/vnd.google-apps.')||Number(f.size)>this.maxBytes)throw new Error('Неподдерживаемый файл Drive: '+path);
        const entry:Entry={path,id:f.id,version:f.version,hash:f.sha256Checksum|| (old?.version===f.version?old.hash:'')};
        if(!entry.hash)entry.hash=await hash(await this.download(entry));
        output.set(f.id,entry);byId.set(f.id,entry);
      }
      token=data.nextPageToken||'';if(!token)nextToken=data.newStartPageToken||'';
    }while(token);
    if(!nextToken)throw new Error('Drive не вернул курсор изменений');
    if(structural)return this.rebuild();
    const paths=new Map<string,Entry>();
    for(const entry of output.values()){if(paths.has(entry.path))throw new Error('В Drive два объекта с одинаковым именем: '+entry.path);paths.set(entry.path,entry);}
    this.deletedIds.clear();for(const id of deleted)this.deletedIds.add(id);
    this.index={...previous,token:nextToken,entries:[...output.values()],folderMeta:[...this.folderMeta]};
    return paths;
  }
  async rebuild():Promise<Map<string,Entry>> {
    const token=(await this.req({url:'https://www.googleapis.com/drive/v3/changes/startPageToken'})).json.startPageToken;
    if(!token)throw new Error('Drive не вернул начальный курсор');
    const output=await this.fullScan();
    this.index={root:this.root,token,entries:[...output.values()],folders:[...this.folders],folderMeta:[...this.folderMeta]};
    this.deletedIds.clear();return output;
  }

  folders=new Map<string,string>(); historyId='';
  folderMeta=new Map<string,FileMeta>();
  private folderRequests=new Map<string,Promise<string>>();
  private cache=new Map<string,ArrayBuffer>(); private cachedBytes=0; scanned=0;
  constructor(public root:string,private getToken:()=>Promise<string>,private transport:(params:RequestUrlParam)=>Promise<RequestUrlResponse>,private maxBytes=10*1024*1024,private control:Control={}) {
    if(!/^[\w-]+$/.test(root)||root==='root')throw new Error('Укажите ID отдельной папки Drive, не корень диска');
    this.folders.set('',root);
  }
  async req(params:RequestUrlParam):Promise<RequestUrlResponse> {
    const execute=async()=>{
      this.control.check?.();
      const response=await this.transport({...params,headers:{...params.headers,Authorization:'Bearer '+await this.getToken()},throw:false});
      if(response.status>=400)throw new Error('Drive HTTP '+response.status+(response.status===412?' — файл изменился, повторите синк':''));
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
    const result=await this.req({url:API+'?fields=id',method:'POST',contentType:'application/json',body:JSON.stringify({name,mimeType:FOLDER,parents:[parent]})});
    // Concurrent devices may both create a folder. Stop rather than silently split the tree.
    const check=(await this.children(parent,name)).filter(f=>f.name===name);
    if(check.length!==1)throw new Error('Одновременное создание папки; устраните дубликаты в Drive');
    return result.json.id as string;
  }
  async parent(path:string):Promise<string>{
    const parts=path.split('/').slice(0,-1);let key='',parent=this.root;
    for(const part of parts){key=key?key+'/'+part:part;let id=this.folders.get(key);if(!id){id=await this.folder(part,parent);this.folders.set(key,id);}parent=id;}return parent;
  }
  async create(name:string,parent:string,bytes:ArrayBuffer,mimeType='application/octet-stream'):Promise<FileMeta>{
    const boundary='nb_'+crypto.randomUUID();const enc=new TextEncoder();
    const head=enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({name,parents:[parent],mimeType})}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const tail=enc.encode(`\r\n--${boundary}--\r\n`);const data=new Uint8Array(head.length+bytes.byteLength+tail.length);
    data.set(head);data.set(new Uint8Array(bytes),head.length);data.set(tail,head.length+bytes.byteLength);
    const response=await this.req({url:'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields='+fields,method:'POST',contentType:'multipart/related; boundary='+boundary,body:buffer(data)});
    return response.json as FileMeta;
  }
  async write(path:string,bytes:ArrayBuffer,expected?:Entry):Promise<Entry>{
    if(bytes.byteLength>this.maxBytes)throw new Error('Файл превышает лимит');
    let result:FileMeta;
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
      result=await this.create(name,parent,bytes,path.endsWith('.md')?'text/markdown':'application/octet-stream');
      if((await this.children(parent,name)).filter(f=>f.name===name).length!==1)throw new Error('Одновременное создание файла; обе копии сохранены в Drive');
    }
    const entry={path,id:result.id,version:result.version,hash:await hash(bytes)};
    if(result.sha256Checksum){if(result.sha256Checksum!==entry.hash)throw new Error('Проверка записи не пройдена');}
    else {const saved=await this.read(entry);if(await hash(saved)!==entry.hash)throw new Error('Проверка записи не пройдена');}
    if(this.index)this.index.entries=[...this.index.entries.filter(e=>e.path!==path&&e.id!==entry.id),entry];
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
  async trash(entry:Entry){if(!entry.id||!entry.version)throw new Error('Нет версии для безопасного удаления');await this.patchChecked(entry.id,entry.version,{labels:{trashed:true}});if(this.index)this.index.entries=this.index.entries.filter(e=>e.id!==entry.id);}
  /** Check every descendant, including unsupported/hidden files, before trashing a folder. */
  async treeStamp(id:string):Promise<string>{
    const rows:string[]=[];
    const walk=async(parent:string,depth:number)=>{if(depth>30)throw new Error('Слишком большая глубина');for(const f of await this.children(parent)){if(f.name.startsWith('.')||f.name==='Note Bridge Conflicts')throw new Error('В папке есть служебные файлы; проверьте её вручную');rows.push(JSON.stringify([f.id,f.name,f.version,f.mimeType]));if(f.mimeType===FOLDER)await walk(f.id,depth+1);else if(f.name.startsWith('.')||f.mimeType.startsWith('application/vnd.google-apps.'))throw new Error('В папке есть служебные/неподдерживаемые файлы; удалите её вручную после проверки');}};
    await walk(id,0);return rows.sort().join('\n');
  }
  async snapshot(path:string,bytes:ArrayBuffer,source:string):Promise<void>{
    if(!this.historyId)this.historyId=await this.folder(HISTORY,this.root);
    const id=crypto.randomUUID(),timestamp=new Date().toISOString();
    const snapshot=await this.create(id+'.snapshot',this.historyId,bytes);
    const event={schema:1,time:timestamp,path,source,hash:await hash(bytes),snapshotId:snapshot.id};
    await this.create(id+'.json',this.historyId,new TextEncoder().encode(JSON.stringify(event)).buffer,'application/json');
  }
}
