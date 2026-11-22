/* Explicit robot command queue; never executes a simulation log automatically. */
const http=require('node:http'),fs=require('node:fs'),crypto=require('node:crypto');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(),crypto.createHash('sha256').update(b).digest());
function createRobotServer(config){
 const now=config.now||Date.now,epoch=crypto.randomUUID(),devices=new Map(config.devices.map(d=>[d.id,{...d,queue:[],history:[],boot:null,health:null}]));
 return http.createServer(async(req,res)=>{
  const send=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  try{
   const url=new URL(req.url,'http://localhost'),match=url.pathname.match(/^\/api\/robots\/([^/]+)\/(poll|ack|commands|status|stop)$/);if(!match)return send(404,{error:'not_found'});
   const device=devices.get(decodeURIComponent(match[1]));if(!device)return send(404,{error:'unknown_device'});
   const action=match[2],operator=['commands','status','stop'].includes(action),token=(req.headers.authorization||'').replace(/^Bearer /,'');if(!equal(token,operator?config.operatorToken:device.token))return send(401,{error:'unauthorized'});
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>65536)return send(413,{error:'too_large'});}const body=raw?JSON.parse(raw):{};
   if(action==='status'&&req.method==='GET')return send(200,{epoch,boot:device.boot,health:device.health,queue:device.queue,history:device.history});
   if(action==='stop'&&req.method==='POST'){device.queue=[];device.stop=crypto.randomUUID();if(device.health)device.health.ready=false;return send(200,{ok:true});}
   if(action==='poll'&&req.method==='POST'){
    if(typeof body.boot!=='string'||!body.boot.length||body.boot.length>80)return send(400,{error:'boot_required'});
    if(device.boot&&device.boot!==body.boot){device.queue=[];device.stop=crypto.randomUUID();}
    if(device.health&&device.queue.length&&now()-device.health.seen_at>1500){device.queue=[];device.stop=crypto.randomUUID();}
    device.boot=body.boot;device.health={...body,seen_at:now()};
    if(device.stop){const id=device.stop;device.stop=null;device.health.ready=false;return send(200,{epoch,stop:true,id});}
    const command=device.queue[0];if(command&&!command.expires_at)command.expires_at=now()+15000;
    if(command&&command.expires_at<=now()){device.queue=[];device.health.ready=false;return send(200,{epoch,stop:true,error:'command_expired'});}
    return send(200,{epoch,command:body.ready===true?command||null:null});
   }
   if(action==='ack'&&req.method==='POST'){
    if(body.epoch!==epoch||body.boot!==device.boot)return send(409,{error:'session_changed'});
    const command=device.queue[0];if(!command||body.id!==command.id){if(device.history.some(c=>c.id===body.id))return send(200,{ok:true});return send(409,{error:'unknown_command'});}
    if(!['done','failed'].includes(body.status))return send(400,{error:'invalid_status'});
    device.history.push({...command,status:body.status,detail:String(body.detail||'').slice(0,200)});device.history=device.history.slice(-200);device.queue.shift();if(body.status==='failed')device.queue=[];return send(200,{ok:true});
   }
   if(action==='commands'&&req.method==='POST'){
    if(!device.health||now()-device.health.seen_at>2000||device.health.ready!==true)return send(409,{error:'device_not_ready'});
    if(device.queue.length)return send(409,{error:'queue_not_empty'});
    const rows=body.commands;if(!Array.isArray(rows)||!rows.length||rows.length>100)return send(400,{error:'commands_required'});
    // Accept structured units only. Completed manual measurements cannot be replayed.
    if(rows.some(c=>c.manual||!['forward','backward','left','right','stop'].includes(c.kind)||c.kind!=='stop'&&(!Number.isFinite(c.value)||c.value<=0||c.value>(['left','right'].includes(c.kind)?45:.25)||c.unit!==(['left','right'].includes(c.kind)?'deg':'m'))))return send(422,{error:'invalid_command_or_unit',detail:'Only new movement orders: <=0.25 m or <=45 degrees. No manual/history replay.'});
    device.queue=rows.map(c=>({id:crypto.randomUUID(),kind:c.kind,value:c.kind==='stop'?0:c.value,unit:c.kind==='stop'?'':c.unit}));return send(201,{ids:device.queue.map(c=>c.id)});
   }
   send(405,{error:'method_not_allowed'});
  }catch{send(400,{error:'invalid_request'});}
 });
}
if(require.main===module){
 const file=process.argv[2];if(!file){console.error('Usage: node robot-server.cjs PRIVATE_CONFIG.json [host=127.0.0.1] [port=8766]');process.exitCode=1;}
 else{const config=JSON.parse(fs.readFileSync(file,'utf8'));if(!config.operatorToken||!Array.isArray(config.devices)||config.devices.some(d=>!d.id||!d.token))throw Error('Invalid private config');createRobotServer(config).listen(Number(process.argv[4]||8766),process.argv[3]||'127.0.0.1',()=>console.log('Robot command server started. No simulation commands are queued automatically.'));}
}
module.exports={createRobotServer};
