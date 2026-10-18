import {random,digest,equal,seal,unseal} from './crypto';
type Session={id:string;challenge:string;google_verifier:string;expires:number;status:string;encrypted_refresh:string|null};
type Device={token_hash:string;encrypted_refresh:string;expires:number};
const SCOPES='openid email https://www.googleapis.com/auth/drive';
class HttpError extends Error {constructor(public status:number,message:string){super(message);}}
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'"};
function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{...headers,'Content-Type':'application/json'}});}
function text(value:string,status=200){return new Response(value,{status,headers:{...headers,'Content-Type':'text/plain; charset=utf-8'}});}
async function body(request:Request):Promise<Record<string,string>> {
  if(!request.headers.get('content-type')?.startsWith('application/json'))throw new HttpError(415,'JSON required');
  // Enforce bounds even for chunked requests.
  const reader=request.body?.getReader();let length=0;const chunks:Uint8Array[]=[];
  if(!reader)throw new HttpError(400,'Missing body');
  for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>4096){await reader.cancel();throw new HttpError(413,'Request too large');}chunks.push(value);}
  const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  let parsed:unknown;try{parsed=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new HttpError(400,'Invalid JSON');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.values(parsed).some(v=>typeof v!=='string'))throw new HttpError(400,'Invalid input');
  return parsed as Record<string,string>;
}
function valid(s:string|undefined){return !!s&&/^[A-Za-z0-9_-]{43}$/.test(s);}
async function googleToken(env:Env,values:Record<string,string>):Promise<{access_token:string;expires_in:number;refresh_token?:string;scope?:string}> {
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,...values}),signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new HttpError(401,'Google authorization expired or failed. Connect again.');
  const result=await response.json() as {access_token:string;expires_in:number;refresh_token?:string;scope?:string};
  if(!result.access_token||!result.expires_in)throw new HttpError(502,'Invalid Google response');return result;
}
function configured(env:Env){return !!(env.DB&&env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET&&env.ALLOWED_EMAIL&&env.PAIRING_CODE?.length>=32&&env.TOKEN_ENCRYPTION_KEY&&env.PUBLIC_ORIGIN&&!env.PUBLIC_ORIGIN.includes('REPLACE'));}
export default {
  async fetch(request:Request,env:Env):Promise<Response> {
    try {
      const url=new URL(request.url), now=Date.now();
      if(url.pathname==='/health')return json({service:'note-bridge-auth',version:'0.1.0',configured:configured(env)});
      if(!configured(env))throw new HttpError(503,'OAuth setup is not complete');
      if(url.origin!==env.PUBLIC_ORIGIN||url.protocol!=='https:')throw new HttpError(400,'Invalid service origin');
      if(request.method==='POST'&&url.pathname==='/start') {
        const b=await body(request);
        if(!await equal(b.pairingCode||'',env.PAIRING_CODE))throw new HttpError(403,'Invalid pairing code');
        if(!valid(b.challenge))throw new HttpError(400,'Invalid challenge');
        await env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(now).run();
        const count=await env.DB.prepare('SELECT count(*) AS n FROM sessions').first<{n:number}>();
        if((count?.n||0)>=20)throw new HttpError(429,'Too many pending connections');
        const id=random();
        await env.DB.prepare('INSERT INTO sessions(id,challenge,google_verifier,expires) VALUES(?,?,?,?)').bind(id,b.challenge,random(),now+600000).run();
        return json({session:id,url:env.PUBLIC_ORIGIN+'/authorize?session='+id});
      }
      if(request.method==='GET'&&url.pathname==='/authorize') {
        const id=url.searchParams.get('session')||'';
        if(!valid(id))throw new HttpError(400,'Invalid session');
        const s=await env.DB.prepare("SELECT * FROM sessions WHERE id=? AND expires>? AND status='pending'").bind(id,now).first<Session>();
        if(!s)throw new HttpError(410,'Connection expired');
        const target=new URL('https://accounts.google.com/o/oauth2/v2/auth');
        target.search=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:env.PUBLIC_ORIGIN+'/callback',response_type:'code',scope:SCOPES,access_type:'offline',prompt:'consent',state:id,code_challenge:await digest(s.google_verifier),code_challenge_method:'S256'}).toString();
        return new Response(null,{status:302,headers:{...headers,Location:target.toString(),'Set-Cookie':`nb_state=${id}; Secure; HttpOnly; SameSite=Lax; Path=/callback; Max-Age=600`}});
      }
      if(request.method==='GET'&&url.pathname==='/callback') {
        const state=url.searchParams.get('state')||'';
        const cookie=request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith('nb_state='))?.slice(9)||'';
        if(!valid(state)||!await equal(state,cookie))throw new HttpError(403,'Browser session mismatch');
        const s=await env.DB.prepare("UPDATE sessions SET status='exchanging' WHERE id=? AND expires>? AND status='pending' RETURNING *").bind(state,now).first<Session>();
        if(!s)throw new HttpError(410,'Connection expired or already used');
        try {
          const code=url.searchParams.get('code');if(!code||url.searchParams.has('error'))throw new HttpError(403,'Google access was not granted');
          const token=await googleToken(env,{grant_type:'authorization_code',code,code_verifier:s.google_verifier,redirect_uri:env.PUBLIC_ORIGIN+'/callback'});
          if(!token.refresh_token||!token.scope?.split(' ').includes('https://www.googleapis.com/auth/drive'))throw new HttpError(403,'Offline Drive access is required');
          const info=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:'Bearer '+token.access_token},signal:AbortSignal.timeout(20000)});
          if(!info.ok)throw new HttpError(403,'Cannot verify Google identity');
          const user=await info.json() as {email?:string;email_verified?:boolean};
          if(!user.email_verified||!await equal((user.email||'').toLowerCase(),env.ALLOWED_EMAIL.toLowerCase()))throw new HttpError(403,'This account is not allowed');
          await env.DB.prepare("UPDATE sessions SET status='ready', encrypted_refresh=?, google_verifier='' WHERE id=?").bind(await seal(token.refresh_token,env.TOKEN_ENCRYPTION_KEY),state).run();
          return text('Google Drive подключён. Вернитесь в Obsidian и нажмите «Завершить подключение». Окно можно закрыть.');
        } catch(error) {await env.DB.prepare('DELETE FROM sessions WHERE id=?').bind(state).run();throw error;}
      }
      if(request.method==='POST'&&url.pathname==='/claim') {
        const b=await body(request);if(!valid(b.verifier)||!valid(b.session))throw new HttpError(400,'Invalid session');
        const challenge=await digest(b.verifier);
        const s=await env.DB.prepare('SELECT * FROM sessions WHERE id=? AND challenge=? AND expires>?').bind(b.session,challenge,now).first<Session>();
        if(!s)throw new HttpError(410,'Connection expired');
        if(s.status!=='ready')return json({status:'pending'},202);
        // Atomic consumption: only one caller can receive this grant.
        const consumed=await env.DB.prepare("DELETE FROM sessions WHERE id=? AND challenge=? AND status='ready' AND expires>? RETURNING *").bind(b.session,challenge,now).first<Session>();
        if(!consumed?.encrypted_refresh)throw new HttpError(410,'Already claimed');
        const deviceToken=random();
        await env.DB.prepare('INSERT INTO devices(token_hash,encrypted_refresh,created,expires) VALUES(?,?,?,?)').bind(await digest(deviceToken),consumed.encrypted_refresh,now,now+180*86400000).run();
        return json({deviceToken});
      }
      if(request.method==='POST'&&(url.pathname==='/token'||url.pathname==='/disconnect')) {
        const token=request.headers.get('Authorization')?.replace(/^Bearer /,'')||'';
        if(!valid(token))throw new HttpError(401,'Device authorization required');
        const h=await digest(token);
        if(url.pathname==='/disconnect'){await env.DB.prepare('DELETE FROM devices WHERE token_hash=?').bind(h).run();return json({disconnected:true});}
        const device=await env.DB.prepare('SELECT * FROM devices WHERE token_hash=? AND expires>?').bind(h,now).first<Device>();
        if(!device)throw new HttpError(401,'Connect this device again');
        const lease=await env.DB.prepare('UPDATE devices SET last_refresh=? WHERE token_hash=? AND last_refresh<? RETURNING token_hash').bind(now,h,now-10000).first();
        if(!lease)throw new HttpError(429,'Please retry in 10 seconds');
        const result=await googleToken(env,{grant_type:'refresh_token',refresh_token:await unseal(device.encrypted_refresh,env.TOKEN_ENCRYPTION_KEY)});
        if(result.refresh_token)await env.DB.prepare('UPDATE devices SET encrypted_refresh=? WHERE token_hash=?').bind(await seal(result.refresh_token,env.TOKEN_ENCRYPTION_KEY),h).run();
        return json({accessToken:result.access_token,expiresIn:result.expires_in});
      }
      throw new HttpError(404,'Not found');
    } catch(error) {return json({error:error instanceof HttpError?error.message:'Authorization service error'},error instanceof HttpError?error.status:500);}
  },
  async scheduled(_event:ScheduledController,env:Env):Promise<void> {
    await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE expires<?').bind(Date.now()),env.DB.prepare('DELETE FROM devices WHERE expires<?').bind(Date.now())]);
  }
} satisfies ExportedHandler<Env>;
