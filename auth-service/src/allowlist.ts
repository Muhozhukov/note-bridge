import {equal} from './crypto';
/** Keep the legacy binding name; accept exact addresses, never domains/wildcards. */
export function allowedEmails(value:string|undefined):string[]{
  if(typeof value!=='string'||value.length>16384)return [];
  const entries=value.split(/[,;\r\n]/).map(s=>s.trim().toLowerCase()).filter(Boolean);
  if(!entries.length||entries.length>100||entries.some(s=>s.length>254||! /^[^\s@,;<>*]+@[^\s@,;<>*]+\.[^\s@,;<>*]+$/.test(s)))return [];
  return [...new Set(entries)];
}
export async function permittedEmail(value:string|undefined,email:unknown,verified:unknown):Promise<boolean>{
  if(verified!==true||typeof email!=='string')return false;
  const matches=await Promise.all(allowedEmails(value).map(allowed=>equal(email.toLowerCase(),allowed)));
  return matches.some(Boolean);
}
