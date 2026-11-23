const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
//ssыыыыыыыsssss
const ROOT = __dirname;
const DIST = path.resolve(ROOT, "dist");
const ZIP = path.join(ROOT, "aruco-site.zip");
const SOURCE_FILES = ["login.html", "welcome.html", "markers.html", "polygon.html", "auth.js",
  "aruco_dict_4x4_50.js", "aruco.js", "polygon-geometry.js", "marker-detection.js",
  "polygon-worker.js", "polygon.js", "polygon.css", "cloud-config.js", "cloud-client.js", "cloud-login.js",
  "setup.html", "setup.css", "setup.js", "setup-geometry.js", "setup-export.js", "firmware-ui.js", "firmware.css",
  "firmware/roi_robot.ino", "firmware/hardware.h", "firmware/hardware-config.h", "firmware/indicators.h", "firmware/README.md", "robot-server.cjs", "robot-firmware-setup.js", "robot-cloud-ui.js", "local/cloud-bridge.cjs", "local/aruco-tracker.py", "local/robot-private.example.json", "local/tracker-private.example.json", "local/flash-esp32.cmd", "firmware/hardware-config.2s.example.h",
  "charging.html", "charging.css", "charging-model.js", "charging.js", "ar.html", "ar.css", "ar-api.js", "ar.js",
  "truck.html", "truck.css", "truck-model.js", "truck-navigation.js", "truck-learning.js", "truck-command-log.js", "truck-traction.js", "truck-mujoco.js", "truck-web3d.js", "mujoco-browser-worker.js", "mujoco-scene.js", "mujoco-planning.js", "truck.js"];
const VENDOR_FILES = [
  ["node_modules/@mujoco/mujoco/mujoco.js", "assets/vendor/mujoco.js"],
  ["node_modules/@mujoco/mujoco/mujoco.wasm", "assets/vendor/mujoco.wasm"],
  ["node_modules/@mujoco/mujoco/README.md", "assets/vendor/README-mujoco.md"],
  ["mujoco_sim/LICENSE-MuJoCo.txt", "assets/vendor/LICENSE-mujoco.txt"],
  ["node_modules/three/build/three.module.js", "assets/vendor/three.module.js"],
  ["node_modules/three/build/three.core.js", "assets/vendor/three.core.js"],
  ["node_modules/three/LICENSE", "assets/vendor/LICENSE-three.txt"],
  ["mujoco_sim/terrain.cjs", "mujoco-terrain.js"],
  ["node_modules/jspdf/dist/jspdf.umd.min.js", "assets/vendor/jspdf.umd.min.js"],
  ["node_modules/js-aruco2/src/cv.js", "assets/vendor/aruco-cv.js"],
  ["node_modules/js-aruco2/src/aruco.js", "assets/vendor/aruco-detector.js"],
  ["node_modules/jspdf/LICENSE", "assets/vendor/LICENSE-jspdf.txt"],
  ["node_modules/js-aruco2/LICENSE.txt", "assets/vendor/LICENSE-js-aruco2.txt"]
];

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const name of files) {
    const filename = Buffer.from(name, "utf8"), bytes = fs.readFileSync(path.join(DIST, name));
    const compressed = zlib.deflateRawSync(bytes), crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(33, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(ZIP, Buffer.concat([...local, directory, end]));
}

function build() {
  const settings = {};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "cloud-config.js"), "utf8"), { window: settings }, { timeout: 1000 });
  const fromEnvironment = Boolean(process.env.SUPABASE_URL || process.env.SUPABASE_PUBLISHABLE_KEY);
  const cloudUrl = (fromEnvironment ? process.env.SUPABASE_URL : settings.ROI_CLOUD?.url) || "";
  const cloudKey = (fromEnvironment ? process.env.SUPABASE_PUBLISHABLE_KEY : settings.ROI_CLOUD?.publishableKey) || "";
  if (Boolean(cloudUrl) !== Boolean(cloudKey)) throw new Error("Set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.");
  if (cloudUrl) {
    const parsed = new URL(cloudUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") throw new Error("SUPABASE_URL must be an HTTPS project URL without a path.");
    const legacyRole = cloudKey.startsWith("eyJ") ? JSON.parse(Buffer.from(cloudKey.split(".")[1], "base64url")).role : null;
    if (!cloudKey.startsWith("sb_publishable_") && legacyRole !== "anon") throw new Error("Use only the public publishable/anon key, never a secret or service_role key.");
  }
  // Validate every input before replacing this script's generated directory.
  for (const name of [...SOURCE_FILES, ...VENDOR_FILES.map(([source]) => source)]) {
    if (!fs.existsSync(path.join(ROOT, name))) throw new Error("Missing " + name + ". Run npm.cmd install.");
  }
  if (path.dirname(DIST) !== path.resolve(ROOT) || path.basename(DIST) !== "dist") throw new Error("Invalid output directory");
  if (fs.existsSync(DIST) && fs.lstatSync(DIST).isSymbolicLink()) throw new Error("Output directory must not be a symbolic link");
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  const files = [];
  function write(name, data) {
    fs.mkdirSync(path.dirname(path.join(DIST, name)), { recursive: true });
    fs.writeFileSync(path.join(DIST, name), data);
    files.push(name);
  }
  for (const name of SOURCE_FILES) {
    let content = fs.readFileSync(path.join(ROOT, name), "utf8");
    if (name === "cloud-config.js" && cloudUrl) content = "window.ROI_CLOUD = Object.freeze(" + JSON.stringify({ url: cloudUrl, publishableKey: cloudKey }) + ");\n";
    for (const [source, target] of VENDOR_FILES.filter(([source]) => source.endsWith(".js"))) {
      content = content.split(source).join(target);
    }
    write(name, content);
  }
  for (const [source, target] of VENDOR_FILES) write(target, fs.readFileSync(path.join(ROOT, source)));
  const releaseHash=createHash('sha256');
  for(const name of files.slice().sort())releaseHash.update(fs.readFileSync(path.join(DIST,name)));
  const release=releaseHash.digest('hex').slice(0,16);
  for (const name of SOURCE_FILES.filter(name => name.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(DIST, name), "utf8").replace(/\b(src|href)="([^"?#]+\.(?:js|css))"/g, (match, attr, asset) => {
      const file = path.join(DIST, asset);
      if (!fs.existsSync(file)) return match;
      const version = createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);
      return attr + '="' + asset + '?v=' + version + '"';
    });
    fs.writeFileSync(path.join(DIST, name), html.replace('</head>','<meta name="roi-build" content="'+release+'"></head>'));
  }
  write("index.html", fs.readFileSync(path.join(DIST, "login.html")));
  write("_headers", "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(self), microphone=()\n/*.html\n  Cache-Control: no-cache\n/*.js\n  Cache-Control: no-cache\n");
  makeZip(files.sort());
  console.log("Ready: " + DIST + " (" + files.length + " public files)");
  console.log("Upload: " + ZIP + " (" + Math.round(fs.statSync(ZIP).size / 1024) + " KB)");
}

if (require.main === module) {
  try { build(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { build };
