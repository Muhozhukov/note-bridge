import {MergeModal} from './merge';
import {Modal,Setting,Notice,type App} from 'obsidian';
import type NoteBridge from './main';
import {decide,type Entry} from '../../core/sync';
import {duplicateFolders} from '../../core/changes';
export type Review={local:Map<string,Entry>;remote:Map<string,Entry>;folders:Map<string,string>};
export class ResolutionModal extends Modal {
  constructor(app:App,private plugin:NoteBridge){super(app);}
  onOpen(){this.plugin.reviewing++;this.titleEl.setText('Конфликты и удаления');void this.reload();}
  onClose(){this.plugin.reviewing--;this.plugin.schedule();}
  async reload(refresh=false){
    this.contentEl.empty();this.contentEl.createEl('p',{text:'Проверка актуальных версий…'});
    try{
      const review=await this.plugin.review(refresh);this.contentEl.empty();
      this.contentEl.createEl('p',{text:'Удаление из Drive переносит объект в корзину. Перед заменой версии сохраняется снимок. Если файлы изменились после проверки, действие будет остановлено.'});
      const action=(fn:()=>Promise<void>)=>{
        this.contentEl.querySelectorAll('button').forEach(b=>b.disabled=true);
        const status=this.contentEl.createEl('p',{text:'Применяем решение…',attr:{role:'status'}});
        void fn().then(()=>{new Notice('Решение применено');return this.reload();}).catch(e=>{status.setText(String(e));this.contentEl.querySelectorAll('button').forEach(b=>b.disabled=false);});
      };
      let count=0;
      for(const rename of this.plugin.state.renames||[]){
        count++;new Setting(this.contentEl).setName('Ожидает переименования: '+rename.from+' → '+rename.to).setDesc('Если целевая папка уже существует, сначала проверьте дубликаты ниже. Можно отменить только передачу переименования: файлы останутся на местах и будут сравниваться отдельно.').addButton(b=>b.setButtonText('Отменить передачу').onClick(()=>new ConfirmModal(this.app,'Отменить передачу переименования? Содержимое останется на обеих сторонах.',()=>action(async()=>{if(this.plugin.busy)throw new Error('Дождитесь операции');this.plugin.state.renames=this.plugin.state.renames?.filter(r=>r!==rename);await this.plugin.persist();})).open()));
      }
      for(const duplicate of duplicateFolders(review.local,review.remote,review.folders)){
        count++;const duplicateCard=this.contentEl.createDiv({cls:'nb-conflict-card nb-danger-card'});new Setting(duplicateCard).setName('Дубликат: '+duplicate.from).setDesc(`${duplicate.count} файлов совпадают с «${duplicate.to}» в Drive и на телефоне. Локально «${duplicate.from}» отсутствует.`).addButton(b=>b.setButtonText('В корзину Drive').setWarning().onClick(()=>new ConfirmModal(this.app,`Перенести «${duplicate.from}» (${duplicate.count} файлов) в корзину Drive? Пустые папки останутся. Папка «${duplicate.to}» останется.`,()=>action(()=>this.plugin.removeDuplicate(duplicate,review))).open()));
      }
      const paths=new Set([...review.local.keys(),...review.remote.keys(),...Object.keys(this.plugin.state.baseline)]);
      for(const path of [...paths].sort()){
        const l=review.local.get(path),r=review.remote.get(path),type=decide(this.plugin.state.baseline[path]?.hash,l?.hash,r?.hash);
        if(!['conflict','local-deletion','remote-deletion'].includes(type))continue;count++;
        const card=this.contentEl.createDiv({cls:'nb-conflict-card'+(type.includes('deletion')?' nb-danger-card':'')});
        card.createEl('div',{text:type==='conflict'?'Разные правки в одной заметке':'Требуется решение об удалении',cls:'nb-conflict-label'});
        const row=new Setting(card).setName(path).setDesc(type==='conflict'?'Обе версии изменились':type==='local-deletion'?'Удалено на телефоне, осталось в Drive':'Удалено в Drive, осталось на телефоне');
        const choose=(side:'local'|'remote')=>action(()=>this.plugin.resolve(path,side,review));
        if(type==='conflict'&&/\.(md|txt)$/i.test(path))new Setting(card).addButton(b=>b.setButtonText('Сравнить и объединить изменения').setCta().onClick(()=>new MergeModal(this.app,this.plugin,path,review,()=>{void this.reload();}).open()));
        if(type==='conflict')row.addButton(b=>b.setButtonText('Оставить телефон').onClick(()=>choose('local'))).addButton(b=>b.setButtonText('Оставить Drive').onClick(()=>choose('remote')));
        if(type==='local-deletion')row.addButton(b=>b.setButtonText('Восстановить на телефоне').onClick(()=>choose('remote'))).addButton(b=>b.setButtonText('В корзину Drive').setWarning().onClick(()=>new ConfirmModal(this.app,'Перенести в корзину Drive: '+path,()=>choose('local')).open()));
        if(type==='remote-deletion')row.addButton(b=>b.setButtonText('Вернуть в Drive').onClick(()=>choose('local'))).addButton(b=>b.setButtonText('Удалить на телефоне').setWarning().onClick(()=>new ConfirmModal(this.app,'Перенести в локальную корзину: '+path,()=>choose('remote')).open()));
      }
      if(!count)this.contentEl.createEl('p',{text:'Конфликтов, ожидающих удаления и точных дубликатов папок не найдено.'});
      new Setting(this.contentEl).addButton(b=>b.setButtonText('Проверить изменения в Drive').onClick(()=>{void this.reload(true);}));
    }catch(e){this.contentEl.empty();this.contentEl.createEl('p',{text:String(e)});new Setting(this.contentEl).addButton(b=>b.setButtonText('Повторить проверку').onClick(()=>{void this.reload(true);}));}
  }
}
class ConfirmModal extends Modal {
 constructor(app:App,private message:string,private confirm:()=>void){super(app);}
 onOpen(){this.titleEl.setText('Подтверждение');this.contentEl.addClass('nb-danger-card');this.contentEl.createEl('p',{text:this.message});new Setting(this.contentEl).addButton(b=>b.setButtonText('Отмена').onClick(()=>this.close())).addButton(b=>b.setButtonText('Подтвердить').setWarning().onClick(()=>{this.close();this.confirm();}));}
}
