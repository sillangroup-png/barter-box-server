'use strict';
// Version-aware extension of the existing coordinator. Forwarding stays in dry-run.
const crypto=require('crypto');
const enabled=()=>process.env.FLOW_VIDEO_VERSIONS_ENABLED==='1';
function state(st){return st.videoFlow||(st.videoFlow={pendingMedia:[],reviewOutbox:[]});}
function recordVersion(deal,{messageId,url,source='blogger'}){
 const versions=deal.flowVideoVersions||(deal.flowVideoVersions=[]);
 const existing=versions.find(v=>messageId&&v.sourceMessageId===messageId);if(existing)return existing;
 const v={id:crypto.randomUUID(),number:versions.length+1,source,sourceMessageId:messageId||null,url,receivedAt:new Date().toISOString(),review:null};
 versions.push(v);deal.flowCurrentVideoVersionId=v.id;return v;
}
function queueAmbiguous(st,message,deals){const f=state(st);if(f.pendingMedia.some(x=>x.messageId===message.messageId))return;
 f.pendingMedia.push({messageId:message.messageId,url:String(message.contentUri||''),text:String(message.text||''),type:String(message.type||''),dealIds:deals.map(d=>d.id),receivedAt:new Date().toISOString(),status:'needs_assignment'});
}
function beginReview(deal,url){return recordVersion(deal,{url,source:'manager',messageId:'manual:'+url+':'+(deal.flowCurrentVideoVersionId||'first')});}
function finishReview(st,deal,versionId,result,error){const version=(deal.flowVideoVersions||[]).find(v=>v.id===versionId);if(!version)return;
 version.review=result?{status:'done',score:result.score,scale:result.scale||9,method:(result.scale||9)===18?'video-review-v2/18':'existing-video-review-v1/9',text:String(result.text||'').slice(0,12000),model:result.model||null,at:new Date().toISOString()}:{status:'error',error:String(error||'').slice(0,300),at:new Date().toISOString()};
 if(result&&deal.flowCurrentVideoVersionId===versionId){const f=state(st);if(!f.reviewOutbox.some(x=>x.videoVersionId===versionId))f.reviewOutbox.push({id:crypto.randomUUID(),dealId:deal.id,videoVersionId:versionId,versionNumber:version.number,url:version.url,review:version.review,responsible:deal.responsible,status:'dry_run',createdAt:new Date().toISOString(),note:'Отправка тимлиду требует проверки контакта, медиа API и ID ответа.'});}
}
module.exports={enabled,recordVersion,queueAmbiguous,beginReview,finishReview};
