// App-only GPU compositor. Scientific waveform geometry remains the measured,
// immutable raster; only the temporal reveal and entry diffusion run on GPU.
import { WebGPURenderer, Scene, OrthographicCamera, Mesh, PlaneGeometry, MeshBasicNodeMaterial, CanvasTexture, Vector2, SRGBColorSpace, NoToneMapping } from 'three/webgpu';
import { Fn, uv, uniform, vec2, vec3, vec4, float, floor, fract, sin, dot, mix, max, abs, length, clamp, texture, step } from 'three/tsl';
const diagnostics = window.__paintGpuStats = window.__pulsePaintGPU = { ready: false, backend: 'loading', frames: 0, frameMs: 0, maxFrameMs: 0, pixelBudget: 850000, surfaces: {} };
const hash = Fn(([p]) => fract(sin(dot(p, vec2(127.1,311.7)).add(19.3)).mul(43758.5453)));
const noise = Fn(([p]) => {
  const i = floor(p), f = fract(p), s = f.mul(f).mul(float(3).sub(f.mul(2)));
  return mix(mix(hash(i),hash(i.add(vec2(1,0))),s.x),mix(hash(i.add(vec2(0,1))),hash(i.add(vec2(1,1))),s.x),s.y);
});
async function surface(name, material) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden','true'); canvas.hidden = true;
  const renderer = new WebGPURenderer({ canvas, alpha:true, antialias:false, forceWebGL:new URLSearchParams(location.search).get('paintBackend') === 'webgl2' });
  renderer.outputColorSpace = SRGBColorSpace; renderer.toneMapping = NoToneMapping;
  const scene = new Scene(), camera = new OrthographicCamera(-1,1,1,-1,0,1);
  const geometry = new PlaneGeometry(2,2); scene.add(new Mesh(geometry,material));
  let alive = true, width=1, height=1, scale=1, last=0, slow=0;
  const info = diagnostics.surfaces[name] = { backend:'loading',frames:0,frameMs:0,pixels:1 };
  const fail = () => { alive=false; canvas.hidden=true; info.backend='unavailable'; diagnostics.ready=false; diagnostics.backend='unavailable'; if(name==='manuscript') { document.getElementById('manuscript').style.visibility=''; window.dispatchEvent(new Event('paintgpulost')); } };
  canvas.addEventListener('webglcontextlost', fail);
  renderer.onDeviceLost = fail;
  try {
    await renderer.init();
    info.backend = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2'; diagnostics.backend=info.backend;
    renderer.setSize(2,2,false); await renderer.compileAsync(scene,camera); renderer.render(scene,camera);
  } catch(error) {
    fail(); geometry.dispose();material.dispose();void renderer.dispose().catch(()=>{});throw error;
  }
  const resize = (w,h) => {
    width=w; height=h;
    const dpr=Math.min(devicePixelRatio||1,2,Math.sqrt(diagnostics.pixelBudget/(w*h)))*scale;
    renderer.setSize(Math.max(1,Math.round(w*dpr)),Math.max(1,Math.round(h*dpr)),false);
    info.pixels=canvas.width*canvas.height;info.width=canvas.width;info.height=canvas.height;info.dpr=dpr;
  };
  return { canvas, get alive(){return alive;}, resize,
    draw() {
      if(!alive)return false;
      try {
        const now=performance.now(), dt=last ? now-last : 0; last=now;
        if(dt>23 && dt<100)slow++; else slow=Math.max(0,slow-1);
        if(slow>24 && scale>.55){scale*=.85;resize(width,height);slow=0;}
        const began=performance.now(); renderer.render(scene,camera);
        info.frameMs=performance.now()-began; info.frames++;
        diagnostics.frameMs=info.frameMs;diagnostics.frames++;diagnostics.maxFrameMs=Math.max(diagnostics.maxFrameMs,info.frameMs);
        return true;
      }catch{fail();return false;}
    },
    dispose(){alive=false;canvas.remove();geometry.dispose();material.dispose();void renderer.dispose().catch(()=>{});}
  };
}
export async function createPaintGPU() {
  const size=uniform(new Vector2(1,1)), origin=uniform(new Vector2()), half=uniform(0), reach=uniform(0), feather=uniform(16), opacity=uniform(1);
  const entryMaterial=new MeshBasicNodeMaterial({transparent:true,depthTest:false,depthWrite:false});
  entryMaterial.fragmentNode=Fn(()=>{
    const p=vec2(uv().x,float(1).sub(uv().y)).mul(size);
    const cloud=noise(p.div(96)), bloom=noise(p.div(29)), grain=noise(p.div(5)), tooth=hash(floor(p));
    const delta=vec2(max(abs(p.x.sub(origin.x)).sub(half),0),p.y.sub(origin.y));
    const travel=length(delta).mul(float(1).add(cloud.sub(.5).mul(.19)).add(bloom.sub(.5).mul(.075))).add(grain.sub(.5).mul(13)).add(tooth.sub(.5).mul(3));
    const wet=clamp(reach.sub(travel).div(feather),0,1);
    const depth=cloud.mul(.52).add(bloom.mul(.32)).add(grain.mul(.12)).add(tooth.mul(.04));
    // Nested low-opacity deposits pool at the same irregular wet front.
    // Reusing the absorption field avoids extra noise/texture samples per pixel.
    const rimDistance=abs(wet.sub(.68).add(grain.sub(.5).mul(.07)));
    const broad=max(float(1).sub(rimDistance.mul(3.5)),0);
    const middle=max(float(1).sub(rimDistance.mul(7)),0);
    const fine=max(float(1).sub(rimDistance.mul(18)),0);
    const deposit=float(1).sub(float(1).sub(broad.mul(.12)).mul(float(1).sub(middle.mul(.16))).mul(float(1).sub(fine.mul(.21))));
    const edge=deposit.mul(2.3), pool=max(depth.sub(.46),0).mul(70);
    const rgb=vec3(float(31).add(depth.mul(54)).sub(edge.mul(17)),float(82).add(depth.mul(84)).sub(edge.mul(25)).sub(pool),float(216).add(depth.mul(37)).sub(edge.mul(14)).sub(pool.mul(.4))).div(255);
    const body=wet.mul(wet).mul(float(3).sub(wet.mul(2))).mul(float(.72).add(depth.mul(.16)));
    const alpha=float(1).sub(float(1).sub(body).mul(float(1).sub(deposit)));
    return vec4(rgb,alpha.mul(opacity));
  })();
  const entry=await surface('entry',entryMaterial);
  Object.assign(entry.canvas.style,{position:'fixed',inset:'0',width:'100%',height:'100%',pointerEvents:'none',zIndex:'1000'});document.body.append(entry.canvas);
  const blank=document.createElement('canvas');blank.width=blank.height=1;
  // Allocate a valid backing bitmap before GPU warmup uploads this texture.
  blank.getContext('2d').clearRect(0,0,1,1);
  let base=new CanvasTexture(blank), ink=new CanvasTexture(blank), cached=null;
  base.colorSpace=ink.colorSpace=SRGBColorSpace;
  const row=uniform(-1), boundary=uniform(0), scrollRows=uniform(0), textureRows=uniform(4);
  const y=float(1).sub(uv().y).mul(4).add(scrollRows);
  const paperUV=vec2(uv().x,float(1).sub(y.div(textureRows)));
  const baseNode=texture(base,paperUV),inkNode=texture(ink,paperUV);
  const liveMaterial=new MeshBasicNodeMaterial({transparent:true,depthTest:false,depthWrite:false});
  const mask=float(1).sub(step(row.add(1),y)).mul(max(float(1).sub(step(row,y)),float(1).sub(step(boundary,uv().x))));
  liveMaterial.fragmentNode=mix(baseNode,inkNode,mask);
  let live;
  try{live=await surface('manuscript',liveMaterial);}catch(error){entry.dispose();base.dispose();ink.dispose();throw error;}
  Object.assign(live.canvas.style,{position:'absolute',inset:'0',width:'100%',height:'100%',pointerEvents:'none'});
  const source=document.getElementById('manuscript');source.parentElement.append(live.canvas);
  const resizeLive=()=>{ const rect=source.getBoundingClientRect(); if(rect.width && rect.height) { live.resize(rect.width,rect.height); if(cached && !live.canvas.hidden) live.draw(); } };
  const observer=new ResizeObserver(resizeLive);observer.observe(source);resizeLive();
  diagnostics.ready=true;
  return {
    beginEntry(w,h,x,y,halfWidth){if(!entry.alive)return false;entry.resize(w,h);size.value.set(w,h);origin.value.set(x,y);half.value=halfWidth;entry.canvas.hidden=false;return true;},
    entry(reachValue,featherValue,alpha){reach.value=reachValue;feather.value=featherValue;opacity.value=alpha;return entry.draw();},
    endEntry(){entry.canvas.hidden=true;},
    manuscript(raster,rowValue,x,offsetRows=0){
      if(!live.alive){source.style.visibility='';return false;}
      if(cached!==raster){cached=raster;base.dispose();ink.dispose();base=new CanvasTexture(raster.base);ink=new CanvasTexture(raster.ink);base.colorSpace=ink.colorSpace=SRGBColorSpace;baseNode.value=base;inkNode.value=ink;}
      row.value=rowValue;boundary.value=x;scrollRows.value=offsetRows;textureRows.value=raster.rows||4;
      const ok=live.draw();live.canvas.hidden=!ok;source.style.visibility=ok?'hidden':'';return ok;
    },
    clear(){live.canvas.hidden=true;source.style.visibility='';cached=null;},
    dispose(){diagnostics.ready=false;observer.disconnect();entry.dispose();live.dispose();base.dispose();ink.dispose();source.style.visibility='';}
  };
}
