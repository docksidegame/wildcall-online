// Ranked matchmaking and server-run duels over WebSocket. Each match runs the real duel engine in its own realm.
import {WebSocketServer} from 'ws';
import crypto from 'crypto';
import {sql} from './db.js';
import {makeRealm,rules,withSave} from './game.js';
import {getCfg,lockUser,loadUser,saveUser,today,publicUser,userFromCookie,stakeStatus} from './shared.js';

const socks=new Map();      // userId -> ws
const queue=[];             // {uid,name,rating,games,deck,stake,since,sig}
const matches=new Map();    // matchId -> match
const userMatch=new Map();  // userId -> matchId
const PROMPT_SECS=+process.env.PVP_PROMPT_SECS||30,GRACE_SECS=+process.env.PVP_GRACE_SECS||45;
export const pvpOnline=()=>({sockets:socks.size,queued:queue.length,matches:matches.size});
const send=(ws,o)=>{if(ws&&ws.readyState===1)ws.send(JSON.stringify(o))};
const sendU=(uid,o)=>send(socks.get(uid),o);

export function initPvp(server){
  const wss=new WebSocketServer({server,path:'/ws',maxPayload:64*1024});
  wss.on('connection',async(ws,req)=>{
    let u=null;try{u=await userFromCookie(req.headers.cookie)}catch(e){}
    if(!u){send(ws,{t:'err',msg:'Please sign in again.'});ws.close();return}
    const uid=u.id;const old=socks.get(uid);if(old&&old!==ws){send(old,{t:'err',msg:'Signed in somewhere else.'});old.close()}
    socks.set(uid,ws);ws.isAlive=true;ws.on('pong',()=>{ws.isAlive=true});
    const mid=userMatch.get(uid);if(mid&&matches.has(mid))reattach(matches.get(mid),uid);
    ws.on('message',buf=>{let m;try{m=JSON.parse(buf)}catch(e){return}onMsg(uid,m).catch(e=>{console.error('[pvp]',e);send(ws,{t:'err',msg:e.message||'Error'})})});
    ws.on('close',()=>{if(socks.get(uid)===ws){socks.delete(uid);leaveQueue(uid);const mid=userMatch.get(uid);if(mid&&matches.has(mid))dropped(matches.get(mid),uid)}});
  });
  setInterval(()=>{for(const ws of wss.clients){if(!ws.isAlive){ws.terminate();continue}ws.isAlive=false;ws.ping()}},25000).unref();
  setInterval(matchmake,1500).unref();
}
function leaveQueue(uid){const i=queue.findIndex(q=>q.uid===uid);if(i>=0)queue.splice(i,1)}
async function onMsg(uid,m){
  if(m.t==='queue')return joinQueue(uid,m);
  if(m.t==='cancel'){leaveQueue(uid);sendU(uid,{t:'unqueued'});return}
  const mid=userMatch.get(uid);const M=mid&&matches.get(mid);if(!M)return;
  const pi=M.pl.findIndex(p=>p.uid===uid);if(pi<0)return;
  if(m.t==='act'){if(m.a==='forfeit'){M.chain=M.chain.then(()=>M.S.netAct(pi,'forfeit'));return}
    if(!['summon','attach','evolve','retreat','playLand','activateLand','swapCard','playTrainer','attack','endTurn'].includes(m.a))return;
    const args=Array.isArray(m.args)?m.args.slice(0,4).map(x=>typeof x==='number'||typeof x==='string'||x==null?x:null):[];
    M.chain=M.chain.then(async()=>{const ok=await M.S.netAct(pi,m.a,args);if(!ok&&m.a!=='endTurn')sendU(uid,{t:'err',msg:'That move isn\'t allowed right now.'});M.push()}).catch(e=>console.error('[match]',e));return}
  if(m.t==='choice'){const p=M.prompts.get(m.id);if(!p||p.pi!==pi)return;const ok=p.opts.find(o=>JSON.stringify(o.val)===JSON.stringify(m.val));p.finish(ok?ok.val:p.opts[0].val);return}
}
async function joinQueue(uid,m){
  if(userMatch.has(uid))return sendU(uid,{t:'err',msg:'You are already in a match.'});
  leaveQueue(uid);const u=await loadUser(uid);if(!u||!u.save)return sendU(uid,{t:'unqueued',msg:'Create your save first.'});
  const S=rules();const d=u.save.decks[+m.deck];if(!d)return sendU(uid,{t:'unqueued',msg:'Pick a deck.'});
  const probs=S.deckProblems(d.cards);if(probs.length)return sendU(uid,{t:'unqueued',msg:'That deck isn\'t legal: '+probs.join(', ')});
  const cnt={};for(const id of d.cards)if(!S.isExtra(id)){cnt[id]=(cnt[id]||0)+1;if(cnt[id]>(u.save.coll[id]||0))return sendU(uid,{t:'unqueued',msg:'You don\'t own every card in that deck.'})}
  let stake=Math.max(0,Math.round(+m.stake||0));
  if(stake){const ss=stakeStatus(u);const cfg=getCfg().stakes;if(!ss.stakesAllowed)return sendU(uid,{t:'unqueued',msg:ss.stakesReason});
    if(stake>cfg.max||!(cfg.options||[]).includes(stake))return sendU(uid,{t:'unqueued',msg:'That stake isn\'t allowed.'});
    if(u.save.coins<stake)return sendU(uid,{t:'unqueued',msg:'You don\'t have enough coins for that stake.'})}
  const sig=d.cards.find(id=>S.C[id]&&S.C[id].kind==='unit')||'zapkit';
  queue.push({uid,name:u.username,rating:u.rating,games:u.wins+u.losses,deck:d.cards.slice(),stake,since:Date.now(),sig});
  sendU(uid,{t:'queued'});
}
function matchmake(){
  queue.sort((a,b)=>a.since-b.since);
  for(let i=0;i<queue.length;i++){const a=queue[i];const waitA=(Date.now()-a.since)/1000;
    for(let j=i+1;j<queue.length;j++){const b=queue[j];if(a.stake!==b.stake)continue;const wait=Math.max(waitA,(Date.now()-b.since)/1000);
      if(Math.abs(a.rating-b.rating)<=Math.min(800,100+wait*10)){queue.splice(j,1);queue.splice(i,1);startMatch(a,b).catch(e=>console.error('[start]',e));i--;break}}}
  // nobody around: after botSecs, play an AI rival instead (never for stakes)
  const botSecs=+process.env.PVP_BOT_SECS||getCfg().pvp.botSecs;
  if(botSecs>0)for(let i=queue.length-1;i>=0;i--){const a=queue[i];if(!a.stake&&(Date.now()-a.since)/1000>=botSecs){queue.splice(i,1);
    const bot=rules().botFor(a.rating);startMatch(a,{bot:true,uid:null,name:bot.name,title:bot.title,rating:a.rating,games:99,deck:bot.deck,stake:0,sig:bot.sig}).catch(e=>console.error('[bot]',e))}}
}
async function startMatch(a,b){
  if(a.stake){const take=q=>lockUser(q.uid,async()=>{const u=await loadUser(q.uid);if(!u||u.save.coins<q.stake)return false;u.save.coins-=q.stake;
      const day=today();const daily=u.daily&&u.daily.day===day?u.daily:{day};daily.stakes=(daily.stakes||0)+1;
      await sql(`update users set save=$2,daily=$3 where id=$1`,[u.id,JSON.stringify(u.save),JSON.stringify(daily)]);return true});
    if(!await take(a)){sendU(a.uid,{t:'unqueued',msg:'Not enough coins for that stake.'});b.since=Date.now();queue.push(b);return}
    if(!await take(b)){await refund(a);sendU(b.uid,{t:'unqueued',msg:'Not enough coins for that stake.'});a.since=Date.now();queue.push(a);return}}
  const id=crypto.randomBytes(8).toString('hex');const realm=makeRealm();const S=realm.WCS;
  const M={id,S,pl:[a,b].map(q=>({uid:q.uid,name:q.name,rating:q.rating,games:q.games,sig:q.sig,bot:!!q.bot,title:q.title,away:null})),bot:!!b.bot,stake:a.stake,prompts:new Map(),chain:Promise.resolve(),fx:[[],[]],pushT:null,turnT:null,deadline:0,ended:false,started:Date.now()};
  matches.set(id,M);M.pl.forEach(p=>{if(p.uid!=null)userMatch.set(p.uid,id)});
  const cfg=getCfg();
  const NET={server:true,
    dirty(){M.push()},
    fx(q){for(const f of q)for(let pi=0;pi<2;pi++){const g={...f};if(typeof g.who==='string'&&g.who.startsWith('heart'))g.who='heart'+(+g.who.slice(5)===pi?0:1);M.fx[pi].push(g)}M.push()},
    prompt(pi,title,sub,opts){return new Promise(res=>{const pid=crypto.randomBytes(6).toString('hex');
      const p={pi,opts,title,sub,done:false,finish:v=>{if(p.done)return;p.done=true;clearTimeout(p.t);M.prompts.delete(pid);sendU(M.pl[pi].uid,{t:'promptgone',id:pid});res(v)}};
      p.t=setTimeout(()=>p.finish(opts[0].val),PROMPT_SECS*1000);M.prompts.set(pid,p);
      sendU(M.pl[pi].uid,{t:'prompt',id:pid,title,sub,opts,secs:PROMPT_SECS})})},
    turn(pi){clearTimeout(M.turnT);const secs=+process.env.PVP_TURN_SECS||cfg.pvp.turnSecs||75;M.deadline=Date.now()+secs*1000;M.turnPi=pi;
      M.turnT=setTimeout(()=>timeoutTurn(M,pi),secs*1000+300);M.push()},
    end(w){finish(M,w,null)}};
  M.pushNow=()=>{if(M.pushT){clearImmediate(M.pushT);M.pushT=null}const D=S.D;if(!D)return;for(let pi=0;pi<2;pi++){const fx=M.fx[pi];M.fx[pi]=[];
      sendU(M.pl[pi].uid,{t:'state',view:S.netView(pi),fx,ms:M.deadline?Math.max(0,M.deadline-Date.now()):null,opp:oppInfo(M,pi)})}};
  M.push=()=>{if(M.pushT||M.ended)return;M.pushT=setImmediate(M.pushNow)};
  S.setNet(NET);S.setFast(!M.bot); // bot matches keep the AI's natural pacing
  for(let pi=0;pi<2;pi++)sendU(M.pl[pi].uid,{t:'match',id,opp:oppInfo(M,pi),stake:M.stake});
  S.startNetDuel([a.deck,b.deck],[a.name,b.name],[false,!!b.bot]);
}
const oppInfo=(M,pi)=>{const o=M.pl[1-pi];return {name:o.name,rating:o.rating,sig:o.sig,bot:o.bot,title:o.title}};
async function refund(q){await lockUser(q.uid,async()=>{const u=await loadUser(q.uid);u.save.coins+=q.stake;await saveUser(u.id,u.save)})}
function timeoutTurn(M,pi){if(M.ended)return;const D=M.S.D;if(!D||D.over||D.turn!==pi)return;
  for(const p of [...M.prompts.values()])if(p.pi===pi)p.finish(p.opts[0].val);
  M.chain=M.chain.then(async()=>{const D=M.S.D;if(D&&!D.over&&D.turn===pi){M.S.D.busy=false;await M.S.endTurn()}}).catch(e=>console.error(e))}
function reattach(M,uid){const pi=M.pl.findIndex(p=>p.uid===uid);if(pi<0)return;clearTimeout(M.pl[pi].away);M.pl[pi].away=null;
  sendU(uid,{t:'match',id:M.id,opp:oppInfo(M,pi),stake:M.stake});M.push();for(const [pid,p] of M.prompts)if(p.pi===pi)sendU(uid,{t:'prompt',id:pid,title:p.title,sub:p.sub,opts:p.opts})}
function dropped(M,uid){const pi=M.pl.findIndex(p=>p.uid===uid);if(pi<0||M.ended)return;
  M.pl[pi].away=setTimeout(()=>{if(M.ended)return;M.chain=M.chain.then(()=>{if(!M.ended){M.reason=`${M.pl[pi].name} disconnected.`;return M.S.netAct(pi,'forfeit')}})},GRACE_SECS*1000)}
async function finish(M,w,reason){if(M.ended)return;M.ended=true;clearTimeout(M.turnT);for(const p of [...M.prompts.values()])p.finish(p.opts[0].val);
  const cfg=getCfg();const W=M.pl[w],L=M.pl[1-w];
  if(M.bot)return finishBot(M,w);
  const K=p=>p.games<10?40:32;const ea=1/(1+Math.pow(10,(L.rating-W.rating)/400));
  const wAfter=Math.round(W.rating+K(W)*(1-ea)),lAfter=Math.max(100,Math.round(L.rating+K(L)*(0-(1-ea))));
  const out={};
  for(const [p,won,after] of [[W,true,wAfter],[L,false,lAfter]]){
    out[p.uid]=await lockUser(p.uid,async()=>{const u=await loadUser(p.uid);let save=u.save;const day=today();const daily=u.daily&&u.daily.day===day?u.daily:{day};
      let coins=won?cfg.pvp.win:cfg.pvp.loss,packs=0;
      if(won&&!daily.pvpWin){daily.pvpWin=1;coins+=cfg.pvp.dailyCoins;packs=1}
      save.coins+=coins+(won&&M.stake?M.stake*2:0);save.packs+=packs;save=withSave(save,cfg,S=>S.acts.applyPvpResult(won)).save;
      await sql(`update users set save=$2,daily=$3,rating=$4,wins=wins+$5,losses=losses+$6 where id=$1`,[u.id,JSON.stringify(save),JSON.stringify(daily),after,won?1:0,won?0:1]);
      const nu=await loadUser(u.id);return {save,coins,packs,user:publicUser(nu)}})}
  const D=M.S.D;
  await sql(`insert into matches(p1,p2,winner,r1_before,r2_before,r1_after,r2_after,stake,turns,reason) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [M.pl[0].uid,M.pl[1].uid,W.uid,M.pl[0].rating,M.pl[1].rating,M.pl[0]===W?wAfter:lAfter,M.pl[1]===W?wAfter:lAfter,M.stake||0,D?D.turnNo:0,M.reason||reason||null]);
  M.pushNow();
  for(let pi=0;pi<2;pi++){const p=M.pl[pi];const won=p===W;const o=out[p.uid];
    sendU(p.uid,{t:'over',won,oppName:M.pl[1-pi].name,ratingBefore:p.rating,ratingAfter:won?wAfter:lAfter,coins:o.coins,packs:o.packs,stake:M.stake||0,save:o.save,user:o.user,reason:M.reason||null});
    userMatch.delete(p.uid);clearTimeout(p.away)}
  setTimeout(()=>matches.delete(M.id),5000);
}

// bot match: only the human is rewarded; rating and ranked record don't change
async function finishBot(M,w){const cfg=getCfg();const hi=M.pl.findIndex(p=>!p.bot);const H=M.pl[hi],B=M.pl[1-hi];const won=w===hi;
  const o=await lockUser(H.uid,async()=>{const u=await loadUser(H.uid);let save=u.save;const coins=won?(cfg.pvp.botWin??25):(cfg.pvp.botLoss??5);
    save.coins+=coins;save=withSave(save,cfg,S=>S.acts.applyPvpResult(won,true)).save;await saveUser(u.id,save);return {save,coins,user:publicUser(await loadUser(u.id))}});
  const D=M.S.D;
  await sql(`insert into matches(p1,p2,winner,r1_before,r2_before,r1_after,r2_after,stake,turns,reason) values($1,null,$2,$3,$3,$3,$3,0,$4,$5)`,[H.uid,won?H.uid:null,H.rating,D?D.turnNo:0,'bot:'+B.name]);
  M.pushNow();
  sendU(H.uid,{t:'over',won,bot:true,oppName:B.name+' (bot)',ratingBefore:H.rating,ratingAfter:H.rating,coins:o.coins,packs:0,stake:0,save:o.save,user:o.user,reason:M.reason||null});
  userMatch.delete(H.uid);clearTimeout(H.away);setTimeout(()=>matches.delete(M.id),5000)}
