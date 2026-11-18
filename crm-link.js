'use strict';
const crypto=require('crypto');
function mount(app,{getState,persist,requireAuth,env=process.env}){
 if(env.FLOW_LOGISTICS_ENABLED!=='1')return;
 const keyOK=req=>{const want=env.FLOW_CRM_SECRET||'',got=String(req.headers.authorization||'').replace(/^Bearer /,'');return want.length>=32&&Buffer.byteLength(want)===Buffer.byteLength(got)&&crypto.timingSafeEqual(Buffer.from(want),Buffer.from(got))};
 const list=()=>{const st=getState();st.automationFlow=st.automationFlow||{version:1,catalog:[],requests:{},reviewMessages:{},events:[],drafts:[]};return st.automationFlow.bloggerLinks||(st.automationFlow.bloggerLinks=[])};
 app.get('/api/automation/crm-catalog',(req,res)=>{if(!keyOK(req))return res.status(403).json({error:'Нет межсерверного доступа'});res.json({items:getState().automationFlow?.catalog||[]})});
 app.post('/api/automation/crm-blogger',(req,res)=>{if(!keyOK(req))return res.status(403).json({error:'Нет межсерверного доступа'});const b=req.body||{};const handle=String(b.instagram||'').toLowerCase().replace(/^https?:\/\/(www\.)?instagram\.com\//,'').replace(/^@/,'').split(/[/?#]/)[0];if(!b.crmBloggerId||!/^[a-z0-9._]{1,30}$/.test(handle))return res.status(400).json({error:'Нужен ID CRM и Instagram-профиль'});
  const records=list();const collision=records.find(x=>x.handle===handle&&x.crmBloggerId!==String(b.crmBloggerId));if(collision)return res.status(409).json({error:'Профиль связан с другой записью CRM: нужна сверка'});
  const old=records.find(x=>x.crmBloggerId===String(b.crmBloggerId));if(old&&old.handle!==handle)return res.status(409).json({error:'Instagram-профиль изменился: подтвердите соответствие вручную'});
  const record={crmBloggerId:String(b.crmBloggerId),handle,name:String(b.name||handle).slice(0,150),phone:String(b.phone||'').slice(0,30),responsible:String(b.responsible||'').slice(0,100),followers:Math.max(0,Number(b.followers)||0),avgReach:Math.max(0,Number(b.avgReach)||0),er:Math.max(0,Number(b.er)||0),tiktokAccount:String(b.tiktok||'').slice(0,200),followersTT:Math.max(0,Number(b.followersTT)||0),avgReachTT:Math.max(0,Number(b.avgReachTT)||0),cost:Math.max(0,Number(b.price)||0),bloggerCategory:String(b.category||'').slice(0,60),notes:String(b.notes||'').slice(0,300),updatedAt:new Date().toISOString()};if(old)Object.assign(old,record);else records.push(record);persist();res.json({ok:true,crmBloggerId:record.crmBloggerId});
 });
 app.get('/api/automation/crm-blogger/:id',requireAuth,(req,res)=>{if(!['manager','marketer'].includes(req.session.role))return res.status(403).json({error:'Нет доступа'});const profile=list().find(x=>x.crmBloggerId===req.params.id);if(!profile)return res.status(404).json({error:'Профиль не найден'});res.json({profile,integrations:(getState().microInfluencerDeals||[]).filter(x=>x.crmBloggerId===profile.crmBloggerId).map(x=>({id:x.id,plannedDate:x.plannedDate,product:x.product}))});});
}
module.exports={mount};
