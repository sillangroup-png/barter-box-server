'use strict';
const stamp=clock=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Almaty',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(clock()).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
function createDigests({getState,persist,send,getChannel,env=process.env,clock=()=>new Date()}){
 let busy=false;const jobs=()=>getState().logisticsDigests||(getState().logisticsDigests=[]);
 function prepare(){if(!['dry','on'].includes(env.FLOW_LOGISTICS_DIGEST_MODE))return;const p=stamp(clock),minutes=Number(p.hour)*60+Number(p.minute),slot=[720,900].find(s=>minutes>=s&&minutes<s+10);if(slot===undefined)return;
  let contacts={};try{contacts=JSON.parse(env.FLOW_LOGISTICS_CONTACTS_JSON||'{}')}catch{return}
  for(const [name,contact] of Object.entries(contacts)){
   const orders=(getState().orders||[]).filter(o=>o.fulfillment&&o.status!=='cancelled'&&o.status!=='delivered');const selected=orders.filter(o=>{const f=o.fulfillment;if(name==='Сая'||contact.role==='coordinator')return ['distribution','shortage','assembled'].includes(f.stage);if(contact.role==='logistic')return f.stage==='assembled'&&(!contact.warehouse||contact.warehouse===f.warehouse);return f.assembler===name&&f.stage==='assigned'});
   const phone=String(contact.phone||'').replace(/\D/g,'');if(!selected.length||!/^7\d{10}$/.test(phone))continue;
   const key=[p.year,p.month,p.day,slot,name].join(':');if(jobs().some(j=>j.key===key))continue;
   const text=`${name}, задачи на ${slot===720?'12:00':'15:00'}: ${selected.length}.\n`+selected.slice(0,20).map(o=>'Заявка №'+o.id+' · '+({distribution:'распределить',shortage:'нехватка товара',assembled:'готово к отправке',assigned:'собрать'}[o.fulfillment.stage]||o.fulfillment.stage)).join('\n')+'\nОткрыть очередь: '+(env.FLOW_PUBLIC_ORIGIN||'')+'/flow/';
   jobs().push({key,phone,name,text,status:env.FLOW_LOGISTICS_DIGEST_MODE==='dry'?'dry_run':'pending',createdAt:clock().toISOString()});persist();
  }
 }
 async function drain(){if(busy)return;prepare();if(env.FLOW_LOGISTICS_DIGEST_MODE!=='on')return;busy=true;try{const ch=await getChannel();for(const j of jobs().filter(j=>j.status==='pending')){if(clock()-new Date(j.createdAt)>30*60000){j.status='expired';persist();continue}const last=getState().coord?.lastIn?.[j.phone];if(!ch.plain&&(!last||Date.now()-Date.parse(last)>23.5*3600000))continue;j.status='sending';persist();try{const result=await send({channelId:ch.id,chatType:'whatsapp',chatId:j.phone,text:j.text,crmMessageId:'logistics:'+j.key,clearUnanswered:false});if(!result.messageId)throw Error('No ID');j.status='accepted';j.messageId=result.messageId;persist()}catch{j.status='uncertain';persist()}}}finally{busy=false}}
 return {prepare,drain};
}
module.exports={createDigests};
