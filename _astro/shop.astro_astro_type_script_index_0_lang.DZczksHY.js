import{$ as g,q as b,B as m,r as f,e as r,a as s,b as y,w as v,d as w,c as z}from"./ui.DXX6Q7eP.js";import{t as e}from"./i18n.CfZEKsm2.js";const l=g("#app"),h=b("s")||decodeURIComponent(location.pathname.replace(m,"").replace(/^shop\/?/,"").replace(/\/$/,""));let o=null,i="";const p=t=>t.variants.filter(n=>n.qty>0).map(n=>n.size);function $(){if(!o)return;const t=o.shop,n=v(t.whatsapp||t.phone),c=w(o.products.flatMap(p)),d=o.products.filter(a=>i?p(a).includes(i):!0);document.title=`${t.name} — TAILA`,l.innerHTML=`
    <div class="shophead">
      <h1>${s(t.name)} ${t.is_demo?`<span class="badge">${s(e("demo"))}</span>`:""}</h1>
      <div class="meta">
        <span>${s([e(`kind.${t.kind}`),t.district].filter(Boolean).join(", "))}</span>
        ${t.address?`<span>${s(t.address)}</span>`:""}
        ${t.working_hours?`<span>${s(t.working_hours)}</span>`:""}
      </div>
      ${t.description?`<p style="margin-top:10px;max-width:60ch">${s(t.description)}</p>`:""}
      <div class="actions">
        ${n?`<a class="btn small" href="https://wa.me/${n}" target="_blank" rel="noopener">${s(e("shop.wa"))}</a>`:""}
        ${t.phone?`<a class="btn small ghost" href="tel:${s(t.phone)}">${s(e("shop.call"))}</a>`:""}
        ${t.instagram?`<a class="btn small ghost" href="https://instagram.com/${encodeURIComponent(t.instagram)}" target="_blank" rel="noopener">Instagram</a>`:""}
      </div>
    </div>
    ${c.length>1?`<div class="scroller" style="padding-top:12px">
      <button type="button" class="chip" data-size="" aria-pressed="${i===""}">${s(e("shop.allsizes"))}</button>
      ${c.map(a=>`<button type="button" class="tag" data-size="${s(a)}" aria-pressed="${a===i}">${s(a)}</button>`).join("")}
    </div>`:""}
    ${o.products.length===0?r(e("shop.empty"),""):""}
    ${o.products.length>0&&d.length===0?r(e("home.empty.h"),""):""}
    <div class="grid">${d.map(a=>z({id:a.id,title:a.title,price:a.price,old_price:a.old_price,photo:a.photos[0],sizes:p(a)})).join("")}</div>`}l.addEventListener("click",t=>{const n=t.target.closest("[data-size]");if(n){i=n.dataset.size||"",$();return}t.target.closest("#retry")&&u()});async function u(){try{if(o=h?await f("get_shop_page",{p_slug:h}):null,!o){l.innerHTML=r(e("shop.notfound.h"),e("shop.notfound.p"),`<a class="btn small" href="${m}">${s(e("home.link"))}</a>`);return}$()}catch(t){l.innerHTML=r(y(t),"",`<button class="btn small" id="retry" type="button">${s(e("retry"))}</button>`)}}u();
