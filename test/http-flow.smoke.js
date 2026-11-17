// Starts the actual Express application on disposable synthetic data, with no external credentials.
const {spawn}=require('node:child_process'),{mkdtempSync,writeFileSync,rmSync}=require('node:fs'),{tmpdir}=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{const dir=mkdtempSync(path.join(tmpdir(),'mixit-http-'));const root=path.resolve(__dirname,'..');
const initial={drivers:[],campaigns:[],orders:[],returns:[],publications:[],influencerDeals:[],salesByDay:[],microInfluencerDeals:[],productEvents:[],plans:[],productSkuOverrides:[]};writeFileSync(path.join(dir,'state.json'),JSON.stringify(initial));
const port=18431;const child=spawn(process.execPath,['server.js'],{cwd:root,env:{PATH:process.env.PATH,PORT:String(port),DATA_DIR:dir,UPLOADS_DIR:path.join(dir,'uploads'),MANAGER_LOGIN:'test',MANAGER_PASSWORD:'synthetic-test-password',MARKETER_LOGIN:'marketer',MARKETER_PASSWORD:'synthetic-test-password',FLOW_LOGISTICS_ENABLED:'1',COORD_MODE:'off'},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);let token;
const base='http://127.0.0.1:'+port;
async function api(p,body,extra={}){console.log('CHECK',p);const r=await fetch(base+p,{method:body?'POST':'GET',headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json',...extra},body:body?JSON.stringify(body):undefined});const data=await r.json();assert.ok(r.ok,data.error||'HTTP '+r.status);return data;}
let key=0;const cmd=(action,data,k)=>api('/api/automation/command',{action,data},{'Idempotency-Key':k||'smoke-key-'+(++key)});
try{let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(base+'/api/health');if(r.ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,80));}assert.ok(ready,'Server startup failed: '+log.slice(-1000));
const unauth=await fetch(base+'/api/automation/state');assert.equal(unauth.status,401);
token=(await api('/api/auth/login',{role:'manager',login:'test',password:'synthetic-test-password'})).token;
let s=await api('/api/automation/state');assert.equal(s.deals.length,0);
await cmd('catalog_import',{items:[{name:'Тестовый крем',barcode:'0000000000001',cost_kzt:'759.94'}],dryRun:false});s=await api('/api/automation/state');const p=s.catalog[0];
const d1=await api('/api/micro-influencer-deals',{blogerName:'Тест',instagramAccount:'test_beauty',responsible:'Сая',plannedDate:'2026-11-30',flowGoodsInput:[{productId:p.id,qty:2,expectedCostMinor:75994}]});assert.equal(d1.productCost,1519.88);assert.equal(d1.barcode,'');
const d2=await api('/api/micro-influencer-deals',{blogerName:'Тест',instagramAccount:'test_beauty',responsible:'Сая'});
const body={dealIds:[d1.id,d2.id],items:[{productId:p.id,qty:2}],city:'Астана',address:'Тестовый адрес',phone:'+77000000000'};const o=await cmd('shipment_request',body,'stable-shipment-key');assert.equal((await cmd('shipment_request',body,'stable-shipment-key')).id,o.id);
await cmd('shipment_assign',{id:o.id,warehouse:'Астана',assembler:'Аяужан'});await cmd('shipment_stage',{id:o.id,stage:'assembled'});await cmd('shipment_stage',{id:o.id,stage:'dispatched',carrier:'Тест',tracking:'TEST-1'});
s=await api('/api/automation/state');assert.equal(s.orders[0].status,'in_route');assert.notEqual(s.deals[0].productStatus,'товар доставлен');
await api('/api/orders/bulk-deliver',{ids:[o.id],closureType:'sale'});s=await api('/api/automation/state');assert.ok(s.deals.every(d=>d.productStatus==='товар доставлен'));
await api('/api/orders/bulk-status',{ids:[o.id],status:'returned'});s=await api('/api/automation/state');assert.ok(s.deals.every(d=>d.productStatus!=='товар доставлен'));
assert.ok((await fetch(base+'/flow/')).ok);assert.ok((await fetch(base+'/flow-product-picker.js')).ok);
console.log('PASS actual Express: auth, server-side price, grouped shipment, retry, assembly, dispatch, confirmed delivery, reversal, UI assets.');
}catch(e){console.error('Server errors:',log.match(/(?:ReferenceError|TypeError|Error):[^\n]+/g));throw e;}finally{child.kill('SIGTERM');await new Promise(resolve=>{child.on('exit',resolve);setTimeout(resolve,2000)});rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e.message);process.exitCode=1});
