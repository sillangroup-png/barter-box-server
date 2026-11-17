'use strict';
function createRelay({getState,persist,env=process.env,fetchImpl=fetch}){
 let busy=false;const jobs=()=>getState().crmCommsRelay||(getState().crmCommsRelay=[]);
 function enqueue(body){const configured=env.CRM_INSTAGRAM_CHANNEL_ID;if(!configured)return false;const messages=(body.messages||[]).filter(m=>m.channelId===configured&&m.chatType==='instagram');
  // Statuses contain no channel; restrict them to CRM message IDs seen for this configured channel.
  const ids=new Set(jobs().flatMap(j=>j.payload.messages.map(m=>m.messageId)));for(const m of messages)ids.add(m.messageId);
  const statuses=(body.statuses||[]).filter(s=>ids.has(s.messageId));if(!messages.length&&!statuses.length)return false;
  const key=JSON.stringify({messages:messages.map(m=>[m.messageId,m.status]),statuses:statuses.map(s=>[s.messageId,s.status])});if(jobs().some(x=>x.key===key))return false;jobs().push({key,payload:{messages,statuses},state:'pending',attempts:0,nextAt:0});persist();return true;
 }
 async function drain(){if(busy||!env.CRM_COMMS_WEBHOOK_URL||(env.CRM_COMMS_WEBHOOK_SECRET||'').length<32)return;const target=new URL(env.CRM_COMMS_WEBHOOK_URL);if(target.protocol!=='https:')return;busy=true;try{for(const job of jobs().filter(x=>x.state==='pending'&&x.nextAt<=Date.now()).slice(0,10)){job.attempts++;job.nextAt=Date.now()+60000;persist();try{const r=await fetchImpl(target,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+env.CRM_COMMS_WEBHOOK_SECRET,'Content-Type':'application/json'},body:JSON.stringify(job.payload)});if(r.ok)job.state='delivered';}catch{}persist()}}finally{busy=false}}
 return {enqueue,drain};
}
module.exports={createRelay};
