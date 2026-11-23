'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=__dirname;
const read=name=>fs.readFileSync(path.join(root,name),'utf8');

test('local software archive exposes every runtime component through the site build',()=>{
  const build=read('build.cjs');
  for(const file of ['robot-server.cjs','local/cloud-bridge.cjs','local/aruco-tracker.py','local/requirements-tracker.txt','START-ROBOTS-WINDOWS.cmd','INSTALL-TRACKER-WINDOWS.cmd','START-TRACKER-WINDOWS.cmd','README-LOCAL-SOFTWARE.txt'])
    assert.ok(build.includes('"'+file+'"'),`build.cjs must publish ${file}`);
});

test('browser setup downloads a separate local software archive',()=>{
  const js=read('robots-setup.js');
  assert.match(js,/roi-robot-local-software\.zip/);
  assert.match(js,/download-software/);
  assert.match(js,/local\/cloud-bridge\.cjs/);
  assert.match(js,/robot-server\.cjs/);
  assert.match(js,/local\/aruco-tracker\.py/);
});

test('Windows launchers connect the server, cloud bridge and camera tracker',()=>{
  const server=read('START-ROBOTS-WINDOWS.cmd');
  assert.match(server,/node robot-server\.cjs/);
  assert.match(server,/local\\robot-private\.json/);
  assert.match(read('robot-server.cjs'),/startCloudBridge/);
  assert.match(read('START-TRACKER-WINDOWS.cmd'),/local\\aruco-tracker\.py/);
  assert.match(read('INSTALL-TRACKER-WINDOWS.cmd'),/requirements-tracker\.txt/);
  assert.match(read('local/requirements-tracker.txt'),/opencv-contrib-python/);
});
