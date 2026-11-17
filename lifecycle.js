'use strict';
const crypto=require('crypto');
const validDate=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&new Date(s+'T12:00:00Z').toISOString().slice(0,10)===s;
const plus=(s,n)=>{const d=new Date(s+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
function applyEvent(state,id,input,actor){
 const d=(state.microInfluencerDeals||[]).find(d=>String(d.id)===String(id));if(!d)throw Error('Интеграция не найдена');
 if(!['expected_delivery','received','carrier_delivered','delivery_details','payment_paid'].includes(input.type))throw Error('Неизвестное событие');
 const key=String(input.key||'');if(key.length<8||key.length>200)throw Error('Нужен постоянный ключ события');
 const l=d.flowLifecycle||(d.flowLifecycle={events:[],messages:[],payments:{}}),fingerprint=JSON.stringify(input);const old=l.events.find(e=>e.key===key);if(old){if(old.fingerprint!==fingerprint)throw Error('Ключ использован для другого события');return l;}
 if(['expected_delivery','received','carrier_delivered'].includes(input.type)&&!validDate(input.date))throw Error('Укажите корректную дату');
 if(input.type==='payment_paid'&&(!['buyout','delivery','content'].includes(input.purpose)||!input.crmPaymentId||input.confirmed!==true))throw Error('Нужно подтверждение оплаты CRM и назначение');
 if(input.type==='delivery_details'){for(const k of ['goodsKzt','deliveryKzt'])if(!Number.isSafeInteger(Number(input[k]))||Number(input[k])<0)throw Error('Проверьте стоимость');if(!['courier','self_purchase'].includes(input.mode))throw Error('Укажите способ получения');}
 let text='';
 if(input.type==='delivery_details'){l.delivery={mode:input.mode,goodsKzt:Number(input.goodsKzt),deliveryKzt:Number(input.deliveryKzt),address:String(input.address||'').slice(0,1000)};text=input.mode==='courier'?'Для курьерской доставки пришлите, пожалуйста, адрес, ФИО получателя и телефон.':'Подтвердите, пожалуйста, стоимость выбранных товаров и доставки отдельно.';}
 if(input.type==='payment_paid'){const paymentKey=input.purpose+':'+input.crmPaymentId;if(!l.payments[paymentKey]){l.payments[paymentKey]={crmPaymentId:input.crmPaymentId,at:new Date().toISOString()};text=input.purpose==='buyout'?'Оплату за выкуп отправили. После оформления заказа пришлите, пожалуйста, ожидаемую дату доставки.':input.purpose==='delivery'?'Оплату доставки отправили. Подскажите, пожалуйста, ожидаемую дату получения товара.':'Оплата за контент подтверждена. Спасибо!';}}
 if(input.type==='carrier_delivered')l.carrierDeliveredDate=input.date;
 if(input.type==='expected_delivery')l.expectedDeliveryDate=input.date;
 if(input.type==='received'){l.receivedDate=input.date;d.productStatus='товар доставлен';}
 if(['expected_delivery','received'].includes(input.type)){
  const base=l.receivedDate||input.date,proposal={baseDate:base,materialDueDate:plus(base,2),publicationDate:plus(base,4),tentative:!l.receivedDate};
  const previous=l.plan;const protectedPlan=l.planConfirmed||d.publishDate||d.videoStatus==='опубликовано'||(d.plannedDate&&d.plannedDate!==previous?.publicationDate);
  if(protectedPlan){l.suggestedPlan=proposal;}else{l.plan=proposal;d.plannedDate=proposal.publicationDate;l.materialDueDate=proposal.materialDueDate;delete l.suggestedPlan;}
  if(input.type==='received')text=`Подтвердили получение товара. Подскажите, сможете прислать материал на согласование до ${proposal.materialDueDate}? Дату публикации согласуем после проверки.`;
 }
 if(text)l.messages.push({id:crypto.randomUUID(),eventKey:key,text,status:'draft',createdAt:new Date().toISOString()});
 l.events.push({id:crypto.randomUUID(),key,fingerprint,type:input.type,date:input.date||null,actor,at:new Date().toISOString()});return l;
}
function mount(app,{getState,persist,requireAuth,env=process.env}){if(env.FLOW_LOGISTICS_ENABLED!=='1')return;const guard=(req,res,next)=>['manager','marketer'].includes(req.session.role)?next():res.status(403).json({error:'Нет доступа'});
 app.get('/api/automation/lifecycle/:id',requireAuth,guard,(req,res)=>{const d=getState().microInfluencerDeals.find(d=>String(d.id)===req.params.id);if(!d)return res.status(404).end();res.json(d.flowLifecycle||{events:[],messages:[],payments:{}})});
 app.post('/api/automation/lifecycle/:id',requireAuth,guard,(req,res)=>{try{if(req.body.type==='payment_paid')throw Error('Оплата приходит только из CRM');const r=applyEvent(getState(),req.params.id,req.body,req.session.name||req.session.role);persist();res.json(r)}catch(e){res.status(409).json({error:e.message})}});
}
module.exports={applyEvent,mount,plus};
