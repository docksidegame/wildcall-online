# Admin player management: list, open, edit, award with a note the player then sees.
import asyncio,glob,os,subprocess,time,shutil,urllib.request,sys
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import e2e
from playwright.async_api import async_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)));PORT=3166;e2e.BASE=BASE=f'http://localhost:{PORT}'
async def main():
    shutil.rmtree('/tmp/wco-adm-db',ignore_errors=True)
    srv=subprocess.Popen(['node','server/index.js'],cwd=ROOT,env={**os.environ,'PORT':str(PORT),'PGLITE_DIR':'/tmp/wco-adm-db','ADMIN_USERNAMES':'boss'},stdout=open('/tmp/wco-adm.log','w'),stderr=subprocess.STDOUT)
    try:
        for _ in range(60):
            try:urllib.request.urlopen(BASE+'/api/health');break
            except Exception:time.sleep(.3)
        async with async_playwright() as p:
            b=await p.chromium.launch(executable_path=glob.glob('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0])
            A=await (await b.new_context(viewport={'width':1280,'height':900})).new_page();B=await (await b.new_context()).new_page();errs=[]
            for pg in (A,B):pg.on('pageerror',lambda e:errs.append(str(e)))
            await e2e.signup(A,'boss');await e2e.signup(B,'casey')
            await A.goto(BASE);await A.wait_for_timeout(800);await A.click('[data-act="admin"]');await A.wait_for_selector('.adm-tr[data-act="admopen"]')
            print('players listed',await A.evaluate("document.querySelectorAll('.adm-tr[data-act=admopen]').length"))
            await A.screenshot(path='/tmp/wco-shots/a1_players.png',full_page=True)
            await A.click('.adm-tr[data-act="admopen"]:has-text("casey")');await A.wait_for_selector('[data-act="admusave"]')
            await A.fill('[data-f="coins"]','1234');await A.fill('[data-f="rating"]','1111');await A.click('[data-act="admusave"]');await A.wait_for_timeout(800)
            await A.fill('#aw_c','500');await A.fill('#aw_p','2');await A.fill('#aw_n','Thanks for testing!');await A.click('[data-act="admuaward"]');await A.wait_for_timeout(900)
            await A.screenshot(path='/tmp/wco-shots/a2_player.png',full_page=True)
            print('audit rows',await A.evaluate("document.querySelectorAll('.adm-log').length"))
            await B.goto(BASE);await B.wait_for_timeout(1500)
            print('casey inbox modal',await B.evaluate("document.querySelector('.modal h2')&&document.querySelector('.modal').textContent.replace(/\\s+/g,' ').slice(0,120)"))
            print('casey coins',await B.evaluate('WC.SAVE.coins'),'packs',await B.evaluate('WC.SAVE.packs'))
            await B.screenshot(path='/tmp/wco-shots/a3_inbox.png')
            await B.goto(BASE);await B.wait_for_timeout(1200);print('inbox again after reload?',await B.evaluate("!!document.querySelector('.modal h2')"))
            await A.click('[data-act="admback"]');await A.wait_for_timeout(500);await A.fill('#awc_all','50');await A.click('[data-act="admawardall"]');await A.wait_for_timeout(300);await A.click('.modal [data-act="admawardall"]');await A.wait_for_timeout(800)
            await B.goto(BASE);await B.wait_for_timeout(1200);print('casey coins after award-all',await B.evaluate('WC.SAVE.coins'))
            print('errors',errs[:4]);await b.close()
    finally:srv.terminate()
asyncio.run(main())
