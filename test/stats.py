# Balance stats: play a bot match and a story duel, then check the admin Balance page.
import asyncio,glob,os,subprocess,time,shutil,urllib.request,sys,json
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import e2e
from playwright.async_api import async_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)));PORT=3188;e2e.BASE=BASE=f'http://localhost:{PORT}'
async def main():
    shutil.rmtree('/tmp/wco-stat-db',ignore_errors=True)
    srv=subprocess.Popen(['node','server/index.js'],cwd=ROOT,env={**os.environ,'PORT':str(PORT),'PGLITE_DIR':'/tmp/wco-stat-db','PVP_BOT_SECS':'2','ADMIN_USERNAMES':'boss'},stdout=open('/tmp/wco-stat.log','w'),stderr=subprocess.STDOUT)
    try:
        for _ in range(60):
            try:urllib.request.urlopen(BASE+'/api/health');break
            except Exception:time.sleep(.3)
        async with async_playwright() as p:
            b=await p.chromium.launch(executable_path=glob.glob('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0]);pg=await (await b.new_context(viewport={'width':1280,'height':900})).new_page();errs=[];pg.on('pageerror',lambda e:errs.append(str(e)))
            await e2e.signup(pg,'boss')
            # story duel (needs 30s)
            await pg.click('[data-act="duel"][data-i="0"]');await pg.wait_for_timeout(400)
            for _ in range(5):
                if await pg.query_selector('[data-act="talkskip"]'):await pg.click('[data-act="talkskip"]');await pg.wait_for_timeout(150)
            await pg.wait_for_timeout(31000);await pg.evaluate('WC.endDuel(0)');await pg.wait_for_timeout(2000)
            # bot match
            await pg.goto(BASE);await pg.wait_for_timeout(800);await pg.click('[data-act="ranked"]');await pg.wait_for_timeout(600);await pg.click('[data-act="rkqueue"]')
            t0=time.time()
            while time.time()-t0<240:
                await e2e.play_turn(pg)
                if await pg.evaluate("WC.UI.screen")=='pvpresult':break
                await asyncio.sleep(.2)
            st=await pg.evaluate("fetch('/api/admin/stats?days=30').then(r=>r.json())")
            print('overview',json.dumps(st['overview']),'| first',st['first'],'| rivals',json.dumps(st['rivals']),'| bots',json.dumps(st['bots']),'| cards',len(st['cards']),'top',st['cards'][:2])
            await pg.goto(BASE);await pg.wait_for_timeout(800);await pg.click('[data-act="admin"]');await pg.wait_for_selector('[data-act="admstats"]');await pg.click('[data-act="admstats"]');await pg.wait_for_selector('.st-cards');await pg.wait_for_timeout(400)
            await pg.fill('#stmin','0');await pg.dispatch_event('#stmin','change');await pg.wait_for_timeout(300)
            print('card rows shown',await pg.evaluate("document.querySelectorAll('.st-cr:not(.head)').length"))
            await pg.screenshot(path='/tmp/wco-shots/s1_balance.png',full_page=True)
            print('errors',errs[:4]);await b.close()
    finally:srv.terminate();print(open('/tmp/wco-stat.log').read()[-600:])
asyncio.run(main())
