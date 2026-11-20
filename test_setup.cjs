const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const {chromium}=require('playwright');
const root=__dirname, output=path.join(root,'test-output');
fs.mkdirSync(output,{recursive:true});
for(const name of ['polygon-geometry.js','setup-geometry.js'])vm.runInThisContext(fs.readFileSync(path.join(root,name),'utf8'));
const G=SetupGeometry;
function points(values){return values.map(([x,y])=>({id:randomUUID(),x,y}));}
function geometryTests(){
  const boundary=points([[0,0],[1000,0],[1000,700],[0,700]]);
  const route={points:points([[1,350],[999,350]]),maxDepth:5,maxSlope:2};
  const depth=G.emptyDepth();assert.deepEqual(G.routeErrors(route,boundary,depth),[]);
  depth.cells[7*20+10]=null;assert(G.routeErrors(route,boundary,depth).some(e=>e.includes('препятствие')));
  depth.cells[7*20+10]=6;assert(G.routeErrors(route,boundary,depth).some(e=>e.includes('глубина')));
  depth.cells[7*20+10]=3;assert(G.routeErrors(route,boundary,depth).some(e=>e.includes('перепад')));
  const concave=points([[100,100],[900,100],[900,600],[600,600],[600,300],[400,300],[400,600],[100,600]]);
  assert(!G.inPolygon(points([[200,500],[800,500]]),concave,false),'Concave shortcut leaves boundary');
  assert(!G.validPoints(points([[0,0],[100,100],[0,100],[100,0]])));
  assert.throws(()=>G.validateDepth({...depth,cells:[1]}));
  assert.throws(()=>G.validateDepth({...depth,cells:depth.cells.map(()=>-1)}));
  const start={x:125,y:325},end={x:875,y:325},barrier=G.emptyDepth();
  for(let row=0;row<barrier.rows;row++)barrier.cells[row*barrier.cols+10]=null;
  assert.equal(G.findPath(start,end,boundary,barrier),null,'A solid wall must be unreachable');
  barrier.cells[3*20+10]=0;
  const detour=G.findPath(start,end,boundary,barrier);assert(detour&&detour.length>2,'A* takes a detour through the gap');
  assert.deepEqual(G.routeErrors({points:detour,maxDepth:5,maxSlope:2},boundary,barrier),[]);
  const cliff=G.emptyDepth();for(let row=0;row<cliff.rows;row++)cliff.cells[row*20+10]=3;
  assert.equal(G.findPath(start,end,boundary,cliff),null,'A* obeys slope constraints');
  assert(G.findPath(start,end,boundary,cliff,{maxSlope:3}));
  assert.equal(G.findPath(start,end,boundary,cliff,{maxDepth:2,maxSlope:3}),null,'A* obeys depth limits');
  const ridge=G.emptyDepth();for(let row=2;row<12;row++)for(let col=9;col<=11;col++)ridge.cells[row*20+col]=1;
  const straight=[start,end],smooth=G.findPath(start,end,boundary,ridge);
  assert.deepEqual(G.routeErrors({points:straight,maxDepth:5,maxSlope:2},boundary,ridge),[],'The straight route is legal but rough');
  assert(smooth&&smooth.length>2,'Prefer a curved flat detour even when the direct line is legal');
  const directMetrics=G.pathMetrics(straight,boundary,ridge),smoothMetrics=G.pathMetrics(smooth,boundary,ridge);
  assert.equal(smoothMetrics.peak,0);assert.equal(smoothMetrics.variation,0);assert(smoothMetrics.length>directMetrics.length);
  assert(directMetrics.peak>smoothMetrics.peak,'Smoothing cannot cut the route back across the ridge');
  const concavePath=G.findPath({x:225,y:525},{x:775,y:525},concave,G.emptyDepth());
  assert(concavePath&&G.inPolygon(concavePath,concave,false),'A* stays inside concave polygons');
  const zones=[['warehouse',[[180,180],[300,180],[300,280],[180,280]]],['charging',[[400,180],[500,180],[500,280],[400,280]]],['mining',[[600,180],[700,180],[700,280],[600,280]]],['transport',[[140,140],[860,140],[860,580],[140,580]]]].map(([kind,coords],i)=>({id:'zone-'+i,name:kind,kind,points:points(coords)}));
  const vehicle={id:'truck',name:'Truck',type:'truck'},terrainBoundary=points([[100,100],[900,100],[900,600],[100,600]]);
  for(const seed of [...Array.from({length:32},(_,i)=>i),12345,23456,4294967295]){
    const map=G.generateDepth(terrainBoundary,zones,seed);assert.deepEqual(map,G.generateDepth(terrainBoundary,zones,seed),'Seed reproduces the map');
    assert(map.cells.includes(null)&&map.cells.some(v=>v>0));assert.equal(G.validateDepth(map).seed,seed);
    const planned=G.planRoutes(terrainBoundary,zones,[vehicle],map);assert.equal(planned.routes.length,2,'Two default connections for seed '+seed);assert.deepEqual(planned.unreachable,[]);
    for(const route of planned.routes){assert.deepEqual(G.routeErrors(route,terrainBoundary,map,[zones[3].points]),[]);assert.notEqual(route.toZoneId,zones[3].id,'Driving area is not a destination');}
    const covered=new Set(planned.routes.flatMap(route=>[route.fromZoneId,route.toZoneId]));assert(zones.filter(z=>z.kind!=='transport').every(zone=>covered.has(zone.id)),'Every working zone is connected');
  }
  // An S-shaped neck has no cell centres at this resolution. Continuous
  // corridor reservation and polygon visibility still have to connect it.
  const narrow=points([[100,100],[400,100],[400,290],[600,290],[600,400],[900,400],[900,650],[590,650],[590,300],[390,300],[390,600],[100,600]]);
  assert(G.validPoints(narrow));
  const smallZone=(id,kind,x,y)=>({id,name:id,kind,points:points([[x-10,y-10],[x+10,y-10],[x+10,y+10],[x-10,y+10]])});
  const narrowZones=[smallZone('store','warehouse',250,350),smallZone('mine','mining',750,500),smallZone('charge','charging',250,150),{id:'drivable',name:'Driving area',kind:'transport',points:narrow}];
  for(const limits of [{maxDepth:5,maxSlope:2,boundaryClearance:0,markerClearance:0},{maxDepth:1,maxSlope:.01,boundaryClearance:0,markerClearance:0},{maxDepth:0,maxSlope:0,boundaryClearance:0,markerClearance:0}]){
    const map=G.generateDepth(narrow,narrowZones,98765,20,14,limits),planned=G.planRoutes(narrow,narrowZones,[vehicle],map,limits);
    assert.equal(planned.routes.length,2,'All narrow-neck connections remain reachable '+JSON.stringify(limits));assert.deepEqual(planned.unreachable,[]);
    for(const route of planned.routes)assert.deepEqual(G.routeErrors(route,narrow,map),[]);
  }
  const overlapping=[{...zones[0],id:'a',kind:'warehouse'},{...zones[0],id:'b',kind:'mining'},zones[3]],overlapMap=G.generateDepth(terrainBoundary,overlapping,33);
  assert.equal(G.planRoutes(terrainBoundary,overlapping,[vehicle],overlapMap).routes.length,1,'Coincident centres still reach the destination zone');
  assert.throws(()=>G.planRoutes(terrainBoundary,zones,Array(16).fill(vehicle),G.emptyDepth()),/30/);
  const concaveDriving=[concave];
  const restricted=G.findPath({x:225,y:525},{x:775,y:525},boundary,G.emptyDepth(),{transportAreas:concaveDriving});
  assert(restricted&&G.inAreas(restricted,concaveDriving),'Cannot shortcut through excluded parts of the driving area');
  assert(G.routeErrors({points:points([[225,525],[775,525]]),maxDepth:5,maxSlope:2},boundary,G.emptyDepth(),concaveDriving).some(e=>e.includes('транспортной')));
  assert.throws(()=>G.generateDepth(terrainBoundary,[...zones.slice(0,3),{...zones[3],points:points([[700,400],[800,400],[800,500],[700,500]])}],1),/должна/);
  const drivingUnion=[points([[100,100],[500,100],[500,500],[100,500]]),points([[400,400],[900,400],[900,600],[400,600]])];
  const unionPath=G.findPath({x:200,y:200},{x:800,y:550},boundary,G.emptyDepth(),{transportAreas:drivingUnion});
  assert(!G.inAreas(points([[200,200],[800,550]]),drivingUnion));assert(unionPath&&G.inAreas(unionPath,drivingUnion),'Can move across overlapping transport areas without cutting excluded space');
  const safety=G.safetyContext(boundary,[boundary],[{x:500,y:350}]),policy={boundaryClearance:15,markerClearance:40};
  assert(G.clearanceErrors(points([[100,350],[900,350]]),policy,safety).some(e=>e.includes('рукомаркер')),'Check the segment interior, not just endpoints');
  const around=G.findPath({x:125,y:325},{x:875,y:325},boundary,G.emptyDepth(),{...policy,markers:[{x:500,y:350}]});
  assert(around&&around.length>2);assert.deepEqual(G.clearanceErrors(around,policy,safety),[]);
  assert(G.clearanceErrors(points([[100,10],[900,10]]),policy,safety).some(e=>e.includes('границы')));
  const unionSafety=G.safetyContext(boundary,drivingUnion,[]);
  assert.deepEqual(G.clearanceErrors(points([[450,350],[450,550]]),{boundaryClearance:20,markerClearance:0},unionSafety),[],'Overlapping-area seams are not driving boundaries');
  assert.equal(G.pathMetrics(points([[100,350],[900,350]]),boundary,G.emptyDepth(),{...policy,markers:[{x:500,y:350}]}),null);
  const corridor=[points([[100,300],[900,300],[900,320],[100,320]])];
  const corridorStart={x:200,y:310},corridorEnd={x:800,y:310};
  assert.equal(G.findPath(corridorStart,corridorEnd,boundary,G.emptyDepth(),{transportAreas:corridor,boundaryClearance:15}),null,'Old gap blocks a 20-unit-wide corridor');
  const corridorPath=G.findPath(corridorStart,corridorEnd,boundary,G.emptyDepth(),{transportAreas:corridor,boundaryClearance:5});
  assert(corridorPath,'Reduced gap opens the narrow corridor');
  assert.deepEqual(G.clearanceErrors(corridorPath,{boundaryClearance:5},G.safetyContext(boundary,corridor,[])),[]);
  const fleet=[vehicle,{id:'dozer',name:'Dozer',type:'bulldozer'},{id:'loader',name:'Loader',type:'loader'},{id:'legacy',name:'Legacy',type:'excavator'}];
  const fleetRoutes=G.planRoutes(terrainBoundary,zones,fleet,G.emptyDepth()).routes;assert.equal(fleetRoutes.length,5);
  const byId=new Map(zones.map(z=>[z.id,z]));
  for(const machine of fleet){const routes=fleetRoutes.filter(r=>r.equipmentId===machine.id);assert(routes.every(r=>r.bidirectional));assert.equal(routes.length,machine.type==='truck'?2:1);
    const charge=routes.find(r=>r.purpose==='charging');assert(charge);assert.equal(byId.get(charge.fromZoneId).kind,machine.type==='loader'?'mining':'warehouse');assert.equal(byId.get(charge.toZoneId).kind,'charging');
    assert(routes.every(r=>!G.vehicleRouteErrors(r,zones,machine).length));
  }
  const haul=fleetRoutes.find(r=>r.purpose==='haul');assert.equal(haul.equipmentId,'truck');
  for(const machine of fleet.filter(v=>v.type!=='truck'))assert(G.vehicleRouteErrors({...haul,equipmentId:machine.id},zones,machine).length);
  assert.throws(()=>G.generateDepth(narrow,narrowZones,98765),/отступ|безопасного/,'Never shrink clearances to force a vehicle into a narrow corridor');
  console.log('PASS planner: 35 reproducible seeds connect every zone; narrow bent corridors, zero depth/slope, overlapping centres; flatter detours preferred to legal straight lines without destructive simplification; impassable imported maps remain blocked.');
  console.log('PASS geometry: concave boundary, thin and edge-adjacent obstacles, depth, cell jumps, invalid maps.');
}

async function main(){
  geometryTests();
  const db=new PGlite();
  await db.exec("create schema auth;create role anon;create role authenticated;create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to authenticated;grant execute on function auth.uid() to authenticated;");
  await db.exec(fs.readFileSync(path.join(root,'supabase/schema.sql'),'utf8'));
  const legacyUser=randomUUID(),legacyPolygon=randomUUID(),legacyEquipment=randomUUID();
  await db.query('insert into auth.users(id) values($1)',[legacyUser]);
  await db.query("insert into public.polygons(id,owner_id,name,geometry) values($1,$2,'Legacy fixture','{}')",[legacyPolygon,legacyUser]);
  await db.exec("alter table public.equipment drop constraint equipment_type_check;alter table public.equipment add constraint equipment_type_check check(type in ('truck','excavator','loader','robot'));");
  await db.query("insert into public.equipment(id,user_id,polygon_id,name,type,marker_id) values($1,$2,$3,'Existing custom name','excavator',49)",[legacyEquipment,legacyUser,legacyPolygon]);
  await db.exec(fs.readFileSync(path.join(root,'supabase/transport-migration.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(root,'supabase/transport-migration.sql'),'utf8'));
  const converted=(await db.query('select * from public.equipment where id=$1',[legacyEquipment])).rows[0];assert.equal(converted.type,'bulldozer');assert.equal(converted.marker_id,49);assert.equal(converted.name,'Existing custom name');
  await db.query('delete from public.equipment where id=$1',[legacyEquipment]);await db.query('delete from public.polygons where id=$1',[legacyPolygon]);await db.query('delete from auth.users where id=$1',[legacyUser]);
  const accounts=new Map(),tokens=new Map();
  let queue=Promise.resolve();
  function serial(action){const result=queue.then(action);queue=result.catch(()=>{});return result;}
  async function asUser(id,sql,args=[]){return serial(()=>db.transaction(async tx=>{
    await tx.exec('set local role authenticated');await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[id]);return tx.query(sql,args);
  }));}
  const rpcParams={create_polygon:['p_name','p_points'],select_polygon:['p_polygon'],create_equipment:['p_name','p_type'],create_equipment_with_id:['p_name','p_type','p_marker_id'],set_equipment_marker:['p_id','p_marker_id'],delete_equipment:['p_id'],save_workspace:['p_zones','p_routes','p_depth','p_revision'],advance_setup:[]};
  async function rpc(id,name,args){return (await asUser(id,'select * from public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+')',args)).rows[0];}
  function json(response,status,data){response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(data));}
  let base,routesEnabled=true;
  const server=http.createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,'http://localhost');
      if(url.pathname==='/favicon.ico'){response.writeHead(204);return response.end();}
      if(url.pathname.startsWith('/auth/v1/')||url.pathname.startsWith('/rest/v1/')){
        let body={};if(request.method==='POST'){let content='';for await(const part of request)content+=part;body=JSON.parse(content||'{}');}
        if(url.pathname==='/auth/v1/signup'){
          if(accounts.has(body.email))return json(response,422,{message:'Email already registered'});
          const id=randomUUID(),account={id,email:body.email,password:body.password};accounts.set(body.email,account);
          await serial(()=>db.query('insert into auth.users(id,raw_user_meta_data) values($1,$2)',[id,JSON.stringify(body.data)]));
          const token=randomUUID();tokens.set(token,account);
          return json(response,200,{access_token:token,refresh_token:token,expires_in:3600,user:{id,email:body.email}});
        }
        if(url.pathname==='/auth/v1/token'){
          const account=body.refresh_token?tokens.get(body.refresh_token):accounts.get(body.email);
          if(!account||!body.refresh_token&&account.password!==body.password)return json(response,400,{message:'Invalid credentials'});
          const token=randomUUID();tokens.set(token,account);
          return json(response,200,{access_token:token,refresh_token:token,expires_in:3600,user:{id:account.id,email:account.email}});
        }
        const token=request.headers.authorization?.replace('Bearer ',''),account=tokens.get(token);
        if(!account)return json(response,401,{message:'Session missing'});
        if(url.pathname==='/auth/v1/logout'){tokens.delete(token);return json(response,200,{});}
        const table=url.pathname.split('/')[3];
        if(table==='rpc'){
          const name=url.pathname.split('/')[4],params=rpcParams[name];if(!params)return json(response,404,{});
          const result=await rpc(account.id,name,params.map(p=>body[p]!==null&&typeof body[p]==='object'?JSON.stringify(body[p]):body[p]));
          return json(response,200,[result]);
        }
        if(['profiles','polygons','equipment','workspaces','marker_reservations'].includes(table))return json(response,200,(await asUser(account.id,'select * from public.'+table+' order by 1')).rows);
        return json(response,404,{});
      }
      if(!url.pathname.startsWith('/roi-site/')){response.writeHead(404);return response.end();}
      const relative=decodeURIComponent(url.pathname.slice('/roi-site/'.length))||'index.html';
      if(relative==='cloud-config.js'){response.writeHead(200,{'Content-Type':'text/javascript'});return response.end('window.ROI_CLOUD='+JSON.stringify({url:base,publishableKey:'sb_publishable_test',features:{routes:routesEnabled}})+';');}
      const file=path.resolve(root,'dist',relative);if(!file.startsWith(path.resolve(root,'dist')+path.sep))throw Error('Invalid path');
      const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
      response.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});response.end(fs.readFileSync(file));
    }catch(error){console.error('TEST API',request.url,error.message);json(response,400,{message:error.message});}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  let browser;
  try{
    browser=await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL||'msedge',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
    const context=await browser.newContext({viewport:{width:1400,height:1100},acceptDownloads:true});
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    async function register(page,email,name){await page.goto(base+'/roi-site/');await page.locator('#tabRegister').click();await page.locator('#regLogin').fill(email);await page.locator('#regName').fill(name);await page.locator('#regPass').fill('test-password-123');await page.locator('#regPass2').fill('test-password-123');await page.locator('#registerForm button[type=submit]').click();await page.waitForURL('**/setup.html');await page.waitForFunction(()=>!document.getElementById('polygonTools').hidden);}
    async function checkEditorViewport(){
      await page.waitForFunction(()=>{const rect=id=>document.getElementById(id).getBoundingClientRect(),map=rect('map'),fit=rect('canvasFit'),nav=rect('steps'),windowBox=rect('editorWindow'),actions=rect('actions');return map.width>10&&map.height>10&&map.bottom<=fit.bottom+1&&map.right<=fit.right+1&&nav.top>=0&&nav.bottom<=windowBox.top&&[windowBox,map,actions].every(box=>box.top>=nav.bottom&&box.bottom<=innerHeight&&box.left>=0&&box.right<=innerWidth);});
      const layout=await page.evaluate(()=>{const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};};return {nav:rect('steps'),window:rect('editorWindow'),map:rect('map'),actions:rect('actions'),height:innerHeight,width:innerWidth,overflow:getComputedStyle(document.body).overflow};});
      assert.equal(layout.overflow,'hidden');assert(layout.nav.top>=0&&layout.nav.bottom<=layout.window.top);
      for(const box of [layout.window,layout.map,layout.actions])assert(box.top>=layout.nav.bottom&&box.bottom<=layout.height&&box.left>=0&&box.right<=layout.width,JSON.stringify(layout));
      await page.mouse.wheel(0,700);assert.equal(await page.evaluate(()=>scrollY),0,'Drawing never needs page scrolling');
    }
    async function clickAt(x,y){const bounds=await page.locator('#map').boundingBox();await page.locator('#map').click({position:{x:x*bounds.width/1000,y:y*bounds.height/700}});}
    async function checkControlsFit(selector){
      const outside=await page.locator(selector).evaluateAll(elements=>elements.filter(element=>{
        const r=element.getBoundingClientRect();return r.width&&r.height&&(r.top<-1||r.left<-1||r.bottom>innerHeight+1||r.right>innerWidth+1);
      }).map(element=>element.id||element.textContent||element.tagName));
      assert.deepEqual(outside,[],'Visible controls fit the viewport');
      assert(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1&&document.documentElement.scrollWidth<=innerWidth+1));
    }
    await page.goto(base+'/roi-site/');await page.locator('#tabRegister').click();
    for(const viewport of [{width:390,height:844},{width:844,height:390},{width:1400,height:1100}]){await page.setViewportSize(viewport);await checkControlsFit('.box button,.box input,.box select');}
    await register(page,'alice@example.com','Alice');const alice=accounts.get('alice@example.com');
    assert.equal((await asUser(alice.id,'select registration_status from public.profiles')).rows[0].registration_status,'polygon');
    assert.equal(await page.locator('#editorWindow').isVisible(),false,'New polygon waits for an explicit button click');
    await page.locator('#openEditor').click();await checkEditorViewport();
    for(const viewport of [{width:390,height:844},{width:844,height:390},{width:1400,height:900}]){await page.setViewportSize(viewport);await checkEditorViewport();await page.screenshot({path:path.join(output,'setup-window-'+viewport.width+'.png')});}
    await page.locator('#background').selectOption('camera');await page.waitForFunction(()=>document.getElementById('camera').videoWidth>0);
    await page.locator('#freezeCamera').click();assert.equal(await page.locator('#frozen').isVisible(),true);
    await page.locator('#background').selectOption('grid');assert.equal(await page.locator('#camera').evaluate(v=>v.srcObject),null);
    for(const [x,y]of [[100,100],[900,100],[900,600],[100,600]])await clickAt(x,y);
    await clickAt(500,100);assert.equal(await page.locator('#vertexList button').count(),5,'Insert vertex on existing edge');
    const bounds=await page.locator('#map').boundingBox();
    await page.mouse.move(bounds.x+500*bounds.width/1000,bounds.y+100*bounds.height/700);await page.mouse.down();await page.mouse.move(bounds.x+500*bounds.width/1000,bounds.y+70*bounds.height/700);await page.mouse.up();
    await page.locator('#finishShape').click();
    await page.locator('#closeEditor').click();assert.equal(await page.locator('#editorWindow').isVisible(),false);
    await page.locator('#steps button').first().click();assert.equal(await page.locator('#vertexList button').count(),5,'Opening the current step retains the draft');
    for(const name of ['', '   ']){
      await page.locator('#polygonName').fill(name);await page.locator('#next').click();
      await page.waitForFunction(()=>!document.getElementById('message').hidden&&document.getElementById('messageText').textContent.includes('название полигона'));
      assert.equal(await page.locator('#message').getAttribute('role'),'alert');assert.equal(await page.locator('#polygonName').getAttribute('aria-invalid'),'true');
      assert.equal((await asUser(alice.id,'select count(*)::int as count from public.polygons')).rows[0].count,0);
      await page.locator('#dismissNotification').click();assert.equal(await page.locator('#message').isVisible(),false);
    }
    const constraintMessage=await page.evaluate(async()=>{try{await AppCloud.rpc('create_polygon',{p_name:' ',p_points:[{x:0,y:0},{x:100,y:0},{x:100,y:100}]});return '';}catch(error){return error.message;}});
    assert.match(constraintMessage,/Введите название полигона/);assert(!constraintMessage.includes('polygons_name_check'));
    await page.locator('#polygonName').fill('  Общий полигон  ');await page.locator('#next').click();
    await page.waitForFunction(()=>!document.getElementById('garage').hidden);
    assert.equal(await page.locator('#equipmentType option[value=bulldozer]').innerText(),'Бульдозер');assert.equal(await page.locator('#equipmentType option[value=excavator]').count(),0);
    await page.locator('#equipmentName').fill('Самосвал Alice');await page.locator('#equipmentForm button[type=submit]').click();await page.locator('.equipment-card').waitFor();
    assert(!/aruco/i.test(await page.locator('#garage').innerText()),'Garage labels use ID only');
    const firstMachine=(await asUser(alice.id,'select * from public.equipment')).rows[0];
    await page.locator('.equipment-id-form input').fill('49');await page.locator('.equipment-id-form button').click();
    await page.waitForFunction(()=>document.querySelector('.equipment-id-form input').value==='49'&&!document.querySelector('main').inert);
    assert.equal((await asUser(alice.id,'select marker_id from public.equipment')).rows[0].marker_id,49);
    await assert.rejects(rpc(alice.id,'set_equipment_marker',[firstMachine.id,0]),/уже занят/,'Server reserves polygon vertex IDs too');
    await assert.rejects(rpc(alice.id,'create_equipment_with_id',['Conflicting','truck',0]),/уже занят/);
    assert.equal((await asUser(alice.id,'select count(*)::int as count from public.equipment')).rows[0].count,1,'Failed creation rolls back the entire equipment and reservation');
    await page.locator('.equipment-id-form input').fill('0');await page.locator('.equipment-id-form button').click();
    await page.waitForFunction(()=>document.getElementById('messageText').textContent.includes('уже занят'));
    assert.equal((await asUser(alice.id,'select marker_id from public.equipment')).rows[0].marker_id,49);
    await page.locator('.equipment-id-form input').fill(String(firstMachine.marker_id));await page.locator('.equipment-id-form button').click();
    await page.waitForFunction(id=>document.querySelector('.equipment-id-form input').value===String(id)&&!document.querySelector('main').inert,firstMachine.marker_id);
    await page.locator('#openEquipmentForm').click();await page.locator('#equipmentName').fill('Pagination test');await page.locator('#equipmentMarkerId').fill('48');await page.locator('#equipmentForm button[type=submit]').click();
    await page.waitForFunction(()=>document.querySelectorAll('.equipment-card').length===2&&!document.querySelector('main').inert);
    for(const viewport of [{width:390,height:844},{width:844,height:390},{width:1400,height:1100}]){
      await page.setViewportSize(viewport);await page.waitForTimeout(80);
      assert.equal(await page.locator('.equipment-card').count(),2,'Several machines remain visible on one page');
      await checkControlsFit('#equipmentList input,#equipmentList button');
      await page.screenshot({path:path.join(output,'garage-list-'+viewport.width+'.png')});
    }
    await page.locator('.equipment-card').filter({has:page.getByRole('heading',{name:'Pagination test'})}).locator('.danger').click();await page.waitForFunction(()=>document.querySelectorAll('.equipment-card').length===1&&!document.querySelector('main').inert);
    for(const viewport of [{width:390,height:844},{width:844,height:390},{width:1400,height:1100}]){
      await page.setViewportSize(viewport);await page.waitForTimeout(80);
      assert(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),'Garage fits without page scrolling');
      const idBox=await page.locator('.equipment-id-form input').boundingBox();assert(idBox.y>=0&&idBox.y+idBox.height<=viewport.height);
      await checkControlsFit('#garage button,#garage input,#garage select,#actions button');
      await page.locator('#openEquipmentForm').click();await checkControlsFit('#garage button,#garage input,#garage select,#actions button');await page.locator('#cancelEquipmentForm').click();
      await page.screenshot({path:path.join(output,'garage-'+viewport.width+'.png')});
    }
    const pdfPromise=page.waitForEvent('download');await page.locator('#exportMarkers').click();await(await pdfPromise).saveAs(path.join(output,'setup-markers.pdf'));
    assert.equal(fs.readFileSync(path.join(output,'setup-markers.pdf')).subarray(0,5).toString(),'%PDF-');
    await page.locator('#next').click();await page.waitForFunction(()=>!document.getElementById('zoneKindLabel').hidden);
    const zoneSpecs=[['warehouse',[[180,180],[300,180],[300,280],[180,280]]],['charging',[[400,180],[500,180],[500,280],[400,280]]],['mining',[[600,180],[700,180],[700,280],[600,280]]],['transport',[[140,140],[860,140],[860,580],[140,580]]]];
    for(const [kind,coords]of zoneSpecs){await page.locator('#zoneKind').selectOption(kind);await page.locator('#newShape').click();for(const [x,y]of coords)await clickAt(x,y);await page.locator('#applyShape').click();await page.locator('#shapeProperties').waitFor({state:'hidden'});}
    await page.locator('#toggleProperties').click();await page.locator('#shapeList .item').first().getByRole('button',{name:'Изменить'}).click();await page.locator('#closeProperties').click();
    for(const viewport of [{width:390,height:844},{width:844,height:390},{width:1400,height:1100}]){
      await page.setViewportSize(viewport);await checkEditorViewport();await checkControlsFit('#editorWindow button,#editorWindow input,#editorWindow select');
      const before=await page.locator('#map').boundingBox();await page.locator('#toggleProperties').click();
      await checkControlsFit('#editorProperties button');
      const after=await page.locator('#map').boundingBox();assert(Math.abs(before.width-after.width)<1,'Zone list does not reduce map width');
      await page.locator('#closeProperties').click();await page.screenshot({path:path.join(output,'zones-'+viewport.width+'.png')});
    }
    await page.locator('#applyShape').click();
    await page.evaluate(()=>{crypto.getRandomValues=array=>{array[0]=12345;return array;};});
    await page.locator('#next').click();await page.waitForFunction(()=>!document.getElementById('depthPanel').hidden);
    assert.equal(await page.locator('#shapeList .item').count(),2,'First visit creates working-zone routes automatically');
    await checkEditorViewport();
    assert(!/препятствие|Превышен|выходит/.test(await page.locator('#validation').innerText()));
    const autoDownload=page.waitForEvent('download');await page.locator('#exportWorkspace').click();await(await autoDownload).saveAs(path.join(output,'auto-routes.json'));
    const autoProject=JSON.parse(fs.readFileSync(path.join(output,'auto-routes.json'),'utf8'));assert.equal(autoProject.depth.seed,12345);assert.equal(autoProject.routes.length,2);
    assert.equal(await page.locator('.route-label').count(),0);assert(!/№/.test(await page.locator('#map').textContent()),'Route numbers are absent from the map');
    const equipmentCard=page.locator('#routeLegendItems .equipment-route-card').first();
    assert.equal(await equipmentCard.locator('.route-list-item').count(),2,'Routes are grouped under their equipment');
    await equipmentCard.hover();assert.equal(await page.locator('.route-points').count(),2,'Hover reveals the equipment route points');
    await page.locator('#editorTitle').hover();assert.equal(await page.locator('.route-points').count(),0,'Leaving the card clears the preview');
    await equipmentCard.locator('.equipment-route-select').click();await page.locator('#editorTitle').hover();
    assert.equal(await page.locator('.route-points').count(),2,'Click pins the equipment preview after the cursor leaves');
    assert.deepEqual(autoProject.routes.map(r=>r.number),[1,2]);
    const autoSafety=G.safetyContext(autoProject.polygon.geometry.points,autoProject.zones.filter(z=>z.kind==='transport').map(z=>z.points),G.routingMarkers(autoProject.polygon.geometry.points,autoProject.zones));
    for(const route of autoProject.routes)assert.deepEqual(G.clearanceErrors(route.points,route,autoSafety),[],'Generated routes keep the requested gaps');
    for(const route of autoProject.routes)assert.deepEqual(G.routeErrors(route,autoProject.polygon.geometry.points,autoProject.depth),[]);
    await page.locator('#toggleProperties').click();assert.equal(await page.locator('#shapeList .equipment-route-card').count(),1);
    assert.equal(await page.locator('polyline[data-route-id="'+autoProject.routes[0].id+'"]').getAttribute('stroke-width'),'6');
    await page.locator('#shapeList .item').first().getByRole('button',{name:'Изменить'}).click();
    const firstPath=autoProject.routes[0].points;await clickAt((firstPath[0].x+firstPath[1].x)/2,(firstPath[0].y+firstPath[1].y)/2);
    assert.equal(await page.locator('#vertexList button').count(),firstPath.length+1,'Automatically generated routes remain editable');
    await page.locator('#applyShape').click();await page.locator('#save').click();
    const savedAuto=(await asUser(alice.id,'select * from public.workspaces')).rows[0];assert.equal(savedAuto.routes.length,2);assert.equal(savedAuto.routes[0].points.length,firstPath.length+1);assert.equal(savedAuto.depth.seed,12345);
    assert.deepEqual(savedAuto.routes.map(r=>r.number),[1,2]);assert(savedAuto.routes.every(r=>r.boundaryClearance===5&&r.markerClearance===40));
    assert.equal((await rpc(alice.id,'advance_setup',[])).registration_status,'ready','Server independently accepts generated and edited paths');
    await page.reload();await page.locator('#autoRoutes').waitFor();assert.equal(await page.locator('#shapeList .item').count(),2,'Saved automatic routes survive reload');
    const mapBefore=await page.locator('#map').boundingBox();
    await page.locator('#depthPanel summary').click();await page.locator('#plannerMaxDepth').fill('0');await page.locator('#autoRoutes').click();
    await page.waitForFunction(()=>document.getElementById('messageText').textContent.includes('Нет допустимого прохода'));assert.equal(await page.locator('#shapeList .item').count(),2,'Failed rebuilding preserves edited routes');
    await page.locator('#plannerMaxDepth').fill('5');await page.locator('#autoRoutes').click();await page.waitForFunction(()=>document.getElementById('messageText').textContent.includes('Построено траекторий: 2'));
    await page.evaluate(()=>{crypto.getRandomValues=array=>{array[0]=23456;return array;};});await page.locator('#generateDepth').click();
    await page.waitForFunction(()=>document.getElementById('depthSource').textContent.includes('23456'));assert.equal(await page.locator('#shapeList .item').count(),2);
    const mapAfter=await page.locator('#map').boundingBox();assert(Math.abs(mapBefore.width-mapAfter.width)<1&&Math.abs(mapBefore.height-mapAfter.height)<1,'Settings never shrink the route map');
    await page.screenshot({path:path.join(output,'setup-auto-routes.png')});
    await page.locator('#dismissNotification').click();
    await page.locator('#toggleProperties').click();while(await page.locator('#shapeList .item').count()){const count=await page.locator('#shapeList .item').count();await page.locator('#shapeList .danger').first().click();await page.waitForFunction(n=>document.querySelectorAll('#shapeList .item').length===n-1,count);}
    fs.writeFileSync(path.join(output,'flat-depth.json'),JSON.stringify(G.emptyDepth()));await page.locator('#importDepth').setInputFiles(path.join(output,'flat-depth.json'));
    await page.waitForFunction(()=>document.getElementById('depthCols').value==='20');
    await page.locator('#depthPanel summary').click();
    await page.locator('#newShape').click();await clickAt(180,530);await clickAt(820,530);await page.locator('#toggleProperties').click();await page.locator('#applyShape').click();
    await page.locator('#depthPanel summary').click();await page.locator('#paintMode').check();await page.locator('#paintBlocked').check();await clickAt(525,525);
    assert.match(await page.locator('#validation').innerText(),/препятствие/);
    await page.locator('#next').click();await page.waitForFunction(()=>document.getElementById('message').textContent.includes('Исправьте'));
    const depthPromise=page.waitForEvent('download');await page.locator('#exportDepth').click();await(await depthPromise).saveAs(path.join(output,'pseudo-depth.json'));
    const depth=JSON.parse(fs.readFileSync(path.join(output,'pseudo-depth.json'),'utf8'));assert(depth.cells.includes(null));
    const fixed={...depth,cells:depth.cells.map(()=>0)};fs.writeFileSync(path.join(output,'fixed-depth.json'),JSON.stringify(fixed));
    await page.locator('#importDepth').setInputFiles(path.join(output,'fixed-depth.json'));await page.waitForFunction(()=>document.getElementById('validation').textContent.includes('Допустима'));
    await page.locator('#next').click();await page.waitForURL('**/welcome.html');assert.equal(await page.locator('.steps a').count(),4);
    const aliceProfile=(await asUser(alice.id,'select * from public.profiles')).rows[0];assert.equal(aliceProfile.registration_status,'ready');
    const aliceWS=(await asUser(alice.id,'select * from public.workspaces')).rows[0];assert.equal(aliceWS.zones.length,4);assert.equal(aliceWS.routes.length,1);
    const savedBoundary=(await asUser(alice.id,'select geometry from public.polygons where id=$1',[aliceProfile.polygon_id])).rows[0].geometry.points;
    const closeRoute=JSON.stringify({points:points([[180,570],[820,570]])});
    const serverGap=await db.query("select roi_private.route_clearance_ok($1::jsonb,$2::jsonb,$3::jsonb) as ok",[closeRoute,JSON.stringify(savedBoundary),JSON.stringify(aliceWS.zones)]);
    assert(serverGap.rows[0].ok,'Server default accepts a route 10 units from the boundary');
    for(const coordinates of [[[180,578],[820,578]],[[260,300],[340,300]]]){
      const unsafe=structuredClone(aliceWS.routes);unsafe[0].points=points(coordinates);
      const unsafeDraft=await rpc(alice.id,'save_workspace',[JSON.stringify(aliceWS.zones),JSON.stringify(unsafe),JSON.stringify(aliceWS.depth),aliceWS.revision]);
      await assert.rejects(rpc(alice.id,'advance_setup',[]),/недопустима/,'Server enforces gaps from both road boundaries and marker centres');
      const restored=await rpc(alice.id,'save_workspace',[JSON.stringify(aliceWS.zones),JSON.stringify(aliceWS.routes),JSON.stringify(aliceWS.depth),unsafeDraft.revision]);aliceWS.revision=restored.revision;
    }await rpc(alice.id,'advance_setup',[]);
    const outsideDriving=structuredClone(aliceWS.routes);outsideDriving[0].points=points([[150,550],[120,550],[120,150],[850,150],[850,550]]);
    const invalidDraft=await rpc(alice.id,'save_workspace',[JSON.stringify(aliceWS.zones),JSON.stringify(outsideDriving),JSON.stringify(aliceWS.depth),aliceWS.revision]);
    await assert.rejects(rpc(alice.id,'advance_setup',[]),/недопустима/,'Server rejects leaving the driving area even inside the outer polygon');
    const restoredDriving=await rpc(alice.id,'save_workspace',[JSON.stringify(aliceWS.zones),JSON.stringify(aliceWS.routes),JSON.stringify(aliceWS.depth),invalidDraft.revision]);
    const invalidZones=structuredClone(aliceWS.zones),transport=invalidZones.find(z=>z.kind==='transport');transport.points=transport.points.map((p,i)=>({...p,...[{x:300,y:380},{x:500,y:380},{x:500,y:480},{x:300,y:480}][i]}));
    const badZoneDraft=await rpc(alice.id,'save_workspace',[JSON.stringify(invalidZones),JSON.stringify(aliceWS.routes),JSON.stringify(aliceWS.depth),restoredDriving.revision]);
    await assert.rejects(rpc(alice.id,'advance_setup',[]),/транспортной зоны/,'Server requires every working zone to be inside the driving area');
    const finalRestored=await rpc(alice.id,'save_workspace',[JSON.stringify(aliceWS.zones),JSON.stringify(aliceWS.routes),JSON.stringify(aliceWS.depth),badZoneDraft.revision]);
    aliceWS.revision=finalRestored.revision;await rpc(alice.id,'advance_setup',[]);
    await assert.rejects(rpc(alice.id,'save_workspace',[JSON.stringify(aliceWS.zones),JSON.stringify(aliceWS.routes),JSON.stringify(aliceWS.depth),aliceWS.revision-1]),/другой вкладке/);
    const blocked=structuredClone(aliceWS.depth);blocked.cells[10*20+10]=null;
    await rpc(alice.id,'save_workspace',[JSON.stringify(aliceWS.zones),JSON.stringify(aliceWS.routes),JSON.stringify(blocked),aliceWS.revision]);
    await assert.rejects(rpc(alice.id,'advance_setup',[]),/недопустима/,'Server rejects blocked route, independently of UI');
    const latest=(await asUser(alice.id,'select * from public.workspaces')).rows[0];
    await rpc(alice.id,'save_workspace',[JSON.stringify(latest.zones),JSON.stringify(latest.routes),JSON.stringify(aliceWS.depth),latest.revision]);await rpc(alice.id,'advance_setup',[]);
    const second=await browser.newContext({viewport:{width:1400,height:1100}}),bobPage=await second.newPage();bobPage.on('pageerror',e=>errors.push(e.message));
    await register(bobPage,'bob@example.com','Bob');await bobPage.locator('#polygonSelect').selectOption(aliceProfile.polygon_id);assert.equal(await bobPage.locator('#editorWindow').isVisible(),true,'Loading a shared polygon opens its window');assert.equal(await bobPage.locator('#polygonName').inputValue(),'Общий полигон');await bobPage.locator('#next').click();await bobPage.waitForFunction(()=>!document.getElementById('garage').hidden);
    assert.equal(await bobPage.locator('.equipment-card').count(),0,'Bob cannot see Alice equipment');
    await bobPage.locator('#equipmentName').fill('Самосвал Bob');await bobPage.locator('#equipmentForm button[type=submit]').click();await bobPage.locator('.equipment-card').waitFor();
    const bob=accounts.get('bob@example.com');
    const aliceEquipment=(await asUser(alice.id,'select * from public.equipment')).rows;const bobEquipment=(await asUser(bob.id,'select * from public.equipment')).rows;
    await assert.rejects(rpc(bob.id,'set_equipment_marker',[aliceEquipment[0].id,49]),/не найдена/,'Other users cannot change equipment IDs');
    await assert.rejects(rpc(bob.id,'set_equipment_marker',[bobEquipment[0].id,aliceEquipment[0].marker_id]),/уже занят/,'Users sharing a polygon cannot reuse equipment IDs');
    assert.equal(aliceEquipment.length,1);assert.equal(bobEquipment.length,1);assert.notEqual(aliceEquipment[0].marker_id,bobEquipment[0].marker_id);
    assert.equal((await asUser(bob.id,'select * from public.workspaces')).rows[0].zones.length,0);
    const dozer=await rpc(alice.id,'create_equipment',['Dozer test','excavator']),loader=await rpc(alice.id,'create_equipment',['Loader test','loader']);assert.equal(dozer.type,'bulldozer');
    let roleWorkspace=(await asUser(alice.id,'select * from public.workspaces')).rows[0];
    const boundaryPoints=(await asUser(alice.id,'select geometry from public.polygons where id=$1',[aliceProfile.polygon_id])).rows[0].geometry.points;
    for(const machine of [dozer,loader]){
      const truckHaul=savedAuto.routes.find(r=>r.purpose==='haul');
      const wrong=[{...truckHaul,equipmentId:machine.id}];
      roleWorkspace=await rpc(alice.id,'save_workspace',[JSON.stringify(roleWorkspace.zones),JSON.stringify(wrong),JSON.stringify(roleWorkspace.depth),roleWorkspace.revision]);
      await assert.rejects(rpc(alice.id,'advance_setup',[]),/недопустима/,'Non-trucks cannot use hauling routes');
      const valid=G.planRoutes(boundaryPoints,roleWorkspace.zones,[machine],roleWorkspace.depth).routes.map((route,i)=>({...route,id:randomUUID(),number:i+1,points:route.points.map(p=>({...p,id:randomUUID()}))}));assert.equal(valid.length,1);
      roleWorkspace=await rpc(alice.id,'save_workspace',[JSON.stringify(roleWorkspace.zones),JSON.stringify(valid),JSON.stringify(roleWorkspace.depth),roleWorkspace.revision]);
      assert.equal((await rpc(alice.id,'advance_setup',[])).registration_status,'ready','Every vehicle can charge from its own base');
    }
    await rpc(alice.id,'save_workspace',[JSON.stringify(aliceWS.zones),JSON.stringify(aliceWS.routes),JSON.stringify(aliceWS.depth),roleWorkspace.revision]);await rpc(alice.id,'advance_setup',[]);
    await assert.rejects(asUser(bob.id,"update public.profiles set registration_status='ready'"),/permission denied/);
    await assert.rejects(asUser(bob.id,"update public.polygons set name='hijack'"),/permission denied/);
    await assert.rejects(rpc(bob.id,'create_polygon',['Invalid',JSON.stringify(points([[0,0],[100,100],[0,100],[100,0]]))]),/многоугольник/);
    const excessiveBoundary=points(Array.from({length:38},(_,i)=>[500+300*Math.cos(i*Math.PI*2/38),350+300*Math.sin(i*Math.PI*2/38)]));
    await assert.rejects(rpc(bob.id,'create_polygon',['Too many vertices',JSON.stringify(excessiveBoundary)]),/37 вершин/);
    await assert.rejects(rpc(bob.id,'delete_equipment',[aliceEquipment[0].id]),/не найдена/);
    await rpc(bob.id,'advance_setup',[]); // garage -> zones is permitted
    await assert.rejects(rpc(bob.id,'advance_setup',[]),/четыре типа/);
    const reservations=(await asUser(alice.id,'select marker_id from public.marker_reservations where polygon_id=$1',[aliceProfile.polygon_id])).rows;
    assert.equal(new Set(reservations.map(r=>r.marker_id)).size,reservations.length);
    await page.goto(base+'/roi-site/setup.html?step=routes');await page.locator('#newShape').waitFor();
    for(const viewport of [{width:390,height:844},{width:844,height:390},{width:1400,height:900}]){
      await page.setViewportSize(viewport);await checkEditorViewport();
      const before=await page.locator('#map').boundingBox();await page.locator('#depthPanel summary').click();await checkEditorViewport();const after=await page.locator('#map').boundingBox();
      assert(Math.abs(before.width-after.width)<1&&Math.abs(before.height-after.height)<1,'Route settings preserve field size at '+viewport.width);
      await page.locator('#depthPanel summary').click();
    }
    await page.screenshot({path:path.join(output,'setup-live.png'),fullPage:true});
    routesEnabled=false;
    const beforePause=(await asUser(alice.id,'select * from public.workspaces')).rows[0];
    await page.reload();await page.waitForURL('**/setup.html?step=zones');
    assert(await page.locator('#steps button').nth(3).isDisabled(),'Paused trajectories cannot be opened from progress navigation');
    assert(await page.locator('#depthPanel').isHidden(),'Direct route URL falls back to zones without starting the planner');
    await page.locator('#next').click();await page.waitForURL('**/welcome.html');
    assert.equal(await page.locator('.step[aria-disabled="true"]').count(),1);
    assert.equal(await page.locator('.step[aria-disabled="true"]').getAttribute('href'),null);
    const afterPause=(await asUser(alice.id,'select * from public.workspaces')).rows[0];
    assert.deepEqual(afterPause.routes,beforePause.routes,'Pausing leaves saved routes intact');
    assert.deepEqual(afterPause.depth,beforePause.depth,'Pausing leaves saved depth intact');
    assert.deepEqual(errors,[]);
    for(let i=reservations.length;i<50;i++)await rpc(alice.id,'create_equipment',['Capacity '+i,'robot']);
    await assert.rejects(rpc(alice.id,'create_equipment',['Overflow','robot']),/50 ArUCo/);
    assert.equal((await asUser(alice.id,'select count(*)::int as count from public.marker_reservations')).rows[0].count,50);
    console.log('PASS PostgreSQL: registration trigger, persisted statuses, shared immutable polygons, private equipment/workspaces, distinct marker reservations, revision conflicts, server route validation, RLS and prohibited status updates.');
    console.log('PASS browser: automatic terrain and zone routes, editable generated paths, PostgreSQL validation and persistence after reload, regeneration; viewport-fitted drawing window on desktop/mobile/landscape, fixed navigation, retained draft, notifications and name validation; two accounts, full onboarding, camera, garage, PDF, zones, blocked route, depth JSON and completed registration. No JavaScript errors.');
  }catch(error){
    if(browser)for(const context of browser.contexts())for(const page of context.pages()){
      console.error('BROWSER FAILURE',page.url(),(await page.locator('body').innerText()).slice(-4500));
      await page.screenshot({path:path.join(output,'setup-failure.png'),fullPage:true}).catch(()=>{});
    }
    throw error;
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));await db.close();}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
