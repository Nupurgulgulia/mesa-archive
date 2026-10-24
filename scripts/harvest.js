const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const anchor=[...document.querySelectorAll('button')].find(x=>/^(Overview|Resources|Outlines|Class Recordings)$/.test(x.innerText.trim()));
const strip=anchor.parentElement;
const names=[...strip.children].filter(e=>e.tagName==='BUTTON').map(e=>e.innerText.trim()).filter(Boolean);
const getTab=n=>[...strip.children].find(e=>e.tagName==='BUTTON'&&e.innerText.trim()===n);
const body=()=>{const L=document.querySelector('main').innerText.split('\n').map(s=>s.trim()).filter(Boolean);let last=-1;L.slice(0,60).forEach((l,i)=>{if(names.includes(l))last=i});return L.slice(last+1)};
const mainLinks=()=>[...document.querySelector('main').querySelectorAll('a[href]')].map(a=>({t:a.innerText.trim().slice(0,100),h:a.href})).filter(l=>!/\/student\/lms(\/notifications)?$/.test(l.h));
const out={title:document.querySelector('h1,h2')?.innerText,tabs:{}};
for(const n of names){
 const b=getTab(n); if(!b)continue; b.click(); await sleep(1100);
 const m=document.querySelector('main'); const o={lines:body().slice(0,150)};
 const links=mainLinks(); if(links.length)o.links=links.slice(0,60);
 if(/Recordings/.test(n)){o.recs=[...m.querySelectorAll('img[src*="img.youtube.com/vi/"]')].map(im=>{const id=im.src.match(/vi\/([\w-]{11})/)[1];let c=im;for(let i=0;i<6&&c;i++){if(/\d{1,2} \w{3} 20\d\d/.test(c.innerText||'')&&c.innerText.length<300)break;c=c.parentElement}return {id,url:'https://www.youtube.com/watch?v='+id,card:(c?.innerText||'').replace(/\n+/g,' | ')}})}
 const nf=m.querySelectorAll('[class*="group/folder"]').length;
 if(nf){o.folders=[];
  for(let i=0;i<nf;i++){
   const f=document.querySelector('main').querySelectorAll('[class*="group/folder"]')[i]; if(!f)break;
   const name=f.innerText.split('\n').filter(Boolean).slice(0,2).join(' | ');
   const leaf=[...f.querySelectorAll('*')].find(e=>e.children.length===0&&(e.textContent||'').trim()); (leaf||f).click(); await sleep(1200);
   o.folders.push({name,items:body().slice(0,80),links:mainLinks().slice(0,40)});
   const back=[...document.querySelectorAll('main button')].find(x=>/^Back$/.test(x.innerText.trim())); if(back){back.click();await sleep(900)}
  }}
 out.tabs[n]=o;
}
localStorage.setItem('mesa_'+location.pathname.split('/').pop(),JSON.stringify(out));JSON.stringify({id:location.pathname.split('/').pop(),title:out.title,tabs:Object.keys(out.tabs).length,bytes:JSON.stringify(out).length,recs:Object.values(out.tabs).reduce((a,t)=>a+(t.recs?.length||0),0),folders:Object.values(out.tabs).reduce((a,t)=>a+(t.folders?.length||0),0)})
