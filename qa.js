// Browser-only deterministic regression route: /?qa=1. Never runs in the game.
(async()=>{
  const results=[];
  const assert=(condition,message)=>{if(!condition)throw new Error(message);};
  const run=(name,fn)=>{try{fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.message});}};
  const frames=(n)=>{for(let i=0;i<n;i++)GAME.step(1/60);};
  // The character and handbag arrive asynchronously. Running motion checks on
  // the procedural placeholder misses failures in the actual loaded character.
  const assetDeadline=performance.now()+20000;
  while((!GAME.hero.realMesh||!GAME.bag.real||!GAME.assets.ready)&&performance.now()<assetDeadline){
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  run('generated character and handbag finish loading before gameplay checks',()=>{
    assert(GAME.hero.realMesh,'textured character did not load within 20 seconds');
    assert(GAME.bag.real,'textured handbag did not load within 20 seconds');
    assert(GAME.assets.ready,'game is not ready after asset loading');
    assert(document.getElementById('loading-screen').hidden,'loading screen remains after assets are ready');
  });
  const vertexAt=(mesh,index,out)=>{
    out.fromBufferAttribute(mesh.geometry.attributes.position,index);
    if(mesh.isSkinnedMesh)mesh.boneTransform(index,out);
    return out;
  };
  const characterBounds=()=>{
    const mesh=GAME.hero.realMesh,box=new THREE.Box3(),v=new THREE.Vector3();
    assert(mesh,'missing generated character');
    GAME.scene.updateMatrixWorld(true);
    if(mesh.isSkinnedMesh)mesh.skeleton.update();
    for(let i=0;i<mesh.geometry.attributes.position.count;i++){
      vertexAt(mesh,i,v).applyMatrix4(mesh.matrixWorld);
      assert(v.toArray().every(Number.isFinite),'animated character contains non-finite vertices');
      box.expandByPoint(v);
    }
    return box;
  };
  const assertCharacter=()=>{
    const box=characterBounds(),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
    assert(size.y>1.25&&size.y<2.2,`animated character height invalid: ${size.y.toFixed(4)} m`);
    assert(size.x>.15&&size.z>.12&&Math.max(size.x,size.z)<2,`animated character silhouette collapsed or exploded: ${size.toArray().join(', ')}`);
    assert(Math.hypot(center.x-GAME.player.pos.x,center.z-GAME.player.pos.z)<.7,'character displaced from player');
    assert(box.min.y>-.35&&box.min.y<.3,'character left the floor');
    for(let o=GAME.hero.realMesh;o;o=o.parent)assert(o.visible,`character hidden by ${o.name||o.type}`);
  };
  const assertAttachments=()=>{
    GAME.scene.updateMatrixWorld(true);
    const world=o=>o.getWorldPosition(new THREE.Vector3());
    const right=world(GAME.hero.armR.hand),left=world(GAME.hero.armL.hand),bag=world(GAME.bag.group),outlet=world(GAME.bag.outlet);
    for(const hand of [right,left]){
      assert(hand.y>.45&&hand.y<1.7,'animated hand outside plausible body height');
      assert(Math.hypot(hand.x-GAME.player.pos.x,hand.z-GAME.player.pos.z)<1,'animated hand detached from character');
    }
    assert(right.distanceTo(bag)<.1,'handbag detached from carrying hand');
    assert(outlet.distanceTo(bag)<.8,'hose outlet detached from handbag');
    assert(outlet.distanceTo(world(GAME.bag.port))<.002,'hose outlet detached from visible collar');
    // TubeGeometry stores one radial ring per curve point. Its first ring must
    // be centred at the bag outlet, including after walking and turning.
    const tube=GAME.hoseMesh.geometry,ringSize=tube.parameters.radialSegments,ring=new THREE.Vector3(),v=new THREE.Vector3();
    for(let i=0;i<ringSize;i++)ring.add(v.fromBufferAttribute(tube.attributes.position,i));
    ring.multiplyScalar(1/ringSize).applyMatrix4(GAME.hoseMesh.matrixWorld);
    assert(ring.distanceTo(outlet)<.002,'hose begins away from the handbag collar');
  };
  const visibleObjectPixels=(source=GAME.hero.realMesh,width=200)=>{
    // Render the complete room using the actual character material and camera.
    // A white isolated clone can pass when the real shader renders nothing or
    // room geometry occludes the woman. Compare visible/hidden frames instead.
    // Disable her shadow in BOTH frames so a shadow alone cannot pass this test.
    const renderer=GAME.renderer;
    const target=new THREE.WebGLRenderTarget(width,Math.max(1,Math.round(width/GAME.camera.aspect)));
    const shadows=[];source.traverse(o=>{if(o.isMesh)shadows.push([o,o.castShadow]);});
    const previous={target:renderer.getRenderTarget(),color:renderer.getClearColor(new THREE.Color()),alpha:renderer.getClearAlpha(),viewport:renderer.getViewport(new THREE.Vector4()),scissor:renderer.getScissor(new THREE.Vector4()),scissorTest:renderer.getScissorTest(),visible:source.visible};
    try{
      renderer.setRenderTarget(target);renderer.setScissorTest(false);renderer.setClearColor(0x000000,1);
      shadows.forEach(([mesh])=>{mesh.castShadow=false;});
      const pixels=new Uint8Array(target.width*target.height*4),without=new Uint8Array(pixels.length);
      renderer.render(GAME.scene,GAME.camera);
      renderer.readRenderTargetPixels(target,0,0,target.width,target.height,pixels);
      source.visible=false;renderer.render(GAME.scene,GAME.camera);
      renderer.readRenderTargetPixels(target,0,0,target.width,target.height,without);
      let count=0;for(let i=0;i<pixels.length;i+=4)if(Math.max(Math.abs(pixels[i]-without[i]),Math.abs(pixels[i+1]-without[i+1]),Math.abs(pixels[i+2]-without[i+2]))>12)count++;
      return count;
    }finally{
      source.visible=previous.visible;shadows.forEach(([mesh,castShadow])=>{mesh.castShadow=castShadow;});
      renderer.setRenderTarget(previous.target);renderer.setClearColor(previous.color,previous.alpha);
      renderer.setViewport(previous.viewport);renderer.setScissor(previous.scissor);renderer.setScissorTest(previous.scissorTest);
      target.dispose();
    }
  };
  const visibleCharacterPixels=()=>visibleObjectPixels();
  const keyEvent=(type,code,repeat=false)=>GAME.renderer.domElement.dispatchEvent(new KeyboardEvent(type,{code,key:code==='Space'?' ':code,bubbles:true,repeat}));
  const seededLevel=(index,seed)=>{
    const original=Math.random;let state=seed>>>0;
    Math.random=()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/4294967296);
    try{GAME.start(index);}finally{Math.random=original;}
  };
  const putAtFront=(it)=>{
    GAME.player.pos.set(it.mesh.position.x,0,GAME.CONFIG.table.z+GAME.CONFIG.table.d/2+GAME.CONFIG.player.radius+.08);
    GAME.aim(it.mesh.position.x,it.mesh.position.z);
  };
  const collect=(it)=>{
    // Isolate one item at the centre to exercise suction, travel and scoring without
    // accidental neighbouring pickups. Collision/aim reach are tested separately.
    const others=GAME.items.filter(x=>x!==it&&x.state==='rest');
    const positions=others.map(x=>x.mesh.position.clone());
    others.forEach((x,i)=>x.mesh.position.set(20+i,0,20));
    it.mesh.position.set(GAME.CONFIG.table.x,GAME.CONFIG.table.h,GAME.CONFIG.table.z);
    putAtFront(it);GAME.suck(true);
    let ticks=0;while(it.state!=='bagged'&&GAME.game.state==='playing'&&ticks++<300)GAME.step(1/60);
    GAME.suck(false);others.forEach((x,i)=>x.mesh.position.copy(positions[i]));
    assert(it.state==='bagged',`${it.key}: did not travel through hose (${it.state})`);
  };
  for(let i=0;i<3;i++)run(`level ${i+1}: complete target order`,()=>{
    GAME.start(i);
    for(const item of GAME.items.filter(it=>it.isTarget))collect(item);
    assert(GAME.game.state==='won','expected victory');
    assert(GAME.game.mistakes===0,'unexpected penalty');
    assert(GAME.game.fill<=GAME.game.capacity,'target order exceeds capacity');
  });
  run('extra item counts as mistake and fills bag',()=>{
    GAME.start(0);const extra=GAME.items.find(it=>!it.isTarget);collect(extra);
    assert(GAME.game.mistakes===1,'missing mistake');assert(GAME.game.fill===extra.type.volume,'wrong fill');
  });
  run('timeout ends level',()=>{
    GAME.start(0);GAME.game.timeLeft=.02;frames(3);assert(GAME.game.state==='lost','timeout did not end game');
  });
  run('capacity overflow ends level',()=>{
    GAME.start(2);const extra=GAME.items.find(it=>!it.isTarget);
    GAME.game.fill=GAME.game.capacity-1;collect(extra);assert(GAME.game.state==='lost','overflow did not end game');
  });
  run('tracker reduces remaining time',()=>{
    GAME.start(2);const tracker=GAME.items.find(it=>it.key==='tracker');assert(tracker,'missing tracker');
    const before=GAME.game.timeLeft;collect(tracker);assert(before-GAME.game.timeLeft>=10,'missing tracker time penalty');
  });
  run('dye pack stains the bag',()=>{
    GAME.start(2);const dye=GAME.items.find(it=>it.key==='dyepack');assert(dye,'missing dye pack');collect(dye);
    assert(document.querySelector('#pip .dye').style.opacity==='1','missing dye stain');
  });
  run('movement stops at the solid table',()=>{
    GAME.start(0);const c=GAME.CONFIG;
    GAME.player.pos.set(c.table.x,0,c.table.z+c.table.d/2+c.player.radius+.05);
    GAME.camState.yaw=0;GAME.input.keys.add('KeyW');frames(60);GAME.input.keys.clear();
    assert(GAME.player.pos.z>=c.table.z+c.table.d/2+c.player.radius-.005,'walked through table');
  });
  run('camera orbit and reset return behind the player',()=>{
    GAME.start(0);const start=GAME.camState.yaw;GAME.input.keys.add('KeyQ');frames(45);GAME.input.keys.clear();
    assert(Math.abs(GAME.camState.yaw-start)>.9,'camera did not rotate');
    document.getElementById('reset-view').click();assert(Math.abs(GAME.camState.yaw-GAME.player.yaw)<.001,'reset angle wrong');
  });
  run('mouse drag changes yaw and pitch; release stops orbit',()=>{
    GAME.start(0);const c=GAME.renderer.domElement;
    const yaw=GAME.camState.yaw,pitch=GAME.camState.pitch;
    c.dispatchEvent(new PointerEvent('pointerdown',{button:2,clientX:200,clientY:200,bubbles:true,pointerId:17}));
    window.dispatchEvent(new PointerEvent('pointermove',{clientX:360,clientY:310,bubbles:true,pointerId:17}));
    window.dispatchEvent(new PointerEvent('pointerup',{button:2,bubbles:true,pointerId:17}));
    frames(2);
    assert(GAME.camState.yaw<yaw-.2,'horizontal drag ignored');
    assert(GAME.camState.pitch>pitch+.2,'vertical drag ignored');
    const after=GAME.camState.yaw;
    window.dispatchEvent(new PointerEvent('pointermove',{clientX:500,clientY:350,bubbles:true}));
    assert(GAME.camState.yaw===after,'released mouse still rotates camera');
  });
  run('camera stays inside room through complete orbits and pitch limits',()=>{
    GAME.start(0);const r=GAME.CONFIG.room;
    for(const x of [-r.halfW+.25,0,r.halfW-.25]) for(const z of [-r.halfD+.25,0,r.halfD-.25]) {
      GAME.player.pos.set(x,0,z);
      for(let i=0;i<24;i++) for(const pitch of [-.35,.25,1.12]) {
        GAME.camState.yaw=i*Math.PI/12;GAME.camState.pitch=pitch;GAME.camState.distance=3.2;
        frames(1);const p=GAME.camera.position;
        assert(Math.abs(p.x)<r.halfW&&Math.abs(p.z)<r.halfD&&p.y>0&&p.y<r.height,'camera escaped room');
        assert(p.toArray().every(Number.isFinite),'invalid camera transform');
      }
    }
  });
  run('zoom uses bounded wheel input',()=>{
    GAME.start(0);const c=GAME.renderer.domElement;
    c.dispatchEvent(new WheelEvent('wheel',{deltaY:100000,cancelable:true}));
    assert(GAME.camState.distance===GAME.CONFIG.camera.maxDist,'zoom out not limited');
    c.dispatchEvent(new WheelEvent('wheel',{deltaY:-100000,cancelable:true}));
    assert(GAME.camState.distance===GAME.CONFIG.camera.minDist,'zoom in not limited');
  });
  run('pause freezes countdown and resumes',()=>{
    GAME.start(0);document.getElementById('pause').click();const t=GAME.game.timeLeft;frames(90);
    assert(GAME.game.state==='paused'&&GAME.game.timeLeft===t,'pause failed');
    document.getElementById('pause').click();frames(10);assert(GAME.game.timeLeft<t,'resume failed');
  });
  run('pause freezes the last travelling item and resume still completes the level',()=>{
    GAME.start(0);
    const targets=GAME.items.filter(it=>it.isTarget),last=targets.pop();
    targets.forEach(collect);
    GAME.items.filter(it=>it!==last&&it.state==='rest').forEach((it,i)=>it.mesh.position.set(20+i,0,20));
    last.mesh.position.set(GAME.CONFIG.table.x,GAME.CONFIG.table.h,GAME.CONFIG.table.z);
    putAtFront(last);GAME.suck(true);
    for(let ticks=0;last.state!=='hose'&&ticks<300;ticks++)frames(1);
    assert(last.state==='hose','final target did not enter the hose');
    const before={u:last.hoseU,fill:GAME.game.fill,time:GAME.game.timeLeft,position:GAME.player.pos.clone()};
    GAME.input.keys.add('KeyW');document.getElementById('pause').click();
    assert(GAME.input.keys.size===0&&!GAME.input.mouseDown,'pause did not release active controls');
    frames(90);
    assert(last.state==='hose'&&last.hoseU===before.u,'item continued travelling while paused');
    assert(GAME.game.fill===before.fill&&GAME.game.timeLeft===before.time,'score or timer changed while paused');
    assert(GAME.player.pos.distanceTo(before.position)<1e-9,'player moved while paused');
    document.body.classList.add('clean-view');
    document.getElementById('pause').click();frames(60);
    assert(GAME.game.state==='won','resumed final target did not win the level');
    const overlay=document.getElementById('overlay');
    assert(getComputedStyle(overlay).visibility==='visible'&&getComputedStyle(overlay).display!=='none','victory menu hidden in clean view');
    document.body.classList.remove('clean-view');
  });
  run('restart clears held movement, suction and camera drag',()=>{
    GAME.start(0);GAME.input.keys.add('KeyW');GAME.input.keys.add('Space');
    GAME.input.mouseDown=true;GAME.input.rightDrag=true;GAME.start(0);
    assert(GAME.input.keys.size===0&&!GAME.input.mouseDown&&!GAME.input.rightDrag,'restart retained held input');
    const position=GAME.player.pos.clone();frames(20);
    assert(GAME.player.pos.distanceTo(position)<1e-9,'restarted character moves without input');
  });
  run('Space follows one jump arc, carries the hands and bag, and lands without held-key bouncing',()=>{
    GAME.start(0);frames(40);
    const worldY=o=>o.getWorldPosition(new THREE.Vector3()).y;
    const before={body:worldY(GAME.hero.root),hand:worldY(GAME.hero.armR.hand),bag:worldY(GAME.bag.group)};
    keyEvent('keydown','Space');let apex=0,airborneFrames=0,landed=false;
    try{
      for(let i=0;i<90;i++){
        if(i%6===0)keyEvent('keydown','Space',true);
        frames(1);apex=Math.max(apex,GAME.player.pos.y);
        if(!GAME.player.grounded){
          airborneFrames++;
          assert(Math.abs((worldY(GAME.hero.root)-before.body)-GAME.player.pos.y)<.01,'body did not follow jump elevation');
          assert(Math.abs((worldY(GAME.hero.armR.hand)-before.hand)-GAME.player.pos.y)<.06,'hand detached vertically during jump');
          assert(Math.abs((worldY(GAME.bag.group)-before.bag)-GAME.player.pos.y)<.06,'bag did not rise with the character');
          assertCharacterJumpHeight();
        }else if(airborneFrames){
          landed=true;assert(Math.abs(GAME.player.pos.y)<1e-7&&GAME.player.verticalVelocity===0,'landing left vertical drift');
        }
        if(landed)assert(GAME.player.grounded&&GAME.player.pos.y===0,'held Space caused another jump after landing');
      }
    }finally{keyEvent('keyup','Space');}
    assert(apex>.30&&apex<.65,`jump apex invalid: ${apex}`);
    assert(airborneFrames>15&&airborneFrames<45&&landed,'jump did not complete one grounded landing');
    assert(visibleCharacterPixels()>40,'jumping character disappeared after landing');
  });
  function assertCharacterJumpHeight(){
    const box=characterBounds();
    assert(box.min.y>GAME.player.pos.y-.35&&box.min.y<GAME.player.pos.y+.30,'visible mesh left jumping player');
    assert(box.getSize(new THREE.Vector3()).y>1.25,'airborne character collapsed');
    assert(visibleCharacterPixels()>40,'actual jumping character material not visible');
  }
  run('airborne Space cannot double jump, pause freezes the arc, and restart grounds the player',()=>{
    GAME.start(0);frames(30);keyEvent('keydown','Space');frames(7);keyEvent('keyup','Space');
    const velocity=GAME.player.verticalVelocity,height=GAME.player.pos.y;
    assert(!GAME.player.grounded&&velocity>0&&height>0,'first jump did not ascend');
    keyEvent('keydown','Space');frames(1);keyEvent('keyup','Space');
    assert(GAME.player.verticalVelocity<velocity,'airborne Space reset jump velocity');
    document.getElementById('pause').click();
    const paused={y:GAME.player.pos.y,v:GAME.player.verticalVelocity,bag:GAME.bag.group.position.clone()};frames(60);
    assert(GAME.player.pos.y===paused.y&&GAME.player.verticalVelocity===paused.v&&GAME.bag.group.position.equals(paused.bag),'paused jump changed body or prop position');
    document.getElementById('pause').click();frames(40);assert(GAME.player.grounded&&GAME.player.pos.y===0,'resumed jump did not land');
    keyEvent('keydown','Space');frames(5);keyEvent('keyup','Space');assert(GAME.player.pos.y>0,'second grounded jump failed');
    GAME.start(0);assert(GAME.player.pos.y===0&&GAME.player.verticalVelocity===0&&GAME.player.grounded,'restart retained airborne state');
  });
  run('repeated jumps restore the original grounded leg pose without accumulated bending',()=>{
    GAME.start(0);frames(40);const legs=[];
    GAME.hero.rig.traverse(bone=>{if(bone.isBone&&/(UpLeg|Leg|Foot|Toe)/.test(bone.name))legs.push([bone,bone.quaternion.clone()]);});
    assert(legs.length>=6,'missing leg joints for jump recovery check');
    for(let jump=0;jump<4;jump++){
      keyEvent('keydown','Space');frames(5);keyEvent('keyup','Space');frames(50);
      assert(GAME.player.grounded&&GAME.player.pos.y===0,'repeat jump failed to land');
      for(const [bone,rest] of legs)assert(bone.quaternion.angleTo(rest)<.001,`${bone.name} retained a jump bend after landing`);
    }
  });
  run('level 2 keys stay above the rendered cloth and visibly render across seeded placements',()=>{
    const surface=GAME.scene.getObjectByName('table-interaction-surface')?.userData.surfaceHeightAt;
    assert(surface,'missing shared visible cloth surface');
    for(let seed=101;seed<111;seed++){
      seededLevel(1,seed);GAME.camState.yaw=0;GAME.camState.pitch=.9;GAME.camState.distance=2.4;frames(45);
      const keys=GAME.items.find(it=>it.key==='keys');assert(keys&&keys.state==='rest','keys absent from level 2');
      GAME.scene.updateMatrixWorld(true);let minimumClearance=Infinity;
      keys.mesh.traverse(mesh=>{if(!mesh.isMesh)return;const attr=mesh.geometry.attributes.position,v=new THREE.Vector3();
        for(let i=0;i<attr.count;i++){v.fromBufferAttribute(attr,i).applyMatrix4(mesh.matrixWorld);minimumClearance=Math.min(minimumClearance,v.y-surface(v.x,v.z));}
      });
      assert(minimumClearance>=-.0005,`keys buried in cloth for seed ${seed}: ${minimumClearance}m`);
      const pixels=visibleObjectPixels(keys.mesh,800);assert(pixels>8,`keys do not render at original placement for seed ${seed}: ${pixels} pixels`);
    }
  });
  for(let level=0;level<3;level++)run(`level ${level+1}: walk to collect the original layout without moving or hiding items`,()=>{
    seededLevel(level,104+level);GAME.camState.yaw=0;
    const walkTo=(x,z)=>{
      for(let tick=0;tick<180;tick++){
        GAME.input.keys.clear();const dx=x-GAME.player.pos.x,dz=z-GAME.player.pos.z;
        if(Math.hypot(dx,dz)<.035)return;
        if(Math.abs(dx)>.018)GAME.input.keys.add(dx>0?'KeyD':'KeyA');
        if(Math.abs(dz)>.018)GAME.input.keys.add(dz>0?'KeyS':'KeyW');
        frames(1);
      }
      throw new Error('could not walk to the table through the room');
    };
    // Approach the table by the clear side of the chair; then actually walk
    // along its front for each pickup. No character or item teleportation.
    walkTo(.2,.26);GAME.input.keys.clear();
    const targets=GAME.items.filter(it=>it.isTarget).sort((a,b)=>b.mesh.position.x-a.mesh.position.x);
    for(const item of targets){
      walkTo(Math.max(-1.55,Math.min(-.35,item.mesh.position.x+.40)),.26);
      GAME.input.keys.clear();GAME.input.keys.add('KeyW');frames(35);GAME.input.keys.clear();
      GAME.aim(item.mesh.position.x,item.mesh.position.z);frames(25);
      for(let pulse=0;item.state!=='hose'&&item.state!=='bagged'&&pulse<14;pulse++){
        GAME.input.keys.add('KeyF');frames(1);GAME.input.keys.delete('KeyF');
      }
      assert(item.state==='hose'||item.state==='bagged',`${item.key} cannot be picked up after approaching its original position (distance ${GAME.tip.distanceTo(item.mesh.position).toFixed(3)})`);
      frames(40);assert(item.state==='bagged',`${item.key} did not arrive in the bag`);
    }
    assert(GAME.game.state==='won',`unaltered level ${level+1} could not be completed`);
    if(level===1)assert(GAME.game.collected.keys===1,'level 2 keys were not counted');
    assert(GAME.game.mistakes===0,'unintended extra collected while targeting actual item positions');
  });
  run('distant target cannot be collected while standing at the start',()=>{
    seededLevel(0,410);const start=GAME.player.pos.clone();
    const item=GAME.items.filter(it=>it.isTarget).sort((a,b)=>b.mesh.position.distanceTo(start)-a.mesh.position.distanceTo(start))[0];
    const position=item.mesh.position.clone();GAME.aim(position.x,position.z);frames(50);
    assert(GAME.hoseState.outOfReach,'distant aim should ask the player to approach');
    GAME.suck(true);frames(120);GAME.suck(false);
    assert(item.state==='rest'&&item.mesh.position.distanceTo(position)<.005,'distant item was pulled without approaching');
    assert(GAME.player.pos.distanceTo(start)<1e-9,'stationary reach test moved the character');
    assert(GAME.tip.distanceTo(item.mesh.position)>GAME.CONFIG.suction.pullRadius,'nozzle reaches distant target');
  });
  run('hose keeps its complete length, fixed rib count and attachments during aiming, walking and jumping',()=>{
    GAME.start(0);GAME.camState.yaw=0;GAME.player.pos.set(.7,0,1.3);frames(30);
    const expected=GAME.CONFIG.hose.length,ribs=GAME.hoseRibs.count;
    let maxRenderedError=0;
    for(let tick=0;tick<300;tick++){
      GAME.input.keys.clear();GAME.input.keys.add(['KeyW','KeyD','KeyS','KeyA'][Math.floor(tick/75)]);
      const a=tick*.11,r=tick%60<30?.5:6;
      GAME.aim(GAME.player.pos.x+Math.sin(a)*r,GAME.player.pos.z+Math.cos(a)*r);
      if(tick%70===0)keyEvent('keydown','Space');if(tick%70===2)keyEvent('keyup','Space');
      GAME.game.fill=GAME.game.capacity*(tick%100)/105;frames(1);
      const points=GAME.hoseCurve.points;let length=0;
      for(let i=1;i<points.length;i++)length+=points[i].distanceTo(points[i-1]);
      assert(Math.abs(length-expected)<.0001,`hose stretched: ${length}`);
      assert(GAME.hoseRibs.count===ribs,'hose grows or loses corrugation rings');
      const world=o=>o.getWorldPosition(new THREE.Vector3());
      assert(points[0].distanceTo(world(GAME.bag.outlet))<.00001,'hose detached from bag');
      assert(points.at(-1).distanceTo(GAME.tip)<.00001,'nozzle detached from hose');
      const grip=GAME.hoseCurve.samples;
      assert(points[grip].clone().lerp(points[grip+1],.5).distanceTo(world(GAME.hero.armL.hand))<.00001,'hose slips out of gripping hand');
      assert(points.every(p=>p.toArray().every(Number.isFinite)&&p.y>=.025),'hose crossed floor or became invalid');
      const geometry=GAME.hoseMesh.geometry,radial=geometry.parameters.radialSegments,segments=geometry.parameters.tubularSegments;
      let drawn=0,prior=null;const v=new THREE.Vector3();
      for(let ring=0;ring<=segments;ring++){
        const centre=new THREE.Vector3();for(let j=0;j<radial;j++)centre.add(v.fromBufferAttribute(geometry.attributes.position,ring*(radial+1)+j));centre.multiplyScalar(1/radial);
        if(prior)drawn+=centre.distanceTo(prior);prior=centre;
      }
      maxRenderedError=Math.max(maxRenderedError,Math.abs(drawn-expected));
      assert(Math.abs(drawn-expected)<.012,`rendered tube length changed: ${drawn}`);
    }
    GAME.input.keys.clear();keyEvent('keyup','Space');
    console.info('Maximum rendered hose length error, metres:',maxRenderedError);
  });
  run('clean view keeps the lost-level menu and HUD restore button accessible',()=>{
    GAME.start(0);document.body.classList.add('clean-view');GAME.game.timeLeft=.01;frames(2);
    const overlay=document.getElementById('overlay'),restore=document.getElementById('hide-hud');
    assert(GAME.game.state==='lost','timeout did not show loss');
    assert(getComputedStyle(overlay).visibility==='visible'&&getComputedStyle(overlay).display!=='none','loss menu hidden in clean view');
    assert(getComputedStyle(restore).visibility==='visible'&&restore.getClientRects().length>0,'HUD restore button inaccessible');
    document.body.classList.remove('clean-view');
  });
  run('geometry and hose attachments remain finite',()=>{
    GAME.start(2);frames(20);GAME.render();
    GAME.scene.traverse(o=>{
      if(!o.isMesh)return;const p=o.geometry?.attributes.position;
      if(p)for(let i=0;i<p.array.length;i++)assert(Number.isFinite(p.array[i]),`${o.name}: non-finite geometry`);
    });
    const hand=GAME.hero.armR.hand.getWorldPosition(new THREE.Vector3());
    assert(hand.distanceTo(GAME.bag.group.position)<.001,'strap detached from hand');
    assert(GAME.hoseRibs.count>30&&GAME.hoseRibs.count<=260,'rib count invalid');
  });
  for(const key of ['KeyW','KeyA','KeyS','KeyD'])run(`loaded character stays visible and attached while walking ${key.slice(3)}`,()=>{
    GAME.start(0);GAME.input.keys.clear();GAME.player.pos.set(.6,0,1.35);
    GAME.player.yaw=0;GAME.camState.yaw=0;GAME.camState.pitch=.22;GAME.camState.distance=2.4;
    frames(60);assertCharacter();
    GAME.input.keys.add(key);
    try{
      for(let sample=0;sample<8;sample++){
        frames(8);assertCharacter();assertAttachments();
        assert(visibleCharacterPixels()>40,`character draws no substantial pixels while walking ${key.slice(3)}`);
      }
    }finally{GAME.input.keys.clear();}
    frames(80);assertCharacter();assertAttachments();
    assert(visibleCharacterPixels()>40,'character disappears after stopping');
  });
  run('original character material remains visible in the complete room at wall camera angles',()=>{
    GAME.start(0);GAME.input.keys.clear();
    const r=GAME.CONFIG.room;
    const positions=[[r.halfW-.30,1.2],[-r.halfW+.30,1.8],[.6,r.halfD-.30],[.6,-r.halfD+.30]];
    for(const [x,z] of positions)for(let orbit=0;orbit<8;orbit++){
      GAME.player.pos.set(x,0,z);GAME.camState.yaw=orbit*Math.PI/4;GAME.camState.pitch=.3;GAME.camState.distance=2.4;
      frames(3);assertCharacter();
      const pixels=visibleCharacterPixels();
      assert(pixels>40,`full-scene character invisible near wall (${x}, ${z}), camera yaw ${GAME.camState.yaw.toFixed(2)}, changed pixels ${pixels}`);
    }
  });
  run('walking deforms lower-body vertices rather than only moving the whole model',()=>{
    GAME.start(0);GAME.input.keys.clear();GAME.player.pos.set(.6,0,1.35);frames(90);
    const mesh=GAME.hero.realMesh,v=new THREE.Vector3(),samples=[],inverseRoot=new THREE.Matrix4();
    assert(mesh,'missing generated character');
    GAME.scene.updateMatrixWorld(true);inverseRoot.copy(GAME.hero.root.matrixWorld).invert();
    const localVertex=index=>vertexAt(mesh,index,v).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverseRoot);
    for(let i=0;i<mesh.geometry.attributes.position.count;i+=8){
      localVertex(i);if(v.y<.85)samples.push({index:i,position:v.clone()});
    }
    assert(samples.length>20,'missing lower-body vertices');
    GAME.input.keys.add('KeyW');let changed=0;
    try{
      for(let sample=0;sample<4;sample++){
        frames(9);assertCharacter();
        inverseRoot.copy(GAME.hero.root.matrixWorld).invert();
        changed=Math.max(changed,samples.filter(s=>localVertex(s.index).distanceTo(s.position)>.015).length);
      }
    }finally{GAME.input.keys.clear();}
    assert(changed>20,`walk animation did not move the legs (${changed} changed vertices)`);
  });
  // Wait for actual local assets, then test their completion state.
  for(let i=0;i<100;i++){
    const maps=[];GAME.scene.traverse(o=>{const mats=Array.isArray(o.material)?o.material:[o.material];for(const m of mats)if(m)for(const k of ['map','normalMap','roughnessMap'])if(m[k])maps.push(m[k]);});
    if(maps.every(t=>t.image?.width>0))break;
    await new Promise(r=>setTimeout(r,100));
  }
  run('all visible material maps loaded',()=>{
    assert(GAME.pbr.failed.length===0,'texture request failed');
    GAME.scene.traverse(o=>{const mats=Array.isArray(o.material)?o.material:[o.material];for(const m of mats)if(m)for(const k of ['map','normalMap','roughnessMap'])if(m[k])assert(m[k].image?.width>0,`unloaded ${k}`);});
  });
  GAME.game.state='intro';GAME.input.keys.clear();GAME.render();
  const report={passed:results.every(r=>r.passed),checks:results,render:{calls:GAME.renderer.info.render.calls,triangles:GAME.renderer.info.render.triangles,geometries:GAME.renderer.info.memory.geometries,textures:GAME.renderer.info.memory.textures}};
  document.body.classList.remove('clean-view');
  const pre=document.createElement('pre');pre.id='qa-report';pre.style.cssText='position:fixed;inset:0;z-index:1000;background:#15241f;color:#e9f0e9;overflow:auto;padding:24px;user-select:text;margin:0;font:13px monospace';pre.textContent=JSON.stringify(report,null,2);document.body.appendChild(pre);
  console.info('QA '+(report.passed?'PASSED':'FAILED'),report);
})();
