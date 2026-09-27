// Live input/rendering regression. Optional GAME_URL, GAME_DIR, QA_OUTPUT,
// PLAYWRIGHT_MODULE, CHROME_PATH, QA_VIDEO=1 (requires Playwright's ffmpeg).
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createGameServer}=require('./serve.cjs');
let playwright;
for(const entry of [process.env.PLAYWRIGHT_MODULE,'playwright',path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean)){
  try{playwright=require(entry);break;}catch{}
}
if(!playwright)throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
const output=process.env.QA_OUTPUT||path.resolve(__dirname,'../review');fs.mkdirSync(output,{recursive:true});
(async()=>{
  let server,browser;
  const samples=[],errors=[];let started,version=null;
  try{
    let url=process.env.GAME_URL;
    if(!url){server=createGameServer(path.resolve(__dirname,'..',process.env.GAME_DIR||'.'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));url=`http://127.0.0.1:${server.address().port}/`;}
    if(process.env.CHROME_PATH)browser=await playwright.chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
    else try{browser=await playwright.chromium.launch({headless:true});}catch(error){
      if(!/Executable doesn't exist|browser.*not found/i.test(error.message))throw error;
      browser=await playwright.chromium.launch({headless:true,channel:'chrome'});
    }
    const record=process.env.QA_VIDEO==='1';
    const context=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1,...(record?{recordVideo:{dir:path.join(output,'video-raw'),size:{width:1280,height:800}}}:{})});
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    page.on('response',response=>{if(response.status()>=400&&!new URL(response.url()).pathname.endsWith('/favicon.ico'))errors.push(`${response.status()} ${response.url()}`);});
    await page.goto(url,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.GAME?.assets.ready,null,{timeout:30000});
    version=await page.evaluate(()=>new URL(document.querySelector('script[src*="game.js"]').src).searchParams.get('v'));
    await page.screenshot({path:path.join(output,'visibility-intro.png')});
    await page.locator('#overlay .btns button').first().click();started=Date.now();
    const sample=async(label)=>{
      const result=await page.evaluate(()=>{
        const r=GAME.renderer,m=GAME.hero.realMesh;
        const previous={target:r.getRenderTarget(),viewport:r.getViewport(new THREE.Vector4()),scissor:r.getScissor(new THREE.Vector4()),scissorTest:r.getScissorTest(),visible:m.visible,castShadow:m.castShadow};
        const target=new THREE.WebGLRenderTarget(200,Math.round(200/GAME.camera.aspect));
        try{
          r.setRenderTarget(target);r.setScissorTest(false);m.castShadow=false;
          const withHero=new Uint8Array(target.width*target.height*4),without=new Uint8Array(withHero.length);
          r.render(GAME.scene,GAME.camera);r.readRenderTargetPixels(target,0,0,target.width,target.height,withHero);
          m.visible=false;r.render(GAME.scene,GAME.camera);r.readRenderTargetPixels(target,0,0,target.width,target.height,without);
          let pixels=0;for(let i=0;i<withHero.length;i+=4)if(Math.max(Math.abs(withHero[i]-without[i]),Math.abs(withHero[i+1]-without[i+1]),Math.abs(withHero[i+2]-without[i+2]))>12)pixels++;
          return {pixels,rootVisible:GAME.hero.root.visible,meshVisible:previous.visible,position:GAME.player.pos.toArray(),camera:GAME.camera.position.toArray(),moveAmount:GAME.player.moveAmount,state:GAME.game.state};
        }finally{m.visible=previous.visible;m.castShadow=previous.castShadow;r.setRenderTarget(previous.target);r.setViewport(previous.viewport);r.setScissor(previous.scissor);r.setScissorTest(previous.scissorTest);target.dispose();}
      });
      samples.push({label,elapsedMs:Date.now()-started,...result});
      if(result.pixels<=40||!result.rootVisible||!result.meshVisible){
        await page.screenshot({path:path.join(output,'visibility-failure.png')});throw new Error(`Character not drawn at ${label}: ${JSON.stringify(result)}`);
      }
    };
    const hold=async(key,duration)=>{
      await page.keyboard.down(key);
      try{for(let elapsed=0;elapsed<duration;elapsed+=400){await page.waitForTimeout(Math.min(400,duration-elapsed));await sample(`${key}-${elapsed}`);}}
      finally{await page.keyboard.up(key);}
    };
    const orbit=async(direction)=>{
      const from=direction>0?180:1100;await page.mouse.move(from,350);await page.mouse.down({button:'right'});
      try{for(let i=1;i<=12;i++){await page.mouse.move(from+direction*i*70,350+Math.sin(i/12*Math.PI)*80);await page.waitForTimeout(100);if(i%3===0)await sample(`orbit-${direction}-${i}`);}}
      finally{await page.mouse.up({button:'right'});}
    };
    const jump=async()=>{
      await page.keyboard.down('Space');
      try{for(let i=0;i<7;i++){await page.waitForTimeout(100);await sample(`real-space-jump-${i}`);}}
      finally{await page.keyboard.up('Space');}
      if(!await page.evaluate(()=>GAME.player.grounded&&GAME.player.pos.y===0))throw new Error('Held Space did not complete one landing');
    };
    await sample('start');await hold('w',2000);await page.screenshot({path:path.join(output,'visibility-walking.png')});
    await hold('s',2400);await jump();await hold('d',2400);await orbit(1);await hold('a',2800);
    await hold('s',2000);await orbit(-1);await jump();await hold('w',2400);await hold('d',1600);
    await page.waitForTimeout(1000);await sample('stopped');
    await page.screenshot({path:path.join(output,'visibility-wall.png')});
    const video=page.video();await context.close();if(video){await video.saveAs(path.join(output,'visibility-release.webm'));await video.delete();}
  }catch(error){errors.push(error.stack||error.message);}
  finally{
    const report={passed:!errors.length&&samples.length>30,version,durationMs:started?Date.now()-started:null,sampleCount:samples.length,minVisiblePixels:samples.length?Math.min(...samples.map(s=>s.pixels)):null,method:'Normal live loop; actual keyboard/mouse events; original character material rendered in full scene, compared with hidden character, excluding its shadow',samples,errors};
    fs.writeFileSync(path.join(output,'visibility-smoke.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,samples:undefined},null,2));
    if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    if(!report.passed)process.exitCode=1;
  }
})();
