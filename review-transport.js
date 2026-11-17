'use strict';
const {createService}=require('./automation-flow');
const teams={Нина:['Нина','Мадина','Марина','Зарина','Камила'],Сая:['Сая','Надира','Анастасия','Сабрина','Оксана'],Анеля:['Анеля','Ажар']};
const phone=x=>String(x||'').replace(/\D/g,'').replace(/^8(?=\d{10}$)/,'7');
function createReviewTransport({getState,persist,send,getChannel,env=process.env,resolveUrl=item=>item.url}){
 let busy=false;const records=()=>getState().videoFlow?.reviewOutbox||[];
 const service=createService(getState,persist);
 function reviewers(){try{return JSON.parse(env.FLOW_TEAM_LEADS_JSON||'{}')}catch{return {}}}
 function reviewer(manager){const key=String(manager||'').trim().split(/[\s(]/)[0];const team=Object.entries(teams).find(([,people])=>people.includes(key))?.[0];const r=reviewers()[team];return r&&/^7\d{10}$/.test(phone(r.phone))?{name:team,phone:phone(r.phone)}:null}
 function bind(id,item,to){const f=getState().automationFlow||(getState().automationFlow={version:1,catalog:[],requests:{},reviewMessages:{},events:[],drafts:[]});f.reviewMessages[id]={dealId:item.dealId,videoVersionId:item.videoVersionId,reviewerPhone:to.phone,at:new Date().toISOString()};}
 async function drain(){if(busy||!['dry','on'].includes(env.FLOW_REVIEW_SEND_MODE))return;busy=true;try{const channel=await getChannel();
  for(const item of records().filter(x=>['dry_run','pending','media_sent'].includes(x.status)).slice(0,5)){
   const deal=(getState().microInfluencerDeals||[]).find(d=>d.id===item.dealId);
   if(!deal||deal.flowCurrentVideoVersionId!==item.videoVersionId){item.status='superseded';persist();continue}
   const to=reviewer(item.responsible);if(!to){item.lastError='Не настроен подтверждённый контакт тимлида';persist();continue}
   const lastIn=getState().coord?.lastIn?.[to.phone];if(!channel.plain&&(!lastIn||Date.now()-Date.parse(lastIn)>23.5*3600000)){item.lastError='Для WABA нужно активное окно общения с тимлидом';persist();continue}
   item.recipient=to.name;
   const caption=`${deal.blogerName} · интеграция ${deal.id} · v${item.versionNumber}\nGATE ${item.review.score??'—'}/${item.review.scale}\n${String(item.review.text||'').slice(0,2500)}\nОтветьте на видео или это сообщение: Согласовано / Правки: … / Монтаж: … / Пересъём: … При низком GATE: Согласовано: причина`;
   item.preview={video:item.url,text:caption};
   if(env.FLOW_REVIEW_SEND_MODE==='dry'){item.status='dry_run';persist();continue}
   try{
    if(!item.mediaMessageId){item.status='sending_media';persist();const response=await send({channelId:channel.id,chatType:'whatsapp',chatId:to.phone,contentUri:resolveUrl(item),crmMessageId:'flow-review-media:'+item.videoVersionId,clearUnanswered:false});if(!response.messageId)throw Error('no_message_id');item.mediaMessageId=response.messageId;bind(response.messageId,item,to);item.status='media_sent';persist();}
    item.status='sending_caption';persist();const response=await send({channelId:channel.id,chatType:'whatsapp',chatId:to.phone,text:caption,refMessageId:item.mediaMessageId,crmMessageId:'flow-review-caption:'+item.videoVersionId,clearUnanswered:false});if(!response.messageId)throw Error('no_message_id');bind(response.messageId,item,to);item.captionMessageId=response.messageId;item.status='sent';item.sentAt=new Date().toISOString();deal.vstage='lead';deal.vlead=to.name;persist();
   }catch{item.status='uncertain';item.lastError='Результат отправки не подтверждён: проверьте чат перед повтором';persist();}
  }
 }finally{busy=false}}
 function incoming(msg,ourChannel){
  if(!msg||msg.isEcho||msg.isEdited||msg.isDeleted||msg.channelId!==ourChannel||msg.chatType!=='whatsapp')return false;
  const sender=phone(msg.chatId);if(!Object.values(reviewers()).some(r=>phone(r.phone)===sender))return false;
  const st=getState();st.coord=st.coord||{};st.coord.lastIn=st.coord.lastIn||{};st.coord.lastIn[sender]=new Date().toISOString();
  const quoted=msg.quotedMessage?.messageId;const binding=st.automationFlow?.reviewMessages?.[quoted];if(!binding)return true;
  try{const decision=service.execute('тимлид (WhatsApp)',{action:'review_reply',data:{quotedMessageId:quoted,senderPhone:sender,text:msg.text,messageId:msg.messageId}},'review-in:'+msg.messageId);
   const deal=(st.microInfluencerDeals||[]).find(d=>d.id===binding.dealId);if(deal){deal.vstage=({approved:'approved',changes:'revise',reshoot:'reshoot',editing:'lead'})[decision.decision];deal.vstageAt=new Date().toISOString();deal.vleadComment=decision.note||'';if(decision.decision==='approved'){deal.vmissed=0;deal.vdueMissed=null;}if(decision.decision==='editing')deal.flowEditingStatus='requested';}
   persist();return true;
  }catch(e){const events=st.coord.events||(st.coord.events=[]);if(!events.some(x=>x.sourceMessageId===msg.messageId))events.push({id:'review-error:'+msg.messageId,sourceMessageId:msg.messageId,at:new Date().toISOString(),dealId:binding.dealId,to:reviewer((st.microInfluencerDeals||[]).find(d=>d.id===binding.dealId)?.responsible)?.name,kind:'review_attention',text:e.status?e.message:'Ответ требует проверки',read:false});persist();return true;}
 }
 for(const item of records())if(['sending_media','sending_caption'].includes(item.status))item.status='uncertain';
 return {drain,incoming,reviewer};
}
module.exports={createReviewTransport};
