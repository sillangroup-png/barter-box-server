'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),multer=require('multer');
function createMedia({env=process.env,fetchImpl=fetch}){
 const root=path.resolve(env.FLOW_MEDIA_DIR||path.join(env.DATA_DIR||path.join(__dirname,'data'),'flow-media'));
 const valid=id=>/^[a-f0-9-]{36}\.(mp4|mov|webm)$/.test(String(id));
 function sign(id,exp){return crypto.createHmac('sha256',env.FLOW_MEDIA_SECRET||'').update(id+':'+exp).digest('hex')}
 function url(id){if(!valid(id))throw Error('Неверный ID файла');if((env.FLOW_MEDIA_SECRET||'').length<32||!env.FLOW_PUBLIC_ORIGIN||new URL(env.FLOW_PUBLIC_ORIGIN).protocol!=='https:')throw Error('Не настроены защищённые ссылки на видео');const exp=Math.floor(Date.now()/1000)+7*86400;return env.FLOW_PUBLIC_ORIGIN+'/api/automation/media/'+id+'?exp='+exp+'&sig='+sign(id,exp)}
 async function copyRemote(remote){
  url('00000000-0000-0000-0000-000000000000.mp4');
  const source=new URL(remote);const allowed=(env.FLOW_MEDIA_ALLOWED_HOSTS||'').split(',').map(x=>x.trim()).filter(Boolean);
  if(source.protocol!=='https:'||!(source.hostname==='wazzup24.com'||source.hostname.endsWith('.wazzup24.com')||allowed.includes(source.hostname)))throw Error('Источник медиа не входит в разрешённый список');
  const response=await fetchImpl(source,{redirect:'error',signal:AbortSignal.timeout(90000)});if(!response.ok||!response.body)throw Error('Не удалось получить исходное видео');
  const mime=String(response.headers.get('content-type')||'').split(';')[0];if(!['video/mp4','video/quicktime','video/webm','application/octet-stream'].includes(mime))throw Error('Источник не вернул видео');
  if(Number(response.headers.get('content-length')||0)>100*1024*1024)throw Error('Видео больше 100 МБ');
  fs.mkdirSync(root,{recursive:true});const id=crypto.randomUUID()+({ 'video/quicktime':'.mov','video/webm':'.webm'}[mime]||'.mp4'),tmp=path.join(root,id+'.tmp');let size=0;
  const fd=fs.openSync(tmp,'wx');try{for await(const chunk of response.body){size+=chunk.length;if(size>100*1024*1024)throw Error('Видео больше 100 МБ');fs.writeSync(fd,Buffer.from(chunk));}if(!size)throw Error('Пустой видеофайл');fs.closeSync(fd);fs.renameSync(tmp,path.join(root,id));return {id,url:url(id),bytes:size};}catch(e){try{fs.closeSync(fd)}catch{}fs.rmSync(tmp,{force:true});throw e;}
 }
 const upload=multer({storage:multer.diskStorage({destination(req,file,cb){fs.mkdirSync(root,{recursive:true});cb(null,root)},filename(req,file,cb){const ext=path.extname(file.originalname).toLowerCase();if(!['.mp4','.mov','.webm'].includes(ext))return cb(Error('Нужен MP4, MOV или WebM'));cb(null,crypto.randomUUID()+ext)}}),limits:{fileSize:100*1024*1024,files:1}}).single('video');
 function uploadMiddleware(req,res,next){upload(req,res,err=>err?res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'Видео больше 100 МБ':'Не удалось загрузить видео'}):next())}
 function mount(app,requireAuth){if(env.FLOW_VIDEO_VERSIONS_ENABLED!=='1')return;app.get('/api/automation/media/:id',(req,res)=>{const {id}=req.params;if(!valid(id))return res.status(404).end();const expected=sign(id,req.query.exp),given=String(req.query.sig||'');const signed=(env.FLOW_MEDIA_SECRET||'').length>=32&&/^\d+$/.test(String(req.query.exp))&&Number(req.query.exp)>Date.now()/1000&&Number(req.query.exp)<Date.now()/1000+8*86400&&/^[a-f0-9]{64}$/.test(given)&&crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(given));const serve=()=>{res.set('Cache-Control','private, no-store');res.set('X-Content-Type-Options','nosniff');res.sendFile(path.join(root,id));};if(signed)return serve();requireAuth(req,res,()=>{if(!['manager','marketer'].includes(req.session.role))return res.status(403).end();serve()});});}
 return {upload:uploadMiddleware,url,mount,copyRemote,remove(id){if(valid(id))fs.rmSync(path.join(root,id),{force:true})}};
}
module.exports={createMedia};
