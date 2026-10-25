import {Modal,type App} from 'obsidian';
/** Scoped styling only: retain Obsidian focus, backdrop and dismissal behavior. */
export class BridgeModal extends Modal {
  constructor(app:App){super(app);this.containerEl.addClass('nb-modal-container');this.modalEl.addClass('nb-modal');}
}
