export class BrokerError extends Error {
  constructor(public status:number,message:string){super(message);}
}
export type PendingLogin={session:string;verifier:string;origin:string;expires:number};
type Store={device?:string;expired?:boolean;pending?:PendingLogin};
type Reply={status:number;data:Record<string,any>};
export class Connection {
  data:Store;message='';working=false;private generation=0;
  constructor(private io:{load:()=>Store;save:(s:Store)=>void;request:(path:string,data?:Record<string,string>,token?:string)=>Promise<Reply>;changed:()=>void;now?:()=>number}){this.data=io.load();}
  get status(){return this.data.pending?'authorizing':this.data.expired?'expired':this.data.device?'connected':'disconnected';}
  private now(){return this.io.now?.()??Date.now();}
  private save(){this.io.save(this.data);this.io.changed();}
  async start(code:string,origin:string,verifier:string,challenge:string){
    if(this.working||this.data.pending)return;
    const generation=++this.generation;this.working=true;this.message='Открываем вход через Google…';this.io.changed();
    try{
      const r=await this.io.request('/start',{pairingCode:code,challenge});
      if(generation!==this.generation)return;
      const url=new URL(r.data.url);
      if(url.origin!==origin||url.pathname!=='/authorize'||typeof r.data.session!=='string')throw new Error('Неверный ответ сервиса авторизации');
      this.data.pending={session:r.data.session,verifier,origin,expires:this.now()+600000};
      this.message='Завершите вход в браузере и вернитесь в Obsidian.';this.save();return url.href;
    }catch(e){if(generation===this.generation){this.message=e instanceof BrokerError&&e.status===403?'Неверный код подключения. Проверьте код владельца сервиса.':'Не удалось начать вход. Проверьте сеть и настройки сервиса.';this.io.changed();}throw e;}
    finally{this.working=false;this.io.changed();}
  }
  cancel(){this.generation++;delete this.data.pending;this.message='Вход отменён. Можно подключиться снова.';this.save();}
  async poll(origin:string){
    const p=this.data.pending;if(!p||this.working)return false;
    if(p.origin!==origin||p.expires<=this.now()){this.cancel();this.message='Время подключения истекло. Нажмите «Подключиться» и начните вход заново.';this.io.changed();return false;}
    const generation=this.generation;this.working=true;
    try{
      const r=await this.io.request('/claim',{session:p.session,verifier:p.verifier});
      if(generation!==this.generation){if(r.data.deviceToken)void this.io.request('/disconnect',{},r.data.deviceToken).catch(()=>{});return false;}
      if(r.status===202){this.message='Ожидаем завершения входа в браузере…';this.io.changed();return false;}
      if(typeof r.data.deviceToken!=='string'||!r.data.deviceToken)throw new Error('Invalid token');
      this.data={device:r.data.deviceToken};this.message='Google Drive подключён';this.save();return true;
    }catch(e){
      if(generation!==this.generation)return false;
      if(e instanceof BrokerError&&[400,403,410].includes(e.status)){delete this.data.pending;this.message='Подключение не завершено или истекло. Начните вход заново.';this.save();}
      else {this.message='Не удалось проверить вход. Повторим автоматически, когда появится соединение.';this.io.changed();}
      return false;
    }finally{this.working=false;this.io.changed();}
  }
  async token(){
    if(this.status!=='connected')throw new Error(this.status==='expired'?'Сессия Google истекла. Подключитесь заново.':'Сначала подключите Google Drive');
    const generation=this.generation,device=this.data.device;
    try{return (await this.io.request('/token',{},device)).data;}
    catch(e){if(generation===this.generation&&device===this.data.device&&e instanceof BrokerError&&e.status===401){this.data.expired=true;this.message='Сессия Google истекла или доступ отозван. Подключитесь заново, чтобы продолжить синхронизацию.';this.save();throw new Error(this.message);}throw e;}
  }
  async logout(){
    const device=this.data.device;this.generation++;this.data={};this.message='Вы вышли из аккаунта. Заметки и история сохранены.';this.save();
    if(device)try{await this.io.request('/disconnect',{},device);}catch(e){if(!(e instanceof BrokerError&&e.status===401)){this.message='Локальный выход выполнен. Сервер недоступен: отключение устройства на сервере не подтверждено.';this.io.changed();}}
  }
}
