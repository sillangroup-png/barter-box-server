'use strict';
// 18.11.2026: адреса моста можно задать полностью: BLOGERY_REQUESTS_URL / BLOGERY_RESULT_URL (Supabase Edge Function tz-bridge).
const crypto=require('crypto');
function createClient({getState,persist,fetchImpl=fetch,env=process.env}){
 let busy=false;const store=()=>{const st=getState();st.automationFlow=st.automationFlow||{version:1,catalog:[],requests:{},reviewMessages:{},events:[],drafts:[]};return st.automationFlow.briefRequests||(st.automationFlow.briefRequests=[])};
 function request(deal,actor,notes=''){
  const old=store().find(r=>String(r.integrationId)===String(deal.id)&&r.status!=='cancelled');if(old)return old;
  const products=(deal.flowGoods||[]).map(x=>({id:x.id,name:x.name,barcode:x.barcode,kaspiArticle:x.kaspiArticle,qty:x.qty}));
  if(!products.length&&deal.product)products.push({name:deal.product,barcode:deal.barcode||'',qty:1});if(!products.length)throw Error('Сначала выберите товары');
  const row={id:crypto.randomUUID(),integrationId:String(deal.id),status:'pending',attempts:0,nextAt:Date.now(),requestedBy:actor,payload:{integrationId:String(deal.id),blogger:{id:deal.crmBloggerId||'',handle:deal.instagramAccount||deal.blogerName,name:deal.blogerName},products,manager:deal.responsible,plannedDate:deal.plannedDate||'',format:deal.contentFormat||'Instagram Reels',language:deal.videoLang||'',notes}};
  store().push(row);persist();return row;
 }
 async function drain(){if(busy||env.BLOGERY_BRIDGE_ENABLED!=='1')return;busy=true;try{const origin=env.BLOGERY_AUDIT_ORIGIN;if(!origin||new URL(origin).protocol!=='https:'||(env.BLOGERY_BRIDGE_SECRET||'').length<32)return;
  for(const row of store().filter(r=>r.status==='pending'&&r.nextAt<=Date.now()).slice(0,5)){row.attempts++;row.nextAt=Date.now()+300000;persist();try{
   const response=await fetchImpl(env.BLOGERY_REQUESTS_URL?new URL(env.BLOGERY_REQUESTS_URL):new URL('/api/integrations/requests',origin),{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+env.BLOGERY_BRIDGE_SECRET,'Content-Type':'application/json','Idempotency-Key':'barter-request:'+row.id},body:JSON.stringify(row.payload)});
   if(!response.ok)throw Error('HTTP '+response.status);const result=await response.json();if(!result.id)throw Error('Ответ без ID запроса');Object.assign(row,{status:'received',remoteRequestId:result.id,url:origin+'/?flow_request='+encodeURIComponent(result.id),receivedAt:new Date().toISOString(),lastError:null});
  }catch(e){row.lastError=/^HTTP \d+$/.test(e.message)?e.message:'Ошибка связи с Blogery Audit';}persist();}
  for(const row of store().filter(r=>r.status==='received'&&(!r.resultNextAt||r.resultNextAt<=Date.now())).slice(0,5)){
   const deal=(getState().microInfluencerDeals||[]).find(d=>String(d.id)===row.integrationId);if(!deal||deal.videoStatus!=='опубликовано'||!deal.publishDate||!deal.reelsLink)continue;
   const result={integrationId:row.integrationId,publicationUrl:deal.reelsLink,publishedAt:deal.publishDate,resultNote:'Подтверждённая публикация. Просмотры Reels: '+(deal.factReachReels||0)+'; TikTok: '+(deal.factReachTT||0)+'; GATE: '+(deal.vreview?.score??'нет данных')};
   const hash=crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');if(row.resultHash===hash)continue;row.resultNextAt=Date.now()+15*60000;
   try{const response=await fetchImpl(env.BLOGERY_RESULT_URL?new URL(env.BLOGERY_RESULT_URL):new URL('/api/integrations/result',origin),{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+env.BLOGERY_BRIDGE_SECRET,'Content-Type':'application/json'},body:JSON.stringify(result)});if(response.ok){row.resultHash=hash;row.resultSyncedAt=new Date().toISOString();}}catch{}persist();
  }
 }finally{busy=false}}
 function mount(app,requireAuth){
  if(env.FLOW_LOGISTICS_ENABLED!=='1')return;
  const staff=(req,res,next)=>['manager','marketer'].includes(req.session.role)?next():res.status(403).json({error:'Нет доступа'});
  app.post('/api/automation/brief-request/:id',requireAuth,staff,(req,res)=>{try{const d=(getState().microInfluencerDeals||[]).find(x=>String(x.id)===req.params.id);if(!d)return res.status(404).json({error:'Интеграция не найдена'});let actor=req.session.name||'общий вход';try{actor=req.session.name||decodeURIComponent(req.headers['x-actor']||'')||actor}catch{}const row=request(d,actor,String(req.body?.notes||'').slice(0,5000));res.json(row);drain().catch(()=>{});}catch(e){res.status(400).json({error:e.message})}});
  app.get('/api/automation/brief-request/:id',requireAuth,staff,(req,res)=>res.json({request:store().find(r=>r.integrationId===req.params.id)||null,approved:(getState().microInfluencerDeals||[]).find(d=>String(d.id)===req.params.id)?.flowBriefHistory||[]}));
  const timer=setInterval(()=>drain().catch(()=>{}),30000);timer.unref();
 }
 return {request,drain,mount};
}
module.exports={createClient};
