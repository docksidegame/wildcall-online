import {sql} from './db.js';
export const DEFAULT_CFG={prices:{},sale:{all:0,items:{}},disabled:[],market:{prices:{},stock:[]},banner:'',
  stakes:{enabled:false,max:500,daily:5,blocked:['BE','NL','CN'],options:[50,100,250,500]},
  pvp:{win:60,loss:15,dailyCoins:100,turnSecs:75,botSecs:30,botWin:25,botLoss:5},caps:{aiCoins:3000,aiPacks:20}};
export let CFG=structuredClone(DEFAULT_CFG);
export const getCfg=()=>CFG;
export const merge=(a,b)=>{const o={...a};for(const k in b){o[k]=b[k]&&typeof b[k]==='object'&&!Array.isArray(b[k])&&a[k]&&typeof a[k]==='object'?merge(a[k],b[k]):b[k]}return o};
export async function loadCfg(){const r=await sql(`select value from config where key='shop'`);CFG=merge(DEFAULT_CFG,r[0]?r[0].value:{})}
export function setCfg(c){CFG=merge(DEFAULT_CFG,c||{})}
// ---------- per-user lock so saves never race ----------
const locks=new Map();
export function lockUser(id,fn){const prev=locks.get(id)||Promise.resolve();const run=prev.then(fn,fn);const tail=run.catch(()=>{});locks.set(id,tail);tail.then(()=>{if(locks.get(id)===tail)locks.delete(id)});return run}
export async function loadUser(id){const r=await sql(`select * from users where id=$1`,[id]);return r[0]||null}
export async function saveUser(id,save){await sql(`update users set save=$2 where id=$1`,[id,JSON.stringify(save)])}
export const today=()=>new Date().toISOString().slice(0,10);
export function publicUser(u){return u&&{id:u.id,username:u.username,admin:u.admin,rating:u.rating,wins:u.wins,losses:u.losses}}
export const parseCookies=h=>Object.fromEntries((h||'').split(';').map(x=>x.trim().split('=')).filter(x=>x[0]).map(([k,...v])=>[k,decodeURIComponent(v.join('='))]));
export async function userFromCookie(cookieHeader){const tok=parseCookies(cookieHeader).wc_sess;if(!tok)return null;
  const r=await sql(`select u.* from sessions s join users u on u.id=s.user_id where s.token=$1 and s.expires>now()`,[tok]);const u=r[0];if(!u||u.banned)return null;return u}
export function stakeStatus(u){const st=CFG.stakes||{};const s=u.settings||{};const day=today();const used=u.daily&&u.daily.day===day?(u.daily.stakes||0):0;
  let reason=null;if(!st.enabled)reason='Stakes matches are turned off.';else if(!s.stakesOptIn)reason='Stakes matches are off. Turn them on in settings.';else if(!s.country)reason='Set your country in settings first.';
  else if((st.blocked||[]).includes(s.country))reason='Stakes matches aren\'t available in your country.';else if(used>=(st.daily||5))reason='You\'ve played today\'s staked matches.';
  return {stakesAllowed:!reason,stakesReason:reason,stakesLeft:Math.max(0,(st.daily||5)-used),country:s.country||'',stakesOptIn:!!s.stakesOptIn}}
