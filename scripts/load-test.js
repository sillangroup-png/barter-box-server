// Barter Box — самопроверка сервера: функциональные тесты + нагрузочный тест.
// Запуск:  node scripts/load-test.js
// Поднимает сервер на отдельном порту (3002), гоняет тесты, гасит сервер сам.
"use strict";
const { spawn } = require("child_process");
const path = require("path");

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function main(){
  const port = process.env.LOAD_TEST_PORT || "3099";
  const proc = spawn("node", ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, {PORT: port}),
  });
  proc.stdout.on("data", d=> process.stdout.write("[server] " + d));
  proc.stderr.on("data", d=> process.stderr.write("[server-err] " + d));
  await sleep(1200);

  const BASE = `http://localhost:${port}`;
  let pass = 0, fail = 0;
  function ok(name, cond){
    if(cond){ console.log("✅", name); pass++; }
    else { console.log("❌", name); fail++; }
  }

  try{
    let r, j;

    r = await fetch(BASE + "/api/health"); j = await r.json();
    ok("health check отвечает", j.ok === true);

    r = await fetch(BASE + "/api/drivers", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({code:"TEST-01", name:"Тест Тестов", phone:"+7", city:"Алматы", type:"внешний"})});
    const driver = await r.json();
    ok("создание водителя", driver.code === "TEST-01");

    r = await fetch(BASE + "/api/campaigns", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({name:"Test Campaign", city:"Алматы"})});
    const campaign = await r.json();
    ok("создание проекта", !!campaign.id);

    r = await fetch(BASE + "/api/orders", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({campaignId: campaign.id, blogger:"@test_blogger", phone:"+7", city:"Алматы", address:"ул. Тест 1", box:"Уход премиум"})});
    const order = await r.json();
    ok("создание доставки", order.status === "created");

    r = await fetch(BASE + "/api/orders/" + order.id, {method:"PATCH", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({driverCode:"TEST-01", status:"assigned"})});
    const assigned = await r.json();
    ok("назначение водителя", assigned.driverCode === "TEST-01" && assigned.status === "assigned");

    const fd = new FormData();
    fd.append("comment", "Получил лично");
    fd.append("photo", new Blob([Buffer.from([0xff,0xd8,0xff,0xd9])], {type:"image/jpeg"}), "test.jpg");
    r = await fetch(BASE + "/api/orders/" + order.id + "/deliver", {method:"POST", body: fd});
    const delivered = await r.json();
    ok("доставка с фото -> статус delivered + photo", delivered.status === "delivered" && !!delivered.photo);

    r = await fetch(BASE + "/api/orders", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({campaignId: campaign.id, blogger:"@test_blogger2", phone:"+7", city:"Алматы", address:"ул. Тест 2", box:""})});
    const order2 = await r.json();
    const fd2 = new FormData(); fd2.append("comment", "нет фото");
    r = await fetch(BASE + "/api/orders/" + order2.id + "/deliver", {method:"POST", body: fd2});
    ok("доставка БЕЗ фото отклоняется (400)", r.status === 400);

    r = await fetch(BASE + "/api/orders", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({campaignId: campaign.id, blogger:"@test_blogger3", phone:"+7", city:"Алматы", address:"ул. Тест 3", box:""})});
    const order3 = await r.json();
    r = await fetch(BASE + "/api/orders/" + order3.id + "/problem", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({statusCode:"no_answer", comment:"Не берёт трубку"})});
    const prob = await r.json();
    ok("проблемный статус (не дозвонился)", prob.status === "no_answer" && prob.driverComment === "Не берёт трубку");

    r = await fetch(BASE + "/api/orders", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({campaignId: campaign.id, blogger:"@bulk1", phone:"", city:"", address:"a", box:""})});
    const bo1 = await r.json();
    r = await fetch(BASE + "/api/orders", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({campaignId: campaign.id, blogger:"@bulk2", phone:"", city:"", address:"a", box:""})});
    const bo2 = await r.json();
    r = await fetch(BASE + "/api/orders/bulk-assign", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ids:[bo1.id, bo2.id], driverCode:"TEST-01"})});
    const bulkRes = await r.json();
    ok("массовое назначение (2 доставки)", bulkRes.count === 2);

    r = await fetch(BASE + "/api/orders/import", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({rows:[{"блогер":"@csv1","адрес":"ул. CSV 1","город":"Алматы"}]})});
    const importRes = await r.json();
    ok("импорт доставок из CSV", importRes.added === 1);

    r = await fetch(BASE + "/api/publications", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({orderId: order.id, platform:"TikTok", link:"https://x", publishedAt:"2026-07-01", tier:"Малый (эффект 1–7 дней)", promoCode:"X10"})});
    const pub = await r.json();
    ok("создание публикации", pub.orderId === order.id);
    r = await fetch(BASE + "/api/publications/" + pub.id + "/measurements", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({date:"2026-07-05", views:1000, likes:50, comments:5, salesCount:2, salesRevenue:18000})});
    const pubAfter = await r.json();
    ok("добавление замера охвата", pubAfter.measurements.length === 1);

    r = await fetch(BASE + "/api/publications/import", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({rows:[{"блогер":"@test_blogger3","платформа":"TikTok","ссылка":"https://y","просмотры":"500"}]})});
    const pubImportRes = await r.json();
    ok("массовый импорт публикаций (создан+замерен)", pubImportRes.created === 1 && pubImportRes.measured === 1);

    r = await fetch(BASE + "/api/drivers/TEST-01", {method:"DELETE"});
    ok("удаление водителя", (await r.json()).ok === true);

    console.log(`\n📊 Функциональные тесты: ${pass}/${pass+fail} пройдено\n`);

    // ================= НАГРУЗОЧНЫЙ ТЕСТ: 5000 доставок + 20 одновременных пользователей =================
    console.log("🚚 Засеиваю 5000 доставок...");
    const bulkRows = [];
    for(let i=0;i<5000;i++){
      bulkRows.push({"блогер":"@load_test_"+i, "адрес":"ул. Нагрузочная "+i, "город": i%2===0?"Алматы":"Астана"});
    }
    let t0 = Date.now();
    r = await fetch(BASE + "/api/orders/import", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({rows:bulkRows})});
    const loadImport = await r.json();
    let t1 = Date.now();
    console.log(`Добавлено ${loadImport.added} доставок за ${t1-t0} мс`);

    r = await fetch(BASE + "/api/state");
    const stateAfter = await r.json();
    console.log(`Всего доставок в базе: ${stateAfter.orders.length}`);

    let t2 = Date.now();
    await fetch(BASE + "/api/state");
    let t3 = Date.now();
    console.log(`GET /api/state при ${stateAfter.orders.length} доставках: ${t3-t2} мс`);
    ok("GET /api/state укладывается в разумное время (<1500мс) при 5000+ доставках", (t3-t2) < 1500);

    console.log("\n👥 Симулирую 20 одновременных пользователей (чтения + записи одновременно)...");
    const cStart = Date.now();
    const tasks = [];
    for(let u=0; u<20; u++){
      if(u % 4 === 0){
        tasks.push(fetch(BASE + "/api/orders", {method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({campaignId: campaign.id, blogger:"@concurrent_"+u, phone:"", city:"Алматы", address:"ул. "+u, box:""})}));
      } else if(u % 4 === 1){
        tasks.push(fetch(BASE + "/api/orders/" + order.id, {method:"PATCH", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({comment:"concurrent edit " + u})}));
      } else {
        tasks.push(fetch(BASE + "/api/state"));
      }
    }
    const results = await Promise.all(tasks);
    const cEnd = Date.now();
    const allOk = results.every(r=> r.status >= 200 && r.status < 300);
    console.log(`20 одновременных запросов заняли ${cEnd-cStart} мс, все успешны: ${allOk}`);
    ok("все 20 одновременных запросов успешны", allOk);

    r = await fetch(BASE + "/api/state");
    const finalState = await r.json();
    const expected = stateAfter.orders.length + 5; // 5 писателей создают новую доставку (u=0,4,8,12,16)
    console.log(`Доставок после конкурентного теста: ${finalState.orders.length} (ожидалось ${expected})`);
    ok("данные не повреждены после конкурентных записей", finalState.orders.length === expected);

    console.log(`\n📊 ИТОГО: ${pass}/${pass+fail} тестов пройдено`);
  } finally {
    proc.kill();
    await sleep(200);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e=>{ console.error("FATAL", e); process.exit(1); });
