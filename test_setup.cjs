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
  const concavePath=G.findPath({x:225,y:525},{x:775,y:525},concave,G.emptyDepth());
  assert(concavePath&&G.inPolygon(concavePath,concave,false),'A* stays inside concave polygons');
  const zones=[['warehouse',[[180,180],[300,180],[300,280],[180,280]]],['charging',[[400,180],[500,180],[500,280],[400,280]]],['mining',[[600,180],[700,180],[700,280],[600,280]]],['transport',[[300,380],[500,380],[500,480],[300,480]]]].map(([kind,coords],i)=>({id:'zone-'+i,name:kind,kind,points:points(coords)}));
  const vehicle={id:'truck',name:'Truck'},terrainBoundary=points([[100,100],[900,100],[900,600],[100,600]]);
  for(const seed of [1,2,3,4,5,12345,23456]){
    const map=G.generateDepth(terrainBoundary,zones,seed);assert.deepEqual(map,G.generateDepth(terrainBoundary,zones,seed),'Seed reproduces the map');
    assert(map.cells.includes(null)&&map.cells.some(v=>v>0));assert.equal(G.validateDepth(map).seed,seed);
    const planned=G.planRoutes(terrainBoundary,zones,[vehicle],map);assert.equal(planned.routes.length,3,'Three default connections for seed '+seed);assert.deepEqual(planned.unreachable,[]);
    for(const route of planned.routes)assert.deepEqual(G.routeErrors(route,terrainBoundary,map),[]);
  }
  assert.throws(()=>G.planRoutes(terrainBoundary,zones,Array(11).fill(vehicle),G.emptyDepth()),/30/);
  console.log('PASS planner: reproducible terrain, A* detours, impassable walls, depth/slope limits, concave boundaries and zone connections.');
  console.log('PASS geometry: concave boundary, thin and edge-adjacent obstacles, depth, cell jumps, invalid maps.');
}

async function main(){
  geometryTests();
  const db=new PGlite();
  await db.exec("create schema auth;create role anon;create role authenticated;create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to authenticated;grant execute on function auth.uid() to authenticated;");
  await db.exec(fs.readFileSync(path.join(root,'supabase/schema.sql'),'utf8'));
  const accounts=new Map(),tokens=new Map();
  let queue=Promise.resolve();
  function serial(action){const result=queue.then(action);queue=result.catch(()=>{});return result;}
  async function asUser(id,sql,args=[]){return serial(()=>db.transaction(async tx=>{
    await tx.exec('set local role authenticated');await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[id]);return tx.query(sql,args);
  }));}
  const rpcParams={create_polygon:['p_name','p_points'],select_polygon:['p_polygon'],create_equipment:['p_name','p_type'],delete_equipment:['p_id'],save_workspace:['p_zones','p_routes','p_depth','p_revision'],advance_setup:[]};
  async function rpc(id,name,args){return (await asUser(id,'select * from public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+')',args)).rows[0];}
  function json(response,status,data){response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(data));}
  let base;
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
          const result=await rpc(account.id,name,params.map(p=>typeof body[p]==='object'?JSON.stringify(body[p]):body[p]));
          return json(response,200,[result]);
        }
        if(['profiles','polygons','equipment','workspaces','marker_reservations'].includes(table))return json(response,200,(await asUser(account.id,'select * from public.'+table+' order by 1')).rows);
        return json(response,404,{});
      }
      if(!url.pathname.startsWith('/roi-site/')){response.writeHead(404);return response.end();}
      const relative=decodeURIComponent(url.pathname.slice('/roi-site/'.length))||'index.html';
      if(relative==='cloud-config.js'){response.writeHead(200,{'Content-Type':'text/javascript'});return response.end('window.ROI_CLOUD='+JSON.stringify({url:base,publishableKey:'sb_publishable_test'})+';');}
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
    await page.locator('#equipmentName').fill('Самосвал Alice');await page.locator('#equipmentForm button').click();await page.locator('.equipment-card').waitFor();
    const pdfPromise=page.waitForEvent('download');await page.locator('#exportMarkers').click();await(await pdfPromise).saveAs(path.join(output,'setup-markers.pdf'));
    assert.equal(fs.readFileSync(path.join(output,'setup-markers.pdf')).subarray(0,5).toString(),'%PDF-');
    await page.locator('#next').click();await page.waitForFunction(()=>!document.getElementById('zoneKindLabel').hidden);
    const zoneSpecs=[['warehouse',[[180,180],[300,180],[300,280],[180,280]]],['charging',[[400,180],[500,180],[500,280],[400,280]]],['mining',[[600,180],[700,180],[700,280],[600,280]]],['transport',[[300,380],[500,380],[500,480],[300,480]]]];
    for(const [kind,coords]of zoneSpecs){await page.locator('#zoneKind').selectOption(kind);await page.locator('#newShape').click();for(const [x,y]of coords)await clickAt(x,y);await page.locator('#applyShape').click();await page.locator('#shapeProperties').waitFor({state:'hidden'});}
    await page.evaluate(()=>{crypto.getRandomValues=array=>{array[0]=12345;return array;};});
    await page.locator('#next').click();await page.waitForFunction(()=>!document.getElementById('depthPanel').hidden);
    assert.equal(await page.locator('#shapeList .item').count(),3,'First visit creates routes automatically');
    assert(!/препятствие|Превышен|выходит/.test(await page.locator('#validation').innerText()));
    const autoDownload=page.waitForEvent('download');await page.locator('#exportWorkspace').click();await(await autoDownload).saveAs(path.join(output,'auto-routes.json'));
    const autoProject=JSON.parse(fs.readFileSync(path.join(output,'auto-routes.json'),'utf8'));assert.equal(autoProject.depth.seed,12345);assert.equal(autoProject.routes.length,3);
    for(const route of autoProject.routes)assert.deepEqual(G.routeErrors(route,autoProject.polygon.geometry.points,autoProject.depth),[]);
    await page.locator('#shapeList .item').first().getByRole('button',{name:'Изменить'}).click();
    const firstPath=autoProject.routes[0].points;await clickAt((firstPath[0].x+firstPath[1].x)/2,(firstPath[0].y+firstPath[1].y)/2);
    assert.equal(await page.locator('#vertexList button').count(),firstPath.length+1,'Automatically generated routes remain editable');
    await page.locator('#applyShape').click();await page.locator('#save').click();
    const savedAuto=(await asUser(alice.id,'select * from public.workspaces')).rows[0];assert.equal(savedAuto.routes.length,3);assert.equal(savedAuto.routes[0].points.length,firstPath.length+1);assert.equal(savedAuto.depth.seed,12345);
    assert.equal((await rpc(alice.id,'advance_setup',[])).registration_status,'ready','Server independently accepts generated and edited paths');
    await page.reload();await page.locator('#autoRoutes').waitFor();assert.equal(await page.locator('#shapeList .item').count(),3,'Saved automatic routes survive reload');
    await page.locator('#depthPanel summary').click();await page.locator('#plannerMaxDepth').fill('0');await page.locator('#autoRoutes').click();
    await page.waitForFunction(()=>document.getElementById('messageText').textContent.includes('Нет допустимого прохода'));assert.equal(await page.locator('#shapeList .item').count(),3,'Failed rebuilding preserves edited routes');
    await page.locator('#plannerMaxDepth').fill('5');await page.locator('#autoRoutes').click();await page.waitForFunction(()=>document.getElementById('messageText').textContent.includes('Построено траекторий: 3'));
    await page.evaluate(()=>{crypto.getRandomValues=array=>{array[0]=23456;return array;};});await page.locator('#generateDepth').click();
    await page.waitForFunction(()=>document.getElementById('depthSource').textContent.includes('23456'));assert.equal(await page.locator('#shapeList .item').count(),3);
    await page.screenshot({path:path.join(output,'setup-auto-routes.png')});
    await page.locator('#dismissNotification').click();
    while(await page.locator('#shapeList .item').count()){const count=await page.locator('#shapeList .item').count();await page.locator('#shapeList .danger').first().click();await page.waitForFunction(n=>document.querySelectorAll('#shapeList .item').length===n-1,count);}
    fs.writeFileSync(path.join(output,'flat-depth.json'),JSON.stringify(G.emptyDepth()));await page.locator('#importDepth').setInputFiles(path.join(output,'flat-depth.json'));
    await page.waitForFunction(()=>document.getElementById('depthCols').value==='20');
    await page.locator('#depthPanel summary').click();
    await page.locator('#newShape').click();await clickAt(150,550);await clickAt(850,550);await page.locator('#applyShape').click();
    await page.locator('#depthPanel summary').click();await page.locator('#paintMode').check();await page.locator('#paintBlocked').check();await clickAt(525,575);
    assert.match(await page.locator('#validation').innerText(),/препятствие/);
    await page.locator('#next').click();await page.waitForFunction(()=>document.getElementById('message').textContent.includes('Исправьте'));
    const depthPromise=page.waitForEvent('download');await page.locator('#exportDepth').click();await(await depthPromise).saveAs(path.join(output,'pseudo-depth.json'));
    const depth=JSON.parse(fs.readFileSync(path.join(output,'pseudo-depth.json'),'utf8'));assert(depth.cells.includes(null));
    const fixed={...depth,cells:depth.cells.map(()=>0)};fs.writeFileSync(path.join(output,'fixed-depth.json'),JSON.stringify(fixed));
    await page.locator('#importDepth').setInputFiles(path.join(output,'fixed-depth.json'));await page.waitForFunction(()=>document.getElementById('validation').textContent.includes('Допустима'));
    await page.locator('#next').click();await page.waitForURL('**/welcome.html');assert.equal(await page.locator('.steps a').count(),4);
    const aliceProfile=(await asUser(alice.id,'select * from public.profiles')).rows[0];assert.equal(aliceProfile.registration_status,'ready');
    const aliceWS=(await asUser(alice.id,'select * from public.workspaces')).rows[0];assert.equal(aliceWS.zones.length,4);assert.equal(aliceWS.routes.length,1);
    await assert.rejects(rpc(alice.id,'save_workspace',[JSON.stringify(aliceWS.zones),JSON.stringify(aliceWS.routes),JSON.stringify(aliceWS.depth),aliceWS.revision-1]),/другой вкладке/);
    const blocked=structuredClone(aliceWS.depth);blocked.cells[11*20+10]=null;
    await rpc(alice.id,'save_workspace',[JSON.stringify(aliceWS.zones),JSON.stringify(aliceWS.routes),JSON.stringify(blocked),aliceWS.revision]);
    await assert.rejects(rpc(alice.id,'advance_setup',[]),/недопустима/,'Server rejects blocked route, independently of UI');
    const latest=(await asUser(alice.id,'select * from public.workspaces')).rows[0];
    await rpc(alice.id,'save_workspace',[JSON.stringify(latest.zones),JSON.stringify(latest.routes),JSON.stringify(aliceWS.depth),latest.revision]);await rpc(alice.id,'advance_setup',[]);
    const second=await browser.newContext({viewport:{width:1400,height:1100}}),bobPage=await second.newPage();bobPage.on('pageerror',e=>errors.push(e.message));
    await register(bobPage,'bob@example.com','Bob');await bobPage.locator('#polygonSelect').selectOption(aliceProfile.polygon_id);assert.equal(await bobPage.locator('#editorWindow').isVisible(),true,'Loading a shared polygon opens its window');assert.equal(await bobPage.locator('#polygonName').inputValue(),'Общий полигон');await bobPage.locator('#next').click();await bobPage.waitForFunction(()=>!document.getElementById('garage').hidden);
    assert.equal(await bobPage.locator('.equipment-card').count(),0,'Bob cannot see Alice equipment');
    await bobPage.locator('#equipmentName').fill('Самосвал Bob');await bobPage.locator('#equipmentForm button').click();await bobPage.locator('.equipment-card').waitFor();
    const bob=accounts.get('bob@example.com');
    const aliceEquipment=(await asUser(alice.id,'select * from public.equipment')).rows;const bobEquipment=(await asUser(bob.id,'select * from public.equipment')).rows;
    assert.equal(aliceEquipment.length,1);assert.equal(bobEquipment.length,1);assert.notEqual(aliceEquipment[0].marker_id,bobEquipment[0].marker_id);
    assert.equal((await asUser(bob.id,'select * from public.workspaces')).rows[0].zones.length,0);
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
    await page.goto(base+'/roi-site/setup.html?step=routes');await page.locator('#newShape').waitFor();await page.screenshot({path:path.join(output,'setup-live.png'),fullPage:true});
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
