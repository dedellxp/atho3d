"use strict";

// Cole a URL exata do Realtime Database aqui OU em Configurar conexão no login.
const firebaseConfig = {
  apiKey: "AIzaSyAUSH3d_wDx2ampbpaDz7K_mZ_avMUKqMU",
  authDomain: "atho3d.firebaseapp.com",
  databaseURL: "",
  projectId: "atho3d",
  storageBucket: "atho3d.firebasestorage.app",
  messagingSenderId: "814861196913",
  appId: "1:814861196913:web:80ba1faa5205a7936f45d0",
  measurementId: "G-C2FLG8L8QP"
};
const USERS = {
  Janaina: "janaina@hotmail.com",
  Nathalia: "nathalialfernandess@gmail.com",
  Gustavo: "gustavo@hotmail.com",
  Admin: "wendel_hai@hotmail.com"
};
const PAYMENT = { pago:"Pago", parcial:"Parcialmente pago", nao_pago:"Não pago" };
const PAYMENT_MODES = { total:"Total", parcelado:"Parcelado" };
const STATUS = { entregue:"Entregue", finalizado:"Finalizado", em_andamento:"Em andamento", na_fila:"Na fila" };
const EXPENSE_TYPES = { unico:"Único", recorrente:"Recorrente", especial:"Especial" };
const STOCK_TYPES = { filamento:"Filamento", pecas:"Peças", impressora:"Impressora", material:"Material", embalagem:"Embalagem", outros:"Outros" };
const PAGES = { dashboard:"Painel principal", catalog:"Cadastro", orders:"Encomendas", finance:"Financeiro", expenses:"Despesas", payments:"Pagamentos", reports:"Relatórios", stock:"Estoque" };
const $ = s => document.querySelector(s);
const data = { orders:[], expenses:[], stock:[], clients:[], products:[] };
const filters = { orders:{}, payments:{}, expenses:{}, stock:{}, reports:{}, catalog:{} };
const sorts = { orders:{key:"date",dir:-1}, payments:{key:"date",dir:-1}, expenses:{key:"date",dir:-1}, stock:{key:"name",dir:1} };
let auth, db, user, page="dashboard", connected=false, loaded=new Set(), listeners=[];
let modalBusy=false, toastTimer, lastFocus, ready=false;
const pending = new Set();
const money = cents => (Number(cents || 0)/100).toLocaleString("pt-BR", { style:"currency", currency:"BRL" });
const decimal = (n,d=3) => Number(n || 0).toLocaleString("pt-BR",{maximumFractionDigits:d});
const esc = v => String(v ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const options = (map,value="",all="") => (all ? `<option value="">${esc(all)}</option>` : "") + Object.entries(map).map(([k,v])=>`<option value="${esc(k)}" ${k===String(value)?"selected":""}>${esc(v)}</option>`).join("");
const total = o => Math.round(o.unitCents * o.quantity);
const paid = o => Math.min(total(o) || 0,Math.max(0,o.paymentMode==="parcelado"?sum(installmentsOf(o),p=>p.paid?p.amountCents:0):Number(o.paidCents || 0)));
const sum = (rows,fn) => rows.reduce((v,r)=>v+fn(r),0);
const stockValue = s => Math.round(s.unitCents * s.initialQuantity);
const stockUsed = s => Math.round((s.initialQuantity-s.currentQuantity)*1000)/1000;
const unit = s => s.type==="filamento" ? "kg" : "un.";
const normalize = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();

function installmentsOf(o) {
  return Object.entries(o.installments || {}).filter(([,p])=>p && typeof p==="object")
    .sort(([a],[b])=>a.localeCompare(b,"pt-BR",{numeric:true}))
    .map(([id,p])=>({...p,id,paid:p.paid===true}));
}
function paymentOf(o) {
  if (o.paymentMode!=="parcelado") return o.payment || "nao_pago";
  const list=installmentsOf(o);
  return list.length && list.every(p=>p.paid)?"pago":list.some(p=>p.paid)?"parcial":"nao_pago";
}
function validatePlan(plan,invoice) {
  const list=installmentsOf({installments:plan});
  if (!list.length || list.length>120) throw Error("Defina de 1 a 120 parcelas.");
  let planned=0;
  for (const p of list) {
    if (!p.date || isoDate(brDate(p.date))!==p.date) throw Error("Informe uma data válida para cada parcela.");
    if (!Number.isSafeInteger(p.amountCents) || p.amountCents<=0 || p.amountCents>invoice) throw Error("Cada parcela deve ter um valor positivo, até o total da encomenda.");
    planned+=p.amountCents;
  }
  if (planned!==invoice) throw Error(`A soma das parcelas (${money(planned)}) deve ser igual ao total (${money(invoice)}).`);
  return Object.fromEntries(list.map((p,i)=>["p"+(i+1),{date:p.date,amountCents:p.amountCents,paid:p.paid}]));
}
function planPatch(o,plan) {
  const installments=validatePlan(plan,total(o)), list=installmentsOf({installments});
  return {paymentMode:"parcelado",paymentDate:null,installments,installmentCount:list.length,
    paidCents:sum(list,p=>p.paid?p.amountCents:0),payment:paymentOf({paymentMode:"parcelado",installments})};
}
function scheduleDetails(o) {
  if (o.paymentMode!=="parcelado") return `<span>${esc(brDate(o.paymentDate))}</span><small>${money(total(o))}</small>`;
  return installmentsOf(o).map((p,i)=>`<div class="schedule-item"><span>${i+1}. ${esc(brDate(p.date))}</span><strong>${money(p.amountCents)}</strong><small class="${p.paid?"paid-badge":""}">${p.paid?"Pago":"Pendente"}</small></div>`).join("");
}
function paymentSortDate(o) {
  if (o.paymentMode!=="parcelado") return o.paymentDate || "";
  const list=installmentsOf(o), pending=list.filter(p=>!p.paid);
  return (pending.length?pending:list).map(p=>p.date).sort()[0] || "";
}
function clientFilterOptions() {
  const entries=new Map(data.clients.map(c=>[c.id,c.name]));
  data.orders.forEach(o=>{
    if (o.clientId && !entries.has(o.clientId)) entries.set(o.clientId,o.client+" (cadastro excluído)");
    if (!o.clientId) entries.set("legacy:"+normalize(o.client),o.client+" (registro anterior)");
  });
  return Object.fromEntries([...entries].sort((a,b)=>a[1].localeCompare(b[1],"pt-BR")));
}
function matchesClient(o,key) {
  if (key.startsWith("legacy:")) return !o.clientId && normalize(o.client)===key.slice(7);
  return o.clientId===key;
}
function renderCatalog() {
  const panel=(kind,title,description)=>{
    const query=filters.catalog[kind] || "", rows=data[kind].filter(r=>normalize(r.name).includes(normalize(query)))
      .sort((a,b)=>a.name.localeCompare(b.name,"pt-BR"));
    return `<section class="catalog-panel"><div class="catalog-heading"><div><h3>${title}</h3><p class="muted small">${description}</p></div><button class="primary compact" data-create="${kind}">+ Adicionar</button></div><label for="catalog-${kind}">Buscar ${title.toLowerCase()}</label><input id="catalog-${kind}" data-catalog-search="${kind}" value="${esc(query)}" placeholder="Digite parte do nome"><div class="catalog-list">${rows.map(r=>`<div class="catalog-item ${kind==="products"?"catalog-product":""}"><div><strong>${esc(r.name)}</strong>${kind==="products"?`<p class="muted small">${money(r.unitCents)} por unidade</p><dl class="product-costs"><div><dt>Preço de filamento</dt><dd>${r.filamentPriceCents==null?"—":money(r.filamentPriceCents)}</dd></div><div><dt>Quantidade de filamento</dt><dd>${r.filamentGrams==null?"—":decimal(r.filamentGrams)+" g"}</dd></div><div><dt>Custo</dt><dd>${r.costCents==null?"—":money(r.costCents)}</dd></div></dl>`:""}</div>${actionButtons(kind,r.id,false)}</div>`).join("") || `<p class="empty">${loaded.has(kind)?"Nenhum cadastro encontrado.":"Carregando…"}</p>`}</div></section>`;
  };
  return heading("Cadastro","Mantenha os clientes e os preços de referência usados nas encomendas.")+
    `<div class="catalog-grid">${panel("clients","Clientes","Nomes para identificar os pedidos.")}${panel("products","Produtos","Preços de venda, filamento e custos dos produtos.")}</div>`;
}
function today() {
  const p = new Intl.DateTimeFormat("en-US",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
  const v = t => p.find(x=>x.type===t).value;
  return `${v("year")}-${v("month")}-${v("day")}`;
}
function addDays(iso,n) { const d=new Date(iso+"T12:00:00Z"); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function brDate(iso) { return iso ? iso.split("-").reverse().join("/") : "—"; }
function isoDate(value) {
  const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!m) throw Error("Informe a data no formato dd/mm/aaaa.");
  const iso=`${m[3]}-${m[2]}-${m[1]}`, d=new Date(iso+"T12:00:00Z");
  if (+m[3]<1900 || +m[3]>2100 || isNaN(d) || d.toISOString().slice(0,10)!==iso) throw Error("Informe uma data válida entre 1900 e 2100.");
  return iso;
}
function amount(value) {
  let s=String(value).trim().replace(/R\$\s?/g,"").replace(/\s/g,"");
  if (!/^(?:\d+(?:\.\d{3})*(?:,\d{1,6})?|\d+(?:\.\d{1,6})?)$/.test(s)) throw Error("Informe um valor válido, por exemplo 1.234,56.");
  if (s.includes(",")) s=s.replace(/\./g,"").replace(",",".");
  else if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(s)) s=s.replace(/\./g,"");
  const n=Number(s);
  if (!Number.isFinite(n) || n<0 || n>1000000000) throw Error("O valor deve estar entre zero e um bilhão de reais.");
  return n;
}
function numeric(value,integer=false) {
  const n=Number(value);
  if (!String(value).trim() || !Number.isFinite(n) || n<0 || n>1000000000 || (integer && !Number.isInteger(n))) throw Error("Informe uma quantidade válida e não negativa.");
  return Math.round(n*1000)/1000;
}
function text(value,label) { const s=String(value).trim(); if (!s || s.length>180) throw Error(`${label}: preencha até 180 caracteres.`); return s; }
function fail(e) {
  const code=String(e.code || "").toLowerCase();
  if (/invalid-credential|wrong-password|user-not-found|invalid-login/.test(code)) return "Usuário ou senha incorretos.";
  if (code.includes("too-many-requests")) return "Muitas tentativas. Aguarde e tente novamente.";
  if (code.includes("network-request")) return "Falha de conexão. Verifique sua internet.";
  if (code.includes("permission-denied") || code.includes("permission_denied")) return "Acesso negado. Confira as regras do Realtime Database e o e-mail autorizado.";
  if (code.includes("operation-not-allowed")) return "Ative o provedor E-mail/senha no Firebase Authentication.";
  return e.message || "Não foi possível concluir. Tente novamente.";
}
function toast(message,error=false) {
  clearTimeout(toastTimer); $("#toast").textContent=message; $("#toast").className="toast"+(error?" error-toast":""); $("#toast").hidden=false;
  toastTimer=setTimeout(()=>$("#toast").hidden=true,6000);
}
function connection() {
  ready=!!user && connected && loaded.size===Object.keys(data).length;
  $("#connection-state").textContent=ready?"Sincronizado":connected?"Carregando dados…":"Sem conexão";
  $("#connection-state").classList.toggle("online",ready);
}
function guard() { if (!ready) throw Error("Aguarde a conexão e o carregamento dos dados antes de salvar."); }
function cleanup() {
  listeners.forEach(off=>off()); listeners=[]; loaded.clear(); connected=false; ready=false;
  Object.keys(data).forEach(k=>data[k]=[]); pending.clear(); closeModal(true);
}
async function initialize() {
  if (!window.firebase) { $("#login-status").textContent="Não foi possível carregar o Firebase. Verifique a internet e recarregue."; return; }
  const saved=localStorage.getItem("atho3d.databaseURL") || firebaseConfig.databaseURL;
  $("#database-url").value=saved;
  if (!saved) { $("#connection-settings").open=true; $("#login-status").textContent="Informe a URL do Realtime Database em Configurar conexão."; return; }
  try {
    const url=new URL(saved);
    if (url.protocol!=="https:" || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.(firebaseio\.com|firebasedatabase\.app)$/.test(url.hostname) || (url.pathname!=="/" && url.pathname!=="")) throw Error("Use a URL raiz do Realtime Database exibida no Firebase.");
    const app=firebase.initializeApp({...firebaseConfig,databaseURL:url.origin});
    auth=app.auth(); db=app.database(); auth.languageCode="pt-BR";
    await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
    $("#login-status").textContent="Conexão configurada. Entre com sua senha do Firebase.";
    auth.onAuthStateChanged(async current=> {
      if (user && current && user.uid===current.uid) { user=current; return; }
      cleanup(); user=current;
      if (current && !Object.values(USERS).includes((current.email || "").toLowerCase())) {
        $("#login-error").textContent="Este e-mail não está autorizado."; await auth.signOut(); return;
      }
      $("#login").hidden=!!current; $("#app").hidden=!current;
      if (!current) { user=null; $("#content").innerHTML=""; return; }
      $("#user-name").textContent=Object.keys(USERS).find(k=>USERS[k]===current.email.toLowerCase());
      $("#current-date").textContent=new Date().toLocaleDateString("pt-BR",{timeZone:"America/Sao_Paulo",dateStyle:"long"});
      setMenu(localStorage.getItem("atho3d.menu")!=="closed" && innerWidth>1050);
      page="dashboard"; render();
      const c=db.ref(".info/connected"), cb=s=>{connected=s.val()===true;connection();}; c.on("value",cb); listeners.push(()=>c.off("value",cb));
      Object.keys(data).forEach(kind=> {
        const r=db.ref("atho3d/"+kind), fn=s=> {
          data[kind]=Object.entries(s.val() || {}).map(([id,v])=>kind==="orders"?{...v,id,payment:paymentOf(v)}:{...v,id}); loaded.add(kind); connection(); render();
        };
        r.on("value",fn,e=>{loaded.delete(kind);connection();toast(fail(e),true);}); listeners.push(()=>r.off("value",fn));
      });
    });
  } catch(e) { $("#login-error").textContent=fail(e); $("#connection-settings").open=true; }
}
function setMenu(open) {
  document.body.classList.toggle("menu-closed",!open); $("#menu-toggle").setAttribute("aria-expanded",String(open));
  $("#sidebar").inert=!open; localStorage.setItem("atho3d.menu",open?"open":"closed");
}
function navigate(next) {
  if (!user || !PAGES[next]) return; page=next; render();
  if (innerWidth<=1050) setMenu(false); $("#content").focus();
}
function heading(title,description,create="") {
  return `<div class="page-heading"><div><p class="eyebrow">ATHO 3D / GESTÃO</p><h2>${title}</h2><p class="muted">${description}</p></div>${create?`<button class="primary" data-create="${create}">+ Cadastrar novo</button>`:""}</div>`;
}
function menuCard(target,icon,title,desc) { return `<button class="menu-card" data-nav="${target}"><span class="card-icon" aria-hidden="true">${icon}</span><span class="arrow" aria-hidden="true">↗</span><h3>${title}</h3><p class="muted">${desc}</p></button>`; }
function renderDashboard() {
  const due=data.expenses.filter(e=>e.payment==="nao_pago" && e.dueDate<=addDays(today(),5)).length;
  const unpaid=data.orders.filter(o=>o.status==="entregue" && o.payment==="nao_pago").length;
  return `<div class="greeting"><p class="eyebrow">SEU NEGÓCIO, EM PERSPECTIVA</p><h2>Olá, ${esc($("#user-name").textContent)}.</h2><p class="muted">Acompanhe o que precisa de atenção e organize sua produção.</p></div>
  <div class="alert-panel"><button class="alert-card" data-alert="expenses"><div><h3>Despesas vencendo</h3><p class="muted">Não pagas, vencidas ou com vencimento em até 5 dias.</p></div><strong>${due}</strong></button><button class="alert-card" data-alert="orders"><div><h3>Encomendas não pagas</h3><p class="muted">Entregues e ainda sem pagamento. Clique para conferir.</p></div><strong>${unpaid}</strong></button></div>
  <div class="menu-cards dashboard-cards">${menuCard("orders","▤","Encomendas","Clientes, prazos e produção de cada pedido.")}${menuCard("finance","◉","Financeiro","Despesas, recebimentos e resultado do negócio.")}${menuCard("stock","▦","Estoque","Filamentos, peças e materiais sempre à mão.")}${menuCard("catalog","⊕","Cadastro","Clientes e produtos com seus preços de referência.")}</div>
  <p class="muted dashboard-note">${loaded.size===Object.keys(data).length?`${data.orders.length} encomendas · ${data.stock.length} itens no estoque`:"Carregando dados do negócio…"}</p>`;
}
function filterField(label,key,type="text",map=null,all="Todos") {
  const v=filters[page][key] || "";
  return `<div class="filter-field ${key==="q"?"wide":""}"><label for="filter-${key}">${label}</label>${map?`<select id="filter-${key}" data-filter="${key}">${options(map,v,all)}</select>`:`<input id="filter-${key}" data-filter="${key}" type="${type}" value="${esc(v)}" ${type==="date"?'min="1900-01-01" max="2100-12-31"':""}>`}</div>`;
}
function filterBar() {
  let f=filterField(page==="stock"?"Nome ou observação":"Pesquisar", "q") + filterField("Data inicial","from","date") + filterField("Data final","to","date");
  if (page==="orders" || page==="payments") f+=filterField("Cliente","clientId","",clientFilterOptions(),"Todos os clientes")+filterField("Forma de pagamento","paymentMode","",PAYMENT_MODES)+filterField("Pagamento","payment","",PAYMENT)+filterField("Situação","status","",STATUS);
  if (page==="expenses") f+=filterField("Situação","payment","",{pago:"Pago",nao_pago:"Não pago"})+filterField("Tipo","type","",EXPENSE_TYPES)+filterField("Vencimento","due","",{soon:"Vencidas / próximos 5 dias",overdue:"Vencidas"});
  if (page==="stock") f+=filterField("Marca","brand")+filterField("Tipo","type","",STOCK_TYPES)+filterField("Quantidade atual","availability","",{available:"Com saldo",empty:"Esgotado"});
  const columns=page==="stock"?{name:"Nome",brand:"Marca",type:"Tipo",date:"Data",initialQuantity:"Quantidade inicial",unitCents:"Preço unitário",total:"Preço total",currentQuantity:"Quantidade atual",notes:"Observação"}:page==="expenses"?{name:"Nome",date:"Data",dueDate:"Vencimento",amountCents:"Valor",type:"Tipo",payment:"Situação"}:{client:"Cliente",name:"Encomenda",product:"Produto",date:"Data",deadline:"Prazo",unitCents:"Valor unitário",quantity:"Quantidade",total:"Total",paidCents:"Valor pago",paymentMode:"Forma de pagamento",payment:"Pagamento",paymentDate:"Data de pagamento",status:"Situação",notes:"Observação"};
  f+=`<div class="filter-field"><label for="sort-key">Ordenar por</label><select id="sort-key" data-sort-select>${options(columns,sorts[page].key)}</select></div><button class="secondary compact" data-sort-direction>${sorts[page].dir===1?"↑ Crescente":"↓ Decrescente"}</button><button class="secondary compact" data-clear>Limpar filtros</button>`;
  const advanced=page==="stock"?`<details class="advanced-filters"><summary>Filtros de quantidade e preço</summary><div class="filters">${[["initialMin","Qtd. inicial mínima"],["initialMax","Qtd. inicial máxima"],["currentMin","Saldo mínimo"],["currentMax","Saldo máximo"],["unitMin","Preço unitário mínimo (R$)"],["unitMax","Preço unitário máximo (R$)"],["totalMin","Preço total mínimo (R$)"],["totalMax","Preço total máximo (R$)"]].map(([key,label])=>filterField(label,key)).join("")}</div></details>`:"";
  return `<div class="filters">${f}</div>${advanced}`;
}
function filtered(kind) {
  const f=filters[page], rows=data[kind].filter(r=> {
    if (f.from && r.date<f.from || f.to && r.date>f.to) return false;
    if (f.payment && r.payment!==f.payment || f.status && r.status!==f.status || f.type && r.type!==f.type) return false;
    if (f.paymentMode && (r.paymentMode || "total")!==f.paymentMode) return false;
    if (f.clientId && !matchesClient(r,f.clientId)) return false;
    if (f.brand && !normalize(r.brand).includes(normalize(f.brand))) return false;
    if (f.q && !normalize([r.name,r.client,r.product,r.brand,r.notes].join(" ")).includes(normalize(f.q))) return false;
    if (f.due==="soon" && r.dueDate>addDays(today(),5) || f.due==="overdue" && r.dueDate>=today()) return false;
    if (f.availability==="available" && r.currentQuantity<=0 || f.availability==="empty" && r.currentQuantity>0) return false;
    if (kind==="stock") {
      for (const [prefix,value] of [["initial",r.initialQuantity],["current",r.currentQuantity],["unit",r.unitCents/100],["total",stockValue(r)/100]]) {
        try { if (f[prefix+"Min"] && value<amount(f[prefix+"Min"]) || f[prefix+"Max"] && value>amount(f[prefix+"Max"])) return false; } catch { return false; }
      }
    }
    return true;
  });
  const s=sorts[page], value=r=>s.key==="total"?(kind==="stock"?stockValue(r):total(r)):s.key==="paidCents"?paid(r):s.key==="paymentDate"?paymentSortDate(r):s.key==="paymentMode"?PAYMENT_MODES[r.paymentMode || "total"]:s.key==="product"?(r.product || r.name):s.key==="payment"?PAYMENT[r.payment]:s.key==="status"?STATUS[r.status]:s.key==="type"?(kind==="stock"?STOCK_TYPES[r.type]:EXPENSE_TYPES[r.type]):r[s.key];
  return rows.sort((a,b)=> {const x=value(a),y=value(b);return (typeof x==="number"?x-y:String(x || "").localeCompare(String(y || ""),"pt-BR",{numeric:true}))*s.dir || a.id.localeCompare(b.id);});
}
function th(key,label) { const s=sorts[page]; return `<th scope="col" aria-sort="${s.key===key?(s.dir===1?"ascending":"descending"):"none"}"><button data-sort="${key}">${label}${s.key===key?(s.dir===1?" ↑":" ↓"):" ↕"}</button></th>`; }
function td(label,content,cls="") { return `<td data-label="${label}" class="${cls}">${content}</td>`; }
function actionButtons(kind,id,view=true) { return `<div class="actions"><button class="action" data-action="edit" data-kind="${kind}" data-id="${id}">Editar</button>${view?`<button class="action" data-action="view" data-kind="${kind}" data-id="${id}">Ver</button>`:""}<button class="action delete" data-action="delete" data-kind="${kind}" data-id="${id}">Excluir</button></div>`; }
function inlineSelect(kind,id,field,map,value) { return `<select aria-label="${field==="payment"?"Pagamento":"Situação"}" data-inline="${field}" data-kind="${kind}" data-id="${id}">${options(map,value)}</select>`; }
function rowColor(o) { return o.status==="em_andamento"?"row-progress":o.status==="na_fila"?"row-queue":o.payment==="pago"?"row-paid":o.payment==="parcial"?"row-partial":"row-unpaid"; }
function legend() { return `<div class="legend"><span><i class="row-paid"></i>Finalizado/entregue · pago</span><span><i class="row-partial"></i>Finalizado/entregue · parcial</span><span><i class="row-unpaid"></i>Finalizado/entregue · não pago</span><span><i class="row-progress"></i>Em andamento</span><span><i class="row-queue"></i>Na fila</span></div>`; }
function tableCard(rows,kind,headers,body,footer="") {
  const f=filters[page], invalid=f.from && f.to && f.from>f.to;
  return `${invalid?'<p class="error">A data inicial deve ser anterior ou igual à final.</p>':""}<div class="table-card"><div class="table-summary">${loaded.has(kind)?`${rows.length} de ${data[kind].length} registros · Totais referentes aos filtros atuais`:"Carregando registros…"}</div><table class="${page}-table"><thead><tr>${headers}</tr></thead><tbody>${body || `<tr><td class="empty" colspan="${(headers.match(/<th /g) || []).length}">${loaded.has(kind)?"Nenhum registro encontrado. Cadastre um novo ou ajuste os filtros.":"Carregando…"}</td></tr>`}</tbody>${footer?`<tfoot><tr><td colspan="${(headers.match(/<th /g)||[]).length}">${footer}</td></tr></tfoot>`:""}</table></div>`;
}
function renderOrders() {
  const paymentPage=page==="payments", rows=filtered("orders");
  const columns=[["client","Cliente"],["name","Encomenda"],["product","Produto"],["date","Data"],["deadline","Prazo"],["unitCents","Valor unitário"],["quantity","Qtd."],["total","Total"],...(paymentPage?[["paidCents","Valor pago"]]:[]),["paymentMode","Forma"],["payment","Pagamento"],["paymentDate","Datas / parcelas"],["status","Situação"],...(!paymentPage?[["notes","Observação"]]:[])];
  const heads=columns.map(([k,l])=>th(k,l)).join("")+'<th scope="col">Ações</th>';
  const body=rows.map(o=>`<tr class="${rowColor(o)}">${td("Cliente",esc(o.client))}${td("Encomenda",esc(o.name))}${td("Produto",esc(o.product || o.name))}${td("Data",brDate(o.date))}${td("Prazo",brDate(o.deadline))}${td("Valor unitário",money(o.unitCents),"money")}${td("Quantidade",decimal(o.quantity))}${td("Total",money(total(o)),"money")}${paymentPage?td("Valor pago",money(paid(o)),"money"):""}${td("Forma",PAYMENT_MODES[o.paymentMode || "total"])}${td("Pagamento",inlineSelect("orders",o.id,"payment",PAYMENT,o.payment)+`<small>Recebido: ${money(paid(o))}<br>Falta: ${money(total(o)-paid(o))}</small>`)}${td("Datas / parcelas",scheduleDetails(o),"schedule-cell")}${td("Situação",inlineSelect("orders",o.id,"status",STATUS,o.status))}${!paymentPage?td("Observação",esc(o.notes || "—"),"notes"):""}${td("Ações",actionButtons("orders",o.id))}</tr>`).join("");
  return heading(paymentPage?"Pagamentos":"Encomendas",paymentPage?"Recebimentos e valores a receber das mesmas encomendas cadastradas.":"Organize os pedidos e acompanhe cada etapa da produção.",paymentPage?"":"orders") + filterBar() + tableCard(rows,"orders",heads,body,`Total: ${money(sum(rows,total))} · Recebido: ${money(sum(rows,paid))} · A receber: ${money(sum(rows,o=>total(o)-paid(o)))}`)+legend();
}
function renderExpenses() {
  const rows=filtered("expenses"), heads=[["name","Nome"],["date","Data"],["dueDate","Vencimento"],["amountCents","Valor"],["type","Tipo"],["payment","Situação"]].map(([k,l])=>th(k,l)).join("")+'<th scope="col">Ações</th>';
  const body=rows.map(e=>`<tr>${td("Nome",esc(e.name))}${td("Data",brDate(e.date))}${td("Vencimento",brDate(e.dueDate)+(e.payment==="nao_pago" && e.dueDate<today()?"<small>Vencida</small>":""))}${td("Valor",money(e.amountCents),"money")}${td("Tipo",esc(EXPENSE_TYPES[e.type]))}${td("Situação",inlineSelect("expenses",e.id,"payment",{pago:"Pago",nao_pago:"Não pago"},e.payment))}${td("Ações",actionButtons("expenses",e.id))}</tr>`).join("");
  return heading("Despesas","Controle os custos, vencimentos e pagamentos do negócio.","expenses")+filterBar()+tableCard(rows,"expenses",heads,body,`Total de despesas: ${money(sum(rows,e=>e.amountCents))}`);
}
function renderStock() {
  const rows=filtered("stock"), heads=[["name","Nome"],["brand","Marca"],["type","Tipo"],["date","Entrada"],["unitCents","Preço unitário"],["total","Preço total"],["currentQuantity","Quantidade / saldo"],["notes","Observação"]].map(([k,l])=>th(k,l)).join("")+'<th scope="col">Ações</th>';
  const body=rows.map(s=>`<tr>${td("Nome",esc(s.name))}${td("Marca",esc(s.brand || "—"))}${td("Tipo",esc(STOCK_TYPES[s.type]))}${td("Entrada",brDate(s.date))}${td("Preço unitário",`${money(s.unitCents)}<small>Por ${s.type==="filamento"?"1 kg":"unidade"}</small>`,"money")}${td("Preço total",money(stockValue(s)),"money")}${td("Quantidade / saldo",`<div class="stock-control"><div class="stock-initial">Inicial: <strong>${decimal(s.initialQuantity)} ${unit(s)}</strong></div><label for="stock-used-${s.id}">Gasta (${unit(s)})<input id="stock-used-${s.id}" type="number" min="0" max="${s.initialQuantity}" step="${s.type==="filamento"?"0.001":"1"}" value="${stockUsed(s)}" data-stock="used" data-id="${s.id}" aria-label="Quantidade gasta acumulada de ${esc(s.name)}"></label><div class="stock-result"><span>Saldo (${unit(s)})</span><output data-stock-remaining for="stock-used-${s.id}" aria-live="polite">${decimal(s.currentQuantity)}</output></div></div>`,"stock-quantity")}${td("Observação",esc(s.notes || "—"),"notes")}${td("Ações",actionButtons("stock",s.id))}</tr>`).join("");
  return heading("Estoque","Inicial − quantidade gasta = saldo. Informe o consumo acumulado; o saldo é salvo ao sair do campo. Filamentos em kg, demais itens em unidades.","stock")+filterBar()+tableCard(rows,"stock",heads,body,`Valor inicial: ${money(sum(rows,stockValue))} · Valor do saldo atual: ${money(sum(rows,s=>Math.round(s.unitCents*s.currentQuantity)))}`);
}
function reportRows(rows) {
  const f=filters.reports, y1=f.yearFrom || f.yearTo, y2=f.yearTo || f.yearFrom, m1=f.monthFrom || "01", m2=f.monthTo || "12";
  const start=y1?`${y1}-${m1}-01`:"", end=y2?`${y2}-${m2}-31`:"";
  const invalid=(start && start>end) || (!y1 && m1>m2);
  return invalid?[]:rows.filter(r=>y1?(r.date>=start && r.date<=end):(r.date.slice(5,7)>=m1 && r.date.slice(5,7)<=m2));
}
function renderReports() {
  const months=Object.fromEntries(["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"].map((m,i)=>[String(i+1).padStart(2,"0"),m]));
  const years=[...new Set([String(new Date().getFullYear()),...data.orders.map(o=>o.date.slice(0,4)),...data.expenses.map(e=>e.date.slice(0,4))])].sort();
  const ym=Object.fromEntries(years.map(y=>[y,y])), f=filters.reports;
  const orders=reportRows(data.orders), expenses=reportRows(data.expenses), all=sum(orders,total), realized=sum(orders,paid), cost=sum(expenses,e=>e.amountCents);
  const metrics=[["Quantidade de encomendas",orders.length],["Valor total",money(all)],["Valor realizado",money(realized)],["Valor a receber",money(all-realized)],["Encomendas pagas",orders.filter(o=>o.payment==="pago").length],["Encomendas na fila",orders.filter(o=>o.status==="na_fila").length],["Encomendas finalizadas",orders.filter(o=>o.status==="finalizado" || o.status==="entregue").length],["Encomendas em andamento",orders.filter(o=>o.status==="em_andamento").length],["Total de despesas",money(cost)],["Lucro líquido",money(realized-cost),true],["Lucro líquido previsto",money(all-cost),true],["Encomendas entregues",orders.filter(o=>o.status==="entregue").length]];
  const y1=f.yearFrom || f.yearTo, y2=f.yearTo || f.yearFrom, m1=f.monthFrom || "01", m2=f.monthTo || "12", invalid=y1?`${y1}-${m1}`>`${y2}-${m2}`:m1>m2;
  return heading("Relatórios","Uma visão do resultado e da produção, atualizada conforme o período escolhido.")+`<div class="filters">${filterField("Mês inicial","monthFrom","",months,"Janeiro / sem filtro")}${filterField("Mês final","monthTo","",months,"Dezembro / sem filtro")}${filterField("Ano inicial","yearFrom","",ym,"Todos os anos")}${filterField("Ano final","yearTo","",ym,"Todos os anos")}<button class="secondary compact" data-clear>Limpar filtros</button></div>${invalid?'<p class="error">O período inicial deve ser anterior ou igual ao final.</p>':""}<p class="muted report-period">${y1?`${months[m1]} de ${y1} até ${months[m2]} de ${y2}`:`${months[m1]} a ${months[m2]} · todos os anos`}</p><div class="stats-grid">${metrics.map(([label,v,em])=>`<div class="stat ${em?"emphasis":""}"><p>${label}</p><strong>${v}</strong></div>`).join("")}</div><p class="report-note">O período usa a data da encomenda ou da despesa. Valor realizado inclui os pagamentos parciais. Os lucros descontam todas as despesas cadastradas no período, pagas ou não, conforme solicitado. Finalizadas inclui os status Finalizado e Entregue. As quantidades representam o número de encomendas, não a quantidade de peças.</p>`;
}
function render() {
  if (!user) return;
  // Preserva foco e posição durante atualizações automáticas e digitação dos filtros.
  const focus=document.activeElement, fid=focus?.id, caret=focus?.selectionStart, scroll=window.scrollY, advanced=$(".advanced-filters")?.open;
  const html=page==="dashboard"?renderDashboard():page==="catalog"?renderCatalog():page==="finance"?heading("Financeiro","Acompanhe despesas, pagamentos e o resultado da Atho 3D.")+`<div class="menu-cards">${menuCard("expenses","↗","Despesas","Cadastre custos e acompanhe os vencimentos.")}${menuCard("payments","↙","Pagamentos","Confira os valores recebidos e a receber.")}${menuCard("reports","▥","Relatórios","Consulte os indicadores por mês e ano.")}</div>`:page==="orders" || page==="payments"?renderOrders():page==="expenses"?renderExpenses():page==="stock"?renderStock():renderReports();
  $("#content").innerHTML=html; $("#page-title").textContent=PAGES[page];
  document.querySelectorAll("#sidebar [data-nav]").forEach(b=>b.classList.toggle("active",b.dataset.nav===page));
  if (advanced && $(".advanced-filters")) $(".advanced-filters").open=true;
  if (fid && $("#"+fid)) { const el=$("#"+fid); el.focus({preventScroll:true}); if (caret!=null && el.type==="text") el.setSelectionRange(caret,caret); }
  window.scrollTo(0,scroll);
}
function openModal(title,html) {
  if (modalBusy) return;
  lastFocus=document.activeElement; $("#modal-title").textContent=title; $("#modal-body").innerHTML=html;
  if (!$("#modal").open) $("#modal").showModal();
  $("#modal-body input, #modal-body select, #modal-body button")?.focus();
}
function closeModal(force=false) {
  if (modalBusy && !force) return;
  $("#modal").close(); $("#modal-body").innerHTML=""; lastFocus?.focus?.();
}
function field(label,name,value="",type="text",extra="") { return `<div><label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}></div>`; }
function selectField(label,name,map,value) { return `<div><label for="f-${name}">${label}</label><select id="f-${name}" name="${name}">${options(map,value)}</select></div>`; }
function dateField(label,name,iso) {
  return `<div><label for="f-${name}">${label}</label><div class="date-entry"><input id="f-${name}" name="${name}" value="${iso?brDate(iso):""}" placeholder="dd/mm/aaaa" inputmode="numeric" maxlength="10" required data-date-text="${name}"><span class="calendar-button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6m10-6v6M3 11h18"/></svg><input type="date" value="${esc(iso)}" data-calendar="${name}" min="1900-01-01" max="2100-12-31" aria-label="Abrir calendário: ${label}"></span></div></div>`;
}
function moneyInput(label,name,cents=0,precision=2) { return field(label,name,(Number(cents)/100).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:precision}),"text",'inputmode="decimal" required maxlength="24"'); }
function optionalMoneyInput(label,name,cents) { return field(label,name,cents==null?"":(Number(cents)/100).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2}),"text",'inputmode="decimal" maxlength="24" placeholder="Opcional"'); }
function formFooter() { return '<p class="error" id="form-error" role="alert"></p><div class="form-footer"><button type="button" class="secondary" data-close>Cancelar</button><button type="submit" class="primary">Salvar</button></div>'; }
function picker(label,prefix,kind,id,name,existing=false) {
  const active=data[kind].find(r=>r.id===id), value=active?.name || name || "";
  const fallback=existing && value && !active?{id:id || "__legacy__",name:value}:null;
  return `<div class="search-picker" id="combo-${prefix}" data-combo="${prefix}" data-kind="${kind}" data-fallback-id="${esc(fallback?.id || "")}" data-fallback-name="${esc(fallback?.name || "")}"><label for="f-${prefix}Text">${label}</label><div class="picker-input"><input id="f-${prefix}Text" name="${prefix}Text" value="${esc(value)}" required maxlength="180" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="combo-${prefix}-options" data-combo-input="${prefix}" placeholder="Digite para buscar"><button type="button" data-combo-open="${prefix}" class="picker-toggle" aria-label="Abrir lista de ${label}">▾</button></div><input type="hidden" name="${prefix}Id" value="${esc(active?.id || fallback?.id || "")}"><div id="combo-${prefix}-options" class="picker-options" role="listbox" hidden></div></div>`;
}
function showPicker(prefix,query="") {
  const wrapper=$("#combo-"+prefix); if (!wrapper) return;
  const input=wrapper.querySelector("[data-combo-input]"), list=wrapper.querySelector("[role=listbox]");
  const rows=[...data[wrapper.dataset.kind]];
  if (wrapper.dataset.fallbackId && !rows.some(r=>r.id===wrapper.dataset.fallbackId)) rows.unshift({id:wrapper.dataset.fallbackId,name:wrapper.dataset.fallbackName,legacy:true});
  const matches=rows.filter(r=>normalize(r.name).includes(normalize(query))).sort((a,b)=>a.name.localeCompare(b.name,"pt-BR"));
  list.innerHTML=matches.map((r,i)=>`<button type="button" role="option" id="combo-${prefix}-option-${i}" data-combo-choice="${prefix}" data-id="${esc(r.id)}" aria-selected="false">${esc(r.name)}${wrapper.dataset.kind==="products" && !r.legacy?`<small>${money(r.unitCents)}</small>`:""}${r.legacy?"<small>Registro anterior / fora do cadastro</small>":""}</button>`).join("") || '<p class="picker-empty">Nenhum resultado. Adicione o cadastro no menu Cadastro.</p>';
  list.hidden=false; input.setAttribute("aria-expanded","true"); input.removeAttribute("aria-activedescendant"); wrapper.dataset.index="-1";
}
function hidePicker(prefix) {
  const wrapper=$("#combo-"+prefix); if (!wrapper) return;
  wrapper.querySelector("[role=listbox]").hidden=true;
  const input=wrapper.querySelector("[data-combo-input]"); input.setAttribute("aria-expanded","false"); input.removeAttribute("aria-activedescendant");
}
function choosePicker(prefix,id) {
  const wrapper=$("#combo-"+prefix), f=$("#record-form"); if (!wrapper || !f) return;
  const active=data[wrapper.dataset.kind].find(r=>r.id===id);
  const chosen=active || (wrapper.dataset.fallbackId===id?{id,name:wrapper.dataset.fallbackName}:null);
  if (!chosen) return;
  f.elements.namedItem(prefix+"Text").value=chosen.name; f.elements.namedItem(prefix+"Id").value=chosen.id;
  if (prefix==="product" && active) {
    f.elements.namedItem("unitCents").value=(active.unitCents/100).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2});
    if (!f.elements.namedItem("name").value.trim()) f.elements.namedItem("name").value=active.name;
    syncForm("unitCents");
  }
  hidePicker(prefix);
}
function resolveSelection(f,prefix,kind,existing) {
  const id=f.elements.namedItem(prefix+"Id")?.value || "", value=f.elements.namedItem(prefix+"Text")?.value || "";
  const active=data[kind].find(r=>r.id===id);
  if (active && active.name===value) return {id,name:active.name};
  const oldName=prefix==="client"?existing?.client:(existing?.product || existing?.name);
  const oldId=existing?.[prefix+"Id"] || "__legacy__";
  if (existing && id===oldId && value===oldName && !active) return {id:id==="__legacy__"?null:id,name:oldName};
  throw Error(`Selecione um ${prefix==="client"?"cliente":"produto"} na lista. Se necessário, adicione-o primeiro no menu Cadastro.`);
}
function splitCents(value,count) {
  return Array.from({length:count},(_,i)=>Math.floor(value/count)+(i<value%count?1:0));
}
function addMonths(iso,n) {
  const [y,m,d]=iso.split("-").map(Number), first=new Date(Date.UTC(y,m-1+n,1));
  const last=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();
  first.setUTCDate(Math.min(d,last)); return first.toISOString().slice(0,10);
}
function formTotal(f) {
  return Math.round(amount(f.elements.namedItem("unitCents").value)*100)*numeric(f.elements.namedItem("quantity").value,true);
}
function captureInstallments(f) {
  const rows=[...f.querySelectorAll("[data-installment-row]")];
  if (rows.length) f.installmentDraft=rows.map((row,i)=>({dateText:f.elements.namedItem("instDate-"+i).value,amountText:f.elements.namedItem("instAmount-"+i).value,paid:f.elements.namedItem("instPaid-"+i).checked}));
  return f.installmentDraft || [];
}
function drawInstallments(f) {
  const rows=f.installmentDraft || [];
  $("#installment-rows").innerHTML=rows.map((p,i)=>{
    let iso=""; try {iso=isoDate(p.dateText);} catch {}
    return `<div class="installment-row" data-installment-row="${i}"><strong>Parcela ${i+1}</strong>${dateField("Data de pagamento *","instDate-"+i,iso)}${field("Valor (R$) *","instAmount-"+i,p.amountText,"text",'inputmode="decimal" required maxlength="24"')}<label class="check-label"><input type="checkbox" name="instPaid-${i}" ${p.paid?"checked":""}> Paga</label></div>`;
  }).join("");
  rows.forEach((p,i)=>f.elements.namedItem("instDate-"+i).value=p.dateText);
  f.elements.namedItem("installmentCount").value=rows.length || 2;
}
function resizeInstallments(f,count,distribute=false) {
  count=Number(count);
  if (!Number.isInteger(count) || count<1 || count>120) throw Error("O número de pagamentos deve ser de 1 a 120.");
  const old=captureInstallments(f);
  if (old.slice(count).some(p=>p.paid)) throw Error("Desmarque as parcelas pagas que deseja remover antes de reduzir a quantidade.");
  const invoice=formTotal(f);
  let amounts=splitCents(invoice,count), paidFlags=Array.from({length:count},(_,i)=>old[i]?.paid || false);
  if (!old.length) {
    const status=f.elements.namedItem("payment").value;
    const received=status==="pago"?invoice:status==="parcial"?Math.round(amount(f.elements.namedItem("paidCents").value)*100):0;
    if (received>invoice) throw Error("O valor recebido não pode exceder o total.");
    if (received>0 && received<invoice) {
      if(count<2) throw Error("Para preservar um pagamento parcial, crie pelo menos duas parcelas.");
      amounts=[received,...splitCents(invoice-received,count-1)];paidFlags[0]=true;
    } else if (status==="pago") paidFlags=paidFlags.map(()=>true);
  } else if (distribute) {
    const paidTotal=sum(old.slice(0,count),p=>p.paid?Math.round(amount(p.amountText)*100):0), unpaidCount=paidFlags.filter(v=>!v).length;
    if (paidTotal>invoice || (!unpaidCount && paidTotal!==invoice)) throw Error("Confira os valores das parcelas já pagas antes de redistribuir o total.");
    const remaining=splitCents(invoice-paidTotal,unpaidCount);let next=0;
    amounts=paidFlags.map((isPaid,i)=>isPaid?Math.round(amount(old[i].amountText)*100):remaining[next++]);
  }
  let first=today(); try {first=isoDate(f.elements.namedItem("paymentDate").value);} catch {}
  f.installmentDraft=Array.from({length:count},(_,i)=>({dateText:old[i]?.dateText || brDate(addMonths(first,i)),
    amountText:(!distribute && old[i])?old[i].amountText:(amounts[i]/100).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2}),paid:paidFlags[i]}));
  drawInstallments(f); syncForm();
}
function readPlan(f) {
  return Object.fromEntries(captureInstallments(f).map((p,i)=>["p"+(i+1),{date:isoDate(p.dateText),amountCents:Math.round(amount(p.amountText)*100),paid:p.paid}]));
}
function editForm(kind,id="") {
  if (!ready) { toast("Aguarde o carregamento dos dados.",true); return; }
  const r=id?data[kind].find(x=>x.id===id):{};
  if (!r) return;
  let fields="";
  if (kind==="orders") fields=picker("Cliente *","client","clients",r.clientId,r.client,!!id)+picker("Produto *","product","products",r.productId,r.product || r.name,!!id)+field("Encomenda (opcional)","name",r.name,"text",'maxlength="180"')+dateField("Data *","date",r.date || today())+dateField("Prazo *","deadline",r.deadline || today())+field("Quantidade *","quantity",r.quantity ?? 1,"number",'min="1" max="1000000000" step="1" required')+moneyInput("Valor unitário (R$) *","unitCents",r.unitCents)+selectField("Forma de pagamento","paymentMode",PAYMENT_MODES,r.paymentMode || "total")+selectField("Pagamento","payment",PAYMENT,r.payment || "nao_pago")+`<div id="total-date-field">${dateField("Data de pagamento *","paymentDate",r.paymentDate || (id?"":today()))}</div><div id="partial-field">${moneyInput("Valor já pago (R$)","paidCents",paid(r))}</div>`+selectField("Situação","status",STATUS,r.status || "na_fila")+`<div class="span-2" id="installment-section" hidden><div class="installment-toolbar">${field("Número de pagamentos *","installmentCount",installmentsOf(r).length || 2,"number",'min="1" max="120" step="1" required')}<button type="button" class="secondary" data-distribute>Distribuir total entre parcelas</button></div><p class="form-hint">Defina datas e valores. Marque Paga ao receber cada parcela.</p><div id="installment-rows"></div><p id="installment-summary" class="form-hint" aria-live="polite"></p></div><div class="span-2"><p id="order-total" class="form-hint"></p></div>`;
  if (kind==="expenses") fields=field("Nome *","name",r.name,"text",'required maxlength="180"')+selectField("Tipo","type",EXPENSE_TYPES,r.type || "unico")+dateField("Data *","date",r.date || today())+dateField("Data de vencimento *","dueDate",r.dueDate || today())+moneyInput("Valor (R$) *","amountCents",r.amountCents)+selectField("Situação","payment",{pago:"Pago",nao_pago:"Não pago"},r.payment || "nao_pago");
  if (kind==="stock") fields=field("Nome *","name",r.name,"text",'required maxlength="180"')+field("Marca","brand",r.brand,"text",'maxlength="180"')+selectField("Tipo","type",STOCK_TYPES,r.type || "filamento")+dateField("Data de entrada *","date",r.date || today())+field("Quantidade inicial *","initialQuantity",r.initialQuantity ?? 1,"number",'min="0.001" max="1000000000" step="0.001" required')+moneyInput("Preço unitário (R$) *","unitCents",r.unitCents,6)+moneyInput("Preço total (R$) *","totalCents",id?stockValue(r):0)+field("Quantidade atual *","currentQuantity",r.currentQuantity ?? 1,"number",'min="0" max="1000000000" step="0.001" required')+'<p class="span-2 form-hint" id="stock-hint"></p>';
  if (kind==="clients" || kind==="products") fields=field(kind==="clients"?"Nome do cliente *":"Nome do produto *","name",r.name,"text",'required maxlength="180"')+(kind==="products"?moneyInput("Preço unitário (R$) *","unitCents",r.unitCents)+optionalMoneyInput("Preço de filamento (R$)","filamentPriceCents",r.filamentPriceCents)+field("Quantidade de filamento (g)","filamentGrams",r.filamentGrams ?? "","number",'min="0" max="1000000000" step="0.001" placeholder="Opcional"')+optionalMoneyInput("Custo (R$)","costCents",r.costCents)+'<p class="span-2 form-hint">Preencha os valores de filamento e custo para seu controle. Estes campos são opcionais e aparecem somente no cadastro de produtos.</p>':"");
  if (kind==="orders" || kind==="stock") fields+=`<div class="span-2"><label for="f-notes">Observações (opcional)</label><textarea id="f-notes" name="notes" maxlength="5000">${esc(r.notes || "")}</textarea></div>`;
  openModal(`${id?"Editar":"Cadastrar"} ${{orders:"encomenda",expenses:"despesa",stock:"item de estoque",clients:"cliente",products:"produto"}[kind]}`,`<form id="record-form" data-kind="${kind}" data-id="${id}" data-rev="${r.rev || 0}"><div class="form-grid">${fields}</div>${formFooter()}</form>`);
  const f=$("#record-form"); f.recordBaseline=id?r:null; f.installmentAmountsCustomized=!!id && r.paymentMode==="parcelado";
  if (kind==="orders" && r.paymentMode==="parcelado") {
    f.installmentDraft=installmentsOf(r).map(p=>({dateText:brDate(p.date),amountText:(p.amountCents/100).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2}),paid:p.paid})); drawInstallments(f);
  }
  syncForm();
}
function syncForm(changed="") {
  const f=$("#record-form"); if (!f) return;
  const v=n=>f.elements.namedItem(n), kind=f.dataset.kind;
  if (kind==="orders") {
    const installment=v("paymentMode").value==="parcelado";
    $("#installment-section").hidden=!installment; $("#total-date-field").hidden=installment;
    v("paymentDate").disabled=installment; $("#total-date-field [type=date]").disabled=installment;
    v("installmentCount").disabled=!installment;
    if (installment && !f.installmentDraft?.length) {resizeInstallments(f,v("installmentCount").value);return;}
    f.querySelectorAll("[data-installment-row] input").forEach(input=>input.disabled=!installment);
    if (installment) {
      const draft=captureInstallments(f); let allocated=0,received=0;
      try {
        for (const p of draft) {const cents=Math.round(amount(p.amountText)*100);allocated+=cents;if(p.paid) received+=cents;}
        v("payment").value=draft.every(p=>p.paid)?"pago":draft.some(p=>p.paid)?"parcial":"nao_pago";
        v("paidCents").value=(received/100).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2});
        $("#installment-summary").textContent=`Parcelas: ${money(allocated)} · Recebido: ${money(received)} · Diferença para o total: ${money(formTotal(f)-allocated)}`;
      } catch {$("#installment-summary").textContent="Preencha os valores das parcelas.";}
    }
    v("payment").disabled=installment;
    const partial=!installment && v("payment").value==="parcial"; $("#partial-field").hidden=!partial; v("paidCents").disabled=!partial;
    try { $("#order-total").textContent="Total da encomenda: "+money(Math.round(amount(v("unitCents").value)*100)*numeric(v("quantity").value,true)); } catch { $("#order-total").textContent="Preencha a quantidade e o valor unitário."; }
  }
  if (kind==="stock") {
    const filament=v("type").value==="filamento", step=filament?"0.001":"1";
    v("initialQuantity").step=step; v("initialQuantity").min=filament?"0.001":"1"; v("currentQuantity").step=step;
    $("#stock-hint").textContent=filament?"Quantidade em kg; preço por 1 kg. Saldo máximo igual à quantidade inicial.":"Quantidade em unidades inteiras; preço por unidade. Saldo máximo igual à quantidade inicial.";
    if (["initialQuantity","unitCents","totalCents"].includes(changed)) {
      try {
        const q=numeric(v("initialQuantity").value), fmt=n=>n.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:6});
        if (changed==="totalCents" && q>0) v("unitCents").value=fmt(amount(v("totalCents").value)/q);
        else v("totalCents").value=(Math.round(amount(v("unitCents").value)*q*100)/100).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2});
        if (!f.dataset.id && changed==="initialQuantity") v("currentQuantity").value=q;
      } catch { /* Não interrompe valores ainda em digitação. */ }
    }
  }
}
function paymentValues(value,totalCents,partialCents=0) {
  if (!Object.hasOwn(PAYMENT,value)) throw Error("Escolha um pagamento válido.");
  const paidCents=value==="pago"?totalCents:value==="nao_pago"?0:partialCents;
  if (value==="parcial" && (paidCents<=0 || paidCents>=totalCents)) throw Error("O pagamento parcial deve ser maior que zero e menor que o total.");
  return { payment:value,paidCents };
}
async function saveRecord(kind,id,patch,rev=0,deleteRecord=false) {
  guard();
  if (pending.has(kind+id)) throw Error("Este registro já está sendo atualizado.");
  pending.add(kind+id);
  try {
    const timestamp=firebase.database.ServerValue.TIMESTAMP;
    if (!id) { const r=db.ref("atho3d/"+kind).push(); await r.set({...patch,createdAt:timestamp,updatedAt:timestamp,createdBy:user.uid,updatedBy:user.uid,rev:1}); return; }
    const result=await db.ref(`atho3d/${kind}/${id}`).transaction(current=> {
      if (!current || current.rev!==rev) return;
      if (deleteRecord) return null;
      return {...current,...patch,rev:current.rev+1,updatedAt:timestamp,updatedBy:user.uid};
    },undefined,false);
    if (!result.committed) throw Error("O registro foi alterado por outro usuário. Feche a janela e abra novamente para conferir os dados atuais.");
  } finally { pending.delete(kind+id); }
}
async function submitRecord(f) {
  const v=n=>f.elements.namedItem(n)?.value || "", kind=f.dataset.kind;
  const existing=f.recordBaseline || data[kind].find(r=>r.id===f.dataset.id);
  let patch=(kind==="clients" || kind==="products")?{name:text(v("name"),"Nome"),date:existing?.date || today()}:{name:kind==="orders"?v("name").trim():text(v("name"),"Nome"),date:isoDate(v("date"))};
  if (kind==="orders") {
    const quantity=numeric(v("quantity"),true), unitCents=Math.round(amount(v("unitCents"))*100);
    if (quantity<1) throw Error("A quantidade deve ser pelo menos 1.");
    if (!Object.hasOwn(STATUS,v("status"))) throw Error("Situação inválida.");
    const client=resolveSelection(f,"client","clients",existing), product=resolveSelection(f,"product","products",existing);
    patch={...patch,name:text(patch.name || product.name,"Encomenda"),client:client.name,clientId:client.id,product:product.name,productId:product.id,deadline:isoDate(v("deadline")),quantity,unitCents,notes:v("notes").trim(),status:v("status")};
    if (patch.deadline<patch.date) throw Error("O prazo deve ser igual ou posterior à data da encomenda.");
    if (unitCents*quantity>Number.MAX_SAFE_INTEGER) throw Error("O total informado é muito alto.");
    if (!Object.hasOwn(PAYMENT_MODES,v("paymentMode"))) throw Error("Selecione a forma de pagamento.");
    if (v("paymentMode")==="parcelado") {
      const plan=readPlan(f); if (Object.keys(plan).length!==Number(v("installmentCount"))) throw Error("Confira o número de pagamentos e os campos das parcelas.");
      patch={...patch,...planPatch(patch,plan)};
    } else patch={...patch,paymentMode:"total",paymentDate:isoDate(v("paymentDate")),installments:null,installmentCount:null,...paymentValues(v("payment"),unitCents*quantity,Math.round(amount(v("paidCents") || "0")*100))};
  }
  if (kind==="expenses") {
    if (!Object.hasOwn(EXPENSE_TYPES,v("type")) || !["pago","nao_pago"].includes(v("payment"))) throw Error("Tipo ou situação inválidos.");
    patch={...patch,dueDate:isoDate(v("dueDate")),amountCents:Math.round(amount(v("amountCents"))*100),type:v("type"),payment:v("payment")};
  }
  if (kind==="stock") {
    const filament=v("type")==="filamento", initialQuantity=numeric(v("initialQuantity"),!filament), currentQuantity=numeric(v("currentQuantity"),!filament), unitCents=Math.round(amount(v("unitCents"))*100000000)/1000000;
    if (!Object.hasOwn(STOCK_TYPES,v("type"))) throw Error("Tipo inválido.");
    if (initialQuantity<=0 || currentQuantity>initialQuantity) throw Error("A quantidade inicial deve ser positiva e o saldo deve estar entre zero e a quantidade inicial.");
    if (stockValue({unitCents,initialQuantity})>Number.MAX_SAFE_INTEGER) throw Error("O total informado é muito alto.");
    if (v("brand").trim().length>180) throw Error("Marca: limite de 180 caracteres.");
    patch={...patch,brand:v("brand").trim(),type:v("type"),initialQuantity,currentQuantity,unitCents,notes:v("notes").trim()};
  }
  if (kind==="products") patch={...patch,unitCents:Math.round(amount(v("unitCents"))*100),
    filamentPriceCents:v("filamentPriceCents").trim()?Math.round(amount(v("filamentPriceCents"))*100):null,
    filamentGrams:v("filamentGrams").trim()?numeric(v("filamentGrams")):null,
    costCents:v("costCents").trim()?Math.round(amount(v("costCents"))*100):null};
  if ((patch.notes || "").length>5000) throw Error("Observações: limite de 5.000 caracteres.");
  await saveRecord(kind,f.dataset.id,patch,+f.dataset.rev); toast("Registro salvo.");
}
function viewRecord(kind,id) {
  const r=data[kind].find(x=>x.id===id); if (!r) return;
  let details=[["Nome",r.name],["Data",brDate(r.date)]];
  if (kind==="orders") details=[["Cliente",r.client],["Encomenda",r.name],["Produto",r.product || r.name],["Data",brDate(r.date)],["Prazo",brDate(r.deadline)],["Quantidade",decimal(r.quantity)],["Valor unitário",money(r.unitCents)],["Total",money(total(r))],["Forma de pagamento",PAYMENT_MODES[r.paymentMode || "total"]],["Pagamento",PAYMENT[r.payment]],...(r.paymentMode!=="parcelado"?[["Data de pagamento",brDate(r.paymentDate)]]:[]),["Valor recebido",money(paid(r))],["A receber",money(total(r)-paid(r))],["Situação",STATUS[r.status]]];
  if (kind==="expenses") details.push(["Vencimento",brDate(r.dueDate)],["Valor",money(r.amountCents)],["Tipo",EXPENSE_TYPES[r.type]],["Situação",PAYMENT[r.payment]]);
  if (kind==="stock") details.push(["Marca",r.brand || "—"],["Tipo",STOCK_TYPES[r.type]],["Quantidade inicial",`${decimal(r.initialQuantity)} ${unit(r)}`],["Quantidade gasta",`${decimal(stockUsed(r))} ${unit(r)}`],["Quantidade atual",`${decimal(r.currentQuantity)} ${unit(r)}`],["Preço unitário",money(r.unitCents)],["Preço total inicial",money(stockValue(r))]);
  if (kind!=="expenses") details.push(["Observações",r.notes || "—"]);
  openModal("Visualizar registro",`<dl class="view-grid">${details.map(([label,value])=>`<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join("")}${kind==="orders" && r.paymentMode==="parcelado"?`<div class="span-2"><dt>Parcelas (${installmentsOf(r).length})</dt><dd>${scheduleDetails(r)}</dd></div>`:""}</dl><div class="form-footer"><button class="secondary" data-close>Fechar</button></div>`);
}
function deleteModal(kind,id) {
  const r=data[kind].find(x=>x.id===id); if (!r) return;
  openModal("Confirmar exclusão",`<p class="delete-warning">Excluir <strong>${esc(r.name)}</strong>? Esta ação remove o registro do banco.${kind==="clients" || kind==="products"?" As encomendas existentes e seus valores serão preservados.":""} Digite a senha de <strong>${esc($("#user-name").textContent)}</strong> para confirmar.</p><form id="delete-form" data-kind="${kind}" data-id="${id}" data-rev="${r.rev}"><label for="delete-password">Sua senha</label><input id="delete-password" type="password" required autocomplete="current-password"><p class="error" id="form-error" role="alert"></p><div class="form-footer"><button type="button" class="secondary" data-close>Cancelar</button><button class="danger" type="submit">Confirmar exclusão</button></div></form>`);
}
function installmentPaymentModal(r) {
  openModal("Confirmar parcelas pagas",`<p class="muted">${esc(r.client)} · ${esc(r.product || r.name)} · Total ${money(total(r))}</p><form id="installment-payment-form" data-id="${r.id}" data-rev="${r.rev}"><div class="payment-checks">${installmentsOf(r).map((p,i)=>`<label class="payment-check"><input type="checkbox" name="paid-${p.id}" data-payment-check data-cents="${p.amountCents}" ${p.paid?"checked":""}><span>Parcela ${i+1} · ${esc(brDate(p.date))}</span><strong>${money(p.amountCents)}</strong></label>`).join("")}</div><p id="payment-check-summary" class="form-hint"></p>${formFooter()}</form>`);
  $("#installment-payment-form").paymentBaseline=r; paymentCheckSummary();
}
function paymentCheckSummary() {
  const f=$("#installment-payment-form"); if (!f) return;
  const checks=[...f.querySelectorAll("[data-payment-check]")], value=sum(checks,c=>c.checked?Number(c.dataset.cents):0);
  $("#payment-check-summary").textContent=`${PAYMENT[checks.every(c=>c.checked)?"pago":checks.some(c=>c.checked)?"parcial":"nao_pago"]} · Recebido: ${money(value)}`;
}
async function inlineChange(el) {
  const kind=el.dataset.kind, r=data[kind].find(x=>x.id===el.dataset.id), field=el.dataset.inline, choice=el.value;
  if (!r || choice===r[field]) return;
  el.value=r[field];
  if (kind==="orders" && field==="payment" && r.paymentMode==="parcelado") {
    if (choice==="parcial") {installmentPaymentModal(r);return;}
    try {
      el.disabled=true; const plan=Object.fromEntries(installmentsOf(r).map(p=>[p.id,{...p,paid:choice==="pago"}]));
      await saveRecord(kind,r.id,planPatch(r,plan),r.rev);toast("Parcelas atualizadas.");
    } catch(e) {toast(fail(e),true);render();} finally {el.disabled=false;} return;
  }
  if (kind==="orders" && field==="payment" && choice==="parcial") {
    openModal("Registrar pagamento parcial",`<p>Total da encomenda: <strong>${money(total(r))}</strong></p><form id="partial-form" data-id="${r.id}" data-rev="${r.rev}"><div class="form-grid">${moneyInput("Total já recebido (R$)","partialCents",r.paidCents)}</div><p class="form-hint">Informe o valor acumulado já pago, não apenas a última parcela.</p>${formFooter()}</form>`); return;
  }
  try { el.disabled=true; await saveRecord(kind,r.id,kind==="orders" && field==="payment"?paymentValues(choice,total(r)):{[field]:choice},r.rev); toast("Atualizado."); }
  catch(e) {toast(fail(e),true);render();} finally { el.disabled=false; }
}
function stockRemaining(r,value) {
  const used=numeric(value,r.type!=="filamento");
  if (used>r.initialQuantity) throw Error("A quantidade gasta não pode exceder a quantidade inicial.");
  return Math.round((r.initialQuantity-used)*1000)/1000;
}
function stockPreview(el) {
  const r=el.stockBaseline || data.stock.find(x=>x.id===el.dataset.id); if (!r) return;
  el.stockBaseline ??= {...r};
  const output=el.closest(".stock-control").querySelector("[data-stock-remaining]");
  try {output.textContent=decimal(stockRemaining(r,el.value));el.setAttribute("aria-invalid","false");}
  catch {output.textContent="—";el.setAttribute("aria-invalid","true");}
}
async function stockChange(el) {
  const r=el.stockBaseline || data.stock.find(x=>x.id===el.dataset.id); if (!r) return;
  try {
    const quantity=stockRemaining(r,el.value);
    if (quantity===r.currentQuantity) return;
    el.disabled=true; await saveRecord("stock",r.id,{currentQuantity:quantity},r.rev); toast("Saldo atualizado.");
  } catch(e) {toast(fail(e),true);render();} finally {el.disabled=false;}
}

// Eventos delegados continuam funcionando depois de cada atualização da tabela.
document.addEventListener("click",e=> {
  const b=e.target.closest("button"); if (!b) return;
  if (b.dataset.nav) navigate(b.dataset.nav);
  if (b.dataset.create) editForm(b.dataset.create);
  if (b.dataset.comboOpen) showPicker(b.dataset.comboOpen);
  if (b.dataset.comboChoice) choosePicker(b.dataset.comboChoice,b.dataset.id);
  if (b.hasAttribute("data-distribute")) {
    const f=$("#record-form"); try {resizeInstallments(f,f.elements.namedItem("installmentCount").value,true);f.installmentAmountsCustomized=false;$("#form-error").textContent="";} catch(e) {$("#form-error").textContent=fail(e);}
  }
  if (b.hasAttribute("data-close")) closeModal();
  if (b.dataset.sort) { const s=sorts[page]; sorts[page]={key:b.dataset.sort,dir:s.key===b.dataset.sort?-s.dir:1}; render(); }
  if (b.hasAttribute("data-sort-direction")) {sorts[page].dir*=-1;render();}
  if (b.hasAttribute("data-clear")) {filters[page]={};render();}
  if (b.dataset.action) { const {kind,id,action}=b.dataset; if (action==="edit") editForm(kind,id); if (action==="view") viewRecord(kind,id); if (action==="delete") deleteModal(kind,id); }
  if (b.dataset.alert==="expenses") {filters.expenses={payment:"nao_pago",due:"soon"};sorts.expenses={key:"dueDate",dir:1};navigate("expenses");}
  if (b.dataset.alert==="orders") {filters.orders={payment:"nao_pago",status:"entregue"};sorts.orders={key:"deadline",dir:1};navigate("orders");}
});
document.addEventListener("input",e=> {
  const el=e.target;
  if (el.dataset.catalogSearch) {filters.catalog[el.dataset.catalogSearch]=el.value;render();}
  if (el.dataset.comboInput) {
    const f=$("#record-form"); f.elements.namedItem(el.dataset.comboInput+"Id").value="";
    showPicker(el.dataset.comboInput,el.value);
  }
  if (el.dataset.filter && el.type==="text") {filters[page][el.dataset.filter]=el.value;render();}
  if (el.dataset.dateText) { const digits=el.value.replace(/\D/g,"").slice(0,8); el.value=digits.slice(0,2)+(digits.length>2?"/"+digits.slice(2,4):"")+(digits.length>4?"/"+digits.slice(4):""); }
  if (el.closest("#record-form")) {if(el.name.startsWith("instAmount-")) $("#record-form").installmentAmountsCustomized=true;syncForm(el.name);}
  if (el.dataset.stock==="used") stockPreview(el);
});
document.addEventListener("change",e=> {
  const el=e.target;
  if (el.dataset.filter) { filters[page][el.dataset.filter]=el.value;render(); }
  if (el.hasAttribute("data-sort-select")) { sorts[page].key=el.value;render(); }
  if (el.dataset.calendar) {const t=$("#f-"+el.dataset.calendar); t.value=el.value?brDate(el.value):"";}
  if (el.dataset.dateText) { try {el.closest(".date-entry").querySelector('[type="date"]').value=isoDate(el.value);} catch {} }
  if (el.dataset.inline) inlineChange(el);
  if (el.dataset.stock) stockChange(el);
  if (el.hasAttribute("data-payment-check")) paymentCheckSummary();
  if (el.closest("#record-form") && el.name==="installmentCount") {
    const f=$("#record-form"); try {resizeInstallments(f,el.value,!f.installmentAmountsCustomized);$("#form-error").textContent="";} catch(e) {el.value=f.installmentDraft?.length || 2;$("#form-error").textContent=fail(e);}
  }
  if (el.closest("#record-form") && el.tagName==="SELECT") syncForm(el.name);
});
document.addEventListener("focusin",e=>{if (e.target.dataset.comboInput) showPicker(e.target.dataset.comboInput);});
document.addEventListener("click",e=>{document.querySelectorAll("[data-combo]").forEach(w=>{if (!w.contains(e.target)) hidePicker(w.dataset.combo);});});
document.addEventListener("keydown",e=>{
  const prefix=e.target.dataset.comboInput; if (!prefix) return;
  const wrapper=$("#combo-"+prefix), list=wrapper.querySelector("[role=listbox]");
  if (e.key==="Escape" || e.key==="Tab") {hidePicker(prefix);if(e.key==="Escape") e.preventDefault();return;}
  if (["ArrowDown","ArrowUp"].includes(e.key)) {
    e.preventDefault();if(list.hidden) showPicker(prefix);
    const choices=[...list.querySelectorAll("[data-combo-choice]")]; if(!choices.length) return;
    const current=Number(wrapper.dataset.index ?? -1);
    let index=e.key==="ArrowDown"?current+1:current<0?choices.length-1:current-1;
    index=(index+choices.length)%choices.length;wrapper.dataset.index=index;
    choices.forEach((c,i)=>c.setAttribute("aria-selected",String(i===index)));
    e.target.setAttribute("aria-activedescendant",choices[index].id);choices[index].scrollIntoView({block:"nearest"});
  }
  if (e.key==="Enter" && !list.hidden) {
    e.preventDefault();const choices=[...list.querySelectorAll("[data-combo-choice]")], index=Number(wrapper.dataset.index);
    if (choices[index]) choosePicker(prefix,choices[index].dataset.id);else if(choices.length===1) choosePicker(prefix,choices[0].dataset.id);
  }
});
document.addEventListener("submit",async e=> {
  const f=e.target;
  if (!["record-form","delete-form","partial-form","installment-payment-form"].includes(f.id)) return;
  e.preventDefault(); if (modalBusy) return; modalBusy=true;
  const button=f.querySelector('[type="submit"]'); button.disabled=true; $("#form-error").textContent="";
  try {
    if (f.id==="record-form") await submitRecord(f);
    if (f.id==="partial-form") {const r=data.orders.find(x=>x.id===f.dataset.id); if (!r) throw Error("Encomenda não encontrada."); await saveRecord("orders",r.id,paymentValues("parcial",total(r),Math.round(amount(f.elements.namedItem("partialCents").value)*100)),+f.dataset.rev);toast("Pagamento atualizado.");}
    if (f.id==="installment-payment-form") {
      const r=f.paymentBaseline;
      const plan=Object.fromEntries(installmentsOf(r).map(p=>[p.id,{...p,paid:f.elements.namedItem("paid-"+p.id).checked}]));
      await saveRecord("orders",r.id,planPatch(r,plan),+f.dataset.rev);toast("Pagamentos das parcelas atualizados.");
    }
    if (f.id==="delete-form") {
      guard(); const credential=firebase.auth.EmailAuthProvider.credential(user.email,$("#delete-password").value);
      await user.reauthenticateWithCredential(credential); await user.getIdToken(true);
      await saveRecord(f.dataset.kind,f.dataset.id,{},+f.dataset.rev,true);toast("Registro excluído.");
    }
    modalBusy=false; closeModal();
  } catch(e) { if ($("#form-error")) $("#form-error").textContent=fail(e); }
  finally {modalBusy=false;button.disabled=false;}
});
$("#login-form").addEventListener("submit",async e=> {
  e.preventDefault();$("#login-error").textContent="";const button=e.target.querySelector("button");button.disabled=true;
  try {if (!auth) throw Error("Configure a URL do Realtime Database e recarregue.");await auth.signInWithEmailAndPassword(USERS[$("#login-user").value],$("#login-password").value);$("#login-password").value="";}
  catch(e) {$("#login-error").textContent=fail(e);} finally {button.disabled=false;}
});
$("#connection-form").addEventListener("submit",e=> {
  e.preventDefault(); const value=$("#database-url").value.trim();
  try { const url=new URL(value); if (url.protocol!=="https:" || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.(firebaseio\.com|firebasedatabase\.app)$/.test(url.hostname) || url.pathname!=="/") throw Error("Informe a URL raiz do banco Firebase, sem caminhos adicionais.");localStorage.setItem("atho3d.databaseURL",url.origin);location.reload(); }
  catch(e) {$("#login-error").textContent=fail(e);}
});
$("#menu-toggle").addEventListener("click",()=>setMenu(document.body.classList.contains("menu-closed")));
$("#menu-close").addEventListener("click",()=>setMenu(false));
$("#modal-close").addEventListener("click",()=>closeModal());
$("#modal").addEventListener("cancel",e=>{e.preventDefault();closeModal();});
$("#logout").addEventListener("click",async ()=> {if (modalBusy) return;try {await auth.signOut();} catch(e) {toast(fail(e),true);}});
document.querySelectorAll(".logo-box img").forEach(img=>{img.addEventListener("error",()=>img.hidden=true);if (img.complete && !img.naturalWidth) img.hidden=true;});
initialize();
