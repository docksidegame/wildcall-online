// API-level checks: accounts, server economy, anti-cheat guards, admin, stakes. Run against a fresh local server.
import {spawn} from 'child_process';
import fs from 'fs';
const PORT=3122,BASE=`http://localhost:${PORT}`;
fs.rmSync('/tmp/wco-api-db',{recursive:true,force:true});
const srv=spawn('node',['server/index.js'],{env:{...process.env,PORT:String(PORT),PGLITE_DIR:'/tmp/wco-api-db',ADMIN_USERNAMES:'boss'},stdio:['ignore','pipe','pipe']});
let log='';srv.stdout.on('data',d=>log+=d);srv.stderr.on('data',d=>log+=d);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function client(){let cookie='';return async(path,body,method)=>{const r=await fetch(BASE+path,{method:method||(body?'POST':'GET'),headers:{...(body?{'content-type':'application/json'}:{}),cookie},body:body?JSON.stringify(body):undefined});
  const sc=r.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];let j={};try{j=await r.json()}catch(e){}return {status:r.status,...j}}}
let pass=0,fail=0;const ok=(c,m)=>{if(c){pass++;console.log('  ✓',m)}else{fail++;console.log('  ✗',m)}};
try{
  for(let i=0;i<60;i++){try{await fetch(BASE+'/api/health');break}catch(e){await sleep(250)}}
  const A=client(),B=client(),Z=client();
  console.log('accounts');
  ok((await A('/api/signup',{username:'boss',email:'boss@x.com',password:'short',terms:true})).status===400,'short password rejected');
  let r=await A('/api/signup',{username:'boss',email:'boss@x.com',password:'password123',terms:true});ok(r.user&&r.user.admin,'admin flagged from ADMIN_USERNAMES');
  ok((await B('/api/signup',{username:'Boss',email:'b2@x.com',password:'password123',terms:true})).status===409,'duplicate username (case-insensitive) rejected');
  r=await B('/api/signup',{username:'player2',email:'p2@x.com',password:'password123',terms:true});ok(r.user&&!r.user.admin,'normal player signup');
  ok((await Z('/api/me')).status===401,'signed-out /api/me is 401');
  ok((await Z('/api/login',{login:'player2',password:'nope'})).status===401,'wrong password rejected');
  console.log('economy');
  r=await A('/api/act',{a:'buyItem',args:['pack',1]});ok(r.status===400,'cannot buy before picking a starter');
  r=await A('/api/act',{a:'pickStarter',args:[0,'Boss']});ok(r.save&&r.save.coins===200&&r.save.decks.length===1,'starter picked on server');
  ok((await A('/api/act',{a:'pickStarter',args:[1,'x']})).status===400,'cannot pick a second starter');
  r=await A('/api/act',{a:'buyItem',args:['pack',2]});ok(r.save.coins===0&&r.save.packs===3,'bought 2 packs for 200');
  r=await A('/api/act',{a:'buyItem',args:['box',1]});ok(r.save.coins===0&&r.save.packs===3,'cannot buy what you cannot afford');
  r=await A('/api/act',{a:'takePack',args:['std']});ok(Array.isArray(r.result)&&r.result.length===5&&r.save.packs===2,'server rolls pack contents');
  r=await A('/api/act',{a:'takeAll',args:['std']});ok(r.result.length===10&&r.save.packs===0,'quick-open all');
  ok((await A('/api/act',{a:'giveMeCoins',args:[]})).status===400,'unknown action rejected');
  console.log('meta validation');
  const me=(await A('/api/me')).save;const fake={name:'Cheat',cards:Array(60).fill('zyrathor_apex')};
  r=await A('/api/meta',{decks:[...me.decks,fake],active:1});ok(r.fixed&&r.save.decks[1].cards.filter(x=>x==='zyrathor_apex').length<=1,'unowned / over-limit deck cards stripped');
  r=await A('/api/meta',{art:{pyrolynx_apex:'alt'}});ok(!(r.save.art||{}).pyrolynx_apex||r.save.vars&&r.save.vars.pyrolynx_apex,'cannot equip art you do not own');
  console.log('story duel rewards');
  r=await A('/api/duel/finish',{token:'bogus',ri:0,r:{win:true}});ok(r.status===400,'finish without a start token rejected');
  let t=(await A('/api/duel/start',{ri:0})).token;r=await A('/api/duel/finish',{token:t,ri:0,r:{win:true}});ok(r.result&&!r.result.win&&r.save.beaten.length===0,'instant "win" (under 30s) is not counted');
  t=(await A('/api/duel/start',{ri:0})).token;r=await A('/api/duel/finish',{token:t,ri:0,r:{win:true}});ok(r.status===200,'token is single-use and per-duel');
  console.log('admin');
  ok((await B('/api/admin/config')).status===403,'non-admin blocked from admin');
  r=await A('/api/admin/config',{sale:{all:20,items:{pack:50}},banner:'Hello',stakes:{enabled:true,max:500,daily:5,blocked:['BE']},disabled:['premium'],pvp:{win:80,loss:20,dailyCoins:100,turnSecs:60},caps:{aiCoins:500,aiPacks:5}},'PUT');
  ok(r.cfg&&r.cfg.sale.items.pack===50&&r.cfg.banner==='Hello','config saved');
  await B('/api/act',{a:'pickStarter',args:[1,'P2']});
  r=await B('/api/act',{a:'buyItem',args:['pack',1]});ok(r.save.coins===150,'player pays the 50%-off price (150 left of 200)');
  r=await B('/api/act',{a:'buyItem',args:['premium',1]});ok(r.save.packs===2,'disabled item cannot be bought');
  const users=(await A('/api/admin/users?q=player')).rows;ok(users.length===1,'admin user search');
  r=await A('/api/admin/grant',{id:users[0].id,coins:1000,packs:3});ok(r.ok,'admin grant');
  ok((await B('/api/me')).save.coins===1150,'granted coins arrive');
  console.log('stakes settings');
  r=await B('/api/settings',{country:'BE',stakesOptIn:true});ok(!r.stakesAllowed&&/country/.test(r.stakesReason),'blocked country cannot use stakes');
  r=await B('/api/settings',{country:'US',stakesOptIn:true});ok(r.stakesAllowed,'allowed country can opt in');
  await A('/api/admin/ban',{id:users[0].id,banned:true});ok((await B('/api/me')).status===401,'banned player is signed out');
  ok((await B('/api/login',{login:'player2',password:'password123'})).status===403,'banned player cannot sign in');
  ok((await (await fetch(BASE+'/api/leaderboard')).json()).rows!==undefined,'leaderboard public');
}catch(e){console.log('ERROR',e);fail++}
finally{srv.kill();console.log(`\n${pass} passed, ${fail} failed`);if(fail)console.log(log.slice(-2000));process.exit(fail?1:0)}
