import type {Baseline,Entry} from './sync';
export type Rename={from:string;to:string;folder:boolean};
export const under=(path:string,root:string)=>path===root||path.startsWith(root+'/');
export function remapBaseline(base:Baseline,from:string,to:string){
  const moves=Object.keys(base).filter(p=>under(p,from));
  for(const p of moves){const target=to+p.slice(from.length);if(base[target]&&!under(target,from))throw new Error('История нового пути уже существует: '+target);}
  for(const p of moves){base[to+p.slice(from.length)]=base[p];delete base[p];}
}
/** Propose only exact whole-tree duplicates whose old path is absent locally. */
export function duplicateFolders(local:Map<string,Entry>,remote:Map<string,Entry>,folders:Map<string,string>):{from:string;to:string;count:number}[]{
 const result:{from:string;to:string;count:number}[]=[];
 const roots=[...folders.keys()].filter(p=>p&&!p.includes('/'));
 for(const from of roots){
  const old=[...remote.values()].filter(e=>under(e.path,from));
  if(!old.length||[...local.keys()].some(p=>under(p,from)))continue;
  for(const to of roots){
   if(to===from)continue;
   const target=[...remote.values()].filter(e=>under(e.path,to));
   if(target.length!==old.length)continue;
   if(old.every(e=>{const p=to+e.path.slice(from.length);return local.get(p)?.hash===e.hash&&remote.get(p)?.hash===e.hash;})){
    result.push({from,to,count:old.length});break;
   }
  }
 }
 return result;
}
