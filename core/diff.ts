export type Part={kind:'equal';text:string}|{kind:'change';local:string;remote:string;localLine:number;remoteLine:number};
const lines=(text:string)=>text.match(/[^\n]*\n|[^\n]+$/g)||[];
/** Two-way line comparison, retaining original line endings and final newline. */
export function compare(local:string,remote:string):Part[]{
 if(local.length>200000||remote.length>200000)throw new Error('Заметка слишком большая для построчного сравнения (лимит 200 000 символов на версию).');
 const a=lines(local),b=lines(remote);let prefix=0,suffix=0;
 while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;
 while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
 const x=a.slice(prefix,a.length-suffix),y=b.slice(prefix,b.length-suffix),width=y.length+1;
 if((x.length+1)*width>2000000){
  // Patience anchors partition long notes before the bounded exact LCS fallback.
  const unique=(rows:string[])=>{const map=new Map<string,number>();rows.forEach((line,i)=>map.set(line,map.has(line)?-1:i));return map;};
  const ux=unique(x),uy=unique(y),pairs:[number,number][]=[];
  for(const [line,i] of ux){const j=uy.get(line);if(i>=0&&j!==undefined&&j>=0)pairs.push([i,j]);}pairs.sort((a,b)=>a[0]-b[0]);
  const tails:number[]=[],previous=new Int32Array(pairs.length).fill(-1);
  pairs.forEach((pair,i)=>{let lo=0,hi=tails.length;while(lo<hi){const mid=(lo+hi)>>1;if(pairs[tails[mid]][1]<pair[1])lo=mid+1;else hi=mid;}if(lo)previous[i]=tails[lo-1];tails[lo]=i;});
  if(!tails.length)throw new Error('Слишком много различий для сравнения на телефоне. Используйте внешний редактор или выбор целого файла.');
  const anchors:[number,number][]=[];for(let i=tails.at(-1)!;i>=0;i=previous[i])anchors.push(pairs[i]);anchors.reverse();
  const result:Part[]=[];const equal=(text:string)=>{if(!text)return;const last=result.at(-1);if(last?.kind==='equal')last.text+=text;else result.push({kind:'equal',text});};
  equal(a.slice(0,prefix).join(''));let i=0,j=0;
  for(const [ai,bj] of [...anchors,[x.length,y.length] as [number,number]]){
   for(const part of compare(x.slice(i,ai).join(''),y.slice(j,bj).join(''))){if(part.kind==='equal')equal(part.text);else result.push({...part,localLine:part.localLine+prefix+i,remoteLine:part.remoteLine+prefix+j});}
   if(ai<x.length)equal(x[ai]);i=ai+1;j=bj+1;
  }
  equal(a.slice(a.length-suffix).join(''));return result;
 }
 const dp=new Uint32Array((x.length+1)*width),distance=new Uint32Array(dp.length);
 const downFirst=(i:number,j:number)=>{const down=(i+1)*width+j,right=i*width+j+1;return dp[down]>dp[right]||(dp[down]===dp[right]&&distance[down]<=distance[right]);};
 // Prefer equally long alignments that keep nearby lines together. This avoids
 // anchoring on a repeated line far away instead of unchanged local context.
 for(let i=x.length-1;i>=0;i--)for(let j=y.length-1;j>=0;j--){
  const at=i*width+j;
  if(x[i]===y[j]){dp[at]=dp[(i+1)*width+j+1]+1;distance[at]=distance[(i+1)*width+j+1]+Math.abs(i-j);}
  else{const next=downFirst(i,j)?(i+1)*width+j:i*width+j+1;dp[at]=dp[next];distance[at]=distance[next];}
 }
 const parts:Part[]=[];const equal=(text:string)=>{if(!text)return;const last=parts.at(-1);if(last?.kind==='equal')last.text+=text;else parts.push({kind:'equal',text});};
 equal(a.slice(0,prefix).join(''));let i=0,j=0;
 while(i<x.length||j<y.length){
  if(i<x.length&&j<y.length&&x[i]===y[j]){equal(x[i]);i++;j++;continue;}
  const part:Part={kind:'change',local:'',remote:'',localLine:prefix+i+1,remoteLine:prefix+j+1};
  while(i<x.length||j<y.length){
   if(i<x.length&&j<y.length&&x[i]===y[j])break;
   if(i<x.length&&(j===y.length||downFirst(i,j)))part.local+=x[i++];else part.remote+=y[j++];
  }
  parts.push(part);
 }
 equal(a.slice(a.length-suffix).join(''));return parts;
}
export function assemble(parts:Part[],choices:Map<number,'local'|'remote'>){
 return parts.map((p,i)=>{if(p.kind==='equal')return p.text;const choice=choices.get(i);if(!choice)throw new Error('Выберите версию для каждого блока изменений');return p[choice];}).join('');
}
