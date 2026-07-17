// Barter Box — сервер (Express + JSON-хранилище на диске)
// Общая база для всех, кто открывает ссылку: менеджер, маркетолог и водители
// видят и меняют одни и те же данные одновременно.
//
// Хранилище — не SQLite: у SQLite есть нативный биндинг, который надо
// компилировать под конкретную ОС/архитектуру, а это часто рвётся при
// деплое на бесплатный хостинг без интернета к репозиториям сборки.
// Здесь вместо этого простой JSON-файл на диске + всё состояние в памяти
// процесса — для 5 000 записей и 20 одновременных пользователей этого
// с большим запасом достаточно, и работает гарантированно на любом хостинге.
"use strict";

const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");

// DATA_DIR/UPLOADS_DIR можно переопределить переменными окружения — это нужно,
// когда на хостинге (например, Render) подключён постоянный диск на отдельном
// пути: тогда оба указывают на подпапки внутри смонтированного диска, и данные
// переживают перезапуск/передеплой контейнера. Без переменных — как раньше,
// рядом с server.js (локальный запуск, Docker с volume).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, "uploads");
const STATE_PATH = path.join(DATA_DIR, "state.json");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const PLATFORMS = ["Instagram Reels","Instagram Stories","TikTok","YouTube Shorts","Отзыв / пост"];
const BLOGGER_TIERS = ["Малый (эффект 1–7 дней)","Крупный (эффект 2–3 недели)"];
const CAMPAIGN_STAGES = [
  "Запланирован","Концепция","Товары выбраны","Упаковка заказана","Упаковка оплачена",
  "Упаковка на складе","Товары в офисе","Скомплектовано","В доставке","Учёт закрыт","Проект закрыт"
];
const RETURN_STATUSES = ["В офисе","Ожидает решения","Оформлен возврат","Принят на складе","Закрыт"];
const DEAL_STATUSES = ["Запланирована","Опубликована","Оплачена","Закрыта"];

// ---------- Авторизация менеджера/логиста и маркетолога ----------
// Пара логин/пароль — общая на роль (как код у водителей), задаётся переменными
// окружения на хостинге (Render → Environment), а НЕ хранится в коде: репозиторий
// публичный, поэтому реальные значения не должны попадать в git.
const AUTH = {
  manager:  {login: process.env.MANAGER_LOGIN  || null, password: process.env.MANAGER_PASSWORD  || null},
  marketer: {login: process.env.MARKETER_LOGIN || null, password: process.env.MARKETER_PASSWORD || null},
};
const authTokens = new Map(); // token -> role

/* =========================================================================
   1. ХРАНИЛИЩЕ: всё состояние — один объект в памяти, зеркалится в JSON-файл
   ========================================================================= */
function emptyState(){ return {drivers:[], campaigns:[], orders:[], returns:[], publications:[], influencerDeals:[], salesByDay:[]}; }

function seedState(){
  const drivers = [
    {code:"IVAN-77",    name:"Иван Петров",   phone:"+7 701 200 10 10", city:"Алматы", type:"внешний",  active:true},
    {code:"SERGEY-24",  name:"Сергей Ким",    phone:"+7 701 200 10 20", city:"Алматы", type:"внешний",  active:true},
    {code:"DANIYAR-31", name:"Данияр Абдиев", phone:"+7 701 200 10 30", city:"Астана", type:"внешний",  active:true},
    {code:"MARAT-08",   name:"Марат Оспанов", phone:"+7 701 200 10 40", city:"Алматы", type:"внутренний",active:true},
  ];
  const campaigns = [
    {id:1, name:"Barter-боксы / Июль / Топ-5 товаров", city:"Алматы + Астана", period:"Июль 2026",
     responsible:"Сауле", boxType:"Уход премиум", plannedCount:500, stage:"В доставке", budget:1200000},
  ];
  const now = new Date();
  const days = (n)=> new Date(now.getTime()+n*24*3600*1000);
  const fmt = (d)=> d.toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
  const fmtDate = (d)=> d.toISOString().slice(0,10);
  const seedOrders = [
    ["IVAN-77","@aizhan_beauty","+7 701 555 01 01","Алматы","ул. Абая 150, кв. 12","Уход премиум","delivered"],
    ["IVAN-77","@moldir_mua","+7 701 555 01 03","Алматы","мкр Самал-2, д. 33","Уход премиум","assigned"],
    ["IVAN-77","@dias_music","+7 701 555 01 13","Алматы","ул. Байтурсынова 12","Уход премиум","no_answer"],
    ["IVAN-77","@kuanysh_fit","+7 701 555 01 20","Алматы","ул. Тимирязева 42","Уход премиум","assigned"],
    ["SERGEY-24","@laura_fashion","+7 701 555 01 04","Алматы","ул. Жандосова 58, оф. 4","Уход премиум","delivered"],
    ["SERGEY-24","@sanzhar.vlog","+7 701 555 01 05","Алматы","ул. Толе би 200","Уход премиум","addr_bad"],
    ["SERGEY-24","@aida_skincare","+7 701 555 01 08","Алматы","ул. Гоголя 89","Уход премиум","assigned"],
    ["SERGEY-24","@alina_glow","+7 701 555 01 19","Алматы","ул. Шевченко 165","Бьюти-бокс","assigned"],
    ["DANIYAR-31","@dana.style","+7 701 555 01 02","Астана","пр. Кабанбай батыра 40","Уход премиум","delivered"],
    ["DANIYAR-31","@zhanna_cook","+7 701 555 01 07","Астана","ул. Сыганак 18, кв. 44","Уход премиум","absent"],
    ["DANIYAR-31","@erlan_review","+7 701 555 01 09","Астана","пр. Туран 22, оф. 7","Уход премиум","assigned"],
    ["DANIYAR-31","@madina.lux","+7 701 555 01 10","Астана","ул. Достык 5, кв. 90","Уход премиум","reschedule"],
    ["MARAT-08","@beka_tech","+7 701 555 01 11","Алматы","ул. Сатпаева 90/1","Гаджет-набор","created"],
    ["MARAT-08","@kamila_home","+7 701 555 01 12","Алматы","мкр Аксай-4, д. 22","Бьюти-бокс","created"],
    ["MARAT-08","@gulnara_mom","+7 701 555 01 18","Алматы","мкр Коктем-1, д. 3","Бьюти-бокс","returned"],
  ];
  const orders = seedOrders.map((r,i)=>{
    const [driverCode, blogger, phone, city, address, box, status] = r;
    const isTerminal = status!=="created" && status!=="assigned";
    return {
      id:i+1, campaignId:1, driverCode: status==="created" ? null : driverCode,
      blogger, phone, city, address, box, comment:"",
      status, closureType: status==="delivered" ? (i%2===0?"writeoff":"sale") : null,
      photo: status==="delivered" ? "" : null,
      driverComment: status==="no_answer" ? "Звонил 2 раза, не ответили" :
                     status==="addr_bad" ? "Уехала в другой город, новый адрес уточняется" :
                     status==="absent" ? "Никого нет дома, домофон не отвечает" :
                     status==="reschedule" ? "Просила перенести на следующую неделю" :
                     status==="returned" ? "Не дозвонились 3 дня, возврат в офис" : "",
      assignedAt: status==="created" ? null : fmt(now),
      deliveredAt: isTerminal ? fmt(now) : null,
      bitrixSynced: status==="delivered" ? (i%3===0) : false,
    };
  });
  const returns = [
    {id:1, campaignId:1, item:"Уход премиум — набор (6 шт.)", qty:6, status:"В офисе"},
    {id:2, campaignId:1, item:"Бьюти-бокс — упаковка (3 шт.)", qty:3, status:"Ожидает решения"},
  ];
  const publications = [
    {
      id:1, orderId:1, platform:"Instagram Reels", link:"https://instagram.com/reel/demo-aizhan",
      publishedAt: fmtDate(days(-5)), tier: BLOGGER_TIERS[0], promoCode:"AIZHAN15",
      measurements:[
        {id:1, date:fmtDate(days(-3)), views:8200, likes:410, comments:38, saves:52, salesCount:6, salesRevenue:54000, note:"Через 2 дня после публикации"},
        {id:2, date:fmtDate(now),      views:15400, likes:780, comments:71, saves:120, salesCount:14, salesRevenue:126000, note:"Через 5 дней"},
      ],
    },
    {
      id:2, orderId:9, platform:"Instagram Reels", link:"https://instagram.com/reel/demo-dana",
      publishedAt: fmtDate(days(-21)), tier: BLOGGER_TIERS[1], promoCode:"DANA20",
      measurements:[
        {id:3, date:fmtDate(days(-14)), views:98000,  likes:5200,  comments:340, saves:610,  salesCount:52,  salesRevenue:468000,  note:"Через неделю"},
        {id:4, date:fmtDate(now),       views:214000, likes:11800, comments:702, saves:1450, salesCount:131, salesRevenue:1179000, note:"Через 3 недели, пик охвата"},
      ],
    },
  ];

  // Демо: крупные инфлюенс-интеграции + история продаж (для расчёта ROMI с кривой затухания)
  const influencerDeals = [
    {id:1, blogerLogin:"@dana.style", platform:"Instagram Reels", product:"Уход премиум",
     plannedDate: fmtDate(days(-14)), publishedDate: fmtDate(days(-14)),
     plannedReach:150000, plannedClicks:3000, reach:214000, clicks:4100,
     likes:0, comments:0, saves:0, lastUpdatedFrom:"", lastUpdatedAt:"",
     cost:350000, status:"Опубликована", notes:"Крупный блогер, охват выше плана"},
    {id:2, blogerLogin:"@erlan_review", platform:"YouTube Shorts", product:"Уход премиум",
     plannedDate: fmtDate(days(-6)), publishedDate: fmtDate(days(-6)),
     plannedReach:80000, plannedClicks:1500, reach:76000, clicks:1300,
     likes:0, comments:0, saves:0, lastUpdatedFrom:"", lastUpdatedAt:"",
     cost:220000, status:"Опубликована", notes:""},
  ];
  const salesByDay = [];
  // 21 день истории по товару "Уход премиум": база ~40 продаж/день + всплески в дни постов
  for(let i=-20;i<=0;i++){
    const d = fmtDate(days(i));
    let revenue = 40 + Math.round(Math.random()*6-3); // база с небольшим шумом
    if(i===-14) revenue += 90;      // день публикации @dana.style
    else if(i===-13) revenue += 45; // +1 день, 50% затухания
    else if(i===-12) revenue += 18; // +2 дня, 20% затухания
    else if(i===-6) revenue += 50;  // день публикации @erlan_review
    else if(i===-5) revenue += 25;
    else if(i===-4) revenue += 10;
    salesByDay.push({id: salesByDay.length+1, date:d, product:"Уход премиум", revenue: revenue*3500});
  }

  return {drivers, campaigns, orders, returns, publications, influencerDeals, salesByDay};
}

let state = loadState();

function loadState(){
  try{
    if(fs.existsSync(STATE_PATH)){
      const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
      const merged = Object.assign(emptyState(), raw);
      Object.keys(emptyState()).forEach(k=>{ if(!Array.isArray(merged[k])) merged[k] = []; });
      return merged;
    }
  }catch(e){ console.error("Не удалось прочитать state.json, создаю заново:", e.message); }
  const seeded = seedState();
  fs.writeFileSync(STATE_PATH, JSON.stringify(seeded));
  return seeded;
}

let persistScheduled = false;
function persist(){
  // асинхронная запись, чтобы не блокировать event loop под нагрузкой от 20 пользователей;
  // in-memory state уже обновлён синхронно к этому моменту, так что читатели всегда видят
  // свежие данные независимо от того, успела ли запись на диск закончиться.
  if(persistScheduled) return;
  persistScheduled = true;
  setImmediate(()=>{
    persistScheduled = false;
    fs.writeFile(STATE_PATH, JSON.stringify(state), (err)=>{
      if(err) console.error("Ошибка сохранения state.json:", err.message);
    });
  });
}

function nextId(collection){
  const items = state[collection];
  return items.reduce((m,i)=>Math.max(m, i.id||0), 0) + 1;
}
function nextMeasurementId(){
  let max = 0;
  state.publications.forEach(p=> p.measurements.forEach(m=>{ if(m.id>max) max=m.id; }));
  return max + 1;
}

/* =========================================================================
   2. Express app
   ========================================================================= */
const app = express();
app.use(express.json({limit: "2mb"}));
app.use("/uploads", express.static(UPLOADS_DIR, {maxAge: "30d"}));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req,file,cb)=> cb(null, UPLOADS_DIR),
    filename: (req,file,cb)=>{
      const ext = path.extname(file.originalname) || ".jpg";
      cb(null, `order-${req.params.id}-${Date.now()}-${Math.round(Math.random()*1e6)}${ext}`);
    },
  }),
  limits: {fileSize: 8*1024*1024},
});

// ---------- state & health ----------
app.get("/api/state", (req,res)=> res.json(state));
app.get("/api/health", (req,res)=> res.json({ok:true, orders: state.orders.length, time:new Date().toISOString()}));

// ---------- авторизация (менеджер/логист, маркетолог) ----------
app.post("/api/auth/login", (req,res)=>{
  const {role, login, password} = req.body || {};
  const cfg = AUTH[role];
  if(!cfg) return res.status(400).json({error:"Неизвестная роль"});
  if(!cfg.login || !cfg.password){
    return res.status(503).json({error:"Логин для этой роли ещё не настроен на сервере (нужны переменные окружения)"});
  }
  if(login !== cfg.login || password !== cfg.password){
    return res.status(401).json({error:"Неверный логин или пароль"});
  }
  const token = require("crypto").randomBytes(24).toString("hex");
  authTokens.set(token, role);
  res.json({ok:true, token});
});

// ---------- drivers ----------
app.post("/api/drivers", (req,res)=>{
  const {code, name, phone, city, type} = req.body || {};
  if(!code || !name) return res.status(400).json({error:"code и name обязательны"});
  const upCode = String(code).trim().toUpperCase();
  if(state.drivers.some(d=>d.code===upCode)) return res.status(409).json({error:"Такой код уже есть"});
  const driver = {code:upCode, name, phone:phone||"", city:city||"", type:type||"внешний", active:true};
  state.drivers.push(driver);
  persist();
  res.json(driver);
});
app.patch("/api/drivers/:code", (req,res)=>{
  const d = state.drivers.find(d=>d.code===req.params.code);
  if(!d) return res.status(404).json({error:"not found"});
  Object.assign(d, req.body || {});
  persist();
  res.json(d);
});
app.delete("/api/drivers/:code", (req,res)=>{
  state.drivers = state.drivers.filter(d=>d.code!==req.params.code);
  persist();
  res.json({ok:true});
});

// ---------- campaigns ----------
app.post("/api/campaigns", (req,res)=>{
  const b = req.body || {};
  const campaign = {
    id: nextId("campaigns"), name: b.name||"Без названия", city: b.city||"—", period: b.period||"—",
    responsible: b.responsible||"—", boxType: b.boxType||"", plannedCount: b.plannedCount||0,
    stage: b.stage || CAMPAIGN_STAGES[0], budget: b.budget||0,
  };
  state.campaigns.push(campaign);
  persist();
  res.json(campaign);
});
app.patch("/api/campaigns/:id", (req,res)=>{
  const c = state.campaigns.find(c=>c.id===+req.params.id);
  if(!c) return res.status(404).json({error:"not found"});
  Object.assign(c, req.body || {});
  persist();
  res.json(c);
});
app.delete("/api/campaigns/:id", (req,res)=>{
  const id = +req.params.id;
  state.campaigns = state.campaigns.filter(c=>c.id!==id);
  persist();
  res.json({ok:true});
});

// ---------- orders ----------
app.post("/api/orders", (req,res)=>{
  const b = req.body || {};
  const order = {
    id: nextId("orders"), campaignId: b.campaignId||null, driverCode: b.driverCode||null,
    blogger: b.blogger||"", phone: b.phone||"", city: b.city||"—", address: b.address||"",
    box: b.box||"", comment: b.comment||"",
    status: b.driverCode ? "assigned" : "created", closureType: null, photo: null, driverComment: "",
    assignedAt: b.driverCode ? new Date().toLocaleString("ru-RU") : null,
    deliveredAt: null, bitrixSynced: false,
  };
  state.orders.push(order);
  persist();
  res.json(order);
});
app.patch("/api/orders/:id", (req,res)=>{
  const o = state.orders.find(o=>o.id===+req.params.id);
  if(!o) return res.status(404).json({error:"not found"});
  Object.assign(o, req.body || {});
  persist();
  res.json(o);
});
app.delete("/api/orders/:id", (req,res)=>{
  const id = +req.params.id;
  state.orders = state.orders.filter(o=>o.id!==id);
  persist();
  res.json({ok:true});
});

app.post("/api/orders/:id/deliver", upload.single("photo"), (req,res)=>{
  const o = state.orders.find(o=>o.id===+req.params.id);
  if(!o) return res.status(404).json({error:"not found"});
  if(!req.file) return res.status(400).json({error:"Фото обязательно для статуса «Доставлено»"});
  o.status = "delivered";
  o.photo = "/uploads/" + req.file.filename;
  o.driverComment = (req.body && req.body.comment) || "";
  o.deliveredAt = new Date().toLocaleString("ru-RU");
  o.bitrixSynced = false;
  persist();
  res.json(o);
});

app.post("/api/orders/:id/problem", (req,res)=>{
  const o = state.orders.find(o=>o.id===+req.params.id);
  if(!o) return res.status(404).json({error:"not found"});
  const {statusCode, comment} = req.body || {};
  if(!statusCode || !comment) return res.status(400).json({error:"statusCode и comment обязательны"});
  o.status = statusCode;
  o.driverComment = comment;
  o.deliveredAt = new Date().toLocaleString("ru-RU");
  persist();
  res.json(o);
});

app.post("/api/orders/:id/sync-bitrix", (req,res)=>{
  const o = state.orders.find(o=>o.id===+req.params.id);
  if(!o) return res.status(404).json({error:"not found"});
  o.bitrixSynced = true;
  persist();
  res.json(o);
});

app.post("/api/orders/bulk-assign", (req,res)=>{
  const {ids, driverCode} = req.body || {};
  if(!Array.isArray(ids) || !driverCode) return res.status(400).json({error:"ids[] и driverCode обязательны"});
  const now = new Date().toLocaleString("ru-RU");
  const idSet = new Set(ids.map(Number));
  let count = 0;
  state.orders.forEach(o=>{
    if(idSet.has(o.id)){ o.driverCode = driverCode; o.status = "assigned"; o.assignedAt = now; count++; }
  });
  persist();
  res.json({ok:true, count});
});
app.post("/api/orders/bulk-delete", (req,res)=>{
  const {ids} = req.body || {};
  if(!Array.isArray(ids)) return res.status(400).json({error:"ids[] обязателен"});
  const idSet = new Set(ids.map(Number));
  const before = state.orders.length;
  state.orders = state.orders.filter(o=>!idSet.has(o.id));
  persist();
  res.json({ok:true, count: before - state.orders.length});
});

app.post("/api/orders/import", (req,res)=>{
  const {rows} = req.body || {};
  if(!Array.isArray(rows)) return res.status(400).json({error:"rows[] обязателен"});
  const defaultCampaign = state.campaigns[0];
  const driverCodes = new Set(state.drivers.map(d=>d.code));
  let added = 0;
  rows.forEach(r=>{
    const blogger = r["блогер"] || r["blogger"] || "";
    const address = r["адрес"] || r["address"] || "";
    if(!blogger || !address) return;
    const driverCodeRaw = (r["водитель"] || r["driver_code"] || "").toUpperCase();
    const validDriver = driverCodes.has(driverCodeRaw) ? driverCodeRaw : null;
    state.orders.push({
      id: nextId("orders"), campaignId: defaultCampaign ? defaultCampaign.id : null,
      driverCode: validDriver, blogger, phone: r["телефон"] || r["phone"] || "",
      city: r["город"] || r["city"] || "—", address, box: r["бокс"] || r["box"] || "",
      comment: "", status: validDriver ? "assigned" : "created", closureType: null, photo: null,
      driverComment: "", assignedAt: validDriver ? new Date().toLocaleString("ru-RU") : null,
      deliveredAt: null, bitrixSynced: false,
    });
    added++;
  });
  persist();
  res.json({added});
});

// ---------- returns ----------
app.post("/api/returns", (req,res)=>{
  const b = req.body || {};
  const r = {id: nextId("returns"), campaignId: b.campaignId||null, item: b.item||"", qty: b.qty||1, status: b.status||RETURN_STATUSES[0]};
  state.returns.push(r);
  persist();
  res.json(r);
});
app.patch("/api/returns/:id", (req,res)=>{
  const r = state.returns.find(r=>r.id===+req.params.id);
  if(!r) return res.status(404).json({error:"not found"});
  Object.assign(r, req.body || {});
  persist();
  res.json(r);
});
app.delete("/api/returns/:id", (req,res)=>{
  const id = +req.params.id;
  state.returns = state.returns.filter(r=>r.id!==id);
  persist();
  res.json({ok:true});
});

// ---------- publications & measurements ----------
app.post("/api/publications", (req,res)=>{
  const b = req.body || {};
  if(state.publications.some(p=>p.orderId===b.orderId)) return res.status(409).json({error:"У этой доставки уже есть публикация"});
  const pub = {
    id: nextId("publications"), orderId: b.orderId, platform: b.platform||PLATFORMS[0],
    link: b.link||"", publishedAt: b.publishedAt||"", tier: b.tier||BLOGGER_TIERS[0],
    promoCode: b.promoCode||"", measurements: [],
  };
  state.publications.push(pub);
  persist();
  res.json(pub);
});
app.delete("/api/publications/:id", (req,res)=>{
  const id = +req.params.id;
  state.publications = state.publications.filter(p=>p.id!==id);
  persist();
  res.json({ok:true});
});
app.post("/api/publications/:id/measurements", (req,res)=>{
  const pub = state.publications.find(p=>p.id===+req.params.id);
  if(!pub) return res.status(404).json({error:"publication not found"});
  const b = req.body || {};
  const measurement = {
    id: nextMeasurementId(), date: b.date||"", views: b.views||0, likes: b.likes||0,
    comments: b.comments||0, saves: b.saves||0, salesCount: b.salesCount||0,
    salesRevenue: b.salesRevenue||0, note: b.note||"",
  };
  pub.measurements.push(measurement);
  persist();
  res.json(pub);
});

app.post("/api/publications/import", (req,res)=>{
  const {rows} = req.body || {};
  if(!Array.isArray(rows)) return res.status(400).json({error:"rows[] обязателен"});
  let created = 0, measured = 0, skipped = 0;
  rows.forEach(r=>{
    const bloggerRaw = (r["блогер"] || r["blogger"] || "").trim();
    if(!bloggerRaw){ skipped++; return; }
    const order = state.orders.find(o=> o.blogger.toLowerCase() === bloggerRaw.toLowerCase());
    if(!order){ skipped++; return; }

    let pub = state.publications.find(p=>p.orderId===order.id);
    if(!pub){
      pub = {
        id: nextId("publications"), orderId: order.id,
        platform: r["платформа"] || r["platform"] || PLATFORMS[0],
        link: r["ссылка"] || r["link"] || "",
        publishedAt: r["дата_публикации"] || r["published_at"] || new Date().toISOString().slice(0,10),
        tier: r["категория"] || r["tier"] || BLOGGER_TIERS[0],
        promoCode: r["промокод"] || r["promo_code"] || "",
        measurements: [],
      };
      state.publications.push(pub);
      created++;
    }

    const viewsRaw = r["просмотры"] !== undefined ? r["просмотры"] : r["views"];
    if(viewsRaw !== undefined && viewsRaw !== ""){
      pub.measurements.push({
        id: nextMeasurementId(),
        date: r["дата_замера"] || r["measure_date"] || new Date().toISOString().slice(0,10),
        views: parseInt(viewsRaw,10) || 0,
        likes: parseInt(r["лайки"] || r["likes"] || 0, 10) || 0,
        comments: parseInt(r["комментарии"] || r["comments"] || 0, 10) || 0,
        saves: parseInt(r["сохранения"] || r["saves"] || 0, 10) || 0,
        salesCount: parseInt(r["продажи"] || r["sales"] || 0, 10) || 0,
        salesRevenue: parseInt(r["выручка"] || r["revenue"] || 0, 10) || 0,
        note: r["комментарий"] || r["note"] || "",
      });
      measured++;
    }
  });
  persist();
  res.json({created, measured, skipped});
});

// ---------- инфлюенс-интеграции (крупные) ----------
app.post("/api/influencer-deals", (req,res)=>{
  const b = req.body || {};
  if(!b.blogerLogin) return res.status(400).json({error:"blogerLogin обязателен"});
  const deal = {
    id: nextId("influencerDeals"), blogerLogin: b.blogerLogin, platform: b.platform || PLATFORMS[0],
    product: b.product || "", plannedDate: b.plannedDate || "", publishedDate: b.publishedDate || "",
    plannedReach: b.plannedReach || 0, plannedClicks: b.plannedClicks || 0,
    reach: b.reach || 0, clicks: b.clicks || 0, cost: b.cost || 0, plannedCost: b.plannedCost || 0,
    likes: b.likes || 0, comments: b.comments || 0, saves: b.saves || 0,
    lastUpdatedFrom: "", lastUpdatedAt: "",
    status: b.status || DEAL_STATUSES[0], notes: b.notes || "",
  };
  state.influencerDeals.push(deal);
  persist();
  res.json(deal);
});
app.patch("/api/influencer-deals/:id", (req,res)=>{
  const d = state.influencerDeals.find(d=>d.id===+req.params.id);
  if(!d) return res.status(404).json({error:"not found"});
  Object.assign(d, req.body || {});
  persist();
  res.json(d);
});
app.delete("/api/influencer-deals/:id", (req,res)=>{
  const id = +req.params.id;
  state.influencerDeals = state.influencerDeals.filter(d=>d.id!==id);
  persist();
  res.json({ok:true});
});
app.post("/api/influencer-deals/import", (req,res)=>{
  const {rows} = req.body || {};
  if(!Array.isArray(rows)) return res.status(400).json({error:"rows[] обязателен"});
  let added = 0;
  rows.forEach(r=>{
    const blogerLogin = (r["блогер"] || r["blogger"] || r["логин"] || "").trim();
    if(!blogerLogin) return;
    state.influencerDeals.push({
      id: nextId("influencerDeals"), blogerLogin,
      platform: r["платформа"] || r["platform"] || PLATFORMS[0],
      product: r["продукт"] || r["product"] || "",
      plannedDate: r["план_дата"] || r["planned_date"] || "",
      publishedDate: r["факт_дата"] || r["published_date"] || "",
      plannedReach: parseInt(r["план_охват"] || r["planned_reach"] || 0, 10) || 0,
      plannedClicks: parseInt(r["план_клики"] || r["planned_clicks"] || 0, 10) || 0,
      reach: parseInt(r["охват"] || r["reach"] || 0, 10) || 0,
      clicks: parseInt(r["клики"] || r["clicks"] || 0, 10) || 0,
      plannedCost: parseInt(r["план_расход"] || r["planned_cost"] || 0, 10) || 0,
      cost: parseInt(r["расход"] || r["cost"] || 0, 10) || 0,
      likes:0, comments:0, saves:0, lastUpdatedFrom:"", lastUpdatedAt:"",
      status: r["статус"] || r["status"] || DEAL_STATUSES[0],
      notes: r["комментарий"] || r["notes"] || "",
    });
    added++;
  });
  persist();
  res.json({added});
});

// ---------- продажи по дням (вручную из 1С) — нужны для расчёта ROMI блогеров ----------
app.post("/api/sales", (req,res)=>{
  const b = req.body || {};
  if(!b.date || !b.product) return res.status(400).json({error:"date и product обязательны"});
  let row = state.salesByDay.find(s=>s.date===b.date && s.product===b.product);
  if(row){ row.revenue = b.revenue || 0; }
  else{
    row = {id: nextId("salesByDay"), date: b.date, product: b.product, revenue: b.revenue || 0};
    state.salesByDay.push(row);
  }
  persist();
  res.json(row);
});
app.delete("/api/sales/:id", (req,res)=>{
  const id = +req.params.id;
  state.salesByDay = state.salesByDay.filter(s=>s.id!==id);
  persist();
  res.json({ok:true});
});
app.post("/api/sales/import", (req,res)=>{
  const {rows} = req.body || {};
  if(!Array.isArray(rows)) return res.status(400).json({error:"rows[] обязателен"});
  let added = 0, updated = 0;
  rows.forEach(r=>{
    const date = (r["дата"] || r["date"] || "").trim();
    const product = (r["продукт"] || r["product"] || "").trim();
    if(!date || !product) return;
    const revenue = parseInt(r["выручка"] || r["revenue"] || 0, 10) || 0;
    let row = state.salesByDay.find(s=>s.date===date && s.product===product);
    if(row){ row.revenue = revenue; updated++; }
    else{ state.salesByDay.push({id: nextId("salesByDay"), date, product, revenue}); added++; }
  });
  persist();
  res.json({added, updated});
});

// 404 для неизвестных API-путей (чтобы не отдавать index.html вместо ошибки)
app.use("/api", (req,res)=> res.status(404).json({error:"not found"}));

// SPA fallback — всё остальное отдаём как index.html
app.get(/^(?!\/api).*/, (req,res)=>{
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, ()=>{
  console.log(`Barter Box сервер запущен: http://localhost:${PORT}`);
  console.log(`Заказов в базе: ${state.orders.length}`);
});

// Telegram-бот для инфлюенс-статистики: работает в этом же процессе (long polling,
// без отдельного сервиса на Render), включается только если заданы оба env var'а.
try{
  require("./telegram-bot").startTelegramBot(state, persist);
}catch(e){
  console.error("Не удалось запустить Telegram-бота:", e.message);
}
