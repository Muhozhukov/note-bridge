import {compare} from './diff';
const lines=(text:string)=>text.match(/[^\n]*\n|[^\n]+$/g)||[];
type Edit={start:number;end:number;text:string};
function edits(base:string,version:string):Edit[]{let at=0;const result:Edit[]=[];for(const part of compare(base,version)){if(part.kind==='equal'){at+=lines(part.text).length;continue;}const end=at+lines(part.local).length;result.push({start:at,end,text:part.remote});at=end;}return result;}
/** Conservative diff3: touching boundaries are reviewed rather than guessed. */
export function threeWay(base:string,local:string,remote:string):string|undefined{
 if(local===remote)return local;if(base===local)return remote;if(base===remote)return local;
 let a:Edit[],b:Edit[];try{a=edits(base,local);b=edits(base,remote);}catch{return undefined;}
 const combined=[...a];
 for(const right of b){let same=false;for(const left of a){if(left.start===right.start&&left.end===right.end&&left.text===right.text){same=true;continue;}if(left.start<=right.end&&right.start<=left.end)return undefined;}if(!same)combined.push(right);}
 const source=lines(base);let at=0,result='';for(const e of combined.sort((x,y)=>x.start-y.start)){result+=source.slice(at,e.start).join('')+e.text;at=e.end;}return result+source.slice(at).join('');
}
