'use strict';

// Reference-driven geometry. All surfaces remain real 3D meshes and work from
// every camera angle. Metres, Y up, character faces -Z.
const Look = (() => {
  const T = THREE, V = T.Vector3;
  const mesh = (geo, mat, parent, p = [0, 0, 0]) => {
    const m = new T.Mesh(geo, mat); m.position.set(...p);
    m.castShadow = m.receiveShadow = true; parent.add(m); return m;
  };
  const tube = (points, r, mat, parent, segments = 48) =>
    mesh(new T.TubeGeometry(new T.CatmullRomCurve3(points.map(p => new V(...p))), segments, r, 8, false), mat, parent);
  const box = (w, h, d, mat, parent, p) => mesh(new T.BoxGeometry(w, h, d), mat, parent, p);
  const gauss = (x, c, w) => Math.exp(-(((x-c)/w)**2));

  // Smooth section loft; silhouette is controlled independently of microdetail.
  function loft(sections, { rings=54, sides=56, start=0, arc=Math.PI*2, deform, omit, opening } = {}) {
    const pos=[], uv=[], indices=[];
    const first=sections[0][0], last=sections.at(-1)[0];
    const curves = [1,2,3,4].map(k => new T.SplineCurve(sections.map(s=>new T.Vector2(s[0], s[k]||0))));
    for (let i=0;i<=rings;i++) {
      const f=i/rings;
      // Sampling all profile channels at the same parameter keeps the topology continuous.
      const c=curves.map(curve=>curve.getPoint(f)); const y=c[0].x;
      for(let j=0;j<=sides;j++) {
        const gap=opening?opening(y):0;
        const a=opening ? -Math.PI/2+gap+j/sides*(Math.PI*2-2*gap) : start+j/sides*arc;
        let p=new V(c[2].y+c[0].y*Math.cos(a),y,c[3].y+c[1].y*Math.sin(a));
        if(deform) p=deform(p,a,(y-first)/(last-first));
        pos.push(p.x,p.y,p.z); uv.push(j/sides,(y-first)/(last-first));
      }
    }
    for(let i=0;i<rings;i++) for(let j=0;j<sides;j++) {
      const a=i*(sides+1)+j;
      if(omit && omit((pos[a*3+1]+pos[(a+sides+1)*3+1])/2,start+(j+.5)/sides*arc))continue;
      indices.push(a,a+sides+1,a+1,a+1,a+sides+1,a+sides+2);
    }
    const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(pos,3));
    g.setAttribute('uv',new T.Float32BufferAttribute(uv,2));g.setIndex(indices);g.computeVertexNormals();return g;
  }
  function sweep(points, radii, mat, parent, detail=.0) {
    const curve=new T.CatmullRomCurve3(points.map(p=>new V(...p)));
    const g=new T.TubeGeometry(curve,64,1,20,false), p=g.attributes.position;
    for(let i=0;i<=64;i++) {
      const u=i/64, k=u*(radii.length-1), q=Math.min(radii.length-2,Math.floor(k));
      const r=T.MathUtils.lerp(radii[q],radii[q+1],k-q), center=curve.getPointAt(u);
      for(let j=0;j<=20;j++) {
        const n=i*21+j, v=new V().fromBufferAttribute(p,n).sub(center);
        const fold=detail*Math.sin(u*55+j*.24)*Math.sin(u*Math.PI);
        v.multiplyScalar(r+fold).add(center);p.setXYZ(n,v.x,v.y,v.z);
      }
    }
    g.computeVertexNormals();return mesh(g,mat,parent);
  }
  function rounded(w,h,d,r=.015) {
    // Rounded cuboid, preserving bevels instead of hard box highlights.
    const g=new T.BoxGeometry(w,h,d,6,6,6), a=g.attributes.position, p=new V(), c=new V();
    for(let i=0;i<a.count;i++) {
      p.fromBufferAttribute(a,i);c.set(
        T.MathUtils.clamp(p.x,-w/2+r,w/2-r),T.MathUtils.clamp(p.y,-h/2+r,h/2-r),T.MathUtils.clamp(p.z,-d/2+r,d/2-r));
      p.sub(c).normalize().multiplyScalar(r).add(c);a.setXYZ(i,p.x,p.y,p.z);
    }
    g.computeVertexNormals();return g;
  }
  function textures(renderer) {
    const loader=new T.TextureLoader(), failed=[];
    const get=(id,kind,repeat=[1,1])=>{
      const tex=loader.load(`assets/textures/${id}-${kind}.jpg`,undefined,undefined,()=>{
        failed.push(id+' '+kind);document.getElementById('err').textContent='Не удалось загрузить текстуры. Открой игру через локальный сервер.';
        document.getElementById('err').style.display='block';
      });
      tex.wrapS=tex.wrapT=T.RepeatWrapping;tex.repeat.set(...repeat);
      tex.encoding=kind==='Color'?T.sRGBEncoding:T.LinearEncoding;
      tex.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());return tex;
    };
    const set=(id,repeat)=>({map:get(id,'Color',repeat),normalMap:get(id,'NormalGL',repeat),roughnessMap:get(id,'Roughness',repeat)});
    const floor=set('WoodFloor051',[1.25,1.65]);
    for(const tex of Object.values(floor)){tex.center.set(.5,.5);tex.rotation=Math.PI/2;}
    return {leather:set('Leather037',[2,2]),cloth:set('Fabric030',[2.8,2]),floor,wall:set('Plaster003',[2,1.5]),failed};
  }
  function materials(M,pbr) {
    const set=(name,settings)=>Object.assign(M[name],settings);
    // Source maps describe the weave/grain, but their pigment is not the
    // finish in the film: pale cotton and smooth painted walls, not dark
    // upholstery and raw stucco. Keep only subtle luminance variation.
    const paleFinish=(mat,contrast)=>{
      mat.onBeforeCompile=shader=>{
        shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>', `
          #ifdef USE_MAP
            vec4 texel=mapTexelToLinear(texture2D(map,vUv));
            float pigment=dot(texel.rgb,vec3(.2126,.7152,.0722));
            diffuseColor.rgb*=mix(1.0-${contrast},1.0,pigment);
            diffuseColor.a*=texel.a;
          #endif
        `);
      };
      mat.customProgramCacheKey=()=>`pale-finish-${contrast}`;
    };
    set('leather',{...pbr.leather,color:new T.Color(0x151c20).convertSRGBToLinear(),roughness:.48,metalness:0,normalScale:new T.Vector2(.16,.16),envMapIntensity:.50});
    set('bagLeather',{...pbr.leather,color:new T.Color(0x151c1f).convertSRGBToLinear(),roughness:.53,metalness:0,normalScale:new T.Vector2(.22,.22),envMapIntensity:.54,side:T.DoubleSide});
    set('cloth',{...pbr.cloth,color:new T.Color(0xd3deda).convertSRGBToLinear(),roughness:1,normalScale:new T.Vector2(.034,.034),side:T.DoubleSide,vertexColors:true,envMapIntensity:.3});
    paleFinish(M.cloth,.085);
    set('floor',{...pbr.floor,color:new T.Color(0x97948e).convertSRGBToLinear(),roughness:.96,normalScale:new T.Vector2(.04,.04),envMapIntensity:.18});
    M.floor.onBeforeCompile=shader=>{
      shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\nfloat floorGrey=dot(diffuseColor.rgb,vec3(.2126,.7152,.0722));\ndiffuseColor.rgb=mix(diffuseColor.rgb,vec3(floorGrey)*vec3(1.01,1.0,.98),.85);');
      shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=max(.84,roughnessFactor);');
    };
    set('wall',{...pbr.wall,color:new T.Color(0xd1d8d3).convertSRGBToLinear(),roughness:1,normalScale:new T.Vector2(.0015,.0015),vertexColors:true,envMapIntensity:.3});
    paleFinish(M.wall,.026);
    set('skin',{color:new T.Color(0xaf8a7a).convertSRGBToLinear(),roughness:.76,envMapIntensity:.25});
    set('nozzle',{color:new T.Color(0x353d3f).convertSRGBToLinear(),roughness:.72,metalness:0,envMapIntensity:.30});
    set('hair',{color:new T.Color(0x15120f).convertSRGBToLinear(),roughness:.66,envMapIntensity:.35});
    set('gold',{color:new T.Color(0xcaa45e),roughness:.26,envMapIntensity:1.25});
    set('silver',{color:new T.Color(0xb7bdbf),roughness:.25,envMapIntensity:1.15});
    set('magenta',{color:new T.Color(0x713649).convertSRGBToLinear(),roughness:.96});
    set('chairWood',{color:new T.Color(0x2f2926).convertSRGBToLinear(),roughness:.78,envMapIntensity:.25});
    set('bagInside',{...pbr.leather,color:new T.Color(0x25201c),roughness:.77,normalScale:new T.Vector2(.3,.3),side:T.BackSide});
  }
  function character(scene,M,H) {
    for(const k of ['leather','skin','hair','plastic','silver']) {H[k]=M[k].clone();H[k].transparent=true;}
    H.leather.side=T.DoubleSide;H.hair.side=T.DoubleSide;
    H.lips=H.skin.clone();H.lips.color.set(0x79534d);
    const root=new T.Group();root.name='hooded woman';
    const skin=H.skin, leather=H.leather;
    const legs=[];
    for(const side of [-1,1]) {
      const hip=new T.Group();hip.position.set(side*.091,.965,.012);root.add(hip);legs.push(hip);
      mesh(loft([
        [-.905,.033,.037,0,-.012],[-.84,.034,.038,0,0],[-.73,.044,.053,side*.004,.017],
        [-.62,.052,.057,side*.002,.02],[-.51,.047,.045,0,.002],[-.44,.048,.052,0,-.016],
        [-.37,.057,.058,side*.005,-.008],[-.24,.071,.078,side*.011,.0],[-.10,.081,.089,side*.005,0],[.04,.075,.08,0,0]
      ]),skin,hip);
      mesh(rounded(.081,.065,.19,.025),leather,hip,[0,-.938,-.043]);
      // Separate tailored shorts legs produce the visible crotch silhouette.
      mesh(loft([[-.10,.082,.09,0,0],[-.07,.086,.096,0,0],[.025,.087,.1,0,0]],{rings:22,deform:(p,a,u)=>{
        p.z+=.003*Math.sin(a*7+u*13);return p;}}),leather,hip);
      tube([[-.067,-.094,-.052],[0,-.097,-.091],[.067,-.094,-.052]],.0016,H.plastic,hip);
    }
    mesh(loft([[.955,.174,.101],[1.0,.156,.099],[1.04,.134,.089]],{rings:20}),leather,root);
    mesh(loft([[1.025,.136,.087],[1.085,.119,.077],[1.14,.126,.082]],{rings:20}),skin,root);
    mesh(loft([[1.005,.156,.10],[1.037,.144,.095]],{rings:10}),H.plastic,root);
    const buckle=new T.Group();root.add(buckle);buckle.position.set(0,1.021,-.104);
    tube([[-.023,-.016,0],[-.025,.017,0],[.023,.017,0],[.025,-.017,0],[-.023,-.016,0]],.003,H.silver,buckle,24);
    tube([[0,-.014,-.001],[0,.014,-.001]],.0018,H.silver,buckle,5);
    for(const x of [-.105,.10])box(.012,.047,.008,leather,root,[x,1.026,-.079]);
    mesh(loft([[1.255,.052,.078,0,-.011],[1.32,.074,.066,0,-.011],[1.40,.079,.054,0,-.008],[1.48,.041,.043,0,0]],{rings:24}),skin,root);
    const profile=[[1.095,.126,.086],[1.12,.13,.091],[1.18,.126,.087],[1.26,.137,.097],[1.34,.158,.113],[1.405,.177,.089],[1.443,.124,.065],[1.47,.073,.050]];
    mesh(loft(profile,{rings:76,sides:72,deform:(p,a,u)=>{
      const f=.0034*Math.sin(a*9+u*38)*gauss(u,.20,.23)+.0025*Math.sin(u*55+a*3)*gauss(u,.65,.20);
      p.x+=Math.cos(a)*f;p.z+=Math.sin(a)*f;return p;
    },opening:y=>Math.max(0,(y-1.27)*1.95)}),leather,root);
    // Zipper and seam piping follow the jacket instead of floating in front.
    tube([[0,1.096,-.09],[0,1.17,-.09],[0,1.24,-.1],[0,1.275,-.111]],.0024,H.silver,root);
    for(let y=1.103;y<1.273;y+=.007)box(.009,.002,.002,H.silver,root,[0,y,-.111+(1.275-y)*.12]);
    mesh(rounded(.008,.018,.004,.0015),H.silver,root,[0,1.26,-.112]);
    for(const s of [-1,1]) {
      tube([[s*.009,1.275,-.113],[s*.028,1.36,-.105],[s*.052,1.437,-.061]],.0035,leather,root);
      tube([[s*.06,1.102,-.081],[s*.087,1.205,-.073],[s*.099,1.30,-.093]],.0016,H.plastic,root);
      tube([[s*.070,1.14,-.079],[s*.11,1.178,-.057]],.002,H.silver,root);
    }
    // Sculpted head: jaw, chin, cheeks and nose are one continuous surface.
    const faceGeo=loft([[1.474,.018,.028,0,-.02],[1.49,.032,.042,0,-.02],[1.53,.053,.054,0,-.010],[1.576,.064,.057,0,0],[1.62,.061,.062,0,.01],[1.66,.055,.054,0,.011],[1.69,.02,.03,0,.01]],{
      rings:70,sides:80,deform:(p,a)=>{
        const front=gauss(a,Math.PI*1.5,.30);
        p.z-=front*(.022*gauss(p.y,1.563,.027)+.005*gauss(p.y,1.515,.008));
        p.z+=.004*front*gauss(p.y,1.607,.01);return p;
      }
    });
    const facePos=faceGeo.attributes.position,faceUv=faceGeo.attributes.uv;
    for(let i=0;i<facePos.count;i++)faceUv.setXY(i,.5+facePos.getX(i)/.14,(facePos.getY(i)-1.474)/.216);
    const faceMap=new T.TextureLoader().load('assets/face-albedo.jpg');faceMap.encoding=T.sRGBEncoding;
    H.face=skin.clone();H.face.map=faceMap;H.face.color.set(0xc7c5c0);H.face.roughness=.83;
    mesh(faceGeo,H.face,root);
    for(const s of [-1,1]) {
      // Layered locks; taper and broad cross-section avoid the old cylinder of hair.
      for(let k=0;k<8;k++) {
        const x=s*(.061+k*.004), z=-.035+(k%3)*.006;
        sweep([[x,1.64,z],[x+s*.012,1.51,z-.016],[x+s*.025,1.405,z-.068],[x+s*.006,1.29+k*.006,z-.071]], [.013,.015,.012,.002],H.hair,root,.0004);
      }
    }
    H.hood=leather.clone();H.hood.side=T.DoubleSide;
    mesh(loft([[1.415,.099,.081,0,.025],[1.49,.128,.113,0,.032],[1.60,.125,.139,0,.025],[1.69,.092,.12,0,.002],[1.77,.037,.062,0,.012],[1.80,.003,.004,0,.008]],{
      rings:68,sides:64,start:-.81,arc:Math.PI+1.62,deform:(p,a,u)=>{
        const f=.004*Math.sin(a*8+u*16)*Math.sin(u*Math.PI);p.x+=Math.cos(a)*f;p.z+=Math.sin(a)*f;return p;
      }
    }),H.hood,root);
    // Front brim bridges above the eyes; an open, deep hood, not a helmet.
    for(const side of [-1,1]) tube([[side*.068,1.415,-.034],[side*.088,1.49,-.05],[side*.086,1.60,-.076],[side*.065,1.69,-.085]],.003,leather,root,40);
    // Fabric across forehead and apex.
    mesh(loft([[1.616,.117,.148,0,.018],[1.69,.092,.12,0,.002],[1.77,.037,.062,0,.012],[1.80,.003,.004,0,.008]],{rings:36,start:Math.PI+.81,arc:Math.PI-1.62,deform:(p,a,u)=>{
      p.y+=(.013*Math.cos(a)-.026*Math.pow(Math.abs(Math.cos(a)),1.5))*Math.pow(1-u,3);return p;
    }}),H.hood,root);
    const handMesh=(parent,p,side)=>{
      const hand=new T.Group();hand.position.set(...p);parent.add(hand);
      mesh(loft([[-.025,.024,.014],[0,.03,.019],[.034,.023,.015]],{rings:16,sides:24}),skin,hand);
      hand.rotation.x=-.72;hand.rotation.z=side*.32;
      for(let f=0;f<4;f++) {
        const x=(f-1.5)*.013,l=.051-Math.abs(f-1.4)*.007;
        sweep([[x,-.018,0],[x,-.041,-.007],[x,-.025-l,-.022],[x,-.02-l,-.043]], [.008,.007,.006,.004],skin,hand);
      }
      sweep([[side*.024,.01,0],[side*.041,-.011,-.012],[side*.031,-.031,-.028]], [.010,.009,.006],skin,hand);
      return hand;
    };
    const arm=(side)=>{
      const shoulder=new T.Group();shoulder.position.set(side*.15,1.40,0);root.add(shoulder);
      const bag=side===1;
      const points=bag?[[-.04,.008,0],[.022,-.025,0],[.085,-.15,0],[.125,-.255,-.02],[.245,-.19,-.105]]:[[.04,.008,0],[-.022,-.025,0],[-.08,-.16,-.03],[-.12,-.28,-.1],[-.26,-.32,-.26]];
      sweep(points,[.049,.059,.047,.038,.029],leather,shoulder,.0008);
      const end=points.at(-1);
      const hand=handMesh(shoulder,[end[0]+side*.019,end[1]-.01,end[2]-.028],side);
      return {shoulder,hand};
    };
    const armR=arm(1),armL=arm(-1);scene.add(root);
    return {root,legs,armR,armL};
  }
  function bag(scene,M) {
    const group=new T.Group();group.name='soft leather shoulder bag';
    const g=loft([[-1,.58,.50],[-.85,.88,.80],[-.48,1,.98],[.12,.99,1],[.65,.88,.76],[1,.84,.42]],{rings:64,sides:88,deform:(p,a,u)=>{
      const sag=.56*(1-Math.abs(Math.cos(a)))*u*u;
      p.y-=sag;
      const fold=.035*Math.sin(a*5+u*7)*Math.sin(u*Math.PI)+.012*Math.sin(a*13-u*6);
      p.z+=Math.sin(a)*fold;p.x+=Math.cos(a)*fold*.3;return p;
    }});
    const body=mesh(g,M.bagLeather,group,[0,-.43,0]);body.scale.set(.29,.19,.13);
    const rim=[[-.246,-.245,0],[-.18,-.31,-.03],[0,-.36,-.048],[.18,-.31,-.03],[.246,-.245,0]];
    const zip=tube(rim,.003,M.silver,group,60);
    const handleMat=M.bagLeather;
    for(const z of [-.024,.024]) {
      // A flat strap has a leather face and thin edge, rather than a round handle.
      const path=new T.CatmullRomCurve3([new V(-.235,-.25,z),new V(-.15,-.15,z),new V(0,0,z),new V(.15,-.15,z),new V(.235,-.25,z)]);
      const pos=[],uv=[],idx=[];
      for(let i=0;i<=56;i++) {
        const p=path.getPoint(i/56),t=path.getTangent(i/56),side=new V(-t.y,t.x,0).normalize().multiplyScalar(.012);
        for(const s of [-1,1]) {const v=p.clone().addScaledVector(side,s);pos.push(v.x,v.y,v.z);uv.push((s+1)/2,i/56*3);}
        if(i<56){const a=i*2;idx.push(a,a+2,a+1,a+1,a+2,a+3);}
      }
      const geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(pos,3));geo.setAttribute('uv',new T.Float32BufferAttribute(uv,2));geo.setIndex(idx);geo.computeVertexNormals();mesh(geo,handleMat,group);
    }
    for(const x of [-.23,.23]) {
      const ring=mesh(new T.TorusGeometry(.016,.003,8,20),M.silver,group,[x,-.252,-.027]);ring.rotation.y=.2;
      tube([[x,-.27,-.03],[x*1.12,-.41,-.047],[x*.97,-.59,-.063]],.003,M.bagLeather,group,36);
    }
    // A small hard port makes the hose visibly enter the bag instead of
    // beginning at an invisible point somewhere below the character.
    const port=mesh(new T.CylinderGeometry(.026,.034,.08,16),M.nozzle,group,[-.43,-.56,.02]);
    port.rotation.z=Math.PI/2;
    const outlet=new T.Object3D();outlet.position.copy(port.position);group.add(outlet);
    scene.add(group);return {group,body,zip,port,outlet,baseScale:body.scale.clone()};
  }
  function table(scene,M,C,obstacles) {
    const group=new T.Group(), t=C.table;group.position.set(t.x,0,t.z);
    // A fabric skirt under the white cloth, with shallow vertical folds. The
    // old unbroken magenta cuboid looked like a plastic display plinth.
    const skirtGeo=new T.BoxGeometry(t.w-.035,t.h-.035,t.d-.035,64,30,48);
    const skirtPos=skirtGeo.attributes.position,skirtColors=[];
    for(let i=0;i<skirtPos.count;i++){
      let x=skirtPos.getX(i),y=skirtPos.getY(i),z=skirtPos.getZ(i);
      const fromTop=1-(y+(t.h-.035)/2)/(t.h-.035),sideX=Math.abs(x)>(t.w-.035)/2-.001,sideZ=Math.abs(z)>(t.d-.035)/2-.001;
      const across=sideX?z:x,fold=(Math.sin(across*48)+.35*Math.sin(across*79+.7))*.0055*(.45+.55*fromTop);
      if(sideX)x+=Math.sign(x)*fold;if(sideZ)z+=Math.sign(z)*fold;
      skirtPos.setXYZ(i,x,y,z);
      const shade=.93+.05*Math.sin(across*48+.5)-.08*fromTop;skirtColors.push(shade,shade,shade);
    }
    skirtGeo.setAttribute('color',new T.Float32BufferAttribute(skirtColors,3));skirtGeo.computeVertexNormals();
    const skirtMat=M.magenta.clone();skirtMat.vertexColors=true;skirtMat.roughness=1;skirtMat.envMapIntensity=.15;
    mesh(skirtGeo,skirtMat,group,[0,(t.h-.035)/2,0]);
    const drop=t.drop, w=t.w/2,d=t.d/2;
    const wrinkleHeight=(x,z)=>.0035*Math.sin(x*14+z*9)+.0018*Math.sin(z*29-x*8)
      +.007*gauss(x+.37*z,-.24,.035)-.0045*gauss(x+.37*z,-.19,.045)
      +.0055*gauss(z-.18*x,.22,.025);
    // One continuous cloth surface wraps around all four edges and corners.
    const geo=new T.PlaneGeometry(t.w+2*drop,t.d+2*drop,120,88);geo.rotateX(-Math.PI/2);
    const p=geo.attributes.position, shades=[];
    for(let i=0;i<p.count;i++) {
      let x=p.getX(i),z=p.getZ(i), ox=Math.max(0,Math.abs(x)-w),oz=Math.max(0,Math.abs(z)-d);
      const excess=Math.hypot(ox,oz),edge=excess/drop;
      let y=t.h+.005-excess*.97;
      const wave=wrinkleHeight(x,z);
      y+=wave*(excess? .3:1);
      if(ox) x=Math.sign(x)*(w+.006+(Math.sin(z*27)+.36*Math.sin(z*49+1.2))*.009*edge);
      if(oz) z=Math.sign(z)*(d+.006+(Math.sin(x*24+.8)+.28*Math.sin(x*43))*.01*edge);
      p.setXYZ(i,x,y,z);
      // Very soft crease occlusion gives cotton folds depth without adding
      // dirt or a high-contrast printed pattern to the reference's plain cloth.
      const crease=.075*gauss(x+.37*z,-.19,.036)+.045*gauss(z-.18*x,.26,.035);
      const shade=.98-.10*Math.min(1,edge)-crease-.035*(x+w)/(2*w);
      shades.push(shade*.983,shade*.995,shade);
    }
    geo.setAttribute('color',new T.Float32BufferAttribute(shades,3));
    geo.computeVertexNormals();mesh(geo,M.cloth,group);
    // Keep the cursor ray smooth, but share the visible cloth height with item
    // physics: thin keys and chains must rest above its folds, not under them.
    const hit=mesh(new T.PlaneGeometry(t.w,t.d),new T.MeshBasicMaterial({visible:false}),group,[0,t.h+.009,0]);hit.rotation.x=-Math.PI/2;
    hit.name='table-interaction-surface';
    hit.userData.surfaceHeightAt=(worldX,worldZ)=>t.h+.005+wrinkleHeight(worldX-t.x,worldZ-t.z);
    scene.add(group);obstacles.push({minX:t.x-w-.02,maxX:t.x+w+.02,minZ:t.z-d-.02,maxZ:t.z+d+.02});return hit;
  }
  function room(scene,M,C) {
    const {halfW:w,halfD:d,height:h}=C.room;
    const floor=mesh(new T.PlaneGeometry(w*2,d*2),M.floor,scene);floor.rotation.x=-Math.PI/2;floor.castShadow=false;
    const wall=(width,height,p,ry=0)=>{
      const geo=new T.PlaneGeometry(width,height,Math.max(2,Math.ceil(width*14)),Math.max(2,Math.ceil(height*14))),positions=geo.attributes.position,colors=[];
      for(let i=0;i<positions.count;i++){
        const localX=positions.getX(i),worldX=p[0]+Math.cos(ry)*localX,worldY=p[1]+positions.getY(i),worldZ=p[2]-Math.sin(ry)*localX;
        const corner=Math.abs(Math.sin(ry))>.5?d-Math.abs(worldZ):w-Math.abs(worldX);
        const contact=.13*Math.exp(-Math.max(0,corner)/.20)+.065*Math.exp(-worldY/.11)+.095*Math.exp(-(h-worldY)/.21);
        const daylight=.025*(1-(worldX+w)/(2*w));
        const shade=.96-contact+daylight;colors.push(shade,shade,shade);
      }
      geo.setAttribute('color',new T.Float32BufferAttribute(colors,3));
      const m=mesh(geo,M.wall,scene,p);m.rotation.y=ry;m.castShadow=false;return m;
    };
    wall(w*2,h,[0,h/2,d],Math.PI);wall(w*2,h,[0,h/2,-d]);wall(d*2,h,[w,h/2,0],-Math.PI/2);
    const ceilingMat=new T.MeshStandardMaterial({color:0xd7dbd6,roughness:1,envMapIntensity:.2});
    const ceiling=mesh(new T.PlaneGeometry(w*2,d*2),ceilingMat,scene,[0,h,0]);ceiling.rotation.x=Math.PI/2;ceiling.castShadow=false;
    // Balcony opening on the left wall in world space, on the right in the reference camera.
    const z0=-1.75,z1=.80,y0=.12,y1=2.54,mid=(z0+z1)/2;
    wall(z0+d,h,[-w,h/2,(-d+z0)/2],Math.PI/2);
    wall(d-z1,h,[-w,h/2,(d+z1)/2],Math.PI/2);
    wall(z1-z0,y0,[-w,y0/2,mid],Math.PI/2);
    wall(z1-z0,h-y1,[-w,(y1+h)/2,mid],Math.PI/2);
    const frameMat=new T.MeshStandardMaterial({color:0xdeddd3,roughness:.76});
    const sealMat=new T.MeshStandardMaterial({color:0x696b62,roughness:.9});
    for(const z of [z0,z1])box(.15,y1-y0,.046,frameMat,scene,[-w,(y0+y1)/2,z]);
    for(const y of [y0,y1])box(.15,.045,z1-z0,frameMat,scene,[-w,y,mid]);
    for(const z of [z0+.03,z1-.03])box(.016,y1-y0-.04,.011,sealMat,scene,[-w+.079,(y0+y1)/2,z]);
    for(const y of [y0+.025,y1-.025])box(.016,.009,z1-z0-.06,sealMat,scene,[-w+.079,y,mid]);
    box(.19,.024,z1-z0+.06,frameMat,scene,[-w+.025,y0,mid]);
    // Reference-matched photographic plate is used only for the distant outdoor view.
    const tex=new T.TextureLoader().load('assets/balcony-v2.jpg');tex.encoding=T.sRGBEncoding;
    const outside=mesh(new T.PlaneGeometry(4.4,3.3),new T.MeshBasicMaterial({map:tex}),scene,[-w-1.0,1.55,mid]);outside.rotation.y=Math.PI/2;outside.castShadow=false;
    const rail=new T.MeshStandardMaterial({color:0x404238,roughness:.84});
    box(.038,.042,3.2,rail,scene,[-w-.65,1.02,mid]);
    for(let z=z0-.25;z<z1+.3;z+=.15)box(.022,.94,.018,rail,scene,[-w-.65,.54,z]);
    const soffit=new T.MeshStandardMaterial({color:0xd4cebb,roughness:.95});
    for(let z=z0-.4;z<z1+.4;z+=.13)box(1.2,.024,.127,soffit,scene,[-w-.6,2.5,z]);
    const balconyFloor=new T.MeshStandardMaterial({color:0x9d9e8d,roughness:1});
    box(.9,.04,3.25,balconyFloor,scene,[-w-.45,.055,mid]);
    // Skirting board and curtain pole are present in the reference.
    box(w*2,.065,.025,frameMat,scene,[0,.033,d-.01]);
    box(w*2,.065,.025,frameMat,scene,[0,.033,-d+.01]);
    box(.025,.065,d*2,frameMat,scene,[w-.01,.033,0]);
    box(.025,.065,z0+d,frameMat,scene,[-w+.01,.033,(-d+z0)/2]);
    box(.025,.065,d-z1,frameMat,scene,[-w+.01,.033,(d+z1)/2]);
    const pole=mesh(new T.CylinderGeometry(.013,.013,2.9,16),M.chairWood,scene,[-w+.08,2.69,mid]);pole.rotation.x=Math.PI/2;
  }
  function lights(scene) {
    // The film is lit by an overcast balcony, without a hard sun beam. Most
    // energy comes from broad sky/bounce; a weaker key retains contact shadows.
    scene.add(new T.HemisphereLight(0xdce8e9,0x747770,.62));
    const key=new T.DirectionalLight(0xdce9eb,.32);key.position.set(-4,3.8,-.5);key.target.position.set(.3,.8,0);
    key.castShadow=true;key.shadow.mapSize.set(2048,2048);Object.assign(key.shadow.camera,{left:-3,right:3,top:3,bottom:-3,near:.2,far:12});
    key.shadow.bias=-.00012;key.shadow.normalBias=.008;key.shadow.radius=4;scene.add(key,key.target);
    const bounce=new T.DirectionalLight(0xdde2dc,.18);bounce.position.set(1.5,2.2,-3);scene.add(bounce);
    const skyFill=new T.DirectionalLight(0xdcecef,.40);skyFill.position.set(-2,1.8,1.7);scene.add(skyFill);
  }
  return {mesh,tube,loft,sweep,rounded,textures,materials,character,bag,table,room,lights};
})();
