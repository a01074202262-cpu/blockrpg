'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 10000;
const HOST = '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'accounts.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const MAX_PLAYERS = 80;
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean));
fs.mkdirSync(DATA_DIR, {recursive:true});
let db={users:{},states:{}};
try { const parsed=JSON.parse(fs.readFileSync(DB_FILE,'utf8')); if(parsed&&parsed.users&&parsed.states)db=parsed; } catch(e) { if(e.code!=='ENOENT') console.error('Account store could not be read:',e.message); }
function persist(){const tmp=DB_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(db));fs.renameSync(tmp,DB_FILE);}
const sessions=new Map();
const appLimiter=rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-7',legacyHeaders:false});
const authLimiter=rateLimit({windowMs:15*60*1000,limit:12,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'로그인/가입 시도가 너무 많습니다. 잠시 후 다시 시도하세요.'}});
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'","'unsafe-inline'",'https://cdnjs.cloudflare.com'],styleSrc:["'self'","'unsafe-inline'"],connectSrc:["'self'","ws:","wss:"],imgSrc:["'self'","data:"],fontSrc:["'self'","data:"],objectSrc:["'none'"],baseUri:["'self'"],frameAncestors:["'none'"],upgradeInsecureRequests:null}},crossOriginEmbedderPolicy:false,referrerPolicy:{policy:'no-referrer'}}));
app.use(appLimiter);
app.use(express.json({limit:'32kb',strict:true}));
app.use(express.text({type:'text/plain',limit:'32kb'}));
function safeEqual(a,b){const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);}
function hashPassword(password,salt){return crypto.scryptSync(password,salt,64).toString('hex');}
function validUsername(s){return typeof s==='string'&&/^[A-Za-z0-9_가-힣.-]{3,24}$/.test(s);}
function usernameKey(s){return s.toLocaleLowerCase('en-US');}
function validPassword(s){return typeof s==='string'&&s.length>=8&&s.length<=128;}
function sign(payload){const body=Buffer.from(JSON.stringify(payload)).toString('base64url');const sig=crypto.createHmac('sha256',SESSION_SECRET).update(body).digest('base64url');return body+'.'+sig;}
function unsign(token){if(typeof token!=='string')return null;const [body,sig]=token.split('.');if(!body||!sig)return null;const expected=crypto.createHmac('sha256',SESSION_SECRET).update(body).digest('base64url');if(!safeEqual(sig,expected))return null;try{const p=JSON.parse(Buffer.from(body,'base64url').toString());if(!p.u||!p.exp||p.exp<Date.now())return null;return p;}catch{return null;}}
function cookie(res,token){res.setHeader('Set-Cookie',`rpg_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS/1000)}`);}
function clearCookie(res){res.setHeader('Set-Cookie','rpg_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');}
function userFromReq(req){const cookies=String(req.headers.cookie||'').split(';').map(x=>x.trim());const item=cookies.find(x=>x.startsWith('rpg_session='));if(!item)return null;const payload=unsign(decodeURIComponent(item.slice('rpg_session='.length)));return payload&&db.users[payload.u]?payload.u:null;}
function requireUser(req,res,next){const u=userFromReq(req);if(!u)return res.status(401).json({error:'로그인이 필요합니다.'});req.userKey=u;next();}
function publicName(key){return db.users[key].username;}
function cleanState(input){
 if(!input||typeof input!=='object'||Array.isArray(input))return null;
 const p=input.player,c=input.camera;if(!p||typeof p!=='object'||Array.isArray(p))return null;
 const fields=['x','z','y','hp','mhp','lv','xp','nx','coin','at','face','inv','w','a','rg'],player={};
 for(const k of fields){const v=p[k];if(typeof v==='number'&&Number.isFinite(v))player[k]=Math.max(-1000000,Math.min(1000000,v));}
 player.x=Math.max(-220,Math.min(220,Number(player.x)||0));player.z=Math.max(-220,Math.min(220,Number(player.z)||0));
 player.lv=Math.max(1,Math.min(999,Math.floor(Number(player.lv)||1)));player.mhp=Math.max(1,Math.min(100000,Number(player.mhp)||100));player.hp=Math.max(0,Math.min(player.mhp,Number(player.hp)||0));
 player.coin=Math.max(0,Math.min(1e9,Math.floor(Number(player.coin)||0)));player.xp=Math.max(0,Math.min(1e9,Math.floor(Number(player.xp)||0)));
 player.pot=Array.isArray(p.pot)?p.pot.slice(0,8).map(v=>Math.max(0,Math.min(999,Math.floor(Number(v)||0)))):[2,0];
 const camera={};if(c&&typeof c==='object'){for(const k of ['yaw','pit','dist'])if(Number.isFinite(c[k]))camera[k]=Math.max(-1000,Math.min(1000,c[k]));}
 return {version:1,player,camera,savedAt:Date.now()};
}
app.post('/api/register',authLimiter,(req,res)=>{
 const {username,password}=req.body||{};
 if(!validUsername(username))return res.status(400).json({error:'아이디는 한글/영문/숫자/._- 조합으로 3~24자 입력하세요.'});
 if(!validPassword(password))return res.status(400).json({error:'비밀번호는 8~128자로 입력하세요.'});
 const key=usernameKey(username);
 if(db.users[key])return res.status(409).json({error:'이미 사용 중인 아이디입니다.'});
 const salt=crypto.randomBytes(16).toString('hex');
 db.users[key]={username,passwordHash:hashPassword(password,salt),salt,createdAt:Date.now()};
 db.states[key]=null;persist();
 const token=sign({u:key,exp:Date.now()+SESSION_TTL_MS});cookie(res,token);
 res.status(201).json({user:username,state:null});
});
app.post('/api/login',authLimiter,(req,res)=>{
 const {username,password}=req.body||{};if(typeof username!=='string'||typeof password!=='string')return res.status(400).json({error:'아이디와 비밀번호를 입력하세요.'});
 const key=usernameKey(username),u=db.users[key];
 // Constant-ish work for unknown users to reduce username enumeration timing differences.
 const salt=u?u.salt:'00000000000000000000000000000000';
 const actual=hashPassword(password,salt),expected=u?u.passwordHash:'0'.repeat(128);
 if(!u||!safeEqual(actual,expected))return res.status(401).json({error:'아이디 또는 비밀번호가 올바르지 않습니다.'});
 cookie(res,sign({u:key,exp:Date.now()+SESSION_TTL_MS}));
 res.json({user:u.username,state:db.states[key]||null});
});
app.get('/api/me',(req,res)=>{const key=userFromReq(req);if(!key)return res.status(401).json({error:'로그인이 필요합니다.'});res.json({user:publicName(key),state:db.states[key]||null});});
app.post('/api/save',requireUser,(req,res)=>{const state=cleanState(req.body&&req.body.state);if(!state)return res.status(400).json({error:'저장 데이터 형식이 올바르지 않습니다.'});db.states[req.userKey]=state;try{persist();res.json({ok:true,savedAt:state.savedAt});}catch(e){console.error('Persist failed',e);res.status(500).json({error:'서버 저장에 실패했습니다.'});}});
app.post('/api/save-beacon',(req,res)=>{const key=userFromReq(req);if(!key)return res.status(401).end();let body=req.body;if(typeof body==='string'){try{body=JSON.parse(body);}catch{return res.status(400).end();}}const state=cleanState(body&&body.state);if(!state)return res.status(400).end();db.states[key]=state;try{persist();res.status(204).end();}catch(e){res.status(500).end();}});
app.post('/api/logout',(req,res)=>{clearCookie(res);res.json({ok:true});});
app.get('/healthz',(_req,res)=>res.json({ok:true}));
app.use(express.static(path.join(__dirname,'public'),{index:'index.html',dotfiles:'deny',maxAge:'1h',setHeaders(res,p){if(p.endsWith('.html'))res.setHeader('Cache-Control','no-cache');res.setHeader('X-Content-Type-Options','nosniff');}}));
app.use((err,_req,res,_next)=>{if(res.headersSent)return;res.status(400).json({error:'요청을 처리할 수 없습니다.'});});
const server=app.listen(PORT,HOST,()=>console.log(`RPG server listening on ${HOST}:${PORT}; data=${DB_FILE}`));
const wss=new WebSocketServer({noServer:true,maxPayload:1024,perMessageDeflate:false});
const players=new Map(),socketsByIp=new Map();
function allowedOrigin(origin,req){if(!origin)return false;if(ALLOWED_ORIGINS.has(origin))return true;try{const u=new URL(origin),secure=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https';return u.host===req.headers.host&&u.protocol===(secure?'https:':'http:');}catch{return false;}}
function broadcast(data,except){const raw=JSON.stringify(data);for(const c of wss.clients)if(c!==except&&c.readyState===WebSocket.OPEN)try{c.send(raw);}catch{}}
server.on('upgrade',(req,socket,head)=>{let pathname;try{pathname=new URL(req.url,'http://localhost').pathname;}catch{socket.destroy();return;}if(pathname!=='/ws'||!allowedOrigin(req.headers.origin,req)){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();if((socketsByIp.get(ip)||0)>=4||players.size>=MAX_PLAYERS){socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>{ws._ip=ip;socketsByIp.set(ip,(socketsByIp.get(ip)||0)+1);wss.emit('connection',ws,req);});});
wss.on('connection',ws=>{ws.isAlive=true;ws.last=0;const id=crypto.randomUUID(),p={id,name:'플레이어-'+id.slice(0,4),x:0,z:8,y:0,face:0};players.set(id,p);ws.player=p;ws.send(JSON.stringify({type:'welcome',id,players:[...players.values()].filter(x=>x.id!==id)}));broadcast({type:'join',player:p},ws);ws.on('pong',()=>ws.isAlive=true);ws.on('message',(data,binary)=>{const now=Date.now();if(binary||data.length>1024||now-ws.last<80){ws.strikes=(ws.strikes||0)+1;if(ws.strikes>3)ws.close(1008,'rate limit');return;}ws.last=now;let m;try{m=JSON.parse(data.toString());}catch{ws.close(1007,'json');return;}if(!m||m.type!=='move'||![-220,220].every((v,i)=>true)||!Number.isFinite(m.x)||!Number.isFinite(m.z)||!Number.isFinite(m.y)||!Number.isFinite(m.face)||Math.abs(m.x)>230||Math.abs(m.z)>230||m.y<0||m.y>40){ws.strikes=(ws.strikes||0)+1;if(ws.strikes>=3)ws.close(1008,'state');return;}Object.assign(p,{x:m.x,z:m.z,y:m.y,face:m.face});broadcast({type:'state',player:p},ws);});ws.on('close',()=>{players.delete(p.id);broadcast({type:'leave',id:p.id});const n=(socketsByIp.get(ws._ip)||1)-1;if(n>0)socketsByIp.set(ws._ip,n);else socketsByIp.delete(ws._ip);});ws.on('error',()=>{});ws._heartbeat=setInterval(()=>{if(!ws.isAlive){ws.terminate();clearInterval(ws._heartbeat);return;}ws.isAlive=false;ws.ping();},30000);});
server.on('close',()=>{for(const ws of wss.clients)ws.terminate();});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
