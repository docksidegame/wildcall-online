# One player queues alone, gets matched with a bot after PVP_BOT_SECS, and plays it to the end.
import asyncio,glob,os,subprocess,time,shutil,urllib.request,sys
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from e2e import signup,play_turn
from playwright.async_api import async_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)));PORT=3155;BASE=f'http://localhost:{PORT}'
import e2e;e2e.BASE=BASE
async def main():
    shutil.rmtree('/tmp/wco-bot-db',ignore_errors=True)
    srv=subprocess.Popen(['node','server/index.js'],cwd=ROOT,env={**os.environ,'PORT':str(PORT),'PGLITE_DIR':'/tmp/wco-bot-db','PVP_BOT_SECS':'3'},stdout=open('/tmp/wco-bot.log','w'),stderr=subprocess.STDOUT)
    try:
        for _ in range(60):
            try:urllib.request.urlopen(BASE+'/api/health');break
            except Exception:time.sleep(.3)
        async with async_playwright() as p:
            b=await p.chromium.launch(executable_path=glob.glob('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')[0]);pg=await b.new_page(viewport={'width':1280,'height':860});errs=[];pg.on('pageerror',lambda e:errs.append(str(e)))
            await signup(pg,'solo');await pg.goto(BASE);await pg.wait_for_timeout(900);await pg.click('[data-act="ranked"]');await pg.wait_for_timeout(800)
            await pg.click('[data-act="rkqueue"]');await pg.wait_for_timeout(1000);await pg.screenshot(path='/tmp/wco-shots/b1_queue.png')
            t0=time.time();shot=False
            while time.time()-t0<300:
                r=await play_turn(pg)
                if not shot and await pg.evaluate("WC.D&&WC.D.net&&WC.D.turnNo>6"):await pg.screenshot(path='/tmp/wco-shots/b2_duel.png');shot=True
                if await pg.evaluate("WC.UI.screen")=='pvpresult':break
                await asyncio.sleep(.2)
            await pg.wait_for_timeout(800);await pg.screenshot(path='/tmp/wco-shots/b3_result.png')
            print('screen',await pg.evaluate('WC.UI.screen'),'result',await pg.evaluate('JSON.stringify(WC.UI.pvp&&{won:WC.UI.pvp.won,bot:WC.UI.pvp.bot,opp:WC.UI.pvp.oppName,r:[WC.UI.pvp.ratingBefore,WC.UI.pvp.ratingAfter],coins:WC.UI.pvp.coins})'),'turns',await pg.evaluate('WC.D&&WC.D.turnNo'))
            print('stats',await pg.evaluate('JSON.stringify({pg:WC.SAVE.stats.pvpGames,pw:WC.SAVE.stats.pvpWins,w:WC.SAVE.stats.wins})'),'account',await pg.evaluate('JSON.stringify(WC.UI.pvp&&WC.UI.pvp.user)'))
            print('errors',errs[:4]);await b.close()
    finally:
        srv.terminate();print(open('/tmp/wco-bot.log').read()[-800:])
asyncio.run(main())
