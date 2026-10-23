import type {Baseline,Entry,Event} from '../../core/sync';
import type {Progress} from '../../core/control';
import type {Rename} from '../../core/changes';
import type {DriveIndex,WriteIntent} from './drive';
export type Settings={workerUrl:string;folderId:string;autoSync:boolean;intervalSeconds:number;deviceName:string;secretId:string};
export type Operation={id:string;action:string;local?:Entry;remote?:Entry;time:number};
export type Saved={operations?:Record<string,Operation>;pending?:Record<string,WriteIntent>;history?:Record<string,Entry>;noticeKey?:string;conflicts?:Record<string,string>;driveIndex?:DriveIndex;deleted?:string[];lastProgress?:Progress;settings:Settings;baseline:Baseline;events:Event[];binding?:string;resumeSync?:boolean;renames?:(Rename&{id?:string})[];autoMigration?:boolean};
export type StateRecord={kind:'checkpoint';path:string;base:Baseline[string]|null;event:Event;remote?:Entry;conflict?:string;binding:string}|{kind:'intent';key:string;value:WriteIntent|null}|{kind:'history';hash:string;entry:Entry}|{kind:'operation';path:string;value:Operation};
export function applyRecord(state:Saved,record:StateRecord){
 if(record.kind==='intent'){state.pending||={};if(record.value)state.pending[record.key]=record.value;else delete state.pending[record.key];return;}
 if(record.kind==='history'){state.history||={};state.history[record.hash]=record.entry;delete state.pending?.['history|'+record.hash];return;}
 if(record.kind==='operation'){state.operations||={};state.operations[record.path]=record.value;return;}
 if(record.event.action==='rename'&&record.event.detail)delete state.baseline[record.event.detail];
 if(record.path){if(record.base)state.baseline[record.path]=record.base;else delete state.baseline[record.path];
  if(!['error','conflict','local-deletion','remote-deletion'].includes(record.event.action))delete state.operations?.[record.path];
  if(record.conflict){state.conflicts||={};state.conflicts[record.path]=record.conflict;}
  // Recovered remote writes enter the index before the next Changes request.
  if(record.remote&&state.driveIndex){state.driveIndex.entries=state.driveIndex.entries.filter(e=>e.id!==record.remote!.id&&e.path!==record.path);state.driveIndex.entries.push(record.remote);}
 }
 state.binding=record.binding;state.events.push(record.event);state.events=state.events.slice(-500);
}
export const defaults:Settings={workerUrl:'https://note-bridge-auth.pravoepredserdie.workers.dev',folderId:'',autoSync:true,intervalSeconds:120,deviceName:'Моё устройство',secretId:''};
