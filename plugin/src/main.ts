import {Paused,type Progress} from '../../core/control';
import {Plugin,PluginSettingTab,Setting,Notice,Modal,TFile,requestUrl,setIcon,type App} from 'obsidian';
import {SyncEngine,hash,validPath,type Baseline,type Event,type Local,type Entry} from '../../core/sync';
import {Drive} from './drive';
import {random,digest} from '../../auth-service/src/crypto';
type Settings={workerUrl:string;folderId:string;autoSync:boolean;intervalSeconds:number;deviceName:string;secretId:string};
type Saved={settings:Settings;baseline:Baseline;events:Event[];binding?:string;resumeSync?:boolean};
const defaults:Settings={workerUrl:'https://note-bridge-auth.pravoepredserdie.workers.dev',folderId:'',autoSync:false,intervalSeconds:120,deviceName:'Моё устройство',secretId:''};
class HistoryModal extends Modal {
  constructor(app:App,private events:Event[]){super(app);}
  onOpen(){this.titleEl.setText('Note Bridge — журнал');this.contentEl.createEl('p',{text:'Журнал этого устройства. Снимки файлов сохраняются в служебной папке .note-bridge-history в Google Drive. Автоматический откат пока не реализован.'});
    new Setting(this.contentEl).addButton(b=>b.setButtonText('Скопировать журнал').onClick(()=>{void navigator.clipboard.writeText(JSON.stringify({version:'0.1.3',events:this.events},null,2)).then(()=>new Notice('Журнал скопирован')).catch(()=>new Notice('Копирование недоступно; используйте экспорт из настроек.'));}));
    for(const e of this.events.slice(-100).reverse())this.contentEl.createEl('p',{text:`${e.time} · ${e.action} · ${e.path}${e.detail?' — '+e.detail:''}`});}
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
    this.contentEl.createEl('p',{text:'На iPhone держите Obsidian открытым. После возврата прерванная синхронизация продолжится с новой сверки; готовые файлы повторно не скачиваются.'});
  };
  constructor(app:App,private plugin:NoteBridge){super(app);}
  onOpen(){this.plugin.listeners.add(this.render);this.render();}
  onClose(){this.plugin.listeners.delete(this.render);}
}
export default class NoteBridge extends Plugin {
  state:Saved={settings:{...defaults},baseline:{},events:[]};
  status!:HTMLElement; busy=false; stopped=false; timer:number|undefined; saveQueue:Promise<void>=Promise.resolve();
  progress:Progress={phase:'Готов',done:0,total:0}; listeners=new Set<()=>void>(); paused=false; backgrounded=false; explorerButtons=new Set<HTMLElement>();
  tokenRequest?:Promise<string>;
  access?:{token:string;expires:number}; pending?:{session:string;verifier:string};
  async onload(){
    const loaded=await this.loadData() as Partial<Saved>|null;
    this.state={settings:{...defaults,...loaded?.settings},baseline:loaded?.baseline||{},events:loaded?.events||[],binding:loaded?.binding,resumeSync:loaded?.resumeSync};
    if(!this.state.settings.secretId)this.state.settings.secretId='note-bridge-'+crypto.randomUUID();
    await this.persist();
    this.status=this.addStatusBarItem();this.status.setText('Note Bridge: готов');
    this.addRibbonIcon('refresh-cw','Note Bridge: синхронизация и прогресс',()=>this.openProgress());
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
    this.addCommand({id:'preview',name:'Предпросмотр синхронизации',callback:()=>{void this.sync(true);}});
    this.addCommand({id:'history',name:'Показать журнал',callback:()=>new HistoryModal(this.app,this.state.events).open()});
    this.addSettingTab(new BridgeSettings(this.app,this));
    const schedule=()=>{if(!this.state.settings.autoSync||this.busy||this.stopped||this.paused)return;if(this.timer)window.clearTimeout(this.timer);this.timer=window.setTimeout(()=>{void this.sync();},5000);};
    this.registerEvent(this.app.vault.on('modify',schedule));this.registerEvent(this.app.vault.on('create',schedule));this.registerEvent(this.app.vault.on('delete',schedule));this.registerEvent(this.app.vault.on('rename',schedule));
    this.registerDomEvent(document,'visibilitychange',()=>{
      if(document.hidden&&this.busy){this.backgrounded=true;this.setProgress({...this.progress,phase:'Пауза: Obsidian в фоне'});}
      if(!document.hidden){if(this.state.resumeSync&&!this.busy&&!this.paused)void this.sync();else schedule();}
    });
    let last=0;this.registerInterval(window.setInterval(()=>{if(Date.now()-last>=Math.max(60,this.state.settings.intervalSeconds)*1000){last=Date.now();if(!document.hidden)schedule();}},15000));
    this.app.workspace.onLayoutReady(()=>{if(this.state.resumeSync&&!document.hidden)void this.sync();else schedule();});
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
    for(const button of this.explorerButtons){
      button.setAttribute('aria-label','Note Bridge: '+p.phase+(p.total?` ${p.done}/${p.total}`:''));
      button.classList.toggle('nb-sync-active',this.busy);
    }
    this.listeners.forEach(fn=>fn());
  }
  openProgress(){new ProgressModal(this.app,this).open();if(!this.busy)void this.sync();}
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
  local():Local {
    const vault=this.app.vault;
    const mkdir=async(path:string)=>{let p='';for(const part of path.split('/').slice(0,-1)){p=p?p+'/'+part:part;if(!vault.getAbstractFileByPath(p))await vault.createFolder(p);}};
    return {
      scan:async()=>{const files=new Map<string,Entry>();for(const f of vault.getFiles()){
        this.check();
        if(f.path.startsWith('Note Bridge Journal '))continue;
        if(f.path.split('/').some(p=>p.startsWith('.'))||f.path.startsWith('Note Bridge Conflicts/'))continue;
        if(!validPath(f.path))throw new Error('Неподдерживаемый путь: '+f.path);
        if(f.stat.size>10*1024*1024)throw new Error('Файл больше лимита 10 МБ: '+f.path);
        files.set(f.path,{path:f.path,hash:await hash(await vault.readBinary(f))});
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
      conflict:async(path,bytes,key)=>{
        const target='Note Bridge Conflicts/'+path+'.remote-'+key.slice(0,12)+'.'+(path.split('.').at(-1)||'bin');
        if(!vault.getAbstractFileByPath(target)){await mkdir(target);await vault.createBinary(target,bytes);}
      }
    };
  }
  async sync(dryRun=false){
    if(this.busy||this.stopped||document.hidden)return;this.busy=true;this.paused=false;this.backgrounded=false;
    try{
      this.state.resumeSync=!dryRun;await this.persist();this.setProgress({phase:'Сверка…',done:0,total:0});
      const binding=this.origin()+'|'+this.state.settings.folderId;
      if(this.state.binding&&this.state.binding!==binding)throw new Error('Папка или сервис изменились. Используйте отдельное тестовое хранилище.');
      const drive=new Drive(this.state.settings.folderId,()=>this.token(),requestUrl,10*1024*1024,{check:()=>this.check(),progress:p=>this.setProgress(p)});
      const engine=new SyncEngine(this.local(),drive,this.state.baseline,async(base,event)=>{
        this.state.baseline=base;this.state.binding=binding;this.state.events.push(event);this.state.events=this.state.events.slice(-500);await this.persist();
      },{check:()=>this.check(),progress:p=>this.setProgress(p)});
      const events=await engine.run(dryRun);
      this.state.resumeSync=false;await this.persist();
      const pending=events.filter(e=>e.action.includes('deletion')||e.action==='conflict').length;
      this.setProgress({...this.progress,phase:pending?`Проверить: ${pending} конфликтов/удалений`:'Синхронизировано'});
      if(dryRun)new HistoryModal(this.app,events).open();
      else new Notice(pending?`Note Bridge: ${pending} конфликтов/удалений требуют проверки`:'Note Bridge: синхронизация завершена');
    }catch(error){
      const suspended=error instanceof Paused||this.backgrounded||document.hidden;
      const message=suspended?'Пауза. Выполненные операции сохранены.':error instanceof Error?error.message:'Неизвестная ошибка';
      this.setProgress({...this.progress,phase:suspended?'Приостановлено':'Ошибка: '+message});
      if(!suspended){this.state.resumeSync=false;new Notice(message,12000);}
      this.state.events.push({time:new Date().toISOString(),path:this.progress.path||'',action:suspended?'paused':'error',detail:message});this.state.events=this.state.events.slice(-500);await this.persist();
    }finally{
      this.busy=false;this.setProgress(this.progress);
      if(this.state.resumeSync&&!document.hidden&&!this.paused&&!this.stopped)window.setTimeout(()=>{void this.sync();},500);
    }
  }
}
class BridgeSettings extends PluginSettingTab {
  constructor(app:App,private p:NoteBridge){super(app,p);}
  display(){
    const el=this.containerEl;el.empty();el.createEl('h2',{text:'Note Bridge · тестовая версия 0.1.3'});
    el.createEl('p',{text:'Используйте отдельную копию хранилища. Автоудаление и переименование пока не распространяются. Лимит файла — 10 МБ. Другие средства синхронизации этого хранилища должны быть отключены.'});
    new Setting(el).setName('Адрес сервиса авторизации').setDesc('https://имя.workers.dev').addText(t=>t.setValue(this.p.state.settings.workerUrl).onChange(async v=>{if(this.p.busy)return;this.p.state.settings.workerUrl=v.trim();this.p.access=undefined;await this.p.persist();}));
    new Setting(el).setName('ID папки Google Drive').setDesc('Часть адреса после /folders/. Папку создайте заранее.').addText(t=>t.setValue(this.p.state.settings.folderId).onChange(async v=>{if(this.p.busy)return;this.p.state.settings.folderId=v.trim();await this.p.persist();}));
    let pairing='';
    new Setting(el).setName('Код подключения').setDesc('Код владельца сервиса. Используется один раз, не сохраняется в настройках.').addText(t=>{t.inputEl.type='password';t.onChange(v=>{pairing=v;});});
    const action=(fn:()=>Promise<unknown>)=>{void fn().catch(e=>new Notice(e instanceof Error?e.message:'Ошибка',12000));};
    new Setting(el).setName('Вход через Google').addButton(b=>b.setButtonText('Подключить').onClick(()=>action(()=>this.p.connect(pairing)))).addButton(b=>b.setButtonText('Завершить подключение').onClick(()=>action(()=>this.p.claim())));
    new Setting(el).setName('Прогресс').addButton(b=>b.setButtonText('Открыть').onClick(()=>this.p.openProgress()));
    new Setting(el).setName('Экспорт журнала').setDesc('Создаёт JSON без токенов и настроек авторизации. Его можно прислать для диагностики.').addButton(b=>b.setButtonText('Экспортировать').onClick(()=>action(()=>this.p.exportJournal())));
    new Setting(el).setName('Синхронизация').addButton(b=>b.setButtonText('Предпросмотр').onClick(()=>action(()=>this.p.sync(true)))).addButton(b=>b.setButtonText('Синхронизировать').setCta().onClick(()=>action(()=>this.p.sync())));
    new Setting(el).setName('Автоматическая синхронизация').setDesc('Только при открытом приложении. Включайте после успешной ручной проверки.').addToggle(t=>t.setValue(this.p.state.settings.autoSync).onChange(async v=>{this.p.state.settings.autoSync=v;await this.p.persist();}));
    new Setting(el).setName('История').addButton(b=>b.setButtonText('Открыть журнал').onClick(()=>new HistoryModal(this.app,this.p.state.events).open()));
    new Setting(el).setName('Отключить устройство').addButton(b=>b.setButtonText('Отключить').onClick(()=>action(()=>this.p.disconnect())));
  }
}
