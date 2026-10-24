// Checks idle turns time out and a disconnected player forfeits after the grace period.
import {spawn} from 'child_process';import fs from 'fs';import WebSocket from 'ws';
const PORT=3133,BASE=`http://localhost:${PORT}`;fs.rmSync('/tmp/wco-to-db',{recursive:true,force:true});
const srv=spawn('node',['server/index.js'],{env:{...process.env,PORT:String(PORT),PGLITE_DIR:'/tmp/wco-to-db',PVP_TURN_SECS:'3',PVP_GRACE_SECS:'3',PVP_PROMPT_SECS:'2'},stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function mk(n){let cookie='';const call=async(p,b)=>{const r=await fetch(BASE+p,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify(b)});const sc=r.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];return r.json()};
 await call('/api/signup',{username:n,email:n+'@x.com',password:'password123',terms:true});await call('/api/act',{a:'pickStarter',args:[0,n]});
 const ws=new WebSocket(`ws://localhost:${PORT}/ws`,{headers:{cookie}});const log=[];ws.on('message',d=>{const m=JSON.parse(d);log.push(m);if(m.t==='prompt')ws.send(JSON.stringify({t:'choice',id:m.id,val:m.opts[0].val}))});
 await new Promise(r=>ws.on('open',r));return {ws,log}}
try{for(let i=0;i<60;i++){try{await fetch(BASE+'/api/health');break}catch(e){await sleep(250)}}
 const a=await mk('idle1'),b=await mk('idle2');a.ws.send(JSON.stringify({t:'queue',deck:0}));b.ws.send(JSON.stringify({t:'queue',deck:0}));
 await sleep(14000);const turns=a.log.filter(m=>m.t==='state').map(m=>m.view.turnNo);console.log('turnNo seen while both idle:',[...new Set(turns)].join(','));
 console.log(Math.max(...turns)>=3?'  ✓ idle turns time out and pass':'  ✗ turns did not advance');
 b.ws.close();await sleep(6000);const over=a.log.find(m=>m.t==='over');console.log(over&&over.won?'  ✓ disconnected opponent forfeits; reason: '+over.reason:'  ✗ no forfeit after disconnect');
}catch(e){console.log('ERR',e)}finally{srv.kill();process.exit(0)}
