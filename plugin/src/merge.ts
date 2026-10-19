import {Modal,Setting,Notice,type App} from 'obsidian';
import {compare,assemble,type Part} from '../../core/diff';
import type NoteBridge from './main';
import type {Review} from './resolution';
export class MergeModal extends Modal {
 private parts:Part[]=[];private choices=new Map<number,'local'|'remote'>();private closed=false;
 constructor(app:App,private plugin:NoteBridge,private path:string,private review:Review,private done:()=>void){super(app);}
 onOpen(){this.plugin.reviewing++;this.titleEl.setText('Сравнение: '+this.path);void this.load();}
 onClose(){this.closed=true;this.plugin.reviewing--;this.plugin.schedule();}
 async load(){
  this.contentEl.setText('Загрузка обеих версий…');
  try{const text=await this.plugin.conflictText(this.path,this.review);this.parts=compare(text.local,text.remote);if(!this.closed)this.render();}
  catch(e){if(!this.closed)this.contentEl.setText(String(e));}
 }
 render(){
  this.contentEl.empty();this.contentEl.addClass('nb-merge');
  this.contentEl.createEl('p',{text:'Сравниваются текущие версии телефона и Drive. Красный «−» — строки телефона, зелёный «+» — строки Drive. Это различия между версиями, а не определение автора правок: общего исходного текста здесь нет.'});
  const count=this.parts.filter(p=>p.kind==='change').length;
  const summary=this.contentEl.createEl('p',{text:`Выбрано ${this.choices.size} из ${count} блоков`});
  let n=0;
  this.parts.forEach((part,i)=>{
   if(part.kind==='equal'){
    const details=this.contentEl.createEl('details');details.createEl('summary',{text:'Совпадающий текст'});details.createEl('pre',{text:part.text,cls:'nb-diff-context'});return;
   }
   const card=this.contentEl.createDiv({cls:'nb-conflict-card'});card.createEl('h4',{text:`Изменение ${++n} · строки ${part.localLine} / ${part.remoteLine}`});
   card.createEl('div',{text:'− Телефон',cls:'nb-diff-minus'});card.createEl('pre',{text:part.local||'(пустой блок)',cls:'nb-diff-minus'});
   card.createEl('div',{text:'+ Google Drive',cls:'nb-diff-plus'});card.createEl('pre',{text:part.remote||'(пустой блок)',cls:'nb-diff-plus'});
   if(part.local&&!part.local.endsWith('\n')||part.remote&&!part.remote.endsWith('\n'))card.createEl('small',{text:'Одна из версий не содержит перевода строки в конце блока.'});
   const selected=card.createEl('p',{text:'Решение не выбрано'});
   const select=(side:'local'|'remote')=>{this.choices.set(i,side);selected.setText(side==='local'?'✓ Оставить строки телефона':'✓ Оставить строки Drive');summary.setText(`Выбрано ${this.choices.size} из ${count} блоков`);};
   new Setting(card).addButton(b=>b.setButtonText('Телефон').onClick(()=>select('local'))).addButton(b=>b.setButtonText('Drive').onClick(()=>select('remote')));
  });
  new Setting(this.contentEl).addButton(b=>b.setButtonText('Предпросмотр результата').setCta().onClick(()=>{
   try{const result=assemble(this.parts,this.choices);new ResultModal(this.app,this.plugin,this.path,this.review,result,()=>{this.done();this.close();}).open();}catch(e){new Notice(String(e));}
  }));
 }
}
class ResultModal extends Modal {
 private saving=false;
 constructor(app:App,private plugin:NoteBridge,private path:string,private review:Review,private result:string,private done:()=>void){super(app);}
 onOpen(){
  this.plugin.reviewing++;this.titleEl.setText('Итоговая заметка');
  this.contentEl.createEl('p',{text:'Проверьте результат. Здесь можно вручную уточнить любой фрагмент. Сохранение обновит телефон и Google Drive; исходные версии сохранятся в истории.'});
  const editor=this.contentEl.createEl('textarea',{cls:'nb-merge-editor',attr:{'aria-label':'Итоговый текст заметки',spellcheck:'false'}});editor.value=this.result;
  new Setting(this.contentEl).addButton(b=>b.setButtonText('Назад').onClick(()=>{if(!this.saving)this.close();})).addButton(b=>b.setButtonText('Сохранить на обеих сторонах').setCta().onClick(()=>{
   if(this.saving)return;this.saving=true;b.setDisabled(true);editor.disabled=true;
   void this.plugin.saveMerged(this.path,editor.value,this.review).then(()=>{new Notice('Объединённая заметка сохранена');this.close();this.done();}).catch(e=>{new Notice(String(e),15000);this.saving=false;b.setDisabled(false);editor.disabled=false;});
  }));
 }
 onClose(){this.plugin.reviewing--;this.plugin.schedule();}
}
