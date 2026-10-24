// Runs the real game script (public/index.html) inside lightweight Node vm realms.
// One shared "rules" realm handles economy actions; each ranked match gets its own realm.
import fs from 'fs';import vm from 'vm';import path from 'path';
let CODE=null,SCRIPT=null;
export function loadGame(root){
  const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  CODE=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(c=>!c.includes('WC_ONLINE=true')).join('\n');
  SCRIPT=new vm.Script(CODE,{filename:'wildcall-game.js'});
}
function stubEl(){const fn=function(){};const p=new Proxy(fn,{get(t,k){
  if(k===Symbol.toPrimitive)return()=>'';if(k==='style')return {setProperty(){},removeProperty(){}};
  if(k==='classList')return {add(){},remove(){},contains(){return false},toggle(){}};
  if(k==='querySelectorAll'||k==='getElementsByTagName')return()=>[];if(k==='dataset')return {};
  if(k==='children'||k==='childNodes')return [];if(k==='textContent'||k==='innerHTML'||k==='value')return '';
  if(k==='getBoundingClientRect')return()=>({top:0,left:0,width:0,height:0,bottom:0,right:0});if(k==='then')return undefined;return p},
  set(){return true},apply(){return p},construct(){return p}});return p}
export function makeRealm(){
  const el=stubEl();
  const sb={console,setTimeout,clearTimeout,setInterval,clearInterval,setImmediate,MessageChannel,performance,
    requestAnimationFrame:f=>setTimeout(f,0),cancelAnimationFrame(){},
    document:{querySelector:()=>el,querySelectorAll:()=>[],getElementById:()=>null,createElement:()=>stubEl(),addEventListener(){},body:el,documentElement:el},
    localStorage:{getItem:()=>null,setItem(){},removeItem(){}},addEventListener(){},removeEventListener(){},
    matchMedia:()=>({matches:false,addEventListener(){}}),innerWidth:1200,innerHeight:800,navigator:{userAgent:'node'},location:{href:'',protocol:'http:',host:''},
    getComputedStyle:()=>({}),fetch:()=>Promise.reject(new Error('no fetch on server'))};
  sb.window=sb;sb.globalThis=sb;vm.createContext(sb);SCRIPT.runInContext(sb);
  return sb;
}
const clone=o=>o==null?o:JSON.parse(JSON.stringify(o));
let RULES=null,RNET=null;
export function rules(){if(!RULES){RULES=makeRealm();RNET={server:true,toast:null};RULES.WCS.setNet(RNET);RULES.WCS.setFast(true)}return RULES.WCS}
// Run one economy action against a player's save. Returns the new save, the action's return value and any toast text.
export function econ(save,cfg,name,args){
  const S=rules();const fn=S.acts[name];if(!fn)throw new Error('Unknown action');
  S.setCfg(clone(cfg));S.setSave(clone(save));RNET.toast=null;
  const result=fn(...(Array.isArray(args)?args:[]));
  return {save:clone(S.getSave()),result:clone(result===undefined?null:result),msg:RNET.toast};
}
export function withSave(save,cfg,fn){const S=rules();S.setCfg(clone(cfg));S.setSave(clone(save));const r=fn(S);return {save:clone(S.getSave()),result:clone(r)}}
