'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('device token sync updates private config and tracker without overwriting local secrets/calibration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roi-device-token-'));
  try {
    const local = path.join(root, 'local');
    fs.mkdirSync(local);
    fs.copyFileSync(path.join(__dirname, 'local', 'robot-private.example.json'), path.join(local, 'robot-private.example.json'));
    fs.copyFileSync(path.join(__dirname, 'local', 'tracker-private.example.json'), path.join(local, 'tracker-private.example.json'));
    fs.copyFileSync(path.join(__dirname, 'sync-device-config.cjs'), path.join(root, 'sync-device-config.cjs'));
    const id = '12345678-1234-4234-8234-123456789abc';
    const token = 'same-device-token-12345678901234567890';
    fs.writeFileSync(path.join(local, 'robot-private.json'), JSON.stringify({
      operatorToken: 'keep-operator-secret', trackerToken: 'keep-tracker-secret',
      cloud: { refreshToken: 'keep-refresh-token' },
      devices: [{ id, token: 'old-token', model: { calibrated: true, linear_m_s: 0.2 } }]
    }));
    fs.writeFileSync(path.join(local, 'tracker-private.json'), JSON.stringify({
      trackerToken: 'old-tracker-token', anchors: { 40: [1, 2], 41: [3, 4], 42: [5, 6], 43: [7, 8] },
      robots: [{ id, yaw_offset_deg: 123 }]
    }));
    fs.writeFileSync(path.join(local, 'robot-device.private.json'), JSON.stringify({
      id, polygon_id: 'polygon-a', marker_id: 17, token
    }));
    execFileSync(process.execPath, [path.join(root, 'sync-device-config.cjs')], { cwd: root, stdio: 'pipe' });
    const config = JSON.parse(fs.readFileSync(path.join(local, 'robot-private.json'), 'utf8'));
    const tracker = JSON.parse(fs.readFileSync(path.join(local, 'tracker-private.json'), 'utf8'));
    assert.equal(config.devices[0].token, token);
    assert.equal(config.operatorToken, 'keep-operator-secret');
    assert.equal(config.cloud.refreshToken, 'keep-refresh-token');
    assert.equal(config.devices[0].model.calibrated, true);
    assert.equal(config.devices[0].model.linear_m_s, 0.2);
    assert.equal(tracker.trackerToken, 'keep-tracker-secret');
    assert.deepEqual(tracker.anchors, { 40: [1, 2], 41: [3, 4], 42: [5, 6], 43: [7, 8] });
    assert.equal(tracker.robots[0].yaw_offset_deg, 123);
    assert.equal(tracker.robots[0].marker_id, 17);
    assert.equal(tracker.robots.some(robot => String(robot.id).startsWith('REPLACE_')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
