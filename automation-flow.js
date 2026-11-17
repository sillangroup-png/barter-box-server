'use strict';
// Additive pilot. Existing orders and microInfluencerDeals remain the sources of truth.
// No external sends, no cron, no financial mutations, no changes to audit.js.
const crypto=require('crypto');
const path=require('path');
class FlowError extends Error{constructor(message,status=400){super(message);this.status=status;}}
const need=(x,m,s)=>{if(!x)throw new FlowError(m,s)};
const clone=x=>JSON.parse(JSON.stringify(x));
const stamp=()=>new Date().toISOString();
function moneyMinor(value){
 const s=String(value??'').trim().replace(/\s/g,'').replace(',','.');
 need(/^\d{1,10}(?:\.\d{1,2})?$/.test(s),'Некорректная себестоимость');
 const [a,b='']=s.split('.');const n=Number(a)*100+Number(b.padEnd(2,'0'));
 need(Number.isSafeInteger(n),'Слишком большая сумма');return n;
}
function priceSelection(state,raw){
 need(Array.isArray(raw)&&raw.length>0&&raw.length<=100,'Выберите от 1 до 100 товаров');
 const catalog=state.automationFlow?.catalog||[],used=new Set();
 const items=raw.map(l=>{const p=catalog.find(x=>x.id===l.productId);need(p,'Товар не найден');need(!used.has(p.id),'Товар указан дважды');used.add(p.id);
  need(Number.isInteger(l.qty)&&l.qty>0&&l.qty<=10000,'Количество должно быть целым от 1 до 10000');
  if(l.expectedCostMinor!==undefined)need(l.expectedCostMinor===p.costMinor,'Себестоимость изменилась. Пересчитайте товары.',409);
  return {...clone(p),qty:l.qty};});
 return {items,costMinor:items.reduce((sum,p)=>sum+p.costMinor*p.qty,0)};
}
function syncOrderLinks(state,order){
 if(!Array.isArray(order.dealIds)||!order.fulfillment)return 0;
 let changed=0;
 if(order.status==='delivered'){
  // Carrier handoff never sets delivered. Existing driver/confirmed delivery endpoints do.
  order.deliveryLinkSnapshot=order.deliveryLinkSnapshot||{};
  for(const id of order.dealIds){const d=(state.microInfluencerDeals||[]).find(x=>String(x.id)===String(id));if(!d)continue;
   if(!(String(id) in order.deliveryLinkSnapshot))order.deliveryLinkSnapshot[String(id)]=d.productStatus??'';
   if(d.productStatus!=='товар доставлен'){d.productStatus='товар доставлен';changed++;}
  }
 }else if(order.deliveryLinkSnapshot){
  // Explicit reversal of delivery restores only our status, preserving subsequent manual edits.
  for(const [id,previous] of Object.entries(order.deliveryLinkSnapshot)){const d=(state.microInfluencerDeals||[]).find(x=>String(x.id)===id);if(d&&d.productStatus==='товар доставлен'){d.productStatus=previous;changed++;}}
  delete order.deliveryLinkSnapshot;
 }
 return changed;
}
function createService(getState,persist){
 function flow(st){return st.automationFlow||(st.automationFlow={version:1,catalog:[],requests:{},reviewMessages:{},events:[],drafts:[]});}
 function getOrder(st,id){const o=(st.orders||[]).find(x=>String(x.id)===String(id));need(o,'Заявка не найдена',404);need(o.fulfillment,'Это старый заказ; работайте с ним в существующем разделе');return o;}
 function event(f,actor,action,id,details){f.events.push({id:crypto.randomUUID(),at:stamp(),actor,action,entityId:id,...details});}
 function execute(actor,body,key){
  need(typeof key==='string'&&key.length>=8&&key.length<=160,'Требуется Idempotency-Key');
  const st=getState();const before=clone({orders:st.orders||[],microInfluencerDeals:st.microInfluencerDeals||[],automationFlow:st.automationFlow??null});
  try{
   const f=flow(st),fingerprint=crypto.createHash('sha256').update(JSON.stringify({actor,body})).digest('hex');
   if(f.requests[key]){need(f.requests[key].fingerprint===fingerprint,'Ключ уже использован для другого запроса',409);return clone(f.requests[key].response);}
   const d=body.data||{};let result;
   if(body.action==='catalog_import'){
    need(Array.isArray(d.items)&&d.items.length<=5000,'Нужен массив до 5000 товаров');const seen=new Set();
    const items=d.items.map((p,i)=>{const barcode=String(p.barcode||'').trim(),sku=String(p.sku||'').trim();need(barcode||sku,`Строка ${i+1}: нужен ШК или SKU`);
     need(!barcode||/^\d{6,18}$/.test(barcode),`Строка ${i+1}: неверный ШК`);const key=barcode?'bc:'+barcode:'sku:'+sku;need(!seen.has(key),'Повтор товара в файле');seen.add(key);
     need(String(p.name||'').trim(),'Нужно название товара');return {id:key,name:String(p.name).slice(0,300),barcode,sku,internalArticle:String(p.internal_article||''),
      costMinor:moneyMinor(p.cost_kzt),currency:'KZT',costAsOf:stamp(),kaspiArticle:String(p.kaspi_article||''),mappingStatus:String(p.mapping_status||'manual'),
      kaspiCandidates:Array.isArray(p.kaspi_candidates)?p.kaspi_candidates.map(String):[]};});
    result={count:items.length,dryRun:d.dryRun!==false,sample:items.slice(0,8)};
    if(d.dryRun===false){for(const item of items){const index=f.catalog.findIndex(p=>p.id===item.id||Boolean(item.sku)&&p.sku===item.sku);if(index<0)f.catalog.push(item);else f.catalog[index]={...f.catalog[index],...item,id:f.catalog[index].id};}event(f,actor,'catalog.imported','catalog',{count:items.length});}
   }else if(body.action==='shipment_request'){
    const ids=[...new Set((d.dealIds||[]).map(String))];need(ids.length>0&&ids.length<=50,'Выберите интеграции');
    const deals=ids.map(id=>{const deal=(st.microInfluencerDeals||[]).find(x=>String(x.id)===id);need(deal,'Интеграция не найдена: '+id,404);return deal});
    // Same stored Instagram identity; a name alone cannot justify combining shipments.
    const identity=deals[0].instagramAccount;need(deals.length===1||Boolean(identity)&&deals.every(x=>x.instagramAccount===identity),'Для объединения нужен один подтверждённый Instagram-профиль');
    need(!(st.orders||[]).some(o=>o.status!=='cancelled'&&(o.dealIds||[]).some(id=>ids.includes(String(id)))),'Для интеграции уже существует отправка',409);
    for(const k of ['address','city','phone'])need(String(d[k]||'').trim(),'Заполните адрес, город и телефон');
    need(/^\+?[\d ()-]{7,25}$/.test(String(d.phone)),'Проверьте телефон');need(Array.isArray(d.items)&&d.items.length>0,'Выберите товары');const used=new Set();
    const lines=d.items.map(l=>{const p=f.catalog.find(p=>p.id===l.productId);need(p,'Товар не найден');need(!used.has(p.id),'Товар указан дважды');used.add(p.id);
     need(Number.isInteger(l.qty)&&l.qty>0&&l.qty<=10000,'Количество должно быть целым от 1 до 10000');
     return {...clone(p),qty:l.qty};});
    const id=(st.orders||[]).reduce((m,o)=>Math.max(m,Number(o.id)||0),0)+1;
    const order={id,campaignId:null,driverCode:null,blogger:deals[0].blogerName||'',phone:String(d.phone).trim(),city:String(d.city).trim(),address:String(d.address).trim(),
     box:lines.map(p=>`${p.name} × ${p.qty}`).join('; '),comment:String(d.comment||''),status:'created',closureType:'sale',photo:null,driverComment:'',assignedAt:null,deliveredAt:null,bitrixSynced:false,
     dealIds:deals.map(x=>x.id),fulfillment:{stage:'distribution',coordinator:'Сая',requestedBy:actor,requestedAt:stamp(),requiredDate:String(d.requiredDate||''),
      warehouse:null,assembler:null,items:lines,costMinor:lines.reduce((s,p)=>s+p.costMinor*p.qty,0)}};
    (st.orders||(st.orders=[])).push(order);event(f,actor,'shipment.requested',id,{dealIds:order.dealIds});result=order;
   }else if(body.action==='shipment_assign'){
    const o=getOrder(st,d.id);need(['distribution','assigned'].includes(o.fulfillment.stage),'Нельзя переназначить на этом этапе',409);
    need(['Алматы','Астана'].includes(d.warehouse),'Выберите склад');need(String(d.assembler||'').trim(),'Укажите сборщика');
    Object.assign(o.fulfillment,{stage:'assigned',warehouse:d.warehouse,assembler:String(d.assembler).trim().slice(0,100),assignedAt:stamp()});event(f,actor,'assembly.assigned',o.id);result=o;
   }else if(body.action==='shipment_stage'){
    const o=getOrder(st,d.id),from=o.fulfillment.stage;const transitions={assigned:['assembled','shortage','cancelled'],distribution:['cancelled'],shortage:['assigned','cancelled'],assembled:['dispatched','cancelled']};
    need((transitions[from]||[]).includes(d.stage),'Недопустимый переход',409);
    if(d.stage==='shortage')need(String(d.note||'').trim(),'Укажите недостающий товар');
    if(d.stage==='dispatched'){need(String(d.carrier||'').trim()&&String(d.tracking||'').trim(),'Укажите перевозчика и номер отправления');Object.assign(o.fulfillment,{carrier:String(d.carrier),tracking:String(d.tracking),dispatchedAt:stamp()});o.status='in_route';}
    if(d.stage==='cancelled')o.status='cancelled';
    o.fulfillment.stage=d.stage;if(d.note)o.fulfillment.note=String(d.note).slice(0,2000);event(f,actor,'assembly.'+d.stage,o.id);result=o;
   }else if(body.action==='brief_approved'){
    const deal=(st.microInfluencerDeals||[]).find(x=>String(x.id)===String(d.dealId));need(deal,'Интеграция не найдена',404);
    need(d.briefId&&d.versionId&&d.approvedBy&&/^[a-f0-9]{64}$/.test(d.contentSha256||''),'Нужны ID, версия, автор утверждения и SHA-256');
    need(d.files&&Object.values(d.files).length>0&&Object.values(d.files).every(u=>{try{return new URL(u).protocol==='https:'}catch{return false}}),'Нужны защищённые HTTPS-ссылки на файлы');
    const versions=deal.flowBriefHistory||(deal.flowBriefHistory=[]),old=versions.find(x=>x.briefId===d.briefId&&x.versionId===d.versionId);
    if(old){need(old.contentSha256===d.contentSha256,'Содержимое утверждённой версии изменилось',409);result=old;}
    else{result={briefId:String(d.briefId),versionId:String(d.versionId),title:String(d.title||'ТЗ'),files:clone(d.files),contentSha256:d.contentSha256,approvedBy:String(d.approvedBy),approvedAt:stamp(),status:'approved'};versions.push(result);deal.flowBriefApprovedVersionId=result.versionId;event(f,actor,'brief.approved',deal.id,{versionId:result.versionId});}
   }else if(body.action==='brief_sent'){
    const deal=(st.microInfluencerDeals||[]).find(x=>String(x.id)===String(d.dealId));need(deal,'Интеграция не найдена',404);
    const version=(deal.flowBriefHistory||[]).find(x=>x.briefId===d.briefId&&x.versionId===d.versionId);need(version,'Нет утверждённой версии',409);
    need(d.channel&&d.messageId&&d.recipientConfirmed===true,'Нужно подтверждение отправки правильному адресату');
    if(version.status==='sent')result=version;
    else{Object.assign(version,{status:'sent',sentAt:stamp(),channel:String(d.channel),messageId:String(d.messageId)});deal.flowBriefSentVersionId=version.versionId;event(f,actor,'brief.sent',deal.id,{versionId:version.versionId});result=version;}
   }else if(body.action==='review_bind'){
    const deal=(st.microInfluencerDeals||[]).find(x=>String(x.id)===String(d.dealId));need(deal,'Интеграция не найдена',404);
    need(d.messageId&&d.videoVersionId&&d.reviewerPhone,'Нужны ID сообщения, версии и телефон тимлида');
    need(deal.flowCurrentVideoVersionId===d.videoVersionId,'Версия не совпадает с текущей',409);
    need(!f.reviewMessages[d.messageId],'Сообщение уже связано',409);
    f.reviewMessages[d.messageId]={dealId:deal.id,videoVersionId:d.videoVersionId,reviewerPhone:String(d.reviewerPhone).replace(/\D/g,''),at:stamp()};event(f,actor,'review.bound',deal.id);result={ok:true};
   }else if(body.action==='review_reply'){
    const bind=f.reviewMessages[d.quotedMessageId];need(bind,'Ответ без известной связи с видео',409);
    need(String(d.senderPhone||'').replace(/\D/g,'')===bind.reviewerPhone,'Ответ не от назначенного тимлида',403);
    const deal=(st.microInfluencerDeals||[]).find(x=>String(x.id)===String(bind.dealId));need(deal,'Интеграция не найдена',404);
    need(deal.flowCurrentVideoVersionId===bind.videoVersionId,'Ответ на старую версию: нужна ручная проверка',409);
    const match=String(d.text||'').trim().match(/^(согласовано|правки|монтаж|пересъём|пересъем)(?:\s*:\s*([\s\S]+))?$/i);need(match,'Неоднозначный ответ',422);
    const decision={'согласовано':'approved','правки':'changes','монтаж':'editing','пересъём':'reshoot','пересъем':'reshoot'}[match[1].toLowerCase()];
    need(decision==='approved'||Boolean(match[2]),'Для правок нужен комментарий');
    const checked=deal.flowVideoVersions?.find(v=>v.id===bind.videoVersionId)?.review;
    if(decision==='approved'&&checked?.score!=null&&checked.scale&&checked.score/checked.scale<0.6)need(Boolean(match[2]),'При низком GATE ответьте «Согласовано: причина»');
    const decisions=deal.flowVideoDecisions||(deal.flowVideoDecisions=[]);need(!decisions.some(x=>x.videoVersionId===bind.videoVersionId),'Решение по версии уже принято',409);
    const record={videoVersionId:bind.videoVersionId,decision,note:match[2]||'',messageId:String(d.messageId||''),reviewerPhone:bind.reviewerPhone,at:stamp()};decisions.push(record);
    // Separate version-aware data; no unverified mapping to the existing vstage state machine.
    if(decision==='editing')f.drafts.push({id:crypto.randomUUID(),topic:'editing.requested',dealId:deal.id,videoVersionId:bind.videoVersionId,note:record.note,status:'pending'});
    event(f,actor,'video.'+decision,deal.id,{videoVersionId:bind.videoVersionId});result=record;
   }else throw new FlowError('Неизвестное действие');
   f.requests[key]={fingerprint,response:clone(result)};
   // Never discard deduplication keys on a timer: a late retry must not create another order.
   persist();return result;
  }catch(e){st.orders=before.orders;st.microInfluencerDeals=before.microInfluencerDeals;if(before.automationFlow===null)delete st.automationFlow;else st.automationFlow=before.automationFlow;throw e;}
 }
 return {execute,snapshot(){const st=getState(),f=st.automationFlow||{catalog:[],events:[],drafts:[]};return {catalog:f.catalog,orders:(st.orders||[]).filter(o=>o.fulfillment),deals:st.microInfluencerDeals||[],drivers:st.drivers||[],events:f.events.slice(-100).reverse(),drafts:f.drafts,externalSending:false,pendingMedia:(st.videoFlow?.pendingMedia||[]).filter(x=>x.status==='needs_assignment'),reviewOutbox:st.videoFlow?.reviewOutbox||[]};}};
}
function mount(app,{getState,persist,requireAuth}){
 if(process.env.FLOW_LOGISTICS_ENABLED!=='1')return;
 const service=createService(getState,persist);
 const allowed=(req,res,next)=>{if(!['manager','marketer'].includes(req.session.role))return res.status(403).json({error:'Недостаточно прав'});next();};
 const guard=fn=>(req,res)=>{try{res.json(fn(req))}catch(e){res.status(e.status||500).json({error:e.status?e.message:'Ошибка обработки. Действие отменено.'})}};
 app.get('/api/automation/state',requireAuth,allowed,guard(()=>service.snapshot()));
 app.post('/api/automation/command',requireAuth,allowed,guard(req=>{
  need(!['review_bind','review_reply','brief_approved','brief_sent'].includes(req.body?.action),'Только проверенный адаптер WhatsApp',403);
  let selected='';try{selected=decodeURIComponent(String(req.headers['x-actor']||''));}catch{}
  return service.execute(req.session.name||selected||'общий вход',req.body,req.headers['idempotency-key']);
 }));
 // A normalized internal adapter contract; not a claim about raw Wazzup fields.
 app.post('/api/automation/review-event',guard(req=>{
  const expected=process.env.FLOW_REVIEW_ADAPTER_SECRET||'',supplied=String(req.headers.authorization||'').replace(/^Bearer /,'');
  need(expected.length>=32,'Адаптер отключён',503);need(Buffer.byteLength(supplied)===Buffer.byteLength(expected)&&crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)),'Неверный сервисный ключ',401);
  need(['review_bind','review_reply'].includes(req.body?.action),'Недопустимое событие');return service.execute('адаптер WhatsApp',req.body,req.headers['idempotency-key']);
 }));
 app.post('/api/automation/brief-event',guard(req=>{
  const expected=process.env.FLOW_INTEGRATION_SECRET||'',supplied=String(req.headers.authorization||'').replace(/^Bearer /,'');
  need(expected.length>=32,'Связка ТЗ отключена',503);need(Buffer.byteLength(supplied)===Buffer.byteLength(expected)&&crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)),'Неверный сервисный ключ',401);
  need(['brief_approved','brief_sent'].includes(req.body?.action),'Недопустимое событие');return service.execute('Blogery Audit',req.body,req.headers['idempotency-key']);
 }));
 app.get(/^\/flow$/,(req,res)=>res.redirect('/flow/'));
 app.get('/flow/',(req,res)=>res.sendFile(path.join(__dirname,'flow-mobile','index.html')));
 for(const file of ['app.js','style.css','manifest.webmanifest','icon.svg'])app.get('/flow/'+file,(req,res)=>res.sendFile(path.join(__dirname,'flow-mobile',file)));
}
module.exports={mount,createService,syncOrderLinks,moneyMinor,priceSelection,FlowError};
