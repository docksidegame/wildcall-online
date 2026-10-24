# End-to-end test: two players sign up, use the shop, an admin changes prices, then both play a full ranked match.
import asyncio, glob, os, subprocess, time, json, shutil, sys
from playwright.async_api import async_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT=int(os.environ.get('E2E_PORT','3111'));BASE=f'http://localhost:{PORT}'
SHOTS=os.environ.get('E2E_SHOTS','/tmp/wco-shots');os.makedirs(SHOTS,exist_ok=True)

async def signup(pg,name):
    await pg.goto(BASE);await pg.wait_for_selector('#authform')
    await pg.click('[data-act="authtab"][data-t="up"]')
    await pg.fill('input[name=username]',name);await pg.fill('input[name=email]',name+'@example.com');await pg.fill('input[name=password]','password123')
    await pg.check('input[name=terms]');await pg.click('#authform button[type=submit]')
    await pg.wait_for_selector('[data-act="pickstarter"]');await pg.fill('#pname',name)
    await pg.click('[data-act="pickstarter"][data-i="2"]');await pg.wait_for_timeout(500)
    if await pg.query_selector('[data-act="talkskip"]'):await pg.click('[data-act="talkskip"]')
    await pg.wait_for_timeout(300)

async def play_turn(pg):
    """Simple policy: play a basic, attach energy, evolve, attack if possible, else end turn."""
    st=await pg.evaluate("""()=>{const D=WC.D;if(!D||!D.net)return 'none';if(D.over)return 'over';if(document.querySelector('.modal [data-act="choice"]'))return 'prompt';return D.turn===0&&!D.busy?'mine':'wait'}""")
    if st=='prompt':
        await pg.click('.modal [data-act="choice"]');return 'acted'
    if st!='mine':return st
    acted=await pg.evaluate("""async()=>{const D=WC.D,me=D.p[0],C=WC.C;const q=s=>document.querySelector(s);const click=s=>{const e=q(s);if(e){e.click();return true}return false};
      const basic=me.hand.find(h=>C[h.id].kind==='unit'&&!C[h.id].from);
      if(basic&&me.field.some(x=>!x)){click(`.hand [data-uid="${basic.uid}"]`);click(`.hand [data-uid="${basic.uid}"]`);return 'summon'}
      if(!me.sparkUsed){const a=me.field[0];const en=me.hand.find(h=>C[h.id].kind==='energy'&&(h.id==='spark'||(a&&WC.C[h.id].type===C[a.id].type)));
        if(a&&en){click(`.hand [data-uid="${en.uid}"]`);click(`.unit[data-uid="${a.uid}"]`);return 'attach'}}
      const a=me.field[0];if(a&&D.turnNo>2&&WC.canAttack(a)){const m=C[a.id].moves.findIndex(m=>a.sparks>=m.c&&(m.d>0));if(m>=0){click(`.unit[data-uid="${a.uid}"]`);await new Promise(r=>setTimeout(r,50));const b=[...document.querySelectorAll('[data-act="move"]:not([disabled])')].pop();if(b){b.click();await new Promise(r=>setTimeout(r,50));if(WC.D.snipe){const o=WC.D.p[1].field.find(Boolean);click(`.unit[data-uid="${o.uid}"]`)}return 'attack'}click('[data-act="close"]')}}
      click('[data-act="endturn"]');return 'end'}""")
    return acted

async def main():
    dbdir='/tmp/wco-e2e-db';shutil.rmtree(dbdir,ignore_errors=True)
    env={**os.environ,'PORT':str(PORT),'PGLITE_DIR':dbdir,'ADMIN_USERNAMES':'alice'}
    srv=subprocess.Popen(['node','server/index.js'],cwd=ROOT,env=env,stdout=open('/tmp/wco-e2e.log','w'),stderr=subprocess.STDOUT)
    try:
        for _ in range(60):
            try:
                import urllib.request;urllib.request.urlopen(BASE+'/api/health');break
            except Exception:time.sleep(0.3)
        async with async_playwright() as p:
            b=await p.chromium.launch(executable_path=glob.glob('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0])
            ca=await b.new_context(viewport={'width':1280,'height':860});cb=await b.new_context(viewport={'width':390,'height':844})
            A=await ca.new_page();B=await cb.new_page();errs=[]
            for pg,n in [(A,'A'),(B,'B')]:pg.on('pageerror',lambda e,n=n:errs.append(n+': '+str(e)))
            await signup(A,'alice');await signup(B,'bob')
            await A.screenshot(path=SHOTS+'/1_title_admin.png')
            # economy: buy and open a pack on the server
            await A.click('[data-act="home"]') if await A.query_selector('[data-act="home"]') else None
            await A.click('[data-act="shop"]');await A.wait_for_timeout(400)
            c0=await A.evaluate('WC.SAVE.coins');await A.click('[data-act="buyitem"][data-id="pack"]');await A.wait_for_timeout(600)
            c1=await A.evaluate('WC.SAVE.coins');print('buy pack coins',c0,'->',c1)
            await A.click('[data-act="openpack"][data-k="std"]');await A.wait_for_timeout(800)
            await A.click('#bopack');await A.wait_for_timeout(2000);await A.click('[data-act="boall"]');await A.wait_for_timeout(500)
            print('pack screen',await A.evaluate('WC.UI.screen'),await A.evaluate('WC.UI.bo&&WC.UI.bo.cards.length'))
            await A.screenshot(path=SHOTS+'/2_pack.png')
            # tamper attempt: client-side coin edit should not stick
            await A.evaluate("WC.SAVE.coins=999999");await A.goto(BASE);await A.wait_for_timeout(1200)
            print('coins after tamper+reload',await A.evaluate('WC.SAVE.coins'))
            # admin: 50% sale on packs + banner
            await A.click('[data-act="admin"]');await A.wait_for_selector('[data-act="admsave"]')
            await A.fill('.anum[data-k="sale.items.pack"]','50');await A.fill('#abanner','Grand opening: packs half price!');await A.check('#astk')
            await A.click('[data-act="admsave"]');await A.wait_for_timeout(600);await A.screenshot(path=SHOTS+'/3_admin.png',full_page=True)
            await B.goto(BASE);await B.wait_for_timeout(1000);await B.click('[data-act="shop"]');await B.wait_for_timeout(400)
            print('bob sees pack price',await B.text_content('[data-act="buyitem"][data-id="pack"]'))
            await B.screenshot(path=SHOTS+'/4_shop_sale.png')
            # ranked
            for pg in (A,B):
                await pg.goto(BASE);await pg.wait_for_timeout(900);await pg.click('[data-act="ranked"]');await pg.wait_for_timeout(800)
            for pg in (A,B):
                await pg.evaluate("fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({country:'US',stakesOptIn:true})})")
                await pg.evaluate("fetch('/api/admin/grant',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:1,coins:0,packs:0})})")
            await A.evaluate("fetch('/api/admin/grant',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:2,coins:200,packs:0})})")
            await A.evaluate("fetch('/api/admin/grant',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:1,coins:200,packs:0})})")
            for pg in (A,B):
                await pg.goto(BASE);await pg.wait_for_timeout(900);await pg.click('[data-act="ranked"]');await pg.wait_for_timeout(1200)
            await A.screenshot(path=SHOTS+'/5_ranked.png')
            coinsA0=await A.evaluate('WC.SAVE.coins');coinsB0=await B.evaluate('WC.SAVE.coins')
            for pg in (A,B):
                await pg.select_option('#rkstake','50')
            await A.click('[data-act="rkqueue"]');await B.click('[data-act="rkqueue"]')
            # play until over
            t0=time.time();steps=0;shot=False
            while time.time()-t0<240:
                ra=await play_turn(A);rb=await play_turn(B);steps+=1
                if not shot and steps>30:
                    await A.screenshot(path=SHOTS+'/6_duel_A.png');await B.screenshot(path=SHOTS+'/6_duel_B.png');shot=True
                if ra=='over' and rb=='over':break
                if await A.query_selector('[data-act="ranked"]') and await A.evaluate("WC.UI.screen")=='pvpresult':break
                await asyncio.sleep(0.15)
            await A.wait_for_timeout(2500);await A.screenshot(path=SHOTS+'/7_result.png');await B.screenshot(path=SHOTS+'/7_result_B.png')
            print('screens',await A.evaluate('WC.UI.screen'),await B.evaluate('WC.UI.screen'))
            print('pvp result A',await A.evaluate('JSON.stringify(WC.UI.pvp&&{won:WC.UI.pvp.won,r:[WC.UI.pvp.ratingBefore,WC.UI.pvp.ratingAfter],coins:WC.UI.pvp.coins})'))
            print('pvp result B',await B.evaluate('JSON.stringify(WC.UI.pvp&&{won:WC.UI.pvp.won,r:[WC.UI.pvp.ratingBefore,WC.UI.pvp.ratingAfter],coins:WC.UI.pvp.coins})'))
            print('coins A',coinsA0,'->',await A.evaluate('WC.SAVE.coins'),'| coins B',coinsB0,'->',await B.evaluate('WC.SAVE.coins'))
            print('stats A',await A.evaluate('JSON.stringify({w:WC.SAVE.stats.wins,pw:WC.SAVE.stats.pvpWins,pg:WC.SAVE.stats.pvpGames})'));await A.click('[data-act="home"]');await A.wait_for_timeout(300);await A.click('[data-act="bounties"]');await A.wait_for_timeout(300);ids=await A.evaluate("[...document.querySelectorAll('[data-act=claim]:not([disabled])')].map(b=>b.dataset.id).join()");print('A claimable',ids);await A.click('[data-act="claim"][data-id="d_pvp1"]');await A.wait_for_timeout(600);print('A coins after claim',await A.evaluate('WC.SAVE.coins'));await A.screenshot(path=SHOTS+'/8_bounties.png',full_page=True)
            print('page errors',errs[:5])
            await b.close()
    finally:
        srv.terminate();time.sleep(0.5)
        print('--- server log tail ---');print(open('/tmp/wco-e2e.log').read()[-1500:])
if __name__=='__main__':
    asyncio.run(main())
