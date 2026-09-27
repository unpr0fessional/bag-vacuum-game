// Run with Node.js. Optional: GAME_URL, PLAYWRIGHT_MODULE, CHROME_PATH, QA_OUTPUT.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const candidates=[process.env.PLAYWRIGHT_MODULE,'playwright',path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean);
let playwright;
for(const candidate of candidates){try{playwright=require(candidate);break;}catch{}}
if(!playwright)throw new Error('Playwright is required. Install it or set PLAYWRIGHT_MODULE.');
const output=process.env.QA_OUTPUT||path.resolve(__dirname,'../review');
const base=process.env.GAME_URL||'http://127.0.0.1:8765/';
fs.mkdirSync(output,{recursive:true});
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
(async()=>{
  let browser;
  if(process.env.CHROME_PATH)browser=await playwright.chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
  else try{browser=await playwright.chromium.launch({headless:true});}
  catch(error){
    if(!/Executable doesn't exist|browser.*not found/i.test(error.message))throw error;
    browser=await playwright.chromium.launch({headless:true,channel:'chrome'});
  }
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
    const runtimeErrors=[];
    const observeErrors=(page,expectedResponse=()=>false)=>{
      page.on('pageerror',error=>runtimeErrors.push(error.message));
      page.on('response',response=>{if(response.status()>=400&&!new URL(response.url()).pathname.endsWith('/favicon.ico')&&!expectedResponse(response))runtimeErrors.push(`${response.status()} ${response.url()}`);});
      page.on('requestfailed',request=>runtimeErrors.push(`${request.failure()?.errorText}: ${request.url()}`));
      page.on('console',message=>{if(message.type()==='error'&&!message.text().startsWith('Failed to load resource:'))runtimeErrors.push(message.text());});
    };
    observeErrors(page);
    const url=new URL(base);url.searchParams.set('qa','1');url.searchParams.set('check',Date.now());
    await page.goto(url.href,{waitUntil:'load'});
    await page.waitForSelector('#qa-report',{timeout:120000});
    const report=JSON.parse(await page.locator('#qa-report').innerText());
    // The scripted QA route freezes requestAnimationFrame simulation, so these
    // screenshots capture known idle, walking and stopped poses deterministically.
    await page.evaluate(()=>{
      document.getElementById('qa-report').style.display='none';
      document.body.classList.add('clean-view');
      GAME.start(0);GAME.input.keys.clear();GAME.player.pos.set(.55,0,1.25);
      GAME.camState.yaw=-.6;GAME.camState.pitch=.22;GAME.camState.distance=2.4;
      for(let i=0;i<90;i++)GAME.step(1/60);GAME.render();
    });
    await page.screenshot({path:path.join(output,'qa-idle.png')});
    await page.evaluate(()=>{GAME.input.keys.add('KeyW');for(let i=0;i<16;i++)GAME.step(1/60);GAME.render();});
    await page.screenshot({path:path.join(output,'qa-walking.png')});
    await page.evaluate(()=>{GAME.input.keys.clear();for(let i=0;i<90;i++)GAME.step(1/60);GAME.render();});
    await page.screenshot({path:path.join(output,'qa-stopped.png')});
    await page.close();
    const browserChecks=[];
    const runBrowser=async(name,fn)=>{
      try{await fn();browserChecks.push({name,passed:true});}
      catch(error){browserChecks.push({name,passed:false,error:error.message});}
    };
    let runtimeVersions=null;
    await runBrowser('delayed models keep loading gate closed, then Space and Enter activate menu buttons',async()=>{
      const context=await browser.newContext({viewport:{width:1440,height:900}});
      let releaseModels;const holdModels=new Promise(resolve=>{releaseModels=resolve;}),requests=new Set();
      await context.route(url=>/\/assets\/models\/[^/]+\.glb$/.test(url.pathname),async route=>{
        requests.add(new URL(route.request().url()).pathname);await holdModels;await route.continue();
      });
      const page=await context.newPage();observeErrors(page);
      const versionedRequests=[];
      page.on('request',request=>{
        const asset=new URL(request.url());
        if(asset.origin===new URL(base).origin&&(/\.(js|css)$/.test(asset.pathname)||/\/assets\/(models|textures)\//.test(asset.pathname)))versionedRequests.push({path:asset.pathname,version:asset.searchParams.get('v')});
      });
      try{
        await page.goto(base,{waitUntil:'domcontentloaded'});
        await page.waitForFunction(()=>!!window.GAME);
        assert(requests.size===2,'both model requests were not intercepted');
        assert(await page.locator('#loading-screen').isVisible(),'loading overlay missing while models are delayed');
        const gated=await page.evaluate(()=>{GAME.start(0);return {ready:GAME.assets.ready,state:GAME.game.state,time:GAME.game.timeLeft};});
        assert(!gated.ready&&gated.state==='intro','game started before models were loaded');
        await page.screenshot({path:path.join(output,'qa-loading.png')});
        const stillGated=await page.evaluate(()=>({state:GAME.game.state,time:GAME.game.timeLeft}));
        assert(stillGated.state==='intro'&&stillGated.time===gated.time,'timer ran while loading');
        releaseModels();
        await page.waitForFunction(()=>GAME.assets.ready,null,{timeout:30000});
        runtimeVersions={expected:await page.evaluate(()=>new URL(document.querySelector('script[src*="game.js"]').src).searchParams.get('v')),requests:versionedRequests};
        assert(!(await page.locator('#loading-screen').isVisible()),'loading overlay did not disappear');
        const play=page.locator('#overlay .btns button').first();await play.focus();await page.keyboard.press('Space');
        await page.waitForFunction(()=>GAME.game.state==='playing');
        assert(await page.evaluate(()=>!GAME.input.keys.has('Space')),'menu Space leaked into game input');
        await page.keyboard.down('Space');
        await page.waitForFunction(()=>GAME.player.pos.y>.3,null,{timeout:3000});
        await page.screenshot({path:path.join(output,'qa-jump.png')});
        await page.waitForFunction(()=>GAME.player.grounded,null,{timeout:3000});
        await page.waitForTimeout(300);
        assert(await page.evaluate(()=>GAME.player.grounded&&GAME.player.pos.y===0),'held real Space caused repeated jumping');
        await page.keyboard.up('Space');
        await page.evaluate(()=>{GAME.game.timeLeft=.001;});
        await page.waitForFunction(()=>GAME.game.state==='lost');
        await page.locator('#overlay .btns button').first().focus();await page.keyboard.press('Enter');
        await page.waitForFunction(()=>GAME.game.state==='playing');
      }finally{releaseModels();await context.close();}
    });
    await runBrowser('runtime scripts, styles, models and textures share one explicit release version',async()=>{
      assert(runtimeVersions?.expected,'game.js request has no explicit release version');
      assert(runtimeVersions.requests.some(r=>r.path.endsWith('/hero.glb'))&&runtimeVersions.requests.some(r=>r.path.includes('/assets/textures/')),'version check did not observe models and textures');
      const mismatches=runtimeVersions.requests.filter(request=>request.version!==runtimeVersions.expected);
      assert(!mismatches.length,'inconsistent or absent asset versions: '+JSON.stringify(mismatches));
    });
    await runBrowser('failed character load offers retry, blocks play, and reload recovers',async()=>{
      const context=await browser.newContext({viewport:{width:1440,height:900}});let injected=false;
      await context.route(url=>url.pathname.endsWith('/assets/models/hero.glb'),async route=>{
        if(!injected){injected=true;await route.fulfill({status:503,contentType:'text/plain',body:'Intentional QA model-load failure'});}
        else await route.continue();
      });
      const page=await context.newPage();observeErrors(page,response=>response.status()===503&&new URL(response.url()).pathname.endsWith('/assets/models/hero.glb'));
      try{
        await page.goto(base,{waitUntil:'domcontentloaded'});
        await page.waitForFunction(()=>window.GAME?.assets.failed.length>0);
        assert(await page.locator('#loading-screen').isVisible(),'failed load removed the loading gate');
        assert(await page.locator('#loading-retry').isVisible(),'failed load has no retry button');
        const state=await page.evaluate(()=>{GAME.start(0);return {ready:GAME.assets.ready,state:GAME.game.state};});
        assert(!state.ready&&state.state==='intro','failed model permits game start');
        await page.screenshot({path:path.join(output,'qa-load-retry.png')});
        await page.locator('#loading-retry').click();
        await page.waitForFunction(()=>window.GAME?.assets.ready,null,{timeout:30000});
        assert(!(await page.locator('#loading-screen').isVisible()),'retry succeeded but loading gate stayed visible');
        await page.locator('#overlay .btns button').first().click();
        await page.waitForFunction(()=>GAME.game.state==='playing');
      }finally{await context.close();}
    });
    report.checks.push(...browserChecks);
    report.runtimeVersions=runtimeVersions;
    report.runtimeErrors=[...new Set(runtimeErrors)];
    report.passed=report.passed&&browserChecks.every(check=>check.passed)&&report.runtimeErrors.length===0;
    fs.writeFileSync(path.join(output,'browser-checks.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
    if(!report.passed)process.exitCode=1;
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
