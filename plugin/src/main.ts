import {autosyncDelay} from '../../core/scheduling';
import {mergeVersions} from '../../core/merge';
import {ResolutionModal,type Review} from './resolution';
import {under,remapBaseline,duplicateFolders,type Rename} from '../../core/changes';
import {Paused,type Progress} from '../../core/control';
import {Plugin,PluginSettingTab,Setting,Notice,Modal,TFile,TFolder,requestUrl,setIcon,type App} from 'obsidian';
import {SyncEngine,hash,validPath,type Baseline,type Event,type Local,type Entry} from '../../core/sync';
import {Drive,type DriveIndex} from './drive';
import {random,digest} from '../../auth-service/src/crypto';
type Settings={workerUrl:string;folderId:string;autoSync:boolean;intervalSeconds:number;deviceName:string;secretId:string};
type Saved={noticeKey?:string;conflicts?:Record<string,string>;driveIndex?:DriveIndex;deleted?:string[];lastProgress?:Progress;settings:Settings;baseline:Baseline;events:Event[];binding?:string;resumeSync?:boolean;renames?:(Rename&{id?:string})[];autoMigration?:boolean};
const defaults:Settings={workerUrl:'https://note-bridge-auth.pravoepredserdie.workers.dev',folderId:'',autoSync:true,intervalSeconds:120,deviceName:'Моё устройство',secretId:''};
class HistoryModal extends Modal {
  constructor(app:App,private events:Event[]){super(app);}
  onOpen(){this.titleEl.setText('Note Bridge — журнал');this.contentEl.createEl('p',{text:'Журнал этого устройства. Снимки файлов сохраняются в служебной папке .note-bridge-history в Google Drive. Автоматический откат пока не реализован.'});
    new Setting(this.contentEl).addButton(b=>b.setButtonText('Скопировать журнал').onClick(()=>{void navigator.clipboard.writeText(JSON.stringify({version:'0.4.0',events:this.events},null,2)).then(()=>new Notice('Журнал скопирован')).catch(()=>new Notice('Копирование недоступно; используйте экспорт из настроек.'));}));
    const labels:Record<string,string>={upload:'Отправлено в Google Drive',download:'Скачано на устройство',conflict:'Нужно объединить изменения','local-deletion':'Удалено на телефоне — ожидает решения','remote-deletion':'Удалено в Drive — ожидает решения','duplicate-to-trash':'Дубликат перенесён в корзину',resolved:'Конфликт разрешён','resolution-trash-local':'Файл перенесён в локальную корзину','resolution-trash-remote':'Файл перенесён в корзину Drive',merged:'Изменения объединены',rename:'Переименовано',complete:'Синхронизация завершена',paused:'Синхронизация приостановлена',error:'Ошибка синхронизации'};
    const list=this.contentEl.createDiv();
    const render=(onlyIssues:boolean)=>{list.empty();const events=this.events.slice(-100).reverse().filter(e=>!onlyIssues||['conflict','local-deletion','remote-deletion','duplicate-to-trash','resolved','merged','error','resolution-trash-local','resolution-trash-remote'].includes(e.action));
      if(!events.length)list.createEl('p',{text:'Нет событий для отображения.'});
      for(const e of events){const card=list.createDiv({cls:'nb-conflict-card'+(e.action.includes('deletion')||e.action.includes('trash')?' nb-danger-card':'')});
        card.createEl('strong',{text:labels[e.action]||e.action});card.createEl('div',{text:new Date(e.time).toLocaleString('ru-RU'),cls:'nb-event-time'});
        if(e.path)card.createEl('div',{text:e.path,cls:'nb-path'});
        if(e.detail)card.createEl('p',{text:e.action==='resolved'?(e.detail==='local'?'Выбрано состояние телефона':'Выбрано состояние Google Drive'):e.action==='rename'?'Предыдущий путь: '+e.detail:e.detail});
      }
    };
    new Setting(this.contentEl).setName('Только конфликты, удаления и ошибки').addToggle(t=>t.setValue(true).onChange(render));render(true);
    this.contentEl.createEl('p',{text:'Это история событий, а не список нерешённых конфликтов. Актуальные действия доступны в «Конфликты и удаления».'});}

}
class ProgressModal extends Modal {
  private render=()=>{
    this.contentEl.empty();const p=this.plugin.progress;
    this.titleEl.setText('Note Bridge');
    this.contentEl.createEl('p',{text:p.phase});
    const bar=this.contentEl.createEl('progress',{cls:'nb-progress'});bar.max=Math.max(1,p.total);bar.value=p.done;
    if(!p.total&&this.plugin.busy)bar.removeAttribute('value');
    this.contentEl.createEl('p',{text:p.total?`${p.done}/${p.total} обработано · осталось ${Math.max(0,p.total-p.done)} (${Math.round(100*(p.total-p.done)/p.total)}%)`:this.plugin.busy?'Подсчёт файлов — общий объём появится после сверки.':'Нет операций для отображения.'});
    if(p.path)this.contentEl.createEl('p',{text:p.path,cls:'nb-path'});
    new Setting(this.contentEl).addButton(b=>b.setButtonText(this.plugin.busy?'Пауза':'Синхронизировать').onClick(()=>{if(this.plugin.busy)this.plugin.pause();else void this.plugin.sync();})).addButton(b=>b.setButtonText('Журнал').onClick(()=>new HistoryModal(this.app,this.plugin.state.events).open()));
    new Setting(this.contentEl).addButton(b=>b.setButtonText('Конфликты и удаления').onClick(()=>new ResolutionModal(this.app,this.plugin).open()));
    this.contentEl.createEl('p',{text:'На iPhone держите Obsidian открытым. После возврата прерванная синхронизация продолжится с новой сверки; готовые файлы повторно не скачиваются.'});
  };
  constructor(app:App,private plugin:NoteBridge){super(app);}
  onOpen(){this.plugin.reviewing++;this.plugin.listeners.add(this.render);this.render();}
  onClose(){this.plugin.reviewing--;this.plugin.listeners.delete(this.render);}
}
export default class NoteBridge extends Plugin {
  state:Saved={settings:{...defaults},baseline:{},events:[]};
  status!:HTMLElement; busy=false; stopped=false; timer:number|undefined; saveQueue:Promise<void>=Promise.resolve();
  progress:Progress={phase:'Готов',done:0,total:0}; listeners=new Set<()=>void>(); paused=false; backgrounded=false; explorerButtons=new Set<HTMLElement>();
  reviewing=0;applying=0;dirty=false;ribbon?:HTMLElement;
  lastSync=0;lastEdit=0;
  cacheEpoch=0;
  localCache=new Map<string,{mtime:number;size:number;hash:string}>();
  tokenRequest?:Promise<string>;
  access?:{token:string;expires:number}; pending?:{session:string;verifier:string};
  async onload(){
    const loaded=await this.loadData() as Partial<Saved>|null;
    this.state={settings:{...defaults,...loaded?.settings},baseline:loaded?.baseline||{},events:loaded?.events||[],binding:loaded?.binding,resumeSync:loaded?.resumeSync,renames:loaded?.renames||[],autoMigration:true,noticeKey:loaded?.noticeKey,conflicts:loaded?.conflicts||{},driveIndex:loaded?.driveIndex,deleted:loaded?.deleted||[],lastProgress:loaded?.lastProgress};
    if(this.state.lastProgress)this.progress=this.state.lastProgress;
    if(!loaded?.autoMigration)this.state.settings.autoSync=true;
    if(!this.state.settings.secretId)this.state.settings.secretId='note-bridge-'+crypto.randomUUID();
    await this.persist();
    this.status=this.addStatusBarItem();this.status.setText('Note Bridge: готов');
    this.ribbon=this.addRibbonIcon('refresh-cw','Note Bridge: синхронизация и прогресс',()=>this.openProgress());
    const mount=()=>this.mountExplorerButtons();
    this.app.workspace.onLayoutReady(()=>{
      mount();
      const observer=new MutationObserver(mount);
      observer.observe(this.app.workspace.containerEl,{childList:true,subtree:true});
      this.register(()=>observer.disconnect());
    });
    this.registerEvent(this.app.workspace.on('layout-change',mount));
    this.register(()=>{this.explorerButtons.forEach(b=>b.remove());this.explorerButtons.clear();});
    this.addCommand({id:'progress',name:'Синхронизация и прогресс',callback:()=>this.openProgress()});
    this.addCommand({id:'sync',name:'Синхронизировать',callback:()=>{void this.sync();}});
    this.addCommand({id:'rebuild-index',name:'Полная перепроверка индекса',callback:()=>{if(this.busy)return;this.state.driveIndex=undefined;this.localCache.clear();void this.sync();}});
    this.addCommand({id:'preview',name:'Предпросмотр синхронизации',callback:()=>{void this.sync(true);}});
    this.addCommand({id:'resolve',name:'Конфликты и удаления',callback:()=>new ResolutionModal(this.app,this).open()});
    this.addCommand({id:'history',name:'Показать журнал',callback:()=>new HistoryModal(this.app,this.state.events).open()});
    this.addSettingTab(new BridgeSettings(this.app,this));
    const schedule=()=>this.schedule();
    const changed=(file:{path:string})=>{this.cacheEpoch++;this.localCache.delete(file.path);if(this.applying||!validPath(file.path))return;this.lastEdit=Date.now();this.schedule();};
    this.registerEvent(this.app.vault.on('modify',changed));this.registerEvent(this.app.vault.on('create',changed));
    this.registerEvent(this.app.vault.on('delete',file=>{
      if(!this.applying){for(const path of Object.keys(this.state.baseline))if(under(path,file.path)&&!this.state.deleted!.includes(path))this.state.deleted!.push(path);void this.persist();}changed(file);
    }));
    this.registerEvent(this.app.vault.on('rename',(file,old)=>{
      this.localCache.clear();if(this.applying||!validPath(old)||!validPath(file.path))return;this.lastEdit=Date.now();
      const queue=this.state.renames!;const prior=queue.find(r=>r.to===old);
      if(prior)prior.to=file.path;else queue.push({from:old,to:file.path,folder:file instanceof TFolder});
      void this.persist();this.schedule();
    }));
    this.registerDomEvent(document,'visibilitychange',()=>{
      if(document.hidden&&this.busy){this.backgrounded=true;this.setProgress({...this.progress,phase:'Пауза: Obsidian в фоне'});}
      if(!document.hidden){if(this.state.resumeSync&&!this.busy&&!this.paused)void this.sync();else schedule();}
    });
    let last=0;this.registerInterval(window.setInterval(()=>{if(Date.now()-last>=Math.max(60,this.state.settings.intervalSeconds)*1000){last=Date.now();if(!document.hidden)schedule();}},15000));
    this.app.workspace.onLayoutReady(()=>{if(this.state.resumeSync&&!document.hidden)void this.sync();else schedule();});
  }
  schedule(){
    if(this.applying||!this.state.settings.autoSync||this.stopped||this.paused||this.reviewing)return;
    if(this.busy){this.dirty=true;return;}
    if(!this.state.settings.folderId||!this.app.secretStorage?.getSecret(this.state.settings.secretId))return;
    if(this.timer)window.clearTimeout(this.timer);const delay=autosyncDelay(Date.now(),this.lastEdit,this.lastSync);this.timer=window.setTimeout(()=>{void this.sync(false,true);},delay);
  }
  async quiet<T>(fn:()=>Promise<T>):Promise<T>{this.applying++;try{return await fn();}finally{this.applying--;}}
  drive(){
    const drive=new Drive(this.state.settings.folderId,()=>this.token(),requestUrl,10*1024*1024,{check:()=>this.check(),progress:p=>this.setProgress(p)});
    drive.index=this.state.driveIndex;
    const scan=drive.scan.bind(drive);drive.scan=async()=>{const entries=await scan();this.state.driveIndex=drive.index;await this.persist();return entries;};return drive;
  }
  async exclusive<T>(fn:()=>Promise<T>):Promise<T>{
    if(this.busy)throw new Error('Дождитесь завершения синхронизации или нажмите «Пауза»');
    if(this.timer)window.clearTimeout(this.timer);
    const binding=this.origin()+'|'+this.state.settings.folderId;
    if(this.state.binding&&this.state.binding!==binding)throw new Error('Папка или сервис изменились');
    this.busy=true;this.paused=false;this.backgrounded=false;this.setProgress({phase:'Проверка',done:0,total:0});
    try{return await fn();}finally{this.busy=false;this.setProgress({...this.progress,phase:'Готов'});}
  }
  async review(refresh=false):Promise<Review>{
    if(refresh)return this.exclusive(async()=>{const drive=this.drive();return {local:await this.local().scan(),remote:await drive.scan(),folders:drive.folders};});
    const index=this.state.driveIndex;
    if(!index||index.root!==this.state.settings.folderId)throw new Error('Сначала выполните синхронизацию или нажмите «Повторить проверку».');
    return {local:await this.local(false).scan(),remote:new Map(index.entries.map(e=>[e.path,e])),folders:new Map(index.folders)};
  }
  async conflictText(path:string,review:Review){
    return this.exclusive(async()=>{
      if(!/\.(md|txt)$/i.test(path))throw new Error('Построчное сравнение доступно для Markdown и TXT.');
      const l=review.local.get(path),r=review.remote.get(path);if(!l||!r)throw new Error('Одна из версий отсутствует; обновите список');
      const bytes=await this.local().read(path);if(await hash(bytes)!==l.hash)throw new Error('Текст телефона изменился; обновите список');
      const remote=await this.drive().read(r);const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
      return {local:decoder.decode(bytes),remote:decoder.decode(remote)};
    });
  }
  async saveMerged(path:string,text:string,review:Review){
    await this.exclusive(async()=>{
      if(!/\.(md|txt)$/i.test(path))throw new Error('Объединение доступно только для Markdown и TXT');
      const drive=this.drive(),local=this.local(),ls=await local.scan(),rs=await drive.scan();
      const l=ls.get(path),r=rs.get(path),old=review.remote.get(path);
      if(!l||!r||l.hash!==review.local.get(path)?.hash||r.hash!==old?.hash||r.id!==old?.id||r.version!==old?.version)throw new Error('Заметка изменилась после открытия сравнения. Скопируйте итоговый текст, закройте сравнение и обновите список конфликтов.');
      this.state.baseline[path]=await mergeVersions(path,text,local,drive,l,r);
      this.state.events.push({time:new Date().toISOString(),path,action:'merged',detail:'Изменения объединены по блокам; обе исходные версии сохранены в истории'});await this.persist();
    });
  }
  async resolve(path:string,side:'local'|'remote',review:Review){
    await this.exclusive(async()=>{
      const drive=this.drive(),local=this.local(),ls=await local.scan(),rs=await drive.scan();const l=ls.get(path),r=rs.get(path);
      const previous=review.remote.get(path);
      if(l?.hash!==review.local.get(path)?.hash||r?.hash!==previous?.hash||r?.id!==previous?.id||r?.version!==previous?.version)throw new Error('Версии изменились; обновите список');
      if(side==='local'){
        if(l){const bytes=await local.read(path);if(await hash(bytes)!==l.hash)throw new Error('Локальный файл изменился');if(r)await drive.snapshot(path,await drive.read(r),'resolution-remote');const saved=await drive.write(path,bytes,r);this.state.baseline[path]={hash:l.hash,remoteId:saved.id};}
        else if(r){if(this.app.vault.getAbstractFileByPath(path))throw new Error('Локальный файл появился');await drive.trash(r);delete this.state.baseline[path];}
      }else{
        if(r){const bytes=await drive.read(r);if(l)await drive.snapshot(path,await local.read(path),'resolution-local');await local.write(path,bytes,l?.hash);this.state.baseline[path]={hash:r.hash,remoteId:r.id};}
        else if(l){await drive.snapshot(path,await local.read(path),'resolution-local-delete');await local.trash!(path,l.hash);delete this.state.baseline[path];}
      }
      this.state.events.push({time:new Date().toISOString(),path,action:side==='local'&&!l?'resolution-trash-remote':side==='remote'&&!r?'resolution-trash-local':'resolved',detail:side==='local'&&!l||side==='remote'&&!r?'Удаление подтверждено пользователем':side});await this.persist();
    });
  }
  async removeDuplicate(pair:{from:string;to:string;count:number},review:Review){
    await this.exclusive(async()=>{
      const drive=this.drive(),local=await this.local().scan(),remote=await drive.scan();
      if(!duplicateFolders(local,remote,drive.folders).some(p=>p.from===pair.from&&p.to===pair.to&&p.count===pair.count))throw new Error('Папки больше не совпадают; обновите список');
      if(drive.folders.get(pair.from)!==review.folders.get(pair.from)||drive.folders.get(pair.to)!==review.folders.get(pair.to))throw new Error('Папки были заменены');
      for(const [path,entry] of remote)if(under(path,pair.from)||under(path,pair.to)){
        const old=review.remote.get(path);if(!old||old.id!==entry.id||old.hash!==entry.hash||old.version!==entry.version)throw new Error('Содержимое изменилось; обновите список');
      }
      const meta=drive.folderMeta.get(pair.from)!;const stamp=await drive.treeStamp(meta.id);const targetId=drive.folders.get(pair.to)!;const targetStamp=await drive.treeStamp(targetId);
      const latestLocal=await this.local().scan();
      if(!duplicateFolders(latestLocal,remote,drive.folders).some(p=>p.from===pair.from&&p.to===pair.to))throw new Error('Локальные заметки изменились');
      if(await drive.treeStamp(meta.id)!==stamp||await drive.treeStamp(targetId)!==targetStamp)throw new Error('Папка изменилась во время проверки');
      await drive.patchChecked(meta.id,meta.version,{labels:{trashed:true}});
      await drive.scan();
      for(const path of Object.keys(this.state.baseline))if(under(path,pair.from))delete this.state.baseline[path];
      this.state.renames=this.state.renames?.filter(r=>!(r.from===pair.from&&r.to===pair.to));
      this.state.events.push({time:new Date().toISOString(),path:pair.from,action:'duplicate-to-trash',detail:'Копия сохранена: '+pair.to});await this.persist();
    });
  }
  async applyRenames(drive:Drive){
    while(this.state.renames?.length){
      this.check();const rename=this.state.renames[0];
      if(rename.from===rename.to){this.state.renames.shift();await this.persist();continue;}
      const entries=await drive.scan();
      const source=rename.folder?drive.folderMeta.get(rename.from):entries.get(rename.from);
      if(!source&&!rename.id&&!Object.keys(this.state.baseline).some(p=>under(p,rename.from))){this.state.renames.shift();await this.persist();continue;}
      if(this.app.vault.getAbstractFileByPath(rename.from))throw new Error('Старый локальный путь снова существует: '+rename.from);
      if(!this.app.vault.getAbstractFileByPath(rename.to))throw new Error('Цель переименования исчезла: '+rename.to);
      if(!rename.id&&source){
        const known=Object.entries(this.state.baseline).filter(([p,b])=>under(p,rename.from)&&b.remoteId);
        if(!known.some(([p,b])=>entries.get(p)?.id===b.remoteId))throw new Error('Нет общей истории для переименования: '+rename.from+'. Откройте «Конфликты и удаления».');
        if(!rename.folder&&this.state.baseline[rename.from]?.remoteId!==source.id)throw new Error('Файл Drive был заменён');
        rename.id=source.id;await this.persist();
      }
      // Validate baseline remapping before changing the remote object.
      const next={...this.state.baseline};remapBaseline(next,rename.from,rename.to);
      await drive.rename(rename.from,rename.to,rename.folder,entries,rename.id);
      this.state.baseline=next;this.state.renames.shift();await this.persist();
    }
  }
  onunload(){this.stopped=true;if(this.timer)window.clearTimeout(this.timer);this.access=undefined;this.pending=undefined;}
  mountExplorerButtons(){
    if(this.stopped)return;
    for(const button of this.explorerButtons)if(!button.isConnected)this.explorerButtons.delete(button);
    // File explorer has no public toolbar extension API. Keep this integration scoped
    // to its own toolbar; ribbon and commands remain available if the DOM changes.
    for(const leaf of this.app.workspace.getLeavesOfType('file-explorer')){
      const toolbar=leaf.view.containerEl.querySelector<HTMLElement>('.nav-buttons-container');
      if(!toolbar||toolbar.querySelector('.nb-explorer-sync'))continue;
      const button=toolbar.createDiv({cls:'nav-action-button clickable-icon nb-explorer-sync',attr:{role:'button',tabindex:'0','aria-label':'Note Bridge: синхронизировать'}});
      setIcon(button,'refresh-cw');
      const activate=()=>this.openProgress();button.onclick=activate;
      button.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();activate();}};
      this.explorerButtons.add(button);
    }
  }
  setProgress(p:Progress){
    this.progress=p;this.status?.setText('Note Bridge: '+p.phase+(p.total?` ${p.done}/${p.total}`:''));
    this.ribbon?.classList.toggle('nb-sync-active',this.busy);
    for(const button of this.explorerButtons){
      button.setAttribute('aria-label','Note Bridge: '+p.phase+(p.total?` ${p.done}/${p.total}`:''));
      button.classList.toggle('nb-sync-active',this.busy);
    }
    this.listeners.forEach(fn=>fn());
  }
  openProgress(){new ProgressModal(this.app,this).open();}
  pause(){this.paused=true;this.state.resumeSync=false;void this.persist();this.setProgress({...this.progress,phase:'Пауза после текущей операции'});}
  check(){if(this.stopped||this.paused||this.backgrounded||document.hidden)throw new Paused();}
  async exportJournal(){
    const path='Note Bridge Journal '+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
    await this.app.vault.create(path,JSON.stringify({version:this.manifest.version,events:this.state.events},null,2));new Notice('Создан '+path);
  }
  persist(){const data=JSON.parse(JSON.stringify(this.state));this.saveQueue=this.saveQueue.catch(()=>{}).then(()=>this.saveData(data));return this.saveQueue;}
  origin(){const u=new URL(this.state.settings.workerUrl);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('Укажите HTTPS-адрес Worker без пути');return u.origin;}
  async broker(path:string,data?:Record<string,string>,token?:string){
    const r=await requestUrl({url:this.origin()+path,method:'POST',contentType:'application/json',body:JSON.stringify(data||{}),headers:token?{Authorization:'Bearer '+token}:{},throw:false});
    if(r.status>=400)throw new Error(typeof r.json?.error==='string'?r.json.error:'Ошибка авторизации '+r.status);return r;
  }
  async connect(pairingCode:string){
    if(this.busy)throw new Error('Дождитесь завершения синхронизации');
    if(!this.app.secretStorage)throw new Error('Обновите Obsidian: требуется SecretStorage');
    const verifier=random();const r=await this.broker('/start',{pairingCode,challenge:await digest(verifier)});
    const target=new URL(r.json.url);if(target.origin!==this.origin()||target.pathname!=='/authorize')throw new Error('Неверный адрес авторизации');
    this.pending={session:r.json.session,verifier};window.open(target.href);
    new Notice('Разрешите доступ в браузере, затем нажмите «Завершить подключение».');
  }
  async claim(){
    if(!this.pending)throw new Error('Сначала начните подключение. После перезапуска его нужно начать заново.');
    const r=await this.broker('/claim',this.pending);if(r.status===202)throw new Error('Вход в браузере ещё не завершён');
    this.app.secretStorage.setSecret(this.state.settings.secretId,r.json.deviceToken);this.pending=undefined;this.access=undefined;new Notice('Google Drive подключён');
  }
  async disconnect(){
    if(this.busy)throw new Error('Дождитесь синхронизации');
    const token=this.app.secretStorage?.getSecret(this.state.settings.secretId);
    if(token)await this.broker('/disconnect',{},token);
    this.app.secretStorage?.setSecret(this.state.settings.secretId,'');this.access=undefined;this.state.settings.autoSync=false;await this.persist();new Notice('Устройство отключено');
  }
  async token(){
    if(this.access&&this.access.expires>Date.now()+60000)return this.access.token;
    if(this.tokenRequest)return this.tokenRequest;
    this.tokenRequest=(async()=>{
      const device=this.app.secretStorage?.getSecret(this.state.settings.secretId);if(!device)throw new Error('Сначала подключите Google Drive');
      const r=await this.broker('/token',{},device);this.access={token:r.json.accessToken,expires:Date.now()+r.json.expiresIn*1000};return this.access.token;
    })();
    try{return await this.tokenRequest;}finally{this.tokenRequest=undefined;}
  }
  local(checkScan=true):Local {
    const vault=this.app.vault;
    let folderQueue=Promise.resolve();
    const mkdir=(path:string)=>{
      const operation=folderQueue.then(async()=>{let p='';for(const part of path.split('/').slice(0,-1)){p=p?p+'/'+part:part;if(!vault.getAbstractFileByPath(p))await vault.createFolder(p);}});
      folderQueue=operation.catch(()=>{});return operation;
    };
    const adapter:Local={
      exists:path=>!!vault.getAbstractFileByPath(path),
      scan:async()=>{const files=new Map<string,Entry>();for(const f of vault.getFiles()){
        if(checkScan)this.check();
        if(f.path.startsWith('Note Bridge Journal '))continue;
        if(f.path.split('/').some(p=>p.startsWith('.'))||f.path.startsWith('Note Bridge Conflicts/'))continue;
        if(!validPath(f.path))throw new Error('Неподдерживаемый путь: '+f.path);
        if(f.stat.size>10*1024*1024)throw new Error('Файл больше лимита 10 МБ: '+f.path);
        let cached=this.localCache.get(f.path);
        if(!cached||cached.mtime!==f.stat.mtime||cached.size!==f.stat.size){
          const epoch=this.cacheEpoch,mtime=f.stat.mtime,size=f.stat.size,checksum=await hash(await vault.readBinary(f));
          if(f.stat.mtime!==mtime||f.stat.size!==size)throw new Error('Файл изменился во время чтения: '+f.path);
          cached={mtime,size,hash:checksum};if(epoch===this.cacheEpoch)this.localCache.set(f.path,cached);
        }
        files.set(f.path,{path:f.path,hash:cached.hash});
      }return files;},
      read:async(path)=>{const f=vault.getAbstractFileByPath(path);if(!(f instanceof TFile))throw new Error('Файл исчез: '+path);return vault.readBinary(f);},
      write:async(path,bytes,expected)=>{
        this.check();
        const f=vault.getAbstractFileByPath(path);
        if(expected===undefined){if(f)throw new Error('Локальный файл уже появился');await mkdir(path);await vault.createBinary(path,bytes);return;}
        if(!(f instanceof TFile))throw new Error('Локальный файл исчез');
        const original=await vault.readBinary(f);if(await hash(original)!==expected)throw new Error('Локальная заметка изменилась во время загрузки');
        if(f.extension!=='md'&&f.extension!=='txt')throw new Error('Изменённое вложение требует ручной проверки: '+path);
        const decoder=new TextDecoder('utf-8',{fatal:true});const before=decoder.decode(original),after=decoder.decode(bytes);
        await vault.process(f,current=>{if(current!==before)throw new Error('Текст изменился во время синка');return after;});
      },
      move:async(from,to,expected)=>{
        this.check();const f=vault.getAbstractFileByPath(from);
        if(!(f instanceof TFile)||await hash(await vault.readBinary(f))!==expected||vault.getAbstractFileByPath(to))throw new Error('Локальный путь изменился перед перемещением');
        await mkdir(to);await this.app.fileManager.renameFile(f,to);
        let parent=from.split('/').slice(0,-1).join('/');
        while(parent){const folder=vault.getAbstractFileByPath(parent);if(!(folder instanceof TFolder)||folder.children.length)break;await vault.trash(folder,false);parent=parent.split('/').slice(0,-1).join('/');}
      },
      trash:async(path,expected)=>{
        this.check();const f=vault.getAbstractFileByPath(path);
        if(!(f instanceof TFile)||await hash(await vault.readBinary(f))!==expected)throw new Error('Локальный файл изменился перед удалением');
        await vault.trash(f,false);
      },
      conflict:async(path,bytes,key)=>{
        const target='Note Bridge Conflicts/'+path+'.remote-'+key.slice(0,12)+'.'+(path.split('.').at(-1)||'bin');
        if(!vault.getAbstractFileByPath(target)){await mkdir(target);await vault.createBinary(target,bytes);}
      }
    };
    return {...adapter,write:(...args)=>this.quiet(()=>adapter.write(...args)),move:(...args)=>this.quiet(()=>adapter.move!(...args)),trash:(...args)=>this.quiet(()=>adapter.trash!(...args)),conflict:(...args)=>this.quiet(()=>adapter.conflict(...args))};
  }
  async sync(dryRun=false,automatic=false){
    if(this.busy||this.stopped||document.hidden||(automatic&&(this.reviewing||!this.state.settings.autoSync||this.paused)))return;if(this.timer)window.clearTimeout(this.timer);this.lastSync=Date.now();this.dirty=false;this.busy=true;this.paused=false;this.backgrounded=false;
    try{
      this.state.resumeSync=!dryRun;await this.persist();this.setProgress({phase:'Сверка…',done:0,total:0});
      const binding=this.origin()+'|'+this.state.settings.folderId;
      if(this.state.binding&&this.state.binding!==binding)throw new Error('Папка или сервис изменились. Используйте отдельное тестовое хранилище.');
      const drive=this.drive();
      if(!dryRun)await this.applyRenames(drive);
      const engine=new SyncEngine(this.local(),drive,this.state.baseline,async(base,event)=>{
        this.state.baseline=base;this.state.binding=binding;this.state.events.push(event);this.state.events=this.state.events.slice(-500);await this.persist();
      },{check:()=>this.check(),progress:p=>this.setProgress(p)},{local:new Set(this.state.deleted),remote:drive.deletedIds,conflicts:this.state.conflicts});
      const events=await engine.run(dryRun);
      this.state.deleted=this.state.deleted?.filter(p=>!!this.state.baseline[p]&&!this.app.vault.getAbstractFileByPath(p));
      this.state.resumeSync=false;await this.persist();
      const pending=events.filter(e=>e.action.includes('deletion')||e.action==='conflict').length;
      this.setProgress({...this.progress,phase:pending?`Проверить: ${pending} конфликтов/удалений`:'Синхронизировано'});
      const noticeKey=events.filter(e=>e.action==='conflict'||e.action.includes('deletion')).map(e=>e.path+'|'+e.action+'|'+this.state.conflicts?.[e.path]).sort().join('\n');
      const changedIssues=noticeKey!==this.state.noticeKey;
      if(!dryRun){this.state.noticeKey=noticeKey;await this.persist();}
      if(dryRun)new HistoryModal(this.app,events).open();
      else if(!automatic||(pending&&changedIssues))new Notice(pending?`Note Bridge: ${pending} конфликтов/удалений: откройте «Конфликты и удаления»`:'Note Bridge: синхронизация завершена');
    }catch(error){
      const suspended=error instanceof Paused||this.backgrounded||document.hidden;
      const message=suspended?'Пауза. Выполненные операции сохранены.':error instanceof Error?error.message:'Неизвестная ошибка';
      this.setProgress({...this.progress,phase:suspended?'Приостановлено':'Ошибка: '+message});
      if(!suspended){this.state.resumeSync=false;new Notice(message,12000);}
      this.state.events.push({time:new Date().toISOString(),path:this.progress.path||'',action:suspended?'paused':'error',detail:message});this.state.events=this.state.events.slice(-500);await this.persist();
    }finally{
      this.busy=false;this.state.lastProgress=this.progress;await this.persist();this.setProgress(this.progress);
      if(this.dirty)this.schedule();
      if(this.state.resumeSync&&!document.hidden&&!this.paused&&!this.stopped)window.setTimeout(()=>{void this.sync();},500);
    }
  }
}
class BridgeSettings extends PluginSettingTab {
  constructor(app:App,private p:NoteBridge){super(app,p);}
  display(){
    const el=this.containerEl;el.empty();el.createEl('h2',{text:'Note Bridge · тестовая версия 0.4.0'});
    el.createEl('p',{text:'Используйте отдельную копию хранилища. Локальные удаления передаются автоматически, если версия Drive не менялась; спорные удаления — в «Конфликты и удаления». Лимит файла — 10 МБ. Другие средства синхронизации этого хранилища должны быть отключены.'});
    new Setting(el).setName('Адрес сервиса авторизации').setDesc('https://имя.workers.dev').addText(t=>t.setValue(this.p.state.settings.workerUrl).onChange(async v=>{if(this.p.busy)return;this.p.state.settings.workerUrl=v.trim();this.p.access=undefined;await this.p.persist();}));
    new Setting(el).setName('ID папки Google Drive').setDesc('Часть адреса после /folders/. Папку создайте заранее.').addText(t=>t.setValue(this.p.state.settings.folderId).onChange(async v=>{if(this.p.busy)return;this.p.state.settings.folderId=v.trim();await this.p.persist();}));
    let pairing='';
    new Setting(el).setName('Код подключения').setDesc('Код владельца сервиса. Используется один раз, не сохраняется в настройках.').addText(t=>{t.inputEl.type='password';t.onChange(v=>{pairing=v;});});
    const action=(fn:()=>Promise<unknown>)=>{void fn().catch(e=>new Notice(e instanceof Error?e.message:'Ошибка',12000));};
    new Setting(el).setName('Вход через Google').addButton(b=>b.setButtonText('Подключить').onClick(()=>action(()=>this.p.connect(pairing)))).addButton(b=>b.setButtonText('Завершить подключение').onClick(()=>action(()=>this.p.claim())));
    new Setting(el).setName('Конфликты и удаления').addButton(b=>b.setButtonText('Разобрать').onClick(()=>new ResolutionModal(this.app,this.p).open()));
    new Setting(el).setName('Прогресс').addButton(b=>b.setButtonText('Открыть').onClick(()=>this.p.openProgress()));
    new Setting(el).setName('Экспорт журнала').setDesc('Создаёт JSON без токенов и настроек авторизации. Его можно прислать для диагностики.').addButton(b=>b.setButtonText('Экспортировать').onClick(()=>action(()=>this.p.exportJournal())));
    new Setting(el).setName('Синхронизация').addButton(b=>b.setButtonText('Предпросмотр').onClick(()=>action(()=>this.p.sync(true)))).addButton(b=>b.setButtonText('Синхронизировать').setCta().onClick(()=>action(()=>this.p.sync())));
    new Setting(el).setName('Автоматическая синхронизация').setDesc('После 30 секунд без правок, не чаще раза в минуту. Изменения Drive проверяются периодически. iOS может приостановить работу в фоне.').addToggle(t=>t.setValue(this.p.state.settings.autoSync).onChange(async v=>{this.p.state.settings.autoSync=v;await this.p.persist();}));
    new Setting(el).setName('История').addButton(b=>b.setButtonText('Открыть журнал').onClick(()=>new HistoryModal(this.app,this.p.state.events).open()));
    new Setting(el).setName('Отключить устройство').addButton(b=>b.setButtonText('Отключить').onClick(()=>action(()=>this.p.disconnect())));
  }
}
