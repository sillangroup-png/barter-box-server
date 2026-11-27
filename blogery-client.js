'use strict';
// 18.11.2026: адреса моста можно задать полностью: BLOGERY_REQUESTS_URL / BLOGERY_RESULT_URL (Supabase Edge Function tz-bridge).
const crypto=require('crypto');const {createService}=require('./automation-flow');
function createClient({getState,persist,fetchImpl=fetch,env=process.env}){
 let busy=false;const store=()=>{const st=getState();st.automationFlow=st.automationFlow||{version:1,catalog:[],requests:{},reviewMessages:{},events:[],drafts:[]};return st.automationFlow.briefRequests||(st.automationFlow.briefRequests=[])};
 // Крупные интеграции (вкладка «Инфлюенс интеграции крупные», 18.11.2026) идут с номером «L<id>», микро/средние — просто «<id>».
 function findDeal(iid){const st=getState();iid=String(iid);return /^L\d+$/.test(iid)?{large:true,deal:(st.influencerDeals||[]).find(d=>'L'+d.id===iid)}:{large:false,deal:(st.microInfluencerDeals||[]).find(d=>String(d.id)===iid)};}
 function request(deal,actor,notes='',large=false){
  const iid=(large?'L':'')+String(deal.id);
  const old=store().filter(r=>String(r.integrationId)===iid&&r.status!=='cancelled'&&r.status!=='approved').pop();if(old)return old;/* 23.11.2026: если прошлое ТЗ уже готово — новый запрос (например, отдельно на блок сторис) */
  const products=(deal.flowGoods||[]).map(x=>({id:x.id,name:x.name,barcode:x.barcode,kaspiArticle:x.kaspiArticle,qty:x.qty}));
  if(!products.length&&deal.product)products.push({name:deal.product,barcode:deal.barcode||'',qty:1});if(!products.length)throw Error('Сначала укажите товар');
  const blogger=large?{id:deal.crmBloggerId||'',handle:deal.instagramLink||deal.blogerLogin,name:String(deal.blogerLogin||'').replace(/^@/,'')}:{id:deal.crmBloggerId||'',handle:deal.instagramAccount||deal.blogerName,name:deal.blogerName};
  const row={id:crypto.randomUUID(),integrationId:iid,status:'pending',attempts:0,nextAt:Date.now(),requestedBy:actor,payload:{integrationId:iid,blogger,products,manager:deal.responsible,plannedDate:deal.plannedDate||'',format:large?('Крупная интеграция · '+(deal.platform||'')):(deal.contentFormat||'Instagram Reels'),language:large?'':(deal.videoLang||''),notes}};
  store().push(row);persist();return row;
 }
 // 19.11.2026: авторазбор. AUTO_TZ_REQUEST=1 — новая интеграция (с ником и товаром) сама уходит заявкой в Blogery Audit:
 // там сервер разбирает блогера и подбирает идеи под товар, тимлид делает ТЗ. Старые интеграции не трогаем —
 // считаем только те, что заведены после включения (отметка по номеру).
 function igHandle(v){let s=String(v||'').trim().toLowerCase();if(s.includes('instagram.com/'))s=s.split('instagram.com/')[1].split(/[/?#]/)[0];if(s.includes('tiktok.com/'))s=s.split('tiktok.com/')[1].split(/[/?#]/)[0];s=s.replace(/^@/,'');return /^[a-z0-9._]{2,30}$/.test(s)?s:'';}
 function autoRequests(){/* 23.11.2026 (Нина): заявка — только персональный разбор по кнопке менеджера. Авто-заявки выключены; ещё не отправленные — отменяем. */for(const r of store())if(r.status==='pending'&&/^авто/i.test(String(r.requestedBy||''))){r.status='cancelled';r.cancelledAt=new Date().toISOString();persist();}return;if(env.AUTO_TZ_REQUEST!=='1')return;const st=getState();const af=st.automationFlow;if(!af)return;
  const maxId=a=>(a||[]).reduce((m,d)=>Math.max(m,Number(d.id)||0),0);
  if(!af.autoTz){af.autoTz={microFrom:maxId(st.microInfluencerDeals),largeFrom:maxId(st.influencerDeals),at:new Date().toISOString()};persist();return;}
  const has=iid=>store().some(r=>String(r.integrationId)===iid&&r.status!=='cancelled');let n=0;
  for(const [large,list,from] of [[false,st.microInfluencerDeals,af.autoTz.microFrom],[true,st.influencerDeals,af.autoTz.largeFrom]]){
   for(const d of (list||[])){if(n>=5)return;if(!(Number(d.id)>from))continue;const iid=(large?'L':'')+d.id;if(has(iid))continue;
    const h=large?igHandle(d.instagramLink)||igHandle(d.blogerLogin):igHandle(d.instagramAccount)||igHandle(d.tiktokAccount);
    if(!h||!(d.product||(d.flowGoods||[]).length))continue;
    try{request(d,'авто: интеграция заведена','Заявка создана автоматически при заведении интеграции — разбор блогера и идеи готовятся сами.',large);n++;}catch(e){}}}}
 async function drain(){if(busy||env.BLOGERY_BRIDGE_ENABLED!=='1')return;busy=true;try{const origin=env.BLOGERY_AUDIT_ORIGIN;if(!origin||new URL(origin).protocol!=='https:'||(env.BLOGERY_BRIDGE_SECRET||'').length<32)return;
  autoRequests();
  for(const row of store().filter(r=>r.status==='pending'&&r.nextAt<=Date.now()).slice(0,5)){row.attempts++;row.nextAt=Date.now()+300000;persist();try{
   const response=await fetchImpl(env.BLOGERY_REQUESTS_URL?new URL(env.BLOGERY_REQUESTS_URL):new URL('/api/integrations/requests',origin),{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+env.BLOGERY_BRIDGE_SECRET,'Content-Type':'application/json','Idempotency-Key':'barter-request:'+row.id},body:JSON.stringify(row.payload)});
   if(!response.ok)throw Error('HTTP '+response.status);const result=await response.json();if(!result.id)throw Error('Ответ без ID запроса');Object.assign(row,{status:'received',remoteRequestId:result.id,url:origin+'/?flow_request='+encodeURIComponent(result.id),receivedAt:new Date().toISOString(),lastError:null});
  }catch(e){row.lastError=/^HTTP \d+$/.test(e.message)?e.message:'Ошибка связи с Blogery Audit';}persist();}
  // Готовые ТЗ из Blogery Audit (18.11.2026): забираем PDF, утверждаем версию в интеграции, включаем отправку блогеру в WhatsApp.
  const base=String(env.BLOGERY_REQUESTS_URL||'').replace(/\/+$/,'');const waiting=store().filter(r=>['received','approved'].includes(r.status)&&r.remoteRequestId&&(!r.readyNextAt||r.readyNextAt<=Date.now())).sort((a,b)=>(a.readyNextAt||0)-(b.readyNextAt||0)).slice(0,30);/* 27.11.2026: по очереди — раньше брались всегда первые 30 из 100+, новые запросы (Надира, Анастасия) не проверялись и готовые ТЗ не приходили */
  if(base&&waiting.length){for(const r of waiting)r.readyNextAt=Date.now()+60000;try{
   const resp=await fetchImpl(new URL(base+'/status'),{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+env.BLOGERY_BRIDGE_SECRET,'Content-Type':'application/json'},body:JSON.stringify({ids:waiting.map(r=>r.remoteRequestId)})});
   const data=resp.ok?await resp.json():{};
   for(const it of data.items||[]){const row=waiting.find(r=>r.remoteRequestId===it.id);if(!row||it.status!=='ready'||!it.pdfUrl||!/^[a-f0-9]{64}$/.test(it.contentSha256||''))continue;
    const {large,deal}=findDeal(row.integrationId);if(!deal)continue;
    const versionId=String(it.briefId)+':'+it.contentSha256.slice(0,12);
    // 19.11.2026: ТЗ пересобрали в Blogery Audit (снова ready, другой PDF) — перезабираем и заменяем; то же самое — пропускаем
    if((row.status==='approved'&&row.approvedVersionId===versionId)||(row.removedVersionIds||[]).includes(versionId))continue;
    const replaceOld=v=>{for(const x of (deal.flowBriefHistory||[]))if(x.versionId!==versionId&&x.status==='approved')x.status='replaced';};
    if(large){try{new URL(it.pdfUrl);}catch{continue;}const versions=deal.flowBriefHistory||(deal.flowBriefHistory=[]);
     if(!versions.some(v=>v.versionId===versionId))versions.push({briefId:String(it.briefId),versionId,title:String(it.title||'ТЗ'),files:{pdf:it.pdfUrl},contentSha256:it.contentSha256,approvedBy:String(it.approvedBy||'тимлид'),approvedAt:new Date().toISOString(),status:'approved'});
     replaceOld();deal.flowBriefApprovedVersionId=versionId;}
    else try{createService(getState,persist).execute('Blogery Audit',{action:'brief_approved',data:{dealId:deal.id,briefId:String(it.briefId),versionId,approvedBy:it.approvedBy||'тимлид',contentSha256:it.contentSha256,files:{pdf:it.pdfUrl},title:it.title||'ТЗ'}},'blogery-ready:'+it.id+':'+it.contentSha256.slice(0,16));replaceOld();deal.flowBriefApprovedVersionId=versionId;}catch(e){row.lastError='ТЗ не принято: '+e.message;continue;}
    // ТЗ только прикрепляется к интеграции; блогеру отправляет менеджер кнопкой «Отправить ТЗ блогеру» (решение Нины 18.11).
    deal.flowBriefReadyAt=new Date().toISOString();
    Object.assign(row,{status:'approved',approvedVersionId:versionId,approvedAt:new Date().toISOString(),lastError:null});persist();
    try{await fetchImpl(new URL(base+'/ack'),{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+env.BLOGERY_BRIDGE_SECRET,'Content-Type':'application/json'},body:JSON.stringify({id:it.id,autoSend:false,note:''})});}catch{}
   }}catch{}persist();}
  for(const row of store().filter(r=>['received','approved'].includes(r.status)&&(!r.resultNextAt||r.resultNextAt<=Date.now())).slice(0,5)){
   const {large,deal}=findDeal(row.integrationId);if(!deal)continue;
   if(large?(!deal.publishedDate||!deal.reelsLink):(deal.videoStatus!=='опубликовано'||!deal.publishDate||!deal.reelsLink))continue;
   const result=large?{integrationId:row.integrationId,publicationUrl:deal.reelsLink,publishedAt:deal.publishedDate,resultNote:'Подтверждённая публикация (крупная интеграция). Охват: '+(deal.reach||0)+'; клики: '+(deal.clicks||0)}
    :{integrationId:row.integrationId,publicationUrl:deal.reelsLink,publishedAt:deal.publishDate,resultNote:'Подтверждённая публикация. Просмотры Reels: '+(deal.factReachReels||0)+'; TikTok: '+(deal.factReachTT||0)+'; GATE: '+(deal.vreview?.score??'нет данных')};
   const hash=crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');if(row.resultHash===hash)continue;row.resultNextAt=Date.now()+15*60000;
   try{const response=await fetchImpl(env.BLOGERY_RESULT_URL?new URL(env.BLOGERY_RESULT_URL):new URL('/api/integrations/result',origin),{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+env.BLOGERY_BRIDGE_SECRET,'Content-Type':'application/json'},body:JSON.stringify(result)});if(response.ok){row.resultHash=hash;row.resultSyncedAt=new Date().toISOString();}}catch{}persist();
  }
 }finally{busy=false}}
 function mount(app,requireAuth){
  if(env.FLOW_LOGISTICS_ENABLED!=='1')return;
  const staff=(req,res,next)=>['manager','marketer'].includes(req.session.role)?next():res.status(403).json({error:'Нет доступа'});
  app.post('/api/automation/brief-request/:id',requireAuth,staff,(req,res)=>{try{const {large,deal:d}=findDeal(req.params.id);if(!d)return res.status(404).json({error:'Интеграция не найдена'});let actor=req.session.name||'общий вход';try{actor=req.session.name||decodeURIComponent(req.headers['x-actor']||'')||actor}catch{}const row=request(d,actor,String(req.body?.notes||'').slice(0,5000),large);res.json(row);drain().catch(()=>{});}catch(e){res.status(400).json({error:e.message})}});
  // 23.11.2026: удалить запрос ТЗ, поданный по ошибке (любой сотрудник). В Blogery Audit уже ушедший запрос остаётся — там его закрывают вручную.
  app.post('/api/automation/brief-request-cancel/:rid',requireAuth,staff,(req,res)=>{const r=store().find(x=>x.id===req.params.rid);if(!r)return res.status(404).json({error:'Запрос не найден'});if(r.status==='approved')return res.status(400).json({error:'ТЗ по запросу уже готово'});r.status='cancelled';r.cancelledAt=new Date().toISOString();r.cancelledBy=req.session.name||'общий вход';persist();res.json({ok:true});});
  // 19.11.2026: убрать прикреплённое ТЗ из интеграции (например, ТЗ на другой товар). Отправленное блогеру не убираем.
  app.post('/api/automation/brief-remove/:id',requireAuth,staff,(req,res)=>{try{const iid=String(req.params.id);const {deal}=findDeal(iid);if(!deal)return res.status(404).json({error:'Интеграция не найдена'});
   const vid=String(req.body?.versionId||'');const list=deal.flowBriefHistory||[];const v=list.find(x=>x.versionId===vid);if(!v)return res.status(404).json({error:'Такого ТЗ в интеграции нет'});
   if(v.status==='sent'||v.sentAt)return res.status(409).json({error:'Это ТЗ уже отправлено блогеру — убрать нельзя'});
   deal.flowBriefHistory=list.filter(x=>x!==v&&!(x.briefId===v.briefId&&x.status==='replaced'));const left=deal.flowBriefHistory.filter(x=>x.status!=='replaced');
   if(deal.flowBriefApprovedVersionId===vid)deal.flowBriefApprovedVersionId=left.length?left[left.length-1].versionId:'';
   const row=store().find(r=>String(r.integrationId)===iid&&r.status!=='cancelled');
   if(row){(row.removedVersionIds||(row.removedVersionIds=[])).push(vid);if(row.approvedVersionId===vid)Object.assign(row,{status:'received',approvedVersionId:null,readyNextAt:0});}
   let actor=req.session.name||'общий вход';try{actor=req.session.name||decodeURIComponent(req.headers['x-actor']||'')||actor}catch{}
   const af=getState().automationFlow;(af.events||(af.events=[])).push({id:crypto.randomUUID(),at:new Date().toISOString(),actor,action:'brief.removed',entityId:deal.id,versionId:vid,title:v.title});
   persist();res.json({ok:true,approved:deal.flowBriefHistory,approvedId:deal.flowBriefApprovedVersionId||''});}catch(e){res.status(400).json({error:e.message})}});
  // Очередь ТЗ для вкладки «База ТЗ» (23.11.2026): запросы и отправки — без ссылок на файлы и телефонов.
  // 27.11.2026: запросы ТЗ — менеджер свои, тимлид своей команды, Нина и руководство все.
  const scopeOk=(req)=>{const sc=req.app.locals.bbScopeNames?req.app.locals.bbScopeNames(req):null;if(!sc)return()=>true;return(who,iid)=>{if(sc.includes(String(who||'').trim()))return true;try{return sc.includes(String(findDeal(iid).deal?.responsible||'').trim())}catch{return false}}};
  app.get('/api/automation/brief-requests',requireAuth,staff,(req,res)=>{const st=getState(),ok=scopeOk(req);res.json({requests:store().filter(r=>r.status!=='cancelled'&&ok(r.requestedBy,r.integrationId)).slice(-300).map(r=>({id:r.id,integrationId:r.integrationId,status:r.status,requestedBy:r.requestedBy,createdAt:r.createdAt||null,approvedAt:r.approvedAt||null,lastError:r.lastError||null,notes:(r.payload&&r.payload.notes)||''})),
   sent:(st.briefDelivery||[]).filter(j=>ok('',j.integrationId)).slice(-200).map(j=>({integrationId:j.integrationId,versionId:j.versionId,status:j.status,approvedBy:j.approvedBy||'',createdAt:j.createdAt||null,sentAt:j.sentAt||null}))});});
  app.get('/api/automation/brief-request/:id',requireAuth,staff,(req,res)=>res.json({request:store().filter(r=>r.integrationId===req.params.id&&r.status!=='cancelled').pop()||null,approved:findDeal(req.params.id).deal?.flowBriefHistory||[]}));
  // 27.11.2026 (Нина): ТЗ из Claude без заявки — показываем «на рассмотрении» по блогеру, менеджер сам привязывает к интеграции.
  const bridge=async(p,body)=>{const base=String(env.BLOGERY_REQUESTS_URL||'').replace(/\/+$/,'');if(!base||(env.BLOGERY_BRIDGE_SECRET||'').length<32)throw Error('Связь с Blogery Audit не настроена');
   const r=await fetchImpl(new URL(base+p),{method:'POST',redirect:'error',signal:AbortSignal.timeout(60000),headers:{Authorization:'Bearer '+env.BLOGERY_BRIDGE_SECRET,'Content-Type':'application/json'},body:JSON.stringify(body||{})});
   const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||('Blogery Audit: '+r.status));return j;};
  app.get('/api/automation/brief-unlinked',requireAuth,staff,async(req,res)=>{try{res.json(await bridge('/review',{}));}catch(e){res.status(502).json({error:e.message,items:[]})}});
  app.post('/api/automation/brief-attach',requireAuth,staff,async(req,res)=>{try{
   const briefId=String(req.body?.briefId||''),iid=String(req.body?.integrationId||'');const {large,deal}=findDeal(iid);if(!deal)return res.status(404).json({error:'Интеграция не найдена'});
   const out=await bridge('/attach',{briefId,integrationId:(large?'L':'')+String(deal.id),manager:deal.responsible||'',plannedDate:deal.plannedDate||'',format:large?(deal.platform||''):(deal.contentFormat||'')});
   if(!out.id)throw Error(out.error||'Не привязалось');
   let actor=req.session.name||'общий вход';try{actor=req.session.name||decodeURIComponent(req.headers['x-actor']||'')||actor}catch{}
   if(!store().some(r=>r.remoteRequestId===out.id))store().push({id:crypto.randomUUID(),integrationId:(large?'L':'')+String(deal.id),status:'received',attempts:0,nextAt:Date.now(),remoteRequestId:out.id,readyNextAt:0,
    requestedBy:actor+' · привязал ТЗ из Claude',receivedAt:new Date().toISOString(),payload:{integrationId:(large?'L':'')+String(deal.id),manager:deal.responsible,notes:'ТЗ из Claude, привязано в «Базе ТЗ»'}});
   persist();res.json({ok:true,id:out.id,warning:out.error||null});drain().catch(()=>{});
  }catch(e){res.status(400).json({error:e.message})}});
  const timer=setInterval(()=>drain().catch(()=>{}),30000);timer.unref();
 }
 return {request,drain,mount};
}
module.exports={createClient};
