'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const manifestPath = path.join(root, 'github-files.json');
const files = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

test('GitHub manifest is a unique array of existing project files', () => {
  assert.ok(Array.isArray(files));
  assert.ok(files.length > 0);
  assert.equal(new Set(files).size, files.length);
  for (const name of files) {
    assert.equal(typeof name, 'string');
    assert.ok(name.length > 0);
    assert.ok(!path.isAbsolute(name));
    assert.ok(!name.split(/[\\/]/).includes('..'));
    assert.ok(fs.statSync(path.join(root, name)).isFile(), `${name} must exist`);
  }
});

test('manifest excludes private, generated and machine-specific files', () => {
  for (const name of files) {
    assert.ok(!name.startsWith('.lan-tls/'), name);
    assert.ok(!name.startsWith('node_modules/'), name);
    assert.ok(!name.startsWith('dist/'), name);
    assert.ok(!/(^|\/)(\.env|.*-private\.json|.*\.pem|.*\.key)$/i.test(name), name);
  }
});

test('new local robot software files are included in the manifest', () => {
  for (const name of [
    'START-ROBOTS-WINDOWS.cmd',
    'INSTALL-TRACKER-WINDOWS.cmd',
    'START-TRACKER-WINDOWS.cmd',
    'README-LOCAL-SOFTWARE.txt',
    'local/cloud-bridge.cjs',
    'local/aruco-tracker.py',
    'robot-server.cjs',
    'sync-device-config.cjs',
    'test_device_token_sync.cjs',
    'github-files.json'
  ]) assert.ok(files.includes(name), `${name} missing from manifest`);
});
