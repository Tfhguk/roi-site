const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'robots-setup.js'), 'utf8');

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.textContent = ''; this.value = ''; this.files = []; this.hidden = false; this.className = ''; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = [...items]; }
  setAttribute() {}
  scrollIntoView() {}
  remove() {}
  click() {}
}

async function runPage(search = '') {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const p1 = '11111111-1111-4111-8111-111111111111';
  const p2 = '22222222-2222-4222-8222-222222222222';
  const rows = [
    { id: 'robot-p1', name: 'Машина полигона 1', polygon_id: p1, marker_id: 1 },
    { id: 'robot-p2', name: 'Машина полигона 2', polygon_id: p2, marker_id: 2 },
    { id: 'robot-null', name: 'Без полигона', polygon_id: null, marker_id: 3 }
  ];
  const context = {
    document: { getElementById: get, createElement: tag => new Element(tag), body: new Element('body') },
    location: { search, replace() {} },
    URLSearchParams,
    TextEncoder,
    Uint8Array,
    Uint32Array,
    DataView,
    Blob,
    URL,
    setTimeout,
    clearTimeout,
    console,
    navigator: { clipboard: { writeText: async () => {} } },
    crypto: { getRandomValues: a => a.fill(1) },
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    window: { ROI_CLOUD: { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_12345678901234567890' } },
    AppCloud: {
      configured: true,
      session: () => ({ user: { email: 'test@example.com' }, refresh_token: 'refresh' }),
      me: async () => ({ polygon_id: p1, name: 'Test user' }),
      equipment: async () => rows,
      polygons: async () => [{ id: p1, name: 'Северный полигон' }, { id: p2, name: 'Южный полигон' }]
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'robots-setup.js' });
  await new Promise(resolve => setTimeout(resolve, 0));
  return { nodes, p1, p2 };
}

test('wizard displays only equipment belonging to the active polygon', async () => {
  const { nodes } = await runPage();
  const visible = nodes.get('robots').children;
  assert.equal(visible.length, 1);
  assert.match(visible[0].children[1].children[0].textContent, /Машина полигона 1/);
  assert.match(nodes.get('polygon-context').textContent, /Северный полигон/);
});

test('a deep link to a robot from another polygon is rejected', async () => {
  const { nodes } = await runPage('?robot=robot-p2');
  assert.equal(nodes.get('robots').children.length, 1);
  assert.match(nodes.get('notice').textContent, /другому полигону/);
});
