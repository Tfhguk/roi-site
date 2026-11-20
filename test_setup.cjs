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
  assert(G.zoneErrors([...zones,{...zones[3],id:'second-transport'}],terrainBoundary).some(message=>message.includes('только одна транспортная зона')));
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
  assert(G.clearanceErrors(points([[100,350],[900,350]]),policy,safety).some(e=>e.includes('арукомаркер')),'Check the segment interior, not just endpoints');
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
  assert.equal(G.equipmentRole('charging_station').label,'Зарядная станция');assert.equal(G.equipmentRole('other').label,'Иное');
  assert(G.vehicleRouteErrors(haul,zones,{type:'charging_station'}).length);assert.deepEqual(G.vehicleRouteErrors({...haul,purpose:'manual'},zones,{type:'other'}),[]);
  assert.equal(G.planRoutes(terrainBoundary,zones,[vehicle,{id:'station',type:'charging_station'},{id:'other',type:'other'}],G.emptyDepth()).routes.length,2,'Stations do not move; unspecified equipment does not receive invented automatic jobs');
  for(const machine of fleet.filter(v=>v.type!=='truck'))assert(G.vehicleRouteErrors({...haul,equipmentId:machine.id},zones,machine).length);
  assert.throws(()=>G.generateDepth(narrow,narrowZones,98765),/отступ|безопасного/,'Never shrink clearances to force a vehicle into a narrow corridor');
  console.log('PASS planner: 35 reproducible seeds connect every zone; narrow bent corridors, zero depth/slope, overlapping centres; flatter detours preferred to legal straight lines without destructive simplification; impassable imported maps remain blocked.');
  console.log('PASS geometry: concave boundary, thin and edge-adjacent obstacles, depth, cell jumps, invalid maps.');
}

async function main(){
  geometryTests();
  const db=new PGlite();
  await db.exec("create schema auth;create role anon;create role authenticated;create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to authenticated;grant execute on function auth.uid() to authenticated;");
  await db.exec(fs.readFileSync(path.join(root,'supabase/schema.sql'),'utf8').split('-- Polygon zone presets (kept in sync with polygon-presets.sql).')[0]);
  const legacyUser=randomUUID(),legacyPolygon=randomUUID(),legacyEquipment=randomUUID();
  await db.query('insert into auth.users(id) values($1)',[legacyUser]);
  await db.query("insert into public.polygons(id,owner_id,name,geometry) values($1,$2,'Legacy fixture','{}')",[legacyPolygon,legacyUser]);
  const legacyDepth=G.emptyDepth();legacyDepth.cells[0]=17;
  await db.query('insert into public.workspaces(user_id,polygon_id,depth,revision) values($1,$2,$3,11)',[legacyUser,legacyPolygon,JSON.stringify(legacyDepth)]);
  await db.query("update public.profiles set polygon_id=$1,registration_status='zones' where id=$2",[legacyPolygon,legacyUser]);
  await db.exec("alter table public.equipment drop constraint equipment_type_check;alter table public.equipment add constraint equipment_type_check check(type in ('truck','excavator','loader','robot'));");
  await db.query("insert into public.equipment(id,user_id,polygon_id,name,type,marker_id) values($1,$2,$3,'Existing custom name','excavator',49)",[legacyEquipment,legacyUser,legacyPolygon]);
  const legacyStation=randomUUID();await db.query("insert into public.equipment(id,user_id,polygon_id,name,type,marker_id) values($1,$2,$3,'Station name','robot',48)",[legacyStation,legacyUser,legacyPolygon]);
  await db.exec(fs.readFileSync(path.join(root,'supabase/transport-migration.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(root,'supabase/transport-migration.sql'),'utf8'));
  const converted=(await db.query('select * from public.equipment where id=$1',[legacyEquipment])).rows[0];assert.equal(converted.type,'bulldozer');assert.equal(converted.marker_id,49);assert.equal(converted.name,'Existing custom name');
  const station=(await db.query('select * from public.equipment where id=$1',[legacyStation])).rows[0];assert.equal(station.type,'charging_station');assert.equal(station.marker_id,48);assert.equal(station.name,'Station name');
  const preserved=(await db.query('select * from public.workspaces where user_id=$1',[legacyUser])).rows[0];assert.deepEqual(preserved.depth,legacyDepth);assert.equal(preserved.revision,11);assert.equal(preserved.registration_status,'zones','Migrating an existing project preserves data and progress');
  await db.query('delete from public.workspaces where user_id=$1',[legacyUser]);await db.query('update public.profiles set polygon_id=null where id=$1',[legacyUser]);
  await db.query('delete from public.equipment where id=$1',[legacyStation]);
  await db.query('delete from public.equipment where id=$1',[legacyEquipment]);await db.query('delete from public.polygons where id=$1',[legacyPolygon]);await db.query('delete from auth.users where id=$1',[legacyUser]);
  const accounts=new Map(),tokens=new Map();
  let queue=Promise.resolve();
  function serial(action){const result=queue.then(action);queue=result.catch(()=>{});return result;}
  async function asUser(id,sql,args=[]){return serial(()=>db.transaction(async tx=>{
    await tx.exec('set local role authenticated');await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[id]);return tx.query(sql,args);
  }));}
  const rpcParams={create_polygon:['p_name','p_points'],select_polygon:['p_polygon'],open_polygon:['p_polygon','p_reload'],save_polygon_workspace:['p_polygon','p_zones','p_routes','p_depth','p_revision'],get_workspace:[],create_equipment:['p_name','p_type'],create_equipment_with_id:['p_name','p_type','p_marker_id'],create_polygon_equipment:['p_polygon','p_name','p_type','p_marker_id'],set_equipment_marker:['p_id','p_marker_id'],delete_equipment:['p_id'],delete_polygon_garage:['p_polygon'],save_workspace:['p_zones','p_routes','p_depth','p_revision'],advance_setup:[],mark_stage_tutorial:['p_stage'],rename_polygon:['p_id','p_name'],update_polygon:['p_id','p_name','p_points','p_previous'],delete_polygon_preset:['p_id']};
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
        if(['profiles','polygons','equipment','workspaces','marker_reservations'].includes(table)){let rows=(await asUser(account.id,'select * from public.'+table+' order by 1')).rows;for(const [key,value] of url.searchParams)if(value.startsWith('eq.')&&['id','polygon_id','user_id','garage_removed'].includes(key))rows=rows.filter(row=>String(row[key])===value.slice(3));return json(response,200,rows);}
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
    async function register(page,email,name){
      await page.goto(base+'/roi-site/');await page.locator('#tabRegister').click();await page.locator('#regLogin').fill(email);await page.locator('#regName').fill(name);await page.locator('#regPass').fill('test-password-123');await page.locator('#regPass2').fill('test-password-123');await page.locator('#registerForm button[type=submit]').click();await page.waitForURL('**/setup.html');await page.waitForFunction(()=>!document.getElementById('polygonTools').hidden);
      await page.locator('#stageTutorial[open]').waitFor();assert.equal(await page.locator('#tutorialAnimation svg').count(),1);
      await page.locator('#tutorialContinue').click();await page.locator('#stageTutorial').waitFor({state:'hidden'});
      await page.reload();await page.waitForFunction(()=>!document.querySelector('main').inert);assert.equal(await page.locator('#stageTutorial').isVisible(),false,'Acknowledged stage does not reopen after reload');
      await page.locator('#openTutorial').click();assert(await page.locator('#stageTutorial').isVisible(),'Footer can replay the stage tutorial');
      if(name==='Alice')for(const viewport of [{width:390,height:844},{width:844,height:390},{width:1400,height:1100}]){
        await page.setViewportSize(viewport);const box=await page.locator('#stageTutorial').boundingBox();assert(box.x>=0&&box.y>=0&&box.x+box.width<=viewport.width+1&&box.y+box.height<=viewport.height+1);
        assert(await page.locator('#stageTutorial').evaluate(el=>el.scrollHeight<=el.clientHeight+1),'Tutorial fits without scrolling');
        await page.screenshot({path:path.join(output,'tutorial-'+viewport.width+'.png')});
      }
      await page.locator('#tutorialClose').click();await page.locator('#stageTutorial').waitFor({state:'hidden'});
      await page.addLocatorHandler(page.locator('#stageTutorial[open]'),async()=>{await page.locator('#tutorialContinue').click();});
    }
    async function checkEditorViewport(){
      const layout=await(await page.waitForFunction(()=>{
        const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};
        const map=rect('map'),fit=rect('canvasFit'),nav=rect('steps'),windowBox=rect('editorWindow'),actions=rect('actions'),tools=rect('drawingTools'),wide=matchMedia('(min-width:1100px) and (min-height:600px)').matches;
        const valid=(!wide||!tools.width||tools.right<=map.left+1)&&map.width>10&&map.height>10&&map.bottom<=fit.bottom+1&&map.right<=fit.right+1&&nav.top>=0&&(wide?windowBox.right<=nav.left&&nav.bottom<=actions.top:nav.bottom<=windowBox.top)&&[windowBox,map,actions].every(box=>box.top>=0&&box.bottom<=innerHeight&&box.left>=0&&box.right<=innerWidth);
        return valid?{overflow:getComputedStyle(document.body).overflow,toolsFit:!tools.width||document.getElementById('drawingTools').scrollHeight<=document.getElementById('drawingTools').clientHeight+1}:false;
      })).jsonValue();
      assert.equal(layout.overflow,'hidden');assert(layout.toolsFit,'Drawing tools fit without clipping');
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
    for(const viewport of [{width:1100,height:600},{width:1366,height:768},{width:1920,height:1080},{width:1024,height:768},{width:390,height:844},{width:844,height:390},{width:1400,height:900}]){
      await page.setViewportSize(viewport);await checkEditorViewport();await checkControlsFit('#steps button,#actions button,#actions summary,#editorWindow button,#editorWindow input,#editorWindow select');
      await page.screenshot({path:path.join(output,'setup-window-'+viewport.width+'.png')});
    }
    await page.locator('#background').selectOption('camera');await page.waitForFunction(()=>document.getElementById('camera').videoWidth>0);
    await page.locator('#freezeCamera').click();assert.equal(await page.locator('#frozen').isVisible(),true);
    await page.locator('#background').selectOption('grid');assert.equal(await page.locator('#camera').evaluate(v=>v.srcObject),null);
    for(const [x,y]of [[100,100],[900,100],[900,600],[100,600]])await clickAt(x,y);
    await clickAt(500,100);assert.equal(await page.locator('#vertexList button').count(),5,'Insert vertex on existing edge');
    const bounds=await page.locator('#map').boundingBox();
    await page.mouse.move(bounds.x+500*bounds.width/1000,bounds.y+100*bounds.height/700);await page.mouse.down();await page.mouse.move(bounds.x+500*bounds.width/1000,bounds.y+70*bounds.height/700);await page.mouse.up();
    const beforeClose=await page.locator('#vertexList button').count();
    await page.locator('#map').click({button:'right',position:{x:20,y:20}});await page.locator('#contextFinishShape').click();
    assert.equal(await page.locator('#vertexList button').count(),beforeClose,'Right mouse click does not add a vertex');
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
    assert.equal(await page.locator('#equipmentType option[value=charging_station]').innerText(),'Зарядная станция');assert.equal(await page.locator('#equipmentType option[value=other]').innerText(),'Иное');assert.equal(await page.locator('#equipmentType option[value=robot]').count(),0);
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
    await page.locator('#openEquipmentForm').click();await page.locator('#equipmentName').fill('Pagination test');await page.locator('#equipmentType').selectOption('other');await page.locator('#equipmentMarkerId').fill('48');await page.locator('#equipmentForm button[type=submit]').click();
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
    await page.locator('#downloadMenu>summary').click();const pdfPromise=page.waitForEvent('download');await page.locator('#exportMarkers').click();await(await pdfPromise).saveAs(path.join(output,'setup-markers.pdf'));
    assert.equal(fs.readFileSync(path.join(output,'setup-markers.pdf')).subarray(0,5).toString(),'%PDF-');
    await page.locator('#next').click();await page.waitForFunction(()=>!document.getElementById('zoneKindLabel').hidden);
    const zoneSpecs=[['warehouse',[[180,180],[300,180],[300,280],[180,280]]],['charging',[[400,180],[500,180],[500,280],[400,280]]],['mining',[[600,180],[700,180],[700,280],[600,280]]],['transport',[[140,140],[860,140],[860,580],[140,580]]]];
    for(const [kind,coords]of zoneSpecs){await page.locator('#zoneKind').selectOption(kind);await page.locator('#newShape').click();for(const [x,y]of coords)await clickAt(x,y);await page.locator('#map').click({button:'right',position:{x:20,y:20}});await page.locator('#contextFinishShape').click();await page.locator('#shapeProperties').waitFor({state:'hidden'});}
    assert(await page.locator('#zoneKind option[value=transport]').isDisabled(),'A second transport zone cannot be selected');
    await page.locator('#toggleProperties').click();await page.locator('#shapeList .item').filter({hasText:'Транспортная зона'}).getByRole('button',{name:'Изменить'}).click();await page.locator('#closeProperties').click();
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
    await page.locator('#downloadMenu>summary').click();const autoDownload=page.waitForEvent('download');await page.locator('#exportWorkspace').click();await(await autoDownload).saveAs(path.join(output,'auto-routes.json'));
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
    await page.waitForFunction(()=>document.getElementById('saveState').textContent==='Изменения сохранены');
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
    await page.locator('#next').click();await page.waitForURL('**/welcome.html');await page.locator('.steps a').nth(3).waitFor();assert.equal(await page.locator('.steps a').count(),4);
    const profilePattern='**/rest/v1/profiles?**';
    let releaseProfile;const profileGate=new Promise(resolve=>releaseProfile=resolve);
    const delayProfile=async route=>{await profileGate;await route.continue();};
    await page.route(profilePattern,delayProfile);
    try{
      await page.reload({waitUntil:'domcontentloaded'});
      assert.equal(await page.locator('main').getAttribute('aria-busy'),'true');
      assert.equal(await page.locator('.steps a').count(),0,'Loading never shows legacy tool cards');
      assert(await page.locator('#greeting').isHidden(),'No placeholder greeting before the account loads');
    }finally{releaseProfile();}
    await page.locator('.steps a').nth(3).waitFor();await page.unroute(profilePattern,delayProfile);
    await page.route(profilePattern,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Test connection failure'})}));
    await page.reload();await page.locator('#loadError').waitFor();assert.equal(await page.locator('.steps a').count(),0,'An unavailable account never shows legacy cards');
    assert(await page.locator('#retryLoad').isEnabled());assert(await page.locator('#logoutBtn').isEnabled());
    await page.unroute(profilePattern);await page.locator('#retryLoad').click();await page.locator('.steps a').nth(3).waitFor();
    assert(await page.locator('#loadError').isHidden(),'Retry restores the actual account sections');
    const aliceProfile=(await asUser(alice.id,'select * from public.profiles')).rows[0];assert.equal(aliceProfile.registration_status,'ready');
    await page.goto(base+'/roi-site/setup.html?step=polygon');await page.locator('#renamePolygon').waitFor();
    assert(await page.locator('#polygonName').isEnabled());await page.locator('#polygonName').fill('Новое имя');await page.locator('#renamePolygon').click();
    await page.waitForFunction(()=>document.getElementById('messageText').textContent.includes('Пресет полигона обновлён'));
    const renamed=(await asUser(alice.id,'select * from public.polygons where id=$1',[aliceProfile.polygon_id])).rows[0];assert.equal(renamed.name,'Новое имя');
    const ownerMap=await page.locator('#map').boundingBox(),firstBoundary=renamed.geometry.points[0];
    await page.mouse.move(ownerMap.x+firstBoundary.x*ownerMap.width/1000,ownerMap.y+firstBoundary.y*ownerMap.height/700);await page.mouse.down();
    await page.mouse.move(ownerMap.x+(firstBoundary.x-5)*ownerMap.width/1000,ownerMap.y+firstBoundary.y*ownerMap.height/700);await page.mouse.up();
    await page.locator('#save').click();await page.waitForFunction(()=>document.getElementById('saveState').textContent==='Изменения сохранены');
    const ownerMoved=(await asUser(alice.id,'select * from public.polygons where id=$1',[aliceProfile.polygon_id])).rows[0];
    assert(ownerMoved.geometry.points[0].x<firstBoundary.x,'Owner can drag and save the published boundary');
    assert.equal(ownerMoved.geometry.points[0].markerId,firstBoundary.markerId,'Moving a published vertex preserves its marker ID');
    await assert.rejects(rpc(alice.id,'rename_polygon',[aliceProfile.polygon_id,' ']),/название/);
    await page.locator('#polygonName').fill('Общий полигон');await page.locator('#renamePolygon').click();await page.waitForFunction(()=>!document.querySelector('main').inert);
    assert.deepEqual([...aliceProfile.tutorial_seen].sort(),['garage','polygon','routes','zones']);
    await assert.rejects(rpc(alice.id,'mark_stage_tutorial',['invalid']),/Неизвестный/);
    const bobTutorial=await rpc(alice.id,'mark_stage_tutorial',['polygon']);assert.equal(bobTutorial.tutorial_seen.filter(stage=>stage==='polygon').length,1,'Tutorial acknowledgements are idempotent');
    const aliceWS=(await asUser(alice.id,'select * from public.workspaces')).rows[0];assert.equal(aliceWS.zones.length,4);assert.equal(aliceWS.routes.length,1);
    const duplicateTransport=structuredClone(aliceWS.zones.find(zone=>zone.kind==='transport'));duplicateTransport.id=randomUUID();duplicateTransport.points=duplicateTransport.points.map(point=>({...point,id:randomUUID()}));
    await assert.rejects(rpc(alice.id,'save_workspace',[JSON.stringify([...aliceWS.zones,duplicateTransport]),JSON.stringify(aliceWS.routes),JSON.stringify(aliceWS.depth),aliceWS.revision]),/только одна транспортная зона/,'Server rejects duplicate transport zones independently of UI');
    assert.equal((await asUser(alice.id,'select revision from public.workspaces')).rows[0].revision,aliceWS.revision,'Rejected duplicates do not change saved workspace');
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
    await register(bobPage,'bob@example.com','Bob');await bobPage.locator('#polygonSelect').selectOption(aliceProfile.polygon_id);await bobPage.locator('#editorWindow').waitFor({state:'visible'});assert.equal(await bobPage.locator('#editorWindow').isVisible(),true,'Loading a shared polygon opens its window');assert.equal(await bobPage.locator('#polygonName').inputValue(),'Общий полигон');await bobPage.locator('#next').click();await bobPage.waitForFunction(()=>!document.getElementById('garage').hidden);
    assert.equal(await bobPage.locator('.equipment-card').count(),0,'Bob cannot see Alice equipment');
    await bobPage.locator('#equipmentName').fill('Самосвал Bob');await bobPage.locator('#equipmentForm button[type=submit]').click();await bobPage.locator('.equipment-card').waitFor();
    const bob=accounts.get('bob@example.com');
    await assert.rejects(rpc(bob.id,'rename_polygon',[aliceProfile.polygon_id,'Stolen name']),/владелец/);
    const aliceEquipment=(await asUser(alice.id,'select * from public.equipment')).rows;const bobEquipment=(await asUser(bob.id,'select * from public.equipment')).rows;
    await assert.rejects(rpc(bob.id,'set_equipment_marker',[aliceEquipment[0].id,49]),/не найдена/,'Other users cannot change equipment IDs');
    await assert.rejects(rpc(bob.id,'set_equipment_marker',[bobEquipment[0].id,aliceEquipment[0].marker_id]),/уже занят/,'Users sharing a polygon cannot reuse equipment IDs');
    assert.equal(aliceEquipment.length,1);assert.equal(bobEquipment.length,1);assert.notEqual(aliceEquipment[0].marker_id,bobEquipment[0].marker_id);
    const bobWS=await rpc(bob.id,'get_workspace',[]);
    const template=(await asUser(bob.id,'select zone_preset from public.polygons where id=$1',[aliceProfile.polygon_id])).rows[0].zone_preset;
    const zoneGeometry=zones=>zones.map(zone=>({kind:zone.kind,name:zone.name,points:zone.points.map(p=>({x:p.x,y:p.y}))}));
    assert.deepEqual(zoneGeometry(bobWS.zones),zoneGeometry(template),'Choosing a shared polygon loads its owner zone preset');
    assert.equal(bobWS.routes.length,0,'Owner routes never enter another account');assert(bobWS.depth.cells.every(v=>v===0),'Owner depth stays private');
    const ownerPointIds=new Set(template.flatMap(z=>z.points.map(p=>p.markerId)));
    assert(bobWS.zones.flatMap(z=>z.points).every(p=>!ownerPointIds.has(p.markerId)),'Personal zone copies get unoccupied marker IDs');
    const reservationCount=(await asUser(bob.id,'select count(*)::int as count from public.marker_reservations')).rows[0].count;
    assert.deepEqual(await rpc(bob.id,'get_workspace',[]),bobWS,'Reloading keeps the same personal zones and IDs');
    assert.equal((await asUser(bob.id,'select count(*)::int as count from public.marker_reservations')).rows[0].count,reservationCount);
    const editedZones=structuredClone(bobWS.zones);editedZones[0].name='Bob personal zone';
    const bobEdited=await rpc(bob.id,'save_workspace',[JSON.stringify(editedZones),'[]',JSON.stringify(bobWS.depth),bobWS.revision]);
    assert.equal((await rpc(bob.id,'get_workspace',[])).zones[0].name,'Bob personal zone');
    assert.deepEqual((await asUser(bob.id,'select zone_preset from public.polygons where id=$1',[aliceProfile.polygon_id])).rows[0].zone_preset,template,'Other users cannot overwrite the owner preset');
    await bobPage.locator('#next').click();await bobPage.locator('#zoneKindLabel').waitFor();
    await bobPage.locator('#toggleProperties').click();assert.equal(await bobPage.locator('#shapeList .item').count(),4,'Inherited zones appear in the zone editor');await bobPage.locator('#closeProperties').click();
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
    assert.equal((await asUser(bob.id,'select registration_status from public.profiles')).rows[0].registration_status,'zones');
    assert.equal((await rpc(bob.id,'advance_setup',[])).registration_status,'routes','Inherited zones satisfy the zone stage');
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
    const secondOwned=await rpc(alice.id,'create_polygon',['Second personal polygon',JSON.stringify(points([[0,0],[1000,0],[1000,700],[0,700]]))]);
    await page.goto(base+'/roi-site/setup.html?step=polygon');await page.locator('#closeEditor').click();
    assert.equal(await page.locator('#projectList .polygon-project').count(),1,'Saved polygon projects are listed');
    const beforePreview=await rpc(alice.id,'get_workspace',[]);
    await page.locator('#showFullPolygon').click();await page.locator('#polygonPreview[open]').waitFor();
    assert.equal(await page.locator('#polygonPreviewMap polygon').count(),5,'Full polygon preview includes its boundary and all four zones');
    assert.equal(await page.locator('#polygonPreviewMap [data-vertex]').count(),0,'Preview vertices cannot be edited');
    for(const viewport of [{width:390,height:844},{width:844,height:390},{width:1400,height:900}]){
      await page.setViewportSize(viewport);await checkControlsFit('#polygonPreview button,#polygonPreviewMap');
      assert(await page.locator('#polygonPreview').evaluate(el=>el.scrollHeight<=el.clientHeight+1),'Full preview fits without scrolling');
    }
    await page.keyboard.press('Escape');await page.locator('#polygonPreview').waitFor({state:'hidden'});
    assert.deepEqual(await rpc(alice.id,'get_workspace',[]),beforePreview,'Viewing a polygon does not switch or modify its project');
    await page.locator('#polygonSelect').selectOption(secondOwned.id);await page.locator('#editorWindow').waitFor({state:'visible'});
    await page.locator('#previewFromEditor').click();await page.locator('#polygonPreview[open]').waitFor();
    assert.equal(await page.locator('#polygonPreviewMap polygon').count(),1,'Another polygon preview does not inherit active project zones');
    await page.locator('#closePolygonPreview').click();
    const workspaceDownload=page.waitForEvent('download');await page.locator('#downloadMenu summary').click();await page.locator('#exportWorkspace').click();
    const workspaceFile=path.join(output,'selected-polygon.json');await(await workspaceDownload).saveAs(workspaceFile);
    const selectedExport=JSON.parse(fs.readFileSync(workspaceFile,'utf8'));assert.equal(selectedExport.polygon.id,secondOwned.id);assert.deepEqual(selectedExport.equipment,[]);assert.deepEqual(selectedExport.zones,[],'Preview export never includes another polygon zones');
    await page.evaluate(()=>{window.originalExport=SetupExport;window.SetupExport={...SetupExport,markerPDF:markers=>{window.exportedMarkers=markers;}};});
    await page.locator('#downloadMenu summary').click();await page.locator('#exportMarkers').click();
    assert.equal((await page.evaluate(()=>window.exportedMarkers)).length,4,'Marker PDF uses only the selected polygon');
    await page.evaluate(()=>{window.SetupExport=window.originalExport;});
    await page.locator('#next').click();await page.locator('#garage').waitFor({state:'visible'});
    assert.equal(await page.locator('.equipment-card').count(),0,'Each polygon starts with its own empty garage');
    await page.locator('#equipmentName').fill('Second polygon truck');await page.locator('#equipmentMarkerId').fill(String(aliceEquipment[0].marker_id));await page.locator('#equipmentForm button[type=submit]').click();await page.locator('.equipment-card').waitFor();
    assert.equal((await asUser(alice.id,'select marker_id from public.equipment where polygon_id=$1',[secondOwned.id])).rows[0].marker_id,aliceEquipment[0].marker_id,'Different polygons can reuse the same equipment ID');
    await page.locator('#steps button').first().click();await page.locator('#closeEditor').click();
    assert.equal(await page.locator('#projectList .polygon-project').count(),2);
    for(const viewport of [{width:390,height:844},{width:844,height:390},{width:1100,height:600},{width:1400,height:900}]){
      await page.setViewportSize(viewport);await page.waitForFunction(()=>document.querySelectorAll('#projectList .polygon-project').length===(innerHeight<=500?1:2));
      await checkControlsFit('#polygonTools button,#polygonTools select,#actions button');
    }
    await page.locator('.polygon-project[data-polygon-id="'+aliceProfile.polygon_id+'"]').getByRole('button',{name:'Открыть гараж',exact:true}).click();await page.locator('#garage').waitFor({state:'visible'});
    const restoredPersonal=await rpc(alice.id,'get_workspace',[]);
    assert.deepEqual(restoredPersonal.zones,afterPause.zones);assert.deepEqual(restoredPersonal.depth,afterPause.depth);assert.deepEqual(restoredPersonal.routes,afterPause.routes,'Returning restores the complete personal polygon project');
    assert.equal((await asUser(alice.id,'select * from public.profiles')).rows[0].polygon_id,aliceProfile.polygon_id);
    await page.locator('#steps button').first().click();await page.locator('#closeEditor').click();
    await page.locator('.polygon-project[data-polygon-id="'+secondOwned.id+'"]').getByRole('button',{name:'Удалить гараж',exact:true}).click();
    await page.waitForFunction(id=>!document.querySelector('.polygon-project[data-polygon-id="'+id+'"]'),secondOwned.id);
    assert.equal((await asUser(alice.id,'select * from public.equipment where polygon_id=$1',[secondOwned.id])).rows.length,0,'Deleting a garage removes only that polygon equipment');
    assert.equal((await asUser(alice.id,"select * from public.marker_reservations where polygon_id=$1 and purpose='equipment'",[secondOwned.id])).rows.length,0,'Garage removal releases equipment IDs');
    assert.equal((await asUser(alice.id,'select * from public.profiles')).rows[0].registration_status,restoredPersonal.registration_status,'Deleting equipment in another polygon leaves active progress alone');
    await page.locator('#polygonSelect').selectOption(secondOwned.id);await page.locator('#editorWindow').waitFor({state:'visible'});await page.locator('#next').click();await page.locator('#garage').waitFor({state:'visible'});
    assert.equal(await page.locator('.equipment-card').count(),0,'Reopening a removed garage starts empty');
    await page.locator('#deleteGarage').click();await page.waitForFunction(()=>!document.getElementById('polygonTools').hidden&&!document.querySelector('main').inert);
    assert.equal((await asUser(alice.id,'select * from public.profiles')).rows[0].polygon_id,null,'Removing the active garage returns to polygon selection');
    await page.locator('.polygon-project[data-polygon-id="'+aliceProfile.polygon_id+'"]').getByRole('button',{name:'Открыть гараж',exact:true}).click();await page.locator('#garage').waitFor({state:'visible'});
    await db.query('delete from public.workspaces where user_id=$1 and polygon_id=$2',[alice.id,secondOwned.id]);await db.query('delete from public.polygons where id=$1',[secondOwned.id]);
    // A preset survives its owner leaving; an initially empty account can load a later publication.
    const presetOwner=randomUUID(),presetGuest=randomUUID();
    for(const id of [presetOwner,presetGuest])await db.query('insert into auth.users(id) values($1)',[id]);
    const presetPolygon=await rpc(presetOwner,'create_polygon',['Preset fixture',JSON.stringify(points([[0,0],[1000,0],[1000,700],[0,700]]))]);
    const otherPolygon=await rpc(presetOwner,'create_polygon',['Other fixture',JSON.stringify(points([[0,0],[1000,0],[1000,700],[0,700]]))]);
    await rpc(presetOwner,'select_polygon',[presetPolygon.id]);await rpc(presetGuest,'select_polygon',[presetPolygon.id]);
    let guestFixture=await rpc(presetGuest,'get_workspace',[]);assert.equal(guestFixture.zones.length,0);assert.equal(guestFixture.zones_initialized,false);
    const guestMachine=await rpc(presetGuest,'create_equipment',['Private fixture','truck']);
    let ownerFixture=await rpc(presetOwner,'get_workspace',[]);
    const fixtureZones=[{id:randomUUID(),kind:'warehouse',name:'Preset warehouse',points:points([[100,100],[300,100],[200,300]])}];
    ownerFixture=await rpc(presetOwner,'save_workspace',[JSON.stringify(fixtureZones),'[]',JSON.stringify(ownerFixture.depth),ownerFixture.revision]);
    guestFixture=await rpc(presetGuest,'get_workspace',[]);
    assert.deepEqual(zoneGeometry(guestFixture.zones),zoneGeometry(ownerFixture.zones),'Late owner publication fills an untouched empty workspace');
    const originalGeometry=presetPolygon.geometry,updatedBoundary=structuredClone(originalGeometry.points);updatedBoundary[3].y=690;
    await assert.rejects(rpc(presetGuest,'update_polygon',[presetPolygon.id,'Stolen',JSON.stringify(updatedBoundary),JSON.stringify(originalGeometry)]),/владелец/);
    await assert.rejects(rpc(presetGuest,'delete_polygon_preset',[presetPolygon.id]),/владелец/);
    const updatedOriginal=await rpc(presetOwner,'update_polygon',[presetPolygon.id,'Updated preset',JSON.stringify(updatedBoundary),JSON.stringify(originalGeometry)]);
    assert.deepEqual(updatedOriginal.geometry.points.map(p=>p.markerId),originalGeometry.points.map(p=>p.markerId));
    const insertedBoundary=structuredClone(updatedBoundary);insertedBoundary.splice(1,0,...points([[500,0]]));
    const insertedOriginal=await rpc(presetOwner,'update_polygon',[presetPolygon.id,'Updated preset',JSON.stringify(insertedBoundary),JSON.stringify(updatedOriginal.geometry)]);
    assert.equal(insertedOriginal.geometry.points.length,5,'Owner can add published vertices');
    const removedMarker=insertedOriginal.geometry.points[1].markerId;
    const removedOriginal=await rpc(presetOwner,'update_polygon',[presetPolygon.id,'Updated preset',JSON.stringify(updatedBoundary),JSON.stringify(insertedOriginal.geometry)]);
    assert.equal(removedOriginal.geometry.points.length,4,'Owner can delete published vertices');
    assert.equal((await asUser(presetOwner,'select * from public.marker_reservations where polygon_id=$1 and marker_id=$2',[presetPolygon.id,removedMarker])).rows.length,0,'Deleting a vertex releases its marker');
    const invalidBoundary=points([[800,400],[950,400],[950,600],[800,600]]);
    await assert.rejects(rpc(presetOwner,'update_polygon',[presetPolygon.id,'Invalid shrink',JSON.stringify(invalidBoundary),JSON.stringify(removedOriginal.geometry)]),/сохранённых зон/,'An original boundary must contain its published zones');
    await assert.rejects(rpc(presetOwner,'update_polygon',[presetPolygon.id,'Stale',JSON.stringify(updatedBoundary),JSON.stringify(originalGeometry)]),/другой вкладке/);
    const changedPreset=structuredClone(ownerFixture.zones);changedPreset[0].name='Updated warehouse';
    ownerFixture=await rpc(presetOwner,'save_workspace',[JSON.stringify(changedPreset),'[]',JSON.stringify(ownerFixture.depth),ownerFixture.revision]);
    const localEdit=structuredClone(guestFixture.zones);localEdit[0].name='Private changes';
    guestFixture=await rpc(presetGuest,'save_workspace',[JSON.stringify(localEdit),'[]',JSON.stringify(guestFixture.depth),guestFixture.revision]);
    await rpc(presetGuest,'select_polygon',[presetPolygon.id]);guestFixture=await rpc(presetGuest,'get_workspace',[]);
    assert.deepEqual(zoneGeometry(guestFixture.zones),zoneGeometry(ownerFixture.zones),'Explicitly reselecting the same preset loads owner updates over private edits');
    assert.deepEqual((await asUser(presetGuest,'select * from public.equipment')).rows,[guestMachine]);
    await assert.rejects(asUser(presetGuest,"update public.polygons set zone_preset='[]'"),/permission denied/);
    await assert.rejects(asUser(presetGuest,'select roi_private.load_zone_preset($1)',[presetOwner]),/permission denied/);
    await rpc(presetOwner,'select_polygon',[otherPolygon.id]);await rpc(presetOwner,'select_polygon',[presetPolygon.id]);
    assert.deepEqual((await rpc(presetOwner,'get_workspace',[])).zones,ownerFixture.zones,'Owner returns to the original preset and printed IDs');
    await rpc(presetGuest,'select_polygon',[otherPolygon.id]);await rpc(presetGuest,'select_polygon',[presetPolygon.id]);
    guestFixture=await rpc(presetGuest,'get_workspace',[]);
    assert.deepEqual(zoneGeometry(guestFixture.zones),zoneGeometry(ownerFixture.zones),'Switching polygons loads the selected owner preset');
    assert.deepEqual((await asUser(presetGuest,'select * from public.equipment')).rows,[guestMachine],'Polygon changes preserve personal equipment');
    const privateZones=structuredClone(guestFixture.zones);privateZones[0].name='Persistent private warehouse';
    const privateDepth=structuredClone(guestFixture.depth);privateDepth.cells[0]=7;
    guestFixture=await rpc(presetGuest,'save_workspace',[JSON.stringify(privateZones),'[]',JSON.stringify(privateDepth),guestFixture.revision]);
    await rpc(presetGuest,'advance_setup',[]);
    const privateSnapshot=await rpc(presetGuest,'get_workspace',[]);
    await rpc(presetGuest,'select_polygon',[otherPolygon.id]);
    const otherMachine=await rpc(presetGuest,'create_equipment_with_id',['Other polygon truck','truck',guestMachine.marker_id]);assert.equal(otherMachine.marker_id,guestMachine.marker_id);
    let otherWorkspace=await rpc(presetGuest,'get_workspace',[]);const otherDepth=structuredClone(otherWorkspace.depth);otherDepth.cells[0]=42;
    otherWorkspace=await rpc(presetGuest,'save_workspace',['[]','[]',JSON.stringify(otherDepth),otherWorkspace.revision]);
    await rpc(presetGuest,'select_polygon',[presetPolygon.id]);guestFixture=await rpc(presetGuest,'get_workspace',[]);
    assert.deepEqual(guestFixture.zones,privateSnapshot.zones,'Returning preserves private zones and their printed IDs');assert.deepEqual(guestFixture.depth,privateSnapshot.depth);
    assert.equal((await asUser(presetGuest,'select * from public.profiles')).rows[0].registration_status,'zones','Each project restores its own setup progress');
    assert.equal((await asUser(presetGuest,'select * from public.workspaces')).rows.length,2,'Both private workspaces remain in the database');
    assert.deepEqual((await asUser(presetGuest,'select depth from public.workspaces where polygon_id=$1',[otherPolygon.id])).rows[0].depth,otherDepth);
    await assert.rejects(rpc(presetGuest,'save_workspace',[JSON.stringify(privateSnapshot.zones),'[]',JSON.stringify(privateDepth),privateSnapshot.revision]),/другой вкладке/,'Returning invalidates old-tab revisions');
    await assert.rejects(rpc(presetGuest,'save_polygon_workspace',[otherPolygon.id,'[]','[]',JSON.stringify(otherDepth),guestFixture.revision]),/Активный полигон/);
    await assert.rejects(rpc(presetGuest,'create_polygon_equipment',[otherPolygon.id,'Wrong polygon','truck',null]),/Активный полигон/);
    await rpc(presetGuest,'delete_equipment',[otherMachine.id]);assert.equal((await asUser(presetGuest,'select * from public.profiles')).rows[0].registration_status,'zones');
    const expandedZones=structuredClone(guestFixture.zones);expandedZones.push({id:randomUUID(),kind:'mining',name:'Temporary private zone',points:points([[500,100],[700,100],[600,300]])});
    guestFixture=await rpc(presetGuest,'save_workspace',[JSON.stringify(expandedZones),'[]',JSON.stringify(guestFixture.depth),guestFixture.revision]);
    const replacedRefs=guestFixture.zones.flatMap(z=>z.points.map(p=>p.id));
    const damagedGeometry=structuredClone(removedOriginal.geometry);damagedGeometry.points[0].markerId=guestMachine.marker_id;
    await db.query('update public.polygons set geometry=$1 where id=$2',[JSON.stringify(damagedGeometry),presetPolygon.id]);
    const beforeFill=(await asUser(presetOwner,'select count(*)::int as n from public.marker_reservations where polygon_id=$1',[presetPolygon.id])).rows[0].n;
    for(let i=beforeFill;i<50;i++)await rpc(presetOwner,'create_equipment',['Reload capacity '+i,'truck']);
    const fullReservations=(await asUser(presetOwner,'select * from public.marker_reservations where polygon_id=$1',[presetPolygon.id])).rows;
    const keptIds=new Set(fullReservations.filter(r=>r.owner_id!==presetGuest||r.purpose!=='zone').map(r=>r.marker_id));
    const expectedNewIds=Array.from({length:50},(_,id)=>id).filter(id=>!keptIds.has(id)).slice(0,3);
    await rpc(presetGuest,'open_polygon',[presetPolygon.id,true]);guestFixture=await rpc(presetGuest,'get_workspace',[]);
    assert.deepEqual(zoneGeometry(guestFixture.zones),zoneGeometry(ownerFixture.zones),'Explicit reload replaces private zones without changing the garage');
    assert.equal((await asUser(presetGuest,"select * from public.marker_reservations where polygon_id=$1 and owner_id=$2 and purpose='zone' and reference_id=any($3::uuid[])",[presetPolygon.id,presetGuest,replacedRefs])).rows.length,0,'Reload releases old private vertex references before allocating replacements, even at capacity');
    assert.deepEqual((await asUser(presetGuest,'select * from public.equipment')).rows,[guestMachine],'Preset reload never changes equipment IDs');
    assert.deepEqual(guestFixture.zones.flatMap(z=>z.points.map(p=>p.markerId)),expectedNewIds,'Replacement zone IDs use the lowest free numbers after preserving garage IDs');
    const cleanGeometry=(await asUser(presetGuest,'select geometry from public.polygons where id=$1',[presetPolygon.id])).rows[0].geometry;
    assert.equal(cleanGeometry.points[0].markerId,removedOriginal.geometry.points[0].markerId,'Conflicting boundary metadata is restored without overwriting a garage ID');
    const poolAfterReload=(await asUser(presetGuest,'select count(*)::int as n from public.marker_reservations where polygon_id=$1',[presetPolygon.id])).rows[0].n;
    for(let i=0;i<3;i++){
      await rpc(presetGuest,'open_polygon',[presetPolygon.id,true]);await rpc(presetOwner,'open_polygon',[presetPolygon.id,true]);
      assert.equal((await asUser(presetGuest,'select count(*)::int as n from public.marker_reservations where polygon_id=$1',[presetPolygon.id])).rows[0].n,poolAfterReload,'Repeated owner and guest reloads neither leak nor lose marker reservations');
      const ownerReload=await rpc(presetOwner,'get_workspace',[]);assert.deepEqual(ownerReload.zones,ownerFixture.zones,'Owner reload keeps original printed marker IDs reserved');
    }
    guestFixture=await rpc(presetGuest,'get_workspace',[]);
    guestFixture=await rpc(presetGuest,'save_workspace',['[]','[]',JSON.stringify(guestFixture.depth),guestFixture.revision]);
    assert.equal((await rpc(presetGuest,'get_workspace',[])).zones.length,0,'An intentionally saved empty project stays empty');
    await db.exec(fs.readFileSync(path.join(root,'supabase/polygon-presets.sql'),'utf8'));
    assert.equal((await rpc(presetGuest,'get_workspace',[])).zones.length,0,'Repeating the migration keeps private edits');
    await rpc(presetOwner,'delete_polygon_preset',[presetPolygon.id]);
    await assert.rejects(rpc(presetGuest,'open_polygon',[presetPolygon.id,true]),/удалён/);
    await rpc(presetGuest,'select_polygon',[otherPolygon.id]);await rpc(presetGuest,'select_polygon',[presetPolygon.id]);
    assert.equal((await rpc(presetGuest,'get_workspace',[])).zones.length,0,'Deleting a preset preserves a previously loaded workspace');
    assert.deepEqual((await asUser(presetGuest,'select * from public.equipment')).rows,[guestMachine],'Deleting a preset keeps personal equipment');
    for(const table of ['workspaces','equipment','profiles'])await db.query('delete from public.'+table+' where '+(table==='profiles'?'id':'user_id')+'=any($1::uuid[])',[[presetOwner,presetGuest]]);
    await db.query('delete from public.polygons where owner_id=$1',[presetOwner]);
    await db.query('delete from auth.users where id=any($1::uuid[])',[[presetOwner,presetGuest]]);
    for(let i=reservations.length;i<50;i++)await rpc(alice.id,'create_equipment',['Capacity '+i,'robot']);
    await assert.rejects(rpc(alice.id,'create_equipment',['Overflow','robot']),/50 ArUCo/);
    assert.equal((await asUser(alice.id,'select count(*)::int as count from public.marker_reservations')).rows[0].count,50);
    const capacityGuest=randomUUID();await db.query('insert into auth.users(id) values($1)',[capacityGuest]);
    await assert.rejects(rpc(capacityGuest,'select_polygon',[aliceProfile.polygon_id]),/50 ArUCo/,'Preset capacity failure rolls back polygon selection');
    assert.equal((await asUser(capacityGuest,'select * from public.profiles')).rows[0].polygon_id,null);
    assert.equal((await asUser(capacityGuest,'select * from public.workspaces')).rows.length,0);
    assert.equal((await asUser(capacityGuest,'select count(*)::int as count from public.marker_reservations')).rows[0].count,50);
    await db.query('delete from auth.users where id=$1',[capacityGuest]);
    console.log('PASS PostgreSQL: registration trigger, persisted statuses, owner-editable polygon presets, preset reloads and deletion, private equipment/workspaces, distinct marker reservations, revision conflicts, server route validation, RLS and prohibited status updates.');
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
