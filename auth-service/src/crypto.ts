export function encode(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''); }
export function decode(s: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')), c=>c.charCodeAt(0)); }
export const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
export async function digest(s:string):Promise<string> {return encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))));}
export async function equal(a:string,b:string):Promise<boolean> {
  const key=await crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
  const tag=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(a));
  return crypto.subtle.verify('HMAC',key,tag,new TextEncoder().encode(b));
}
async function key(secret:string) {const bytes=decode(secret);if(bytes.length!==32)throw new Error('Invalid encryption key');return crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']);}
export async function seal(value:string,secret:string):Promise<string> {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('note-bridge:v1')},await key(secret),new TextEncoder().encode(value));
  return encode(iv)+'.'+encode(new Uint8Array(data));
}
export async function unseal(value:string,secret:string):Promise<string> {
  const [iv,data]=value.split('.');return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(iv),additionalData:new TextEncoder().encode('note-bridge:v1')},await key(secret),decode(data)));
}
