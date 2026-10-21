// App-only GPU compositor. Scientific waveform geometry remains the measured,
// immutable raster; only the temporal reveal and entry diffusion run on GPU.
import { WebGPURenderer, Scene, OrthographicCamera, Mesh, PlaneGeometry, MeshBasicNodeMaterial, CanvasTexture, Vector2, SRGBColorSpace, NoToneMapping } from 'three/webgpu';
import { Fn, uv, uniform, vec2, vec3, vec4, float, floor, fract, sin, dot, mix, max, abs, clamp, texture, step } from 'three/tsl';
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
  const size=uniform(new Vector2(1,1)), origin=uniform(new Vector2()), travel=uniform(0), settling=uniform(0), opacity=uniform(1);
  const entryMaterial=new MeshBasicNodeMaterial({transparent:true,depthTest:false,depthWrite:false});
  entryMaterial.fragmentNode=Fn(()=>{
    const p=vec2(uv().x,float(1).sub(uv().y)).mul(size), x=p.x.div(size.x);
    // Stationary paper fields are shared by all three passes: pigment never
    // boils or swims, and the fragment cost does not grow with the brush path.
    const cloud=noise(p.div(91)), bloom=noise(p.div(27)), grain=noise(p.div(5)), tooth=hash(floor(p));
    const cobalt=vec3(.13,.27,.78), iris=vec3(.44,.28,.66), teal=vec3(.07,.49,.51);
    const colorPhase=x.mul(4.3).add(p.y.div(size.y).mul(2.7)).add(cloud.mul(.6));
    const pigment=mix(mix(cobalt,iris,sin(colorPhase).mul(.5).add(.5)),teal,sin(colorPhase.add(2.2)).mul(.5).add(.5).mul(.62));
    const ink=vec3(0).toVar(), coverage=float(0).toVar(), painted=float(0).toVar();
    // Three overlapping, curved passes reverse direction as a loaded brush
    // travels up the paper. Width changes represent pressure, not radial scale.
    for(let i=0;i<3;i++) {
      const along=i%2 ? float(1).sub(x) : x;
      const local=clamp(travel.sub(i*.22).div(.52),0,1);
      const bend=sin(x.mul(5.6).add(i*1.7)).mul(.035).sub(x.mul(.045));
      const center=i===0 ? origin.y.div(size.y).add(bend) : float(.92-i*.39).add(bend);
      const pressure=sin(x.mul(4.8).add(i*.8)).mul(.035).add(.183);
      const across=p.y.div(size.y).sub(center);
      const edgeNoise=cloud.sub(.5).mul(.023).add(bloom.sub(.5).mul(.012)).add(grain.sub(.5).mul(.006));
      const edge=pressure.sub(abs(across)).add(edgeNoise);
      const widthMask=clamp(edge.mul(size.y).div(float(7).add(settling.mul(9))),0,1);
      const tipPressure=max(float(1).sub(across.div(pressure).mul(across.div(pressure))),0);
      const bristleTip=sin(across.mul(size.y).mul(.16).add(cloud.mul(4))).mul(.007);
      const head=local.mul(1.34).sub(.20).sub(along).add(tipPressure.mul(.09)).add(bristleTip).add(edgeNoise.mul(1.4));
      const headMask=clamp(head.mul(size.x).div(17),0,1).mul(step(.001,local));
      const wet=widthMask.mul(headMask);
      painted.assign(max(painted,wet));
      const pooled=max(float(1).sub(abs(edge.mul(size.y).sub(8)).div(14)),0).mul(.17)
        .add(max(float(1).sub(abs(head.mul(size.x).sub(11)).div(21)),0).mul(.11));
      // Pigment collects in irregular paper pockets. No periodic rib pattern:
      // evenly spaced ridges read as fabric rather than a natural brush.
      const pigmentCloud=cloud.mul(.60).add(bloom.mul(.32)).add(grain.mul(.08));
      const trailingWash=max(float(1).sub(max(head,0).mul(1.25)),.28);
      const paperBreaks=float(1).sub(max(tooth.sub(.81),0).mul(.65));
      const alpha=wet.mul(float(.27).add(pigmentCloud.mul(.25)).add(pooled)).mul(paperBreaks).mul(trailingWash).mul(opacity);
      const color=pigment.mul(float(1).sub(pooled.mul(1.9))).add(grain.sub(.5).mul(.07));
      ink.assign(color.mul(alpha).add(ink.mul(float(1).sub(alpha))));
      coverage.assign(alpha.add(coverage.mul(float(1).sub(alpha))));
    }
    // The incoming UI is already live underneath. Unpainted paper shields it
    // until the gesture passes, avoiding an outgoing/incoming screen flash.
    const paperAlpha=float(1).sub(painted).mul(opacity).mul(float(1).sub(coverage));
    const combined=coverage.add(paperAlpha);
    return vec4(ink.add(vec3(.992,.984,.969).mul(paperAlpha)).div(max(combined,.001)),combined);
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
    beginEntry(w,h,x,y){if(!entry.alive)return false;entry.resize(w,h);size.value.set(w,h);origin.value.set(x,y);travel.value=0;settling.value=0;opacity.value=0;entry.canvas.hidden=false;return true;},
    entry(progress,dry,alpha){travel.value=progress;settling.value=dry;opacity.value=alpha;return entry.draw();},
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
