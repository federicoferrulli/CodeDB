'use strict';
const { chromium } = require('playwright');
const { startTestServer } = require('../../test/e2e-harness');
const VISTE = ['view-data','view-details','view-uml','view-graph3d','view-query'];

(async () => {
  const server = await startTestServer({ port: 3475 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#grid', { state:'attached', timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { renderGrid } = await import('/js/grid.js');
    document.getElementById('onboarding-overlay')?.remove();
    document.getElementById('welcome').classList.add('hidden');
    document.getElementById('tab-body').classList.remove('hidden');
    document.getElementById('workspace').classList.remove('hidden');
    document.getElementById('placeholder').classList.add('hidden');
    document.getElementById('coll-tab-bar').classList.remove('hidden');
    state.docs=Array.from({length:40},(_,i)=>({_id:i+1,nome:'x'+i,q:i,ok:i%2===0,d:{$date:new Date().toISOString()}}));
    state.columns=['_id','nome','q','ok','d']; state.total=40; renderGrid();
  });

  const out = {};
  for (const tema of ['dark','light']) {
    await page.evaluate((t)=>document.documentElement.setAttribute('data-theme',t), tema);
    const trovati = [];
    for (const v of VISTE) {
      await page.evaluate((vista) => {
        for (const p of document.querySelectorAll('#workspace .view-panel')) p.classList.add('hidden');
        document.getElementById(vista).classList.remove('hidden');
      }, v);
      await page.waitForTimeout(300);
      trovati.push(...await page.evaluate((vista) => {
        const lum = (r,g,b) => { const c=[r,g,b].map(x=>{x/=255;return x<=0.03928?x/12.92:((x+0.055)/1.055)**2.4;});
          return .2126*c[0]+.7152*c[1]+.0722*c[2]; };
        const parse = (s) => { const m=s.match(/rgba?\(([^)]+)\)/); if(!m) return null;
          const p=m[1].split(/[,\s\/]+/).map(Number); return {r:p[0],g:p[1],b:p[2],a:p[3]===undefined?1:p[3]}; };
        // fondo EFFETTIVO: risale finche' trova un colore opaco
        const fondo = (el) => { let n=el;
          while(n && n.nodeType===1){ const c=parse(getComputedStyle(n).backgroundColor);
            if(c && c.a>=0.95) return c; n=n.parentElement; }
          return {r:13,g:17,b:23,a:1}; };
        const res=[];
        const visibile=(el)=>{const r=el.getBoundingClientRect(); const cs=getComputedStyle(el);
          return r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.opacity!=='0';};
        for (const el of document.querySelectorAll('#workspace *, header *, #conn-sidebar *, #sidebar *')) {
          if (!visibile(el)) continue;
          // solo elementi con testo PROPRIO
          const testo = [...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join('');
          if (!testo) continue;
          const cs=getComputedStyle(el);
          const fg=parse(cs.color); if(!fg) continue;
          const bg=fondo(el);
          // testo su fondo semitrasparente: si compone
          const a=fg.a===undefined?1:fg.a;
          const mix={r:fg.r*a+bg.r*(1-a),g:fg.g*a+bg.g*(1-a),b:fg.b*a+bg.b*(1-a)};
          const L1=lum(mix.r,mix.g,mix.b), L2=lum(bg.r,bg.g,bg.b);
          const ratio=(Math.max(L1,L2)+.05)/(Math.min(L1,L2)+.05);
          const px=parseFloat(cs.fontSize), grassetto=parseInt(cs.fontWeight,10)>=700;
          const soglia=(px>=24||(px>=18.66&&grassetto))?3:4.5;
          if (ratio<soglia) res.push({vista, sel:(el.id?'#'+el.id:el.tagName.toLowerCase()+'.'+String(el.className).split(' ').filter(Boolean).slice(0,2).join('.')),
            testo:testo.slice(0,28), ratio:+ratio.toFixed(2), soglia, px:+px.toFixed(1), colore:cs.color});
        }
        return res;
      }, v));
    }
    // dedup per selettore+testo
    const visti=new Set(); out[tema]=[];
    for (const r of trovati){ const k=r.sel+'|'+r.testo; if(visti.has(k))continue; visti.add(k); out[tema].push(r); }
    out[tema].sort((a,b)=>a.ratio-b.ratio);
  }
  console.log(JSON.stringify(out,null,1));
  await browser.close(); await server.stop();
})();
