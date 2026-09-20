const KEY='db/information-portal.json', COOKIE='portal_session', TTL=43200, ITER=210000;
const ROLES=['administrator','editor','reader'], STATUSES=['draft','published'];
const te=new TextEncoder(), td=new TextDecoder();
class E extends Error{constructor(status,message){super(message);this.status=status}}

export async function onRequest({request,env}){
  try{
    if(!env.PORTAL_DATA) throw Error('Missing PORTAL_DATA R2 binding');
    if(!env.SESSION_SECRET||env.SESSION_SECRET.length<32) throw Error('SESSION_SECRET must be at least 32 characters');
    const u=new URL(request.url), m=request.method, p=u.pathname.replace(/^\/api\/?/,'').split('/').filter(Boolean);
    if(['POST','PUT','PATCH','DELETE'].includes(m)){const o=request.headers.get('Origin');if(o&&o!==u.origin)throw new E(403,'Cross-origin request rejected')}
    if(m==='GET'&&p[0]==='bootstrap') return await bootstrap(request,env);
    if(m==='POST'&&p[0]==='setup') return await setup(request,env);
    if(m==='POST'&&p[0]==='login') return await login(request,env);
    if(m==='POST'&&p[0]==='logout') return out({ok:true},200,{'Set-Cookie':deadCookie(request)});
    if(p[0]==='articles'){
      if(m==='GET'&&p.length===1)return await listArticles(request,env,u.searchParams.get('manage')==='1');
      if(m==='GET'&&p.length===2)return await getArticle(request,env,p[1]);
      if(m==='POST'&&p.length===1)return await saveArticle(request,env);
      if(m==='PUT'&&p.length===2)return await saveArticle(request,env,p[1]);
      if(m==='DELETE'&&p.length===2)return await deleteArticle(request,env,p[1]);
    }
    if(p[0]==='admin'&&p[1]==='users'){
      if(m==='GET'&&p.length===2)return await listUsers(request,env);
      if(m==='POST'&&p.length===2)return await saveUser(request,env);
      if(m==='PUT'&&p.length===3)return await saveUser(request,env,p[2]);
      if(m==='DELETE'&&p.length===3)return await deleteUser(request,env,p[2]);
    }
    if(m==='PATCH'&&p[0]==='admin'&&p[1]==='settings')return await settings(request,env);
    throw new E(404,'Endpoint not found');
  }catch(e){console.error(e);return out({error:e instanceof E?e.message:'Internal server error'},e instanceof E?e.status:500)}
}

async function bootstrap(req,env){const {db}=await read(env), s=await session(req,env).catch(()=>null), user=s?fromSession(db,s):null;return out({setupRequired:admins(db)===0,setupTokenRequired:!!env.BOOTSTRAP_TOKEN,mode:db.settings.mode,user:user?safe(user):null,adminCount:admins(db)})}

async function setup(req,env){const b=await body(req), email=emailOf(b.email), pass=passwordOf(b.password);if(env.BOOTSTRAP_TOKEN&&b.bootstrapToken!==env.BOOTSTRAP_TOKEN)throw new E(403,'Invalid setup token');
  const {result:user}=await mutate(env,async db=>{if(admins(db))throw new E(409,'Initial setup has already been completed');const now=new Date().toISOString(),user={id:crypto.randomUUID(),email,role:'administrator',password:await hash(pass),sessionNonce:crypto.randomUUID(),createdAt:now,updatedAt:now};db.users.push(user);return user});
  return out({user:safe(user)},201,{'Set-Cookie':await cookie(req,await token(user,env))})}

async function login(req,env){const b=await body(req),{db}=await read(env), user=db.users.find(x=>x.email===emailOf(b.email));if(!user||!await verify(String(b.password||''),user.password))throw new E(401,'Invalid email or password');return out({user:safe(user)},200,{'Set-Cookie':await cookie(req,await token(user,env))})}

async function listArticles(req,env,manage){const {db}=await read(env),s=await session(req,env).catch(()=>null),user=s?fromSession(db,s):null;if(manage)role(user,['administrator','editor']);else if(db.settings.mode==='private'&&!user)throw new E(401,'Authentication required');const a=manage?db.articles:db.articles.filter(x=>x.status==='published');return out({articles:[...a].sort((x,y)=>y.updatedAt.localeCompare(x.updatedAt))})}
async function getArticle(req,env,id){uuid(id);const {db}=await read(env),s=await session(req,env).catch(()=>null),user=s?fromSession(db,s):null,a=db.articles.find(x=>x.id===id);if(!a)throw new E(404,'Article not found');if(a.status==='draft')role(user,['administrator','editor']);else if(db.settings.mode==='private'&&!user)throw new E(401,'Authentication required');return out({article:a})}
async function saveArticle(req,env,id=null){if(id)uuid(id);const s=await mustSession(req,env),v=articleOf(await body(req));const {result:a}=await mutate(env,db=>{const user=fromSession(db,s);role(user,['administrator','editor']);const now=new Date().toISOString();if(id){const a=db.articles.find(x=>x.id===id);if(!a)throw new E(404,'Article not found');Object.assign(a,v,{updatedAt:now,updatedById:user.id});return a}const a={id:crypto.randomUUID(),...v,authorId:user.id,updatedById:user.id,createdAt:now,updatedAt:now};db.articles.push(a);return a});return out({article:a},id?200:201)}
async function deleteArticle(req,env,id){uuid(id);const s=await mustSession(req,env);await mutate(env,db=>{role(fromSession(db,s),['administrator','editor']);const i=db.articles.findIndex(x=>x.id===id);if(i<0)throw new E(404,'Article not found');db.articles.splice(i,1)});return out({ok:true})}

async function listUsers(req,env){const s=await mustSession(req,env),{db}=await read(env);role(fromSession(db,s),['administrator']);return out({users:db.users.map(safe).sort((a,b)=>a.email.localeCompare(b.email))})}
async function saveUser(req,env,id=null){if(id)uuid(id);const s=await mustSession(req,env),b=await body(req),email=emailOf(b.email),r=roleOf(b.role),pass=b.password?passwordOf(b.password):null;if(!id&&!pass)throw new E(400,'Password is required');
  const {result:user}=await mutate(env,async db=>{role(fromSession(db,s),['administrator']);if(db.users.some(x=>x.email===email&&x.id!==id))throw new E(409,'Email is already in use');const now=new Date().toISOString();if(id){const x=db.users.find(x=>x.id===id);if(!x)throw new E(404,'User not found');if(x.role==='administrator'&&r!=='administrator'&&admins(db)<=1)throw new E(409,'The system must always have at least one administrator');x.email=email;x.role=r;x.updatedAt=now;if(pass){x.password=await hash(pass);x.sessionNonce=crypto.randomUUID()}return x}const x={id:crypto.randomUUID(),email,role:r,password:await hash(pass),sessionNonce:crypto.randomUUID(),createdAt:now,updatedAt:now};db.users.push(x);return x});return out({user:safe(user)},id?200:201)}
async function deleteUser(req,env,id){uuid(id);const s=await mustSession(req,env);await mutate(env,db=>{role(fromSession(db,s),['administrator']);const i=db.users.findIndex(x=>x.id===id);if(i<0)throw new E(404,'User not found');if(db.users[i].role==='administrator'&&admins(db)<=1)throw new E(409,'The system must always have at least one administrator');db.users.splice(i,1)});return out({ok:true},200,s.uid===id?{'Set-Cookie':deadCookie(req)}:{})}
async function settings(req,env){const s=await mustSession(req,env),b=await body(req);if(!['private','public'].includes(b.mode))throw new E(400,'Mode must be private or public');await mutate(env,db=>{const user=fromSession(db,s);role(user,['administrator']);db.settings.mode=b.mode;db.settings.updatedAt=new Date().toISOString();db.settings.updatedById=user.id});return out({ok:true,mode:b.mode})}

function fresh(){const now=new Date().toISOString();return{id:crypto.randomUUID(),schemaVersion:1,settings:{id:crypto.randomUUID(),mode:'private',updatedAt:now,updatedById:null},users:[],articles:[],createdAt:now,updatedAt:now}}
async function read(env){const o=await env.PORTAL_DATA.get(KEY);if(!o)return{db:fresh(),etag:null};const db=await o.json();valid(db);return{db,etag:o.etag}}
async function mutate(env,fn){for(let n=0;n<8;n++){const o=await env.PORTAL_DATA.get(KEY),db=o?await o.json():fresh();valid(db);const result=await fn(db);db.updatedAt=new Date().toISOString();const onlyIf=o?{etagMatches:o.etag}:new Headers({'If-None-Match':'*'});const ok=await env.PORTAL_DATA.put(KEY,JSON.stringify(db),{onlyIf,httpMetadata:{contentType:'application/json; charset=utf-8'}});if(ok)return{db,result}}throw new E(409,'Data changed concurrently. Retry the operation.')}
function valid(db){if(!db||!isUuid(db.id)||db.schemaVersion!==1||!db.settings||!isUuid(db.settings.id)||!['private','public'].includes(db.settings.mode)||!Array.isArray(db.users)||!Array.isArray(db.articles))throw Error('Invalid JSON database');for(const x of [...db.users,...db.articles])if(!isUuid(x.id))throw Error('Record without UUID')}
function admins(db){return db.users.filter(x=>x.role==='administrator').length}
function fromSession(db,s){const u=db.users.find(x=>x.id===s.uid);return u&&u.sessionNonce===s.nonce?u:null}
function role(user,allowed){if(!user)throw new E(401,'Authentication required');if(!allowed.includes(user.role))throw new E(403,'Insufficient permissions');return user}
function safe(u){return{id:u.id,email:u.email,role:u.role,createdAt:u.createdAt,updatedAt:u.updatedAt}}

async function token(user,env){const p=b64(te.encode(JSON.stringify({uid:user.id,nonce:user.sessionNonce,exp:Math.floor(Date.now()/1000)+TTL}))),sig=await hmac(p,env.SESSION_SECRET,'sign');return p+'.'+sig}
async function session(req,env){const raw=readCookie(req.headers.get('Cookie')||'',COOKIE);if(!raw)throw Error('No session');const [p,s,...x]=raw.split('.');if(!p||!s||x.length||!await hmac(p,env.SESSION_SECRET,'verify',s))throw Error('Invalid session');const v=JSON.parse(td.decode(unb64(p)));if(!isUuid(v.uid)||!isUuid(v.nonce)||v.exp<=Date.now()/1000)throw Error('Expired session');return v}
async function mustSession(req,env){return session(req,env).catch(()=>{throw new E(401,'Authentication required')})}
async function hmac(v,secret,op,sig){const k=await crypto.subtle.importKey('raw',te.encode(secret),{name:'HMAC',hash:'SHA-256'},false,[op]);if(op==='sign')return b64(new Uint8Array(await crypto.subtle.sign('HMAC',k,te.encode(v))));return crypto.subtle.verify('HMAC',k,unb64(sig),te.encode(v))}
async function hash(pass){const salt=crypto.getRandomValues(new Uint8Array(16)),k=await crypto.subtle.importKey('raw',te.encode(pass),'PBKDF2',false,['deriveBits']),bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:ITER},k,256);return{algorithm:'PBKDF2-SHA-256',iterations:ITER,salt:b64(salt),hash:b64(new Uint8Array(bits))}}
async function verify(pass,r){if(!r||r.algorithm!=='PBKDF2-SHA-256')return false;const k=await crypto.subtle.importKey('raw',te.encode(pass),'PBKDF2',false,['deriveBits']),a=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:unb64(r.salt),iterations:r.iterations},k,256)),b=unb64(r.hash);if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a[i]^b[i];return d===0}

async function body(req){if(!(req.headers.get('content-type')||'').includes('application/json'))throw new E(415,'Content-Type must be application/json');try{return await req.json()}catch{throw new E(400,'Invalid JSON body')}}
function emailOf(v){const x=String(v||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)||x.length>254)throw new E(400,'Valid email is required');return x}
function passwordOf(v){const x=String(v||'');if(x.length<10||x.length>200)throw new E(400,'Password must be between 10 and 200 characters');return x}
function roleOf(v){if(!ROLES.includes(v))throw new E(400,'Invalid role');return v}
function articleOf(b){const title=String(b.title||'').trim(),summary=String(b.summary||'').trim(),content=String(b.content||'').trim(),status=String(b.status||'draft');if(!title||title.length>200)throw new E(400,'Title is required and must be at most 200 characters');if(summary.length>600)throw new E(400,'Summary must be at most 600 characters');if(!content||content.length>1000000)throw new E(400,'Article content is required and must be at most 1 MB');if(!STATUSES.includes(status))throw new E(400,'Invalid article status');return{title,summary,content,status}}
function uuid(v){if(!isUuid(v))throw new E(400,'Invalid UUID')}
function isUuid(v){return typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)}
function readCookie(h,n){for(const x of h.split(';')){const [k,...v]=x.trim().split('=');if(k===n)return v.join('=')}return null}
async function cookie(req,t){return COOKIE+'='+t+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+TTL+(new URL(req.url).protocol==='https:'?'; Secure':'')}
function deadCookie(req){return COOKIE+'=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'+(new URL(req.url).protocol==='https:'?'; Secure':'')}
function b64(a){let s='';for(const b of a)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function unb64(v){v=v.replace(/-/g,'+').replace(/_/g,'/');v+='='.repeat((4-v.length%4)%4);return Uint8Array.from(atob(v),c=>c.charCodeAt(0))}
function out(v,status=200,h={}){return new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...h}})}
