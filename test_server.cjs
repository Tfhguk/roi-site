const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { chromium } = require("playwright");
const { startServers, argumentsFrom, localAddresses } = require("./server.cjs");

function request(secure, address, port, pathname, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const transport = secure ? https : http;
    const call = transport.request({ hostname: address, port, path: pathname, headers, method,
      rejectUnauthorized: false, timeout: 10000 }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ code: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8") }));
    });
    call.on("error", reject);
    call.on("timeout", () => call.destroy(new Error("Request timed out")));
    call.end();
  });
}

async function main() {
  assert.equal(argumentsFrom([]).host, "0.0.0.0");
  assert.equal(argumentsFrom(["--port", "9443", "--no-http"]).port, 9443);
  assert.equal(argumentsFrom(["--port", "9443", "--no-http"]).httpPort, false);
  assert.throws(() => argumentsFrom(["--port", "0"]));
  assert.throws(() => argumentsFrom(["--port", "8000"]));
  assert.throws(() => argumentsFrom(["--host", "unexpected.example"]));
  const tlsDirectory = path.join(__dirname, "test-output", "server-tls");
  const app = await startServers({ port: 0, httpPort: 0, tlsDirectory, log: () => {} });
  let browser;
  try {
    const landing = await request(true, "127.0.0.1", app.port, "/");
    assert.equal(landing.code, 302);
    assert.equal(landing.headers.location, "/login.html");
    for (const file of ["login.html", "welcome.html", "markers.html", "polygon.html", "polygon.js", "polygon-worker.js",
      "node_modules/js-aruco2/src/aruco.js", "node_modules/jspdf/dist/jspdf.umd.min.js"]) {
      const result = await request(true, "127.0.0.1", app.port, "/" + file);
      assert.equal(result.code, 200, file);
      assert(result.body.length > 0);
    }
    for (const file of ["/.lan-tls/server-key.pem", "/.lan-tls/firewall-result.json", "/.git/config", "/server.cjs",
      "/node_modules/selfsigned/index.js", "/%2e%2e/login.html", "/node_modules/", "/test-output/server-tls/server-key.pem"]) {
      assert.equal((await request(true, "127.0.0.1", app.port, file)).code, 404, file);
    }
    assert.equal((await request(true, "127.0.0.1", app.port, "/login.html", {}, "POST")).code, 405);
    assert.equal((await request(true, "127.0.0.1", app.port, "/polygon.js", {}, "HEAD")).body, "");
    assert.equal((await request(true, "127.0.0.1", app.port, "/", { Host: "external.invalid" })).code, 421);
    assert.equal((await request(false, "127.0.0.1", app.httpPort, "/login.html")).code, 200);
    const addresses = localAddresses();
    const address = (addresses.find(entry => entry.address.startsWith("192.168.")) || addresses[0] || { address: "127.0.0.1" }).address;
    if (address !== "127.0.0.1") {
      assert.equal((await request(true, address, app.port, "/login.html")).code, 200);
      const redirected = await request(false, address, app.httpPort, "/polygon.html");
      assert.equal(redirected.code, 302);
      assert.equal(redirected.headers.location, "https://" + address + ":" + app.port + "/polygon.html");
    }
    browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || "msedge", headless: true,
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
    // Only the test profile accepts the generated development certificate.
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("https://" + address + ":" + app.port + "/login.html");
    assert(await page.evaluate(() => isSecureContext && Boolean(crypto.subtle) && Boolean(navigator.mediaDevices)));
    await page.locator("#loginUser").fill("admin");
    await page.locator("#loginPass").fill("admin123");
    await page.locator('#loginForm button[type="submit"]').click();
    await page.waitForURL("**/welcome.html");
    await page.locator('a[href="polygon.html"]').click();
    await page.locator("#startCameraBtn").click();
    await page.waitForFunction(() => document.getElementById("modeLabel").textContent === "Прямой эфир");
    await page.locator("#captureBtn").click();
    const detected = await page.evaluate(() => new Promise((resolve, reject) => {
      const worker = new Worker("polygon-worker.js");
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error("Worker timeout")); }, 10000);
      worker.onmessage = event => { clearTimeout(timeout); worker.terminate(); resolve(event.data); };
      worker.onerror = event => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)); };
      const cells = ArucoMarker.matrix(1), size = 160, data = new Uint8ClampedArray(size * size * 4);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const offset = (y * size + x) * 4;
        data[offset] = data[offset + 1] = data[offset + 2] = cells[Math.floor(y / 20)][Math.floor(x / 20)] * 255;
        data[offset + 3] = 255;
      }
      worker.postMessage({ requestId: 1, dictionary: "DICT_4X4_50", width: size, height: size, buffer: data.buffer });
    }));
    assert.equal(detected.error, undefined);
    assert.deepEqual(detected.markers.map(marker => marker.id), [1]);
    assert.deepEqual(errors, []);
    const cert = fs.readFileSync(path.join(tlsDirectory, "server-cert.pem"), "utf8");
    await browser.close(); browser = null;
    await app.close();
    const restarted = await startServers({ port: 0, httpPort: false, tlsDirectory, log: () => {} });
    await restarted.close();
    assert.equal(fs.readFileSync(path.join(tlsDirectory, "server-cert.pem"), "utf8"), cert, "Reuse the existing certificate");
    console.log("PASS: configurable LAN HTTPS/HTTP, certificate SANs and reuse, LAN redirect, private-file restrictions; login, secure camera and marker worker via https://" + address + ".");
  } finally {
    if (browser) await browser.close();
    if (app.secureServer.listening) await app.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
