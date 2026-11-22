const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const https = require("node:https");
const { X509Certificate, createPrivateKey, createPublicKey } = require("node:crypto");
const net = require("node:net");

const ROOT = __dirname;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const LIBRARIES = new Set(["node_modules/jspdf/dist/jspdf.umd.min.js",
  "node_modules/js-aruco2/src/cv.js", "node_modules/js-aruco2/src/aruco.js"]);
const FIRMWARE = new Set(["firmware/roi_robot.ino", "firmware/hardware.h", "firmware/README.md", "robot-server.cjs"]);

function localAddresses() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, entries]) => entries
    .filter(entry => entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254."))
    .map(entry => ({ name, address: entry.address })))
    .sort((a, b) => Number(/vpn|virtual|vethernet|docker|wsl/i.test(a.name)) - Number(/vpn|virtual|vethernet|docker|wsl/i.test(b.name)));
}

async function certificate(directory, addresses) {
  const keyPath = path.join(directory, "server-key.pem"), certPath = path.join(directory, "server-cert.pem");
  const ips = [...new Set(["127.0.0.1", ...addresses.map(entry => entry.address)])];
  const names = [...new Set(["localhost", os.hostname().toLowerCase()])];
  try {
    const [key, cert] = await Promise.all([fsp.readFile(keyPath), fsp.readFile(certPath)]);
    const x509 = new X509Certificate(cert);
    const matchesKey = x509.publicKey.export({ type: "spki", format: "pem" }) ===
      createPublicKey(createPrivateKey(key)).export({ type: "spki", format: "pem" });
    if (matchesKey && Date.parse(x509.validTo) > Date.now() + 86400000 &&
        ips.every(ip => x509.checkIP(ip)) && names.every(name => x509.checkHost(name))) return { key, cert };
  } catch (error) { /* Missing, expired or outdated certificates are replaced locally. */ }
  const selfsigned = require("selfsigned");
  const notBeforeDate = new Date(Date.now() - 300000);
  const notAfterDate = new Date(Date.now() + 365 * 86400000);
  const pems = await selfsigned.generate([{ name: "commonName", value: "localhost" }], {
    algorithm: "sha256", keySize: 2048, notBeforeDate, notAfterDate,
    extensions: [
      { name: "basicConstraints", cA: false, critical: true },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [
        ...names.map(value => ({ type: 2, value })), ...ips.map(ip => ({ type: 7, ip }))
      ] }
    ]
  });
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.writeFile(keyPath, pems.private, { mode: 0o600 });
  await fsp.writeFile(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

function send(response, code, text, headers = {}) {
  response.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(text);
}

async function serve(request, response) {
  if (!["GET", "HEAD"].includes(request.method)) return send(response, 405, "Method not allowed", { Allow: "GET, HEAD" });
  let pathname;
  try { pathname = decodeURIComponent(request.url.split(/[?#]/)[0]); }
  catch (error) { return send(response, 400, "Invalid URL"); }
  if (pathname === "/") return send(response, 302, "", { Location: "/login.html" });
  if (pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
  const relative = pathname.slice(1);
  if (!pathname.startsWith("/") || /[\\\0:]/.test(relative) || relative.split("/").some(part => part.startsWith(".")) ||
      (relative.startsWith("node_modules/") && !LIBRARIES.has(relative)) || (!MIME[path.extname(relative)] && !FIRMWARE.has(relative))) {
    return send(response, 404, "Not found");
  }
  try {
    const builtAsset = relative.startsWith("assets/vendor/") || relative === "mujoco-terrain.js";
    const file = await fsp.realpath(path.join(ROOT, builtAsset ? "dist" : "", relative));
    const resolved = path.relative(ROOT, file);
    if (resolved.startsWith("..") || path.isAbsolute(resolved)) return send(response, 404, "Not found");
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return send(response, 404, "Not found");
    response.writeHead(200, { "Content-Type": FIRMWARE.has(relative)?"text/plain; charset=utf-8":MIME[path.extname(file)], "Content-Length": stat.size,
      "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
    if (request.method === "HEAD") return response.end();
    const input = fs.createReadStream(file);
    input.on("error", () => response.destroy());
    input.pipe(response);
  } catch (error) { send(response, 404, "Not found"); }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.removeListener("error", reject); resolve(); });
  });
}

async function startServers({ host = "0.0.0.0", port = 8443, httpPort = 8000,
  tlsDirectory = path.join(ROOT, ".lan-tls"), log = console.log } = {}) {
  const addresses = localAddresses();
  const credentials = await certificate(tlsDirectory, addresses);
  const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", os.hostname().toLowerCase(), host,
    ...addresses.map(entry => entry.address)]);
  function hostname(request) {
    const hostHeader = request.headers.host;
    if (!hostHeader || !/^[a-zA-Z0-9.:[\]-]+$/.test(hostHeader)) return null;
    try {
      const value = new URL("http://" + hostHeader).hostname.toLowerCase();
      return allowedHosts.has(value) ? value : null;
    } catch (error) { return null; }
  }
  const secureServer = https.createServer(credentials, (request, response) => {
    if (!hostname(request)) return send(response, 421, "Use a local address printed by the server");
    serve(request, response).catch(() => response.destroy());
  });
  let plainServer = null;
  try {
    await listen(secureServer, port, host);
    const actualPort = secureServer.address().port;
    if (httpPort !== false) {
      plainServer = http.createServer((request, response) => {
        const name = hostname(request);
        if (!name) return send(response, 421, "Use a local address printed by the server");
        // Keep old localhost URLs and browser data; LAN clients need HTTPS.
        const localPeer = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress);
        if (localPeer && ["localhost", "127.0.0.1", "[::1]"].includes(name)) {
          serve(request, response).catch(() => response.destroy());
        } else {
          const location = "https://" + name + ":" + actualPort +
            (request.url.startsWith("/") && !request.url.startsWith("//") ? request.url : "/");
          send(response, 302, "Open the HTTPS address for camera access", { Location: location });
        }
      });
      await listen(plainServer, httpPort, host);
    }
    log("\nArUco: HTTPS server is running. Keep this process open.");
    log("This computer: https://localhost:" + actualPort + "/");
    addresses.filter(entry => host === "0.0.0.0" || host === entry.address).forEach(entry =>
      log("LAN [" + entry.name + "]: https://" + entry.address + ":" + actualPort + "/"));
    log("First visit: the browser shows a warning for the local self-signed certificate.");
    log("Allow camera access after opening your server's HTTPS address.");
    log("TLS certificate SHA-256: " + new X509Certificate(credentials.cert).fingerprint256);
    if (plainServer) log("HTTP port: " + plainServer.address().port + " (LAN requests redirect to HTTPS)");
    return { secureServer, plainServer, port: actualPort,
      httpPort: plainServer ? plainServer.address().port : null,
      close: () => Promise.all([secureServer, plainServer].filter(Boolean).map(server => new Promise(resolve => {
        server.close(resolve); server.closeIdleConnections();
      }))) };
  } catch (error) {
    for (const server of [secureServer, plainServer].filter(Boolean)) if (server.listening) server.close();
    throw error;
  }
}

function argumentsFrom(argv) {
  const options = { host: process.env.APP_HOST || "0.0.0.0", port: Number(process.env.APP_HTTPS_PORT || 8443),
    httpPort: Number(process.env.APP_HTTP_PORT || 8000) };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--no-http") options.httpPort = false;
    else if (["--port", "--http-port", "--host"].includes(argv[i]) && argv[i + 1]) {
      const name = argv[i++];
      options[name === "--port" ? "port" : name === "--http-port" ? "httpPort" : "host"] = name === "--host" ? argv[i] : Number(argv[i]);
    } else throw new Error("Usage: npm.cmd start -- --port 8443 --http-port 8000 --host 0.0.0.0 (or --no-http)");
  }
  if (![options.port, options.httpPort].every(value => value === false || Number.isInteger(value) && value >= 1 && value <= 65535) ||
      options.port === options.httpPort) throw new Error("Choose different ports between 1 and 65535.");
  if (!net.isIPv4(options.host) && options.host !== "localhost") throw new Error("--host must be an IPv4 address or localhost.");
  return options;
}

if (require.main === module) {
  Promise.resolve().then(() => startServers(argumentsFrom(process.argv.slice(2)))).then(app => {
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => app.close().then(() => process.exit(0)));
  }).catch(error => {
    console.error(error.code === "EADDRINUSE" ? "Port is in use. Stop the other server or choose --port / --http-port." : error.message);
    process.exitCode = 1;
  });
}
module.exports = { startServers, argumentsFrom, localAddresses };
