# Maintenance mode: admin starts maintenance while a player is mid-match against a bot.
# The match keeps going, new matches are refused, the game locks itself once the match ends,
# players see the maintenance screen, and the admin dashboard says it's clear to update.
import asyncio,glob,os,subprocess,time,shutil,urllib.request,sys,json
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from e2e import signup,play_turn
from playwright.async_api import async_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)));PORT=3166;BASE=f'http://localhost:{PORT}'
import e2e;e2e.BASE=BASE
SH='/tmp/wco-shots';os.makedirs(SH,exist_ok=True)
def ok(c,msg):print(('PASS ' if c else 'FAIL ')+msg)
async def main():
    db='/tmp/wco-maint-db';shutil.rmtree(db,ignore_errors=True)
    env={**os.environ,'PORT':str(PORT),'PGLITE_DIR':db,'PVP_BOT_SECS':'2','ADMIN_USERNAMES':'boss'}
    srv=subprocess.Popen(['node','server/index.js'],cwd=ROOT,env=env,stdout=open('/tmp/wco-maint.log','w'),stderr=subprocess.STDOUT)
    try:
        for _ in range(60):
            try:urllib.request.urlopen(BASE+'/api/health');break
            except Exception:time.sleep(.3)
        async with async_playwright() as p:
            b=await p.chromium.launch(executable_path=glob.glob('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0])
            A=await (await b.new_context(viewport={'width':1280,'height':900})).new_page()
            P=await (await b.new_context(viewport={'width':1280,'height':860})).new_page()
            Q=await (await b.new_context(viewport={'width':390,'height':844})).new_page()
            errs=[]
            for pg,n in [(A,'admin'),(P,'player'),(Q,'other')]:pg.on('pageerror',lambda e,n=n:errs.append(n+': '+str(e)))
            await signup(A,'boss');await signup(P,'pat');await signup(Q,'quinn')
            # pat starts a bot match
            await P.goto(BASE);await P.wait_for_timeout(800);await P.click('[data-act="ranked"]');await P.wait_for_timeout(700);await P.click('[data-act="rkqueue"]')
            for _ in range(40):
                if await P.evaluate("!!(WC.D&&WC.D.net)"):break
                await asyncio.sleep(.25)
            ok(await P.evaluate("!!(WC.D&&WC.D.net)"),'player is in a match')
            # admin starts maintenance
            await A.goto(BASE);await A.wait_for_timeout(800);await A.click('[data-act="admin"]');await A.wait_for_selector('#maintdash [data-act="mstart"]',timeout=8000)
            await A.fill('#mmsg','New cards incoming! Back in 10 minutes.');await A.click('[data-act="mstart"]');await A.wait_for_timeout(1500)
            d=await A.evaluate("fetch('/api/admin/maint').then(r=>r.json())")
            ok(d['state']=='draining' and len(d['matches'])==1 and not d['clear'],f"draining with 1 live match ({d['state']}, {len(d['matches'])}, clear={d['clear']})")
            await A.screenshot(path=SH+'/m1_draining.png',full_page=True)
            # other player: sees the banner, can't queue, can still use the shop
            await Q.goto(BASE);await Q.wait_for_timeout(1200)
            ok(await Q.evaluate("!!document.getElementById('maintbar')"),'banner shown to other players')
            await Q.click('[data-act="ranked"]');await Q.wait_for_timeout(700)
            ok(not await Q.query_selector('[data-act="rkqueue"]'),'find-match button hidden while draining')
            r=await Q.evaluate("fetch('/api/duel/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({rival:0})}).then(r=>r.status)")
            ok(r==503,f'new story duel refused ({r})')
            await Q.screenshot(path=SH+'/m2_banner.png')
            # the match finishes normally
            t0=time.time()
            while time.time()-t0<300:
                await play_turn(P)
                if await P.evaluate("WC.UI.screen")=='pvpresult':break
                await asyncio.sleep(.2)
            ok(await P.evaluate("WC.UI.screen")=='pvpresult','running match was allowed to finish')
            ok(await P.evaluate("!!(WC.UI.pvp)"),'result and rewards recorded')
            await asyncio.sleep(4)
            d=await A.evaluate("fetch('/api/admin/maint').then(r=>r.json())")
            ok(d['state']=='locked' and d['clear'],f"auto-locked and clear ({d['state']}, clear={d['clear']})")
            await A.wait_for_timeout(3500);await A.screenshot(path=SH+'/m3_clear.png',full_page=True)
            ok(await A.query_selector('.mclear') is not None,'dashboard shows Clear to update')
            # players are locked out
            await P.wait_for_timeout(500)
            r=await Q.evaluate("fetch('/api/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({a:'buyItem',args:['pack',1]})}).then(r=>r.status)")
            ok(r==503,f'player actions blocked when locked ({r})')
            await Q.goto(BASE);await Q.wait_for_timeout(1500)
            ok(await Q.evaluate("WC.UI.screen")=='maint',f"player sees maintenance screen ({await Q.evaluate('WC.UI.screen')})")
            ok('New cards incoming' in (await Q.text_content('main') or ''),'message shown to players')
            await Q.screenshot(path=SH+'/m4_locked.png')
            r=await A.evaluate("fetch('/api/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({a:'buyItem',args:['pack',1]})}).then(r=>r.status)")
            ok(r==200,f'admin can still play ({r})')
            # restart keeps the lock (simulates the redeploy)
            srv.terminate();srv.wait();srv=subprocess.Popen(['node','server/index.js'],cwd=ROOT,env=env,stdout=open('/tmp/wco-maint.log','a'),stderr=subprocess.STDOUT)
            for _ in range(60):
                try:urllib.request.urlopen(BASE+'/api/health');break
                except Exception:time.sleep(.3)
            st=json.loads(urllib.request.urlopen(BASE+'/api/status').read())
            ok(st['maint']['state']=='locked','still locked after restart')
            # end maintenance: the waiting player gets back in on their own
            await A.goto(BASE);await A.wait_for_timeout(800);await A.click('[data-act="admin"]');await A.wait_for_selector('#maintdash [data-act="mend"]',timeout=8000)
            await A.click('[data-act="mend"]');await A.wait_for_timeout(300);await A.click('.modal [data-act="mend"]');await A.wait_for_timeout(1000)
            st=json.loads(urllib.request.urlopen(BASE+'/api/status').read())
            ok(st['maint']['state']=='live','back to live')
            for _ in range(40):
                if await Q.evaluate("WC.UI.screen")!='maint':break
                await asyncio.sleep(.5)
            ok(await Q.evaluate("WC.UI.screen")!='maint',f"waiting player let back in ({await Q.evaluate('WC.UI.screen')})")
            ok(not await Q.evaluate("!!document.getElementById('maintbar')"),'banner gone')
            print('page errors',errs[:5]);await b.close()
    finally:
        srv.terminate();print('--- log ---');print(open('/tmp/wco-maint.log').read()[-1200:])
asyncio.run(main())
