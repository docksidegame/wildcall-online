// Wildcall online server: static game, accounts, cloud saves, server-side economy, admin, ranked PvP.
import express from 'express';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import {fileURLToPath} from 'url';
import {initDb,sql} from './db.js';
import {loadGame,econ,withSave,rules} from './game.js';
import {initPvp,pvpOnline} from './pvp.js';
import {getCfg,setCfg,loadCfg,DEFAULT_CFG,lockUser,loadUser,saveUser,today,publicUser,parseCookies,userFromCookie,stakeStatus,merge} from './shared.js';

const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT=+process.env.PORT||3000;
const PROD=process.env.NODE_ENV==='production';
const ADMINS=(process.env.ADMIN_USERNAMES||process.env.ADMIN_USERNAME||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
const SESSION_DAYS=30;





// ---------- tiny helpers ----------
const app=express();
app.set('trust proxy',1);
app.use(express.json({limit:'256kb'}));

const hits=new Map();
function limit(key,max,ms){const now=Date.now();const h=(hits.get(key)||[]).filter(t=>now-t<ms);h.push(now);hits.set(key,h);return h.length>max}
setInterval(()=>{const now=Date.now();for(const [k,h] of hits)if(!h.some(t=>now-t<3600e3))hits.delete(k)},600e3).unref();
const bad=(res,code,msg)=>res.status(code).json({error:msg});

async function auth(req,res,next){try{const u=await userFromCookie(req.headers.cookie);if(!u)return bad(res,401,'Please sign in.');req.user=u;next()}catch(e){next(e)}}
const adminOnly=(req,res,next)=>req.user.admin?next():bad(res,403,'Admins only.');
async function startSession(res,userId){const tok=crypto.randomBytes(32).toString('hex');
  await sql(`insert into sessions(token,user_id,expires) values($1,$2,now()+interval '${SESSION_DAYS} days')`,[tok,userId]);
  res.setHeader('Set-Cookie',`wc_sess=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS*86400}${PROD?'; Secure':''}`)}
function mePayload(u){return {user:publicUser(u),save:u.save,cfg:getCfg()}}

// ---------- accounts ----------
app.post('/api/signup',async(req,res,next)=>{try{
  if(limit('su:'+req.ip,5,3600e3))return bad(res,429,'Too many signups from here. Try again later.');
  const {username='',email='',password='',terms}=req.body||{};
  const un=String(username).trim(),em=String(email).trim().toLowerCase(),pw=String(password);
  if(!/^[A-Za-z0-9_]{3,16}$/.test(un))return bad(res,400,'Usernames are 3–16 letters, numbers or underscores.');
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)||em.length>200)return bad(res,400,'Enter a valid email address.');
  if(pw.length<8||pw.length>200)return bad(res,400,'Passwords need at least 8 characters.');
  if(!terms)return bad(res,400,'Please accept the account rules.');
  const exists=await sql(`select 1 from users where uname=$1 or email=$2`,[un.toLowerCase(),em]);if(exists.length)return bad(res,409,'That username or email is already taken.');
  const hash=await bcrypt.hash(pw,10);const admin=ADMINS.includes(un.toLowerCase());
  const r=await sql(`insert into users(username,uname,email,pass,admin) values($1,$2,$3,$4,$5) returning *`,[un,un.toLowerCase(),em,hash,admin]);
  await startSession(res,r[0].id);res.json(mePayload(r[0]))}catch(e){next(e)}});
app.post('/api/login',async(req,res,next)=>{try{
  if(limit('li:'+req.ip,20,900e3))return bad(res,429,'Too many attempts. Wait a few minutes.');
  const login=String((req.body||{}).login||'').trim().toLowerCase(),pw=String((req.body||{}).password||'');
  const r=await sql(`select * from users where uname=$1 or email=$1`,[login]);const u=r[0];
  if(!u||!(await bcrypt.compare(pw,u.pass)))return bad(res,401,'Wrong username or password.');
  if(u.banned)return bad(res,403,'This account has been banned.');
  if(ADMINS.includes(u.uname)&&!u.admin){await sql(`update users set admin=true where id=$1`,[u.id]);u.admin=true}
  await sql(`update users set last_seen=now() where id=$1`,[u.id]);await startSession(res,u.id);res.json(mePayload(u))}catch(e){next(e)}});
app.post('/api/logout',async(req,res)=>{const tok=parseCookies(req.headers.cookie).wc_sess;if(tok)await sql(`delete from sessions where token=$1`,[tok]).catch(()=>{});res.setHeader('Set-Cookie','wc_sess=; Path=/; Max-Age=0');res.json({ok:true})});
app.get('/api/me',auth,async(req,res,next)=>{try{let u=req.user;sql(`update users set last_seen=now() where id=$1`,[u.id]).catch(()=>{});
  if(u.save&&!u.save.capV){u=await lockUser(u.id,async()=>{const x=await loadUser(u.id);if(x.save&&!x.save.capV){const r=withSave(x.save,getCfg(),()=>null);const note=r.save.capNote;delete r.save.capNote;await saveUser(x.id,r.save);x.save=note?{...r.save,capNote:note}:r.save}return x})}
  res.json(mePayload(u))}catch(e){next(e)}});

// ---------- economy actions run by the real game code on the server ----------
const ACTS=new Set(['buyItem','buyTheme','buySingle','sellExtras','claimBounty','takePack','takeAll','pickStarter']);
app.post('/api/act',auth,async(req,res,next)=>{try{
  const {a,args}=req.body||{};if(!ACTS.has(a))return bad(res,400,'Unknown action.');
  if(limit('act:'+req.user.id,120,60e3))return bad(res,429,'Slow down a little.');
  const out=await lockUser(req.user.id,async()=>{const u=await loadUser(req.user.id);
    if(a!=='pickStarter'&&!u.save)throw Object.assign(new Error('Pick a starter deck first.'),{code:400});
    if(a==='pickStarter'&&u.save)throw Object.assign(new Error('You already have a save.'),{code:400});
    const r=econ(u.save,getCfg(),a,args);const note=r.save&&r.save.capNote;if(note)delete r.save.capNote;await saveUser(u.id,r.save);if(note)r.save={...r.save,capNote:note};return r});
  res.json({ok:true,save:out.save,result:out.result,msg:out.msg,cfg:getCfg()})}catch(e){if(e.code)return bad(res,e.code,e.message);next(e)}});

// non-economic save fields (decks, art choice, story scenes seen), validated against what the player owns
app.post('/api/meta',auth,async(req,res,next)=>{try{
  const body=req.body||{};
  const out=await lockUser(req.user.id,async()=>{const u=await loadUser(req.user.id);const save=u.save;if(!save)return {save:null};
    const S=rules();const C=S.C;let fixed=false;
    if(Array.isArray(body.decks)){const decks=[];for(const d of body.decks.slice(0,30)){if(!d||!Array.isArray(d.cards))continue;const cnt={};const cards=[];
        for(const id of d.cards.slice(0,60)){if(typeof id!=='string'||!C[id]){fixed=true;continue}const n=(cnt[id]||0)+1;const own=S.isExtra(id)?99:(save.coll[id]||0);
          if(n>S.limitOf(id)||n>own){fixed=true;continue}cnt[id]=n;cards.push(id)}
        decks.push({name:String(d.name||'Deck').slice(0,40),cards})}
      if(decks.length)save.decks=decks}
    if(Number.isInteger(body.active)&&body.active>=0&&body.active<save.decks.length)save.active=body.active;
    if(body.art&&typeof body.art==='object'){save.art=save.art||{};for(const [id,v] of Object.entries(body.art)){if(S.hasFinish(id)&&save.vars&&save.vars[id]&&save.vars[id][v]>0)save.art[id]=v}}
    if(Array.isArray(body.seen)){const keys=new Set(Object.keys(S.SCENES));save.seen=[...new Set([...(save.seen||[]),...body.seen.filter(k=>keys.has(k))])].slice(0,2000)}
    if(Array.isArray(body.pending)){const p=new Set(body.pending);save.pending=(save.pending||[]).filter(k=>p.has(k))}
    if(typeof body.name==='string')save.name=body.name.trim().slice(0,14)||save.name;
    await saveUser(u.id,save);return {save,fixed}});
  res.json({ok:true,...out})}catch(e){next(e)}});

// story duels against the AI run in the browser; rewards are applied here with daily caps
const duelTokens=new Map();
app.post('/api/duel/start',auth,(req,res)=>{const ri=+(req.body||{}).ri;const tok=crypto.randomBytes(12).toString('hex');duelTokens.set(tok,{uid:req.user.id,ri,t:Date.now()});res.json({token:tok})});
setInterval(()=>{const now=Date.now();for(const [k,v] of duelTokens)if(now-v.t>6*3600e3)duelTokens.delete(k)},600e3).unref();
app.post('/api/duel/finish',auth,async(req,res,next)=>{try{
  const {token,ri,r}=req.body||{};const t=duelTokens.get(token);
  if(!t||t.uid!==req.user.id||t.ri!==+ri)return bad(res,400,'That duel was not started online, so it gives no rewards.');
  duelTokens.delete(token);
  const secs=(Date.now()-t.t)/1000;
  const out=await lockUser(req.user.id,async()=>{const u=await loadUser(req.user.id);let note=null;
    const before={coins:u.save.coins,packs:u.save.packs};
    const res2=withSave(u.save,getCfg(),S=>S.acts.applyDuelResult(+ri,{...r,win:!!(r&&r.win)&&secs>=30}));
    const save=res2.save;const day=today();const daily=u.daily&&u.daily.day===day?u.daily:{day,aiCoins:0,aiPacks:0};
    let dc=save.coins-before.coins,dp=save.packs-before.packs;
    const capC=getCfg().caps.aiCoins,capP=getCfg().caps.aiPacks;
    if(daily.aiCoins+dc>capC){const cut=daily.aiCoins+dc-capC;save.coins-=cut;dc-=cut;note='You hit today\'s coin limit for AI duels. Ranked duels still pay out.'}
    if(daily.aiPacks+dp>capP){const cut=daily.aiPacks+dp-capP;save.packs-=cut;dp-=cut;note=note||'You hit today\'s pack limit for AI duels.'}
    daily.aiCoins+=Math.max(0,dc);daily.aiPacks+=Math.max(0,dp);
    if(res2.result){res2.result.coins=Math.max(0,dc);res2.result.packs=Math.max(0,dp)}
    await sql(`update users set save=$2,daily=$3 where id=$1`,[u.id,JSON.stringify(save),JSON.stringify(daily)]);
    return {save,result:res2.result,note}});
  res.json(out)}catch(e){next(e)}});

// ---------- ranked info ----------
app.get('/api/leaderboard',async(req,res,next)=>{try{res.json({rows:await sql(`select username,rating,wins,losses from users where banned=false and wins+losses>0 order by rating desc,wins desc limit 50`)})}catch(e){next(e)}});

app.get('/api/ranked/me',auth,async(req,res,next)=>{try{const u=req.user;
  const rank=u.wins+u.losses>0?(await sql(`select count(*)::int+1 as r from users where banned=false and wins+losses>0 and rating>$1`,[u.rating]))[0].r:null;
  const h=await sql(`select m.*,a.username as n1,b.username as n2 from matches m left join users a on a.id=m.p1 left join users b on b.id=m.p2 where m.p1=$1 or m.p2=$1 order by m.id desc limit 10`,[u.id]);
  const history=h.map(m=>{const me1=m.p1===u.id;return {won:m.winner===u.id,opp:((me1?m.n2:m.n1)||(m.reason&&m.reason.startsWith('bot:')?m.reason.slice(4)+' (bot)':'?'))+(m.reason==='friendly'?' · friendly':''),delta:me1?m.r1_after-m.r1_before:m.r2_after-m.r2_before,stake:m.stake}});
  res.json({rank,history,...stakeStatus(u)})}catch(e){next(e)}});
app.post('/api/settings',auth,async(req,res,next)=>{try{const b=req.body||{};const s={...(req.user.settings||{})};
  if(typeof b.country==='string'&&/^([A-Z]{2})?$/.test(b.country))s.country=b.country;if(typeof b.stakesOptIn==='boolean')s.stakesOptIn=b.stakesOptIn;
  await sql(`update users set settings=$2 where id=$1`,[req.user.id,JSON.stringify(s)]);res.json(stakeStatus({...req.user,settings:s}))}catch(e){next(e)}});

// ---------- admin ----------
app.get('/api/admin/config',auth,adminOnly,(req,res)=>res.json({cfg:getCfg()}));
app.put('/api/admin/config',auth,adminOnly,async(req,res,next)=>{try{const b=req.body||{};const S=rules();
  const num=(v,max)=>v==null||v===''?undefined:Math.max(0,Math.min(max,Math.round(+v)||0));
  const clean={prices:{},sale:{all:num(b.sale&&b.sale.all,90)||0,items:{}},disabled:Array.isArray(b.disabled)?b.disabled.filter(x=>typeof x==='string').slice(0,50):[],
    market:{prices:{},stock:Array.isArray(b.market&&b.market.stock)?b.market.stock.filter(id=>S.C[id]&&!S.isExtra(id)).slice(0,12):[]},
    banner:String(b.banner||'').slice(0,200),
    stakes:{enabled:!!(b.stakes&&b.stakes.enabled),max:num(b.stakes&&b.stakes.max,100000)??500,daily:num(b.stakes&&b.stakes.daily,100)??5,
      blocked:Array.isArray(b.stakes&&b.stakes.blocked)?b.stakes.blocked.filter(x=>/^[A-Z]{2}$/.test(x)):[],options:[50,100,250,500,1000].filter(v=>v<=(num(b.stakes&&b.stakes.max,100000)??500))},
    pvp:{win:num(b.pvp&&b.pvp.win,5000)??60,loss:num(b.pvp&&b.pvp.loss,5000)??15,dailyCoins:num(b.pvp&&b.pvp.dailyCoins,10000)??100,turnSecs:Math.max(20,num(b.pvp&&b.pvp.turnSecs,600)??75),botSecs:num(b.pvp&&b.pvp.botSecs,600)??30,botWin:num(b.pvp&&b.pvp.botWin,5000)??25,botLoss:num(b.pvp&&b.pvp.botLoss,5000)??5},
    caps:{aiCoins:num(b.caps&&b.caps.aiCoins,1e6)??3000,aiPacks:num(b.caps&&b.caps.aiPacks,1e4)??20}};
  for(const [k,v] of Object.entries((b.prices)||{})){const n=num(v,1e6);if(n!=null)clean.prices[k]=n}
  for(const [k,v] of Object.entries((b.sale&&b.sale.items)||{})){const n=num(v,90);if(n)clean.sale.items[k]=n}
  for(const [k,v] of Object.entries((b.market&&b.market.prices)||{})){const n=num(v,1e6);if(n!=null&&['c','u','r','h'].includes(k))clean.market.prices[k]=n}
  await sql(`insert into config(key,value) values('shop',$1) on conflict(key) do update set value=excluded.value`,[JSON.stringify(clean)]);
  await sql(`insert into audit(admin_id,action,detail) values($1,'config',$2)`,[req.user.id,JSON.stringify(clean)]);
  setCfg(clean);res.json({cfg:getCfg(),public:getCfg()})}catch(e){next(e)}});
app.get('/api/admin/users',auth,adminOnly,async(req,res,next)=>{try{const q='%'+String(req.query.q||'').toLowerCase()+'%';
  const rows=await sql(`select id,username,email,admin,banned,rating,wins,losses,save,created_at,last_seen from users where uname like $1 or email like $1 order by id desc limit 100`,[q]);
  const total=(await sql(`select count(*)::int as n from users`))[0].n;
  res.json({total,rows:rows.map(u=>({id:u.id,username:u.username,email:u.email,admin:u.admin,banned:u.banned,rating:u.rating,wins:u.wins,losses:u.losses,coins:u.save?u.save.coins:0,packs:u.save?u.save.packs:0,created:u.created_at,lastSeen:u.last_seen}))})}catch(e){next(e)}});
app.get('/api/admin/user/:id',auth,adminOnly,async(req,res,next)=>{try{const u=await loadUser(+req.params.id);if(!u)return bad(res,404,'No such player.');
  const S=rules();const sv=u.save||null;
  const summary=sv&&{coins:sv.coins,packs:sv.packs,premium:(sv.special||{}).premium||0,apex:(sv.special||{}).apex||0,uniq:Object.keys(sv.coll||{}).filter(id=>S.C[id]&&sv.coll[id]>0).length,cards:Object.values(sv.coll||{}).reduce((a,b)=>a+b,0),
    decks:(sv.decks||[]).map(d=>({name:d.name,size:d.cards.length,legal:!S.deckProblems(d.cards).length})),beaten:(sv.beaten||[]).length,rivals:S.RIVALS.length,stats:sv.stats||{},name:sv.name,convTotal:sv.convTotal||0};
  const m=await sql(`select m.*,a.username as n1,b.username as n2 from matches m left join users a on a.id=m.p1 left join users b on b.id=m.p2 where m.p1=$1 or m.p2=$1 order by m.id desc limit 15`,[u.id]);
  const audit=await sql(`select a.action,a.detail,a.created_at,x.username as by from audit a left join users x on x.id=a.admin_id where (a.detail->>'id')::text=$1 order by a.id desc limit 20`,[String(u.id)]);
  res.json({user:{id:u.id,username:u.username,email:u.email,admin:u.admin,banned:u.banned,rating:u.rating,wins:u.wins,losses:u.losses,created:u.created_at,lastSeen:u.last_seen,settings:u.settings},save:summary,
    matches:m.map(x=>{const me1=x.p1===u.id;return {when:x.created_at,won:x.winner===u.id,opp:(me1?x.n2:x.n1)||(x.reason&&x.reason.startsWith('bot:')?x.reason.slice(4)+' (bot)':x.reason==='friendly'?'friend':'?'),delta:me1?x.r1_after-x.r1_before:x.r2_after-x.r2_before,stake:x.stake,turns:x.turns,kind:x.reason&&x.reason.startsWith('bot:')?'bot':x.reason==='friendly'?'friendly':'ranked'}}),audit})}catch(e){next(e)}});
app.put('/api/admin/user/:id',auth,adminOnly,async(req,res,next)=>{try{const id=+req.params.id;const b=req.body||{};const changes={};
  const out=await lockUser(id,async()=>{const u=await loadUser(id);if(!u)throw Object.assign(new Error('No such player.'),{code:404});
    if(b.username!=null&&b.username!==u.username){const un=String(b.username).trim();if(!/^[A-Za-z0-9_]{3,16}$/.test(un))throw Object.assign(new Error('Usernames are 3–16 letters, numbers or underscores.'),{code:400});
      if((await sql(`select 1 from users where uname=$1 and id<>$2`,[un.toLowerCase(),id])).length)throw Object.assign(new Error('That username is taken.'),{code:409});
      await sql(`update users set username=$2,uname=$3 where id=$1`,[id,un,un.toLowerCase()]);changes.username=un}
    if(b.email!=null&&b.email!==u.email){const em=String(b.email).trim().toLowerCase();if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em))throw Object.assign(new Error('Enter a valid email.'),{code:400});
      if((await sql(`select 1 from users where email=$1 and id<>$2`,[em,id])).length)throw Object.assign(new Error('That email is in use.'),{code:409});
      await sql(`update users set email=$2 where id=$1`,[id,em]);changes.email=em}
    if(b.rating!=null){const r=Math.max(100,Math.min(5000,Math.round(+b.rating)||1000));if(r!==u.rating){await sql(`update users set rating=$2 where id=$1`,[id,r]);changes.rating=r}}
    if(b.admin!=null&&!!b.admin!==u.admin){if(id===req.user.id)throw Object.assign(new Error('You can\'t remove your own admin access.'),{code:400});await sql(`update users set admin=$2 where id=$1`,[id,!!b.admin]);changes.admin=!!b.admin}
    if(b.banned!=null&&!!b.banned!==u.banned){if(id===req.user.id)throw Object.assign(new Error('You can\'t ban yourself.'),{code:400});await sql(`update users set banned=$2 where id=$1`,[id,!!b.banned]);if(b.banned)await sql(`delete from sessions where user_id=$1`,[id]);changes.banned=!!b.banned}
    if(b.password){const pw=String(b.password);if(pw.length<8)throw Object.assign(new Error('Passwords need at least 8 characters.'),{code:400});await sql(`update users set pass=$2 where id=$1`,[id,await bcrypt.hash(pw,10)]);await sql(`delete from sessions where user_id=$1`,[id]);changes.password='reset'}
    if(u.save){const sv=u.save;let touched=false;const setN=(k,v)=>{if(v==null||v==='')return;const n=Math.max(0,Math.min(1e9,Math.round(+v)||0));return n};
      const c=setN('coins',b.coins);if(c!=null&&c!==sv.coins){changes.coins=[sv.coins,c];sv.coins=c;touched=true}
      const pk=setN('packs',b.packs);if(pk!=null&&pk!==sv.packs){changes.packs=[sv.packs,pk];sv.packs=pk;touched=true}
      sv.special=sv.special||{premium:0,apex:0};for(const k of ['premium','apex']){const v=setN(k,b[k]);if(v!=null&&v!==(sv.special[k]||0)){changes[k]=[sv.special[k]||0,v];sv.special[k]=v;touched=true}}
      if(touched)await saveUser(id,sv)}
    return changes});
  if(Object.keys(out).length)await sql(`insert into audit(admin_id,action,detail) values($1,'edit',$2)`,[req.user.id,JSON.stringify({id,changes:out})]);
  res.json({ok:true,changes:out})}catch(e){if(e.code)return bad(res,e.code,e.message);next(e)}});
// award coins / packs to one player or to everyone (e.g. an event or an apology)
app.post('/api/admin/award',auth,adminOnly,async(req,res,next)=>{try{const b=req.body||{};
  const n=v=>Math.max(-1e7,Math.min(1e7,Math.round(+v||0)));const coins=n(b.coins),packs=n(b.packs),premium=n(b.premium),apex=n(b.apex);const note=String(b.note||'').slice(0,120);
  if(!coins&&!packs&&!premium&&!apex)return bad(res,400,'Nothing to award.');
  const ids=b.all?(await sql(`select id from users where banned=false and save is not null`)).map(r=>r.id):[+b.id];
  let done=0;for(const id of ids){await lockUser(id,async()=>{const u=await loadUser(id);if(!u||!u.save)return;const sv=u.save;sv.coins=Math.max(0,sv.coins+coins);sv.packs=Math.max(0,sv.packs+packs);
    sv.special=sv.special||{premium:0,apex:0};sv.special.premium=Math.max(0,(sv.special.premium||0)+premium);sv.special.apex=Math.max(0,(sv.special.apex||0)+apex);
    if(note)sv.inbox=[...(sv.inbox||[]),{note,coins,packs,premium,apex,at:Date.now()}].slice(-10);await saveUser(id,sv);done++})}
  await sql(`insert into audit(admin_id,action,detail) values($1,'award',$2)`,[req.user.id,JSON.stringify({id:b.all?'all':+b.id,coins,packs,premium,apex,note,players:done})]);
  res.json({ok:true,players:done})}catch(e){next(e)}});
app.post('/api/admin/grant',auth,adminOnly,async(req,res,next)=>{try{const id=+req.body.id,coins=Math.round(+req.body.coins||0),packs=Math.round(+req.body.packs||0);
  const u=await lockUser(id,async()=>{const u=await loadUser(id);if(!u||!u.save)throw Object.assign(new Error('That player has no save yet.'),{code:400});
    u.save.coins=Math.max(0,u.save.coins+coins);u.save.packs=Math.max(0,u.save.packs+packs);await saveUser(id,u.save);return u});
  await sql(`insert into audit(admin_id,action,detail) values($1,'grant',$2)`,[req.user.id,JSON.stringify({id,coins,packs})]);res.json({ok:true,username:u.username})}catch(e){if(e.code)return bad(res,e.code,e.message);next(e)}});
app.post('/api/inbox/clear',auth,async(req,res,next)=>{try{await lockUser(req.user.id,async()=>{const u=await loadUser(req.user.id);if(u.save&&u.save.inbox){delete u.save.inbox;await saveUser(u.id,u.save)}});res.json({ok:true})}catch(e){next(e)}});
app.post('/api/admin/ban',auth,adminOnly,async(req,res,next)=>{try{const id=+req.body.id;if(id===req.user.id)return bad(res,400,'You can\'t ban yourself.');
  await sql(`update users set banned=$2 where id=$1`,[id,!!req.body.banned]);if(req.body.banned)await sql(`delete from sessions where user_id=$1`,[id]);
  await sql(`insert into audit(admin_id,action,detail) values($1,'ban',$2)`,[req.user.id,JSON.stringify({id,banned:!!req.body.banned})]);res.json({ok:true})}catch(e){next(e)}});

// season end: pay rewards by leaderboard position, then soft-reset ratings toward 1000
app.post('/api/admin/season/end',auth,adminOnly,async(req,res,next)=>{try{
  const rows=await sql(`select id,rating,wins,losses from users where banned=false and wins+losses>0 order by rating desc,wins desc`);
  const tier=(i,g)=>i===0?{coins:3000,packs:10}:i<10?{coins:1500,packs:5}:i<100?{coins:500,packs:2}:g>=5?{coins:200,packs:1}:null;
  let paid=0;
  for(let i=0;i<rows.length;i++){const r=rows[i];const t=tier(i,r.wins+r.losses);
    await lockUser(r.id,async()=>{const u=await loadUser(r.id);if(t&&u.save){u.save.coins+=t.coins;u.save.packs+=t.packs;paid++}
      const nr=Math.round(1000+(u.rating-1000)/2);await sql(`update users set save=$2,rating=$3,wins=0,losses=0 where id=$1`,[u.id,JSON.stringify(u.save),nr])})}
  await sql(`insert into audit(admin_id,action,detail) values($1,'season_end',$2)`,[req.user.id,JSON.stringify({players:rows.length,paid})]);
  res.json({ok:true,players:rows.length,paid})}catch(e){next(e)}});
app.get('/api/health',(req,res)=>res.json({ok:true,online:pvpOnline()}));
// ---------- static game ----------
app.use('/art',express.static(path.join(ROOT,'public/art'),{maxAge:'7d',immutable:true}));
app.get(['/','/index.html'],(req,res)=>{res.setHeader('Cache-Control','no-cache');res.sendFile(path.join(ROOT,'public/index.html'))});
app.use('/api',(req,res)=>bad(res,404,'Not found.'));
app.use((err,req,res,next)=>{console.error(err);bad(res,500,'Something went wrong on the server.')});

await initDb();await loadCfg();loadGame(ROOT);rules();
const server=http.createServer(app);
initPvp(server);
server.listen(PORT,()=>console.log(`Wildcall online on http://localhost:${PORT}`));
