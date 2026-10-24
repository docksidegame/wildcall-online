# Online story duel: rewards come from the server after a real-length duel.
import asyncio,glob,os,subprocess,time,shutil,urllib.request
from playwright.async_api import async_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)));PORT=3144;BASE=f'http://localhost:{PORT}'
async def main():
    shutil.rmtree('/tmp/wco-st-db',ignore_errors=True)
    srv=subprocess.Popen(['node','server/index.js'],cwd=ROOT,env={**os.environ,'PORT':str(PORT),'PGLITE_DIR':'/tmp/wco-st-db','ADMIN_USERNAMES':'sam'},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:urllib.request.urlopen(BASE+'/api/health');break
            except Exception:time.sleep(.3)
        async with async_playwright() as p:
            b=await p.chromium.launch(executable_path=glob.glob('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0]);pg=await b.new_page();errs=[];pg.on('pageerror',lambda e:errs.append(str(e)))
            await pg.goto(BASE);await pg.wait_for_selector('#authform');await pg.click('[data-act="authtab"][data-t="up"]')
            await pg.fill('input[name=username]','sam');await pg.fill('input[name=email]','sam@x.com');await pg.fill('input[name=password]','password123');await pg.check('input[name=terms]');await pg.click('#authform button[type=submit]')
            await pg.wait_for_selector('[data-act="pickstarter"]');await pg.click('[data-act="pickstarter"][data-i="0"]');await pg.wait_for_timeout(400);await pg.click('[data-act="talkskip"]')
            await pg.click('[data-act="duel"][data-i="0"]');await pg.wait_for_timeout(500)
            for _ in range(5):
                if await pg.query_selector('[data-act="talkskip"]'):await pg.click('[data-act="talkskip"]');await pg.wait_for_timeout(200)
            print('in duel',await pg.evaluate('WC.UI.screen'));await pg.wait_for_timeout(31500)
            await pg.evaluate('WC.endDuel(0)');await pg.wait_for_timeout(2500)
            print('screen',await pg.evaluate('WC.UI.screen'),'result',await pg.evaluate('JSON.stringify(WC.UI.result)'),'beaten',await pg.evaluate('JSON.stringify(WC.SAVE.beaten)'))
            await pg.reload();await pg.wait_for_timeout(1200);print('after reload coins',await pg.evaluate('WC.SAVE.coins'),'beaten',await pg.evaluate('JSON.stringify(WC.SAVE.beaten)'))
            r=await pg.evaluate("fetch('/api/admin/season/end',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.json())");print('season end',r)
            print('errors',errs[:4]);await b.close()
    finally:srv.terminate()
asyncio.run(main())
