'use strict';
const {createService}=require('./automation-flow');
// 23.11.2026 (Нина): ТЗ из коннектора Claude приходят с approvedBy «Claude · <менеджер>» — их сначала утверждает тимлид.
const BRIEF_LEADS=['Нина','Сая','Сауле'];
const needsLead=v=>/^(на проверке|Claude)/i.test(String(v&&v.approvedBy||''))&&!(v&&v.leadApprovedBy);
function createBriefDelivery({getState,persist,send,getChannel,env=process.env,fetchImpl=fetch}){
 let busy=false;const queue=()=>{const st=getState();st.briefDelivery=st.briefDelivery||[];return st.briefDelivery};
 function enqueue(dealId,versionId,actor){
  const deal=(getState().microInfluencerDeals||[]).find(d=>String(d.id)===String(dealId));if(!deal)throw Error('Интеграция не найдена');
  const version=(deal.flowBriefHistory||[]).find(v=>v.versionId===versionId);if(!version||!version.files?.pdf)throw Error('Нет утверждённой PDF-версии ТЗ');if(needsLead(version))throw Error('ТЗ ещё не утверждено тимлидом (Нина, Сая или Сауле)');
  const phone=String(deal.phone||'').replace(/\D/g,'').replace(/^8(?=\d{10}$)/,'7');if(!/^7\d{10}$/.test(phone))throw Error('Подтвердите телефон блогера');
  const prior=queue().find(x=>x.integrationId===deal.id&&x.versionId===versionId);if(prior)return prior;
  const job={id:'brief-delivery:'+deal.id+':'+versionId,integrationId:deal.id,briefId:version.briefId,versionId,phone,file:version.files.pdf,status:'pending',approvedBy:actor,createdAt:new Date().toISOString()};queue().push(job);persist();return job;
 }
 async function callback(job){if(!env.BLOGERY_AUDIT_ORIGIN||(env.BLOGERY_BRIDGE_SECRET||'').length<32)return;try{const r=await fetchImpl(env.BLOGERY_REQUESTS_URL?new URL(String(env.BLOGERY_REQUESTS_URL).replace(/\/+$/,'')+'/sent'):new URL('/api/integrations/sent',env.BLOGERY_AUDIT_ORIGIN),{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+env.BLOGERY_BRIDGE_SECRET,'Content-Type':'application/json'},body:JSON.stringify({integrationId:String(job.integrationId),briefId:job.briefId,versionId:job.versionId,messageId:job.providerMessageId,channel:'whatsapp'})});if(r.ok){job.callbackDone=true;persist()}}catch{}}
 async function drain(){if(busy||env.FLOW_BRIEF_SEND_MODE!=='on')return;busy=true;try{
  for(const deal of getState().microInfluencerDeals||[]){if(!deal.flowBriefAutoSend||!deal.flowBriefApprovedVersionId)continue;const current=String(deal.phone||'').replace(/\D/g,'').replace(/^8(?=\d{10}$)/,'7');if(current!==deal.flowBriefAutoSendPhone){deal.flowBriefAutoError='Телефон изменился: подтвердите автоматическую отправку заново';continue}try{enqueue(deal.id,deal.flowBriefApprovedVersionId,'автоотправка по разрешению менеджера')}catch(e){deal.flowBriefAutoError=e.message;}}
  const ch=await getChannel();const service=createService(getState,persist);
  for(const job of queue()){
   if(job.status==='sent'){if(!job.callbackDone)await callback(job);continue}
   if(job.status!=='pending')continue;
   const last=getState().coord?.lastIn?.[job.phone];if(!ch.plain&&(!last||Date.now()-Date.parse(last)>23.5*3600000)){job.lastError='Для WABA нужно активное окно общения';persist();continue}
   const deal=(getState().microInfluencerDeals||[]).find(d=>d.id===job.integrationId);if(!deal||String(deal.phone||'').replace(/\D/g,'').replace(/^8(?=\d{10}$)/,'7')!==job.phone){job.status='needs_recipient_check';persist();continue}
   job.status='sending';persist();try{
    // Сначала короткое сообщение, потом PDF с ТЗ (18.11.2026).
    if(!job.textSent){await send({channelId:ch.id,chatType:'whatsapp',chatId:job.phone,text:'Добрый день! Делимся ТЗ по нашей интеграции'+(deal.product?' ('+String(deal.product).slice(0,80)+')':'')+' 🙌 Посмотрите, пожалуйста, и напишите, если будут вопросы.',crmMessageId:job.id+':text',clearUnanswered:false});job.textSent=true;persist();}
    const result=await send({channelId:ch.id,chatType:'whatsapp',chatId:job.phone,contentUri:job.file,crmMessageId:job.id,clearUnanswered:false});if(!result.messageId)throw Error('no_message_id');job.providerMessageId=result.messageId;job.status='accepted';persist();}catch{job.status='uncertain';job.lastError='Проверьте чат перед повтором';persist();}
  }
 }finally{busy=false}}
 function statuses(items){let changed=false;for(const item of items||[]){const job=queue().find(x=>x.providerMessageId===item.messageId);if(!job)continue;
  if(['sent','delivered','read'].includes(item.status)&&job.status!=='sent'){
   createService(getState,persist).execute('WhatsApp',{action:'brief_sent',data:{dealId:job.integrationId,briefId:job.briefId,versionId:job.versionId,channel:'whatsapp',messageId:item.messageId,recipientConfirmed:true}},job.id+':confirmed');job.status='sent';job.sentAt=new Date().toISOString();changed=true;
  }else if(item.status==='error'){job.status='failed';job.lastError=String(item.error?.error||'Ошибка доставки');changed=true;}
 }if(changed)persist();return changed;}
 function approve(dealId,versionId,actor){
  if(!BRIEF_LEADS.includes(actor))throw Error('Утверждают только Нина, Сая или Сауле');
  const deal=(getState().microInfluencerDeals||[]).find(d=>String(d.id)===String(dealId));if(!deal)throw Error('Интеграция не найдена');
  const version=(deal.flowBriefHistory||[]).find(v=>v.versionId===versionId);if(!version)throw Error('Версия ТЗ не найдена');
  if(!version.leadApprovedBy){version.leadApprovedBy=actor;version.leadApprovedAt=new Date().toISOString();persist();}
  return {versionId,leadApprovedBy:version.leadApprovedBy,leadApprovedAt:version.leadApprovedAt};
 }
 function mount(app,requireAuth){if(env.FLOW_LOGISTICS_ENABLED!=='1')return;app.post('/api/automation/brief-approve/:id',requireAuth,(req,res)=>{try{res.json(approve(req.params.id,req.body.versionId,req.session.name||''))}catch(e){res.status(400).json({error:e.message})}});app.post('/api/automation/brief-send/:id',requireAuth,(req,res)=>{if(!['manager','marketer'].includes(req.session.role))return res.status(403).json({error:'Нет доступа'});try{res.json(enqueue(req.params.id,req.body.versionId,req.session.name||'общий вход'));drain().catch(()=>{})}catch(e){res.status(400).json({error:e.message})}});const timer=setInterval(()=>drain().catch(()=>{}),15000);timer.unref();}
 for(const job of queue())if(job.status==='sending')job.status='uncertain';
 return {enqueue,approve,drain,statuses,mount};
}
module.exports={createBriefDelivery,needsLead,BRIEF_LEADS};
