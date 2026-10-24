# Friend challenge: A creates a code, B opens the link and joins; unrated match with no rewards.
import asyncio,glob,os,subprocess,time,shutil,urllib.request,sys
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import e2e
from playwright.async_api import async_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)));PORT=3177;e2e.BASE=BASE=f'http://localhost:{PORT}'
async def main():
    shutil.rmtree('/tmp/wco-fr-db',ignore_errors=True)
    srv=subprocess.Popen(['node','server/index.js'],cwd=ROOT,env={**os.environ,'PORT':str(PORT),'PGLITE_DIR':'/tmp/wco-fr-db','PVP_BOT_SECS':'0'},stdout=open('/tmp/wco-fr.log','w'),stderr=subprocess.STDOUT)
    try:
        for _ in range(60):
            try:urllib.request.urlopen(BASE+'/api/health');break
            except Exception:time.sleep(.3)
        async with async_playwright() as p:
            b=await p.chromium.launch(executable_path=glob.glob('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0])
            A=await (await b.new_context(viewport={'width':1280,'height':900})).new_page();B=await (await b.new_context(viewport={'width':390,'height':844})).new_page();errs=[]
            for pg in (A,B):pg.on('pageerror',lambda e:errs.append(str(e)))
            await e2e.signup(A,'host');await e2e.signup(B,'guest')
            await A.goto(BASE);await A.wait_for_timeout(800);await A.click('[data-act="ranked"]');await A.wait_for_timeout(800)
            await A.click('[data-act="chcreate"]');await A.wait_for_selector('.rk-code .code');code=await A.text_content('.rk-code .code');print('code',code)
            await A.screenshot(path='/tmp/wco-shots/f1_code.png')
            cA=await A.evaluate('WC.SAVE.coins');cB=await B.evaluate('WC.SAVE.coins')
            await B.goto(BASE+'/?c='+code);await B.wait_for_timeout(1500);print('guest screen',await B.evaluate('WC.UI.screen'),'code filled',await B.input_value('#chcode'))
            await B.click('[data-act="chjoin"]')
            t0=time.time()
            while time.time()-t0<300:
                ra=await e2e.play_turn(A);rb=await e2e.play_turn(B)
                if await A.evaluate("WC.UI.screen")=='pvpresult' and await B.evaluate("WC.UI.screen")=='pvpresult':break
                await asyncio.sleep(.15)
            await A.wait_for_timeout(800);await A.screenshot(path='/tmp/wco-shots/f2_result.png')
            for n,pg in (('host',A),('guest',B)):
                print(n,await pg.evaluate('JSON.stringify({won:WC.UI.pvp&&WC.UI.pvp.won,friendly:WC.UI.pvp&&WC.UI.pvp.friendly,r:WC.UI.pvp&&[WC.UI.pvp.ratingBefore,WC.UI.pvp.ratingAfter],coins:WC.SAVE.coins})'))
            print('coins before',cA,cB)
            await A.click('[data-act="ranked"]');await A.wait_for_timeout(1200);print('history',await A.evaluate("[...document.querySelectorAll('.rk-tr b')].map(x=>x.textContent).join('|')"))
            # bad code
            await A.fill('#chcode','ZZZZZZ');await A.click('[data-act="chjoin"]');await A.wait_for_timeout(600);print('bad code toast',await A.evaluate("document.querySelector('.toast')&&document.querySelector('.toast').textContent"))
            print('errors',errs[:4]);await b.close()
    finally:srv.terminate();print(open('/tmp/wco-fr.log').read()[-600:])
asyncio.run(main())
