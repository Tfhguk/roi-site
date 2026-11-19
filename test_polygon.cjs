const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const { pathToFileURL } = require("node:url");

const localFiles = process.argv.includes("--file");
const blockedWorker = process.argv.includes("--blocked-worker");
const failedWorker = process.argv.includes("--failed-worker");

const root = __dirname;
const siteRoot = process.argv.includes("--dist") ? path.join(root, "dist") : root;
const basePath = process.argv.includes("--subpath") ? "/roi-site" : "";
const output = path.join(root, "test-output");
fs.mkdirSync(output, { recursive: true });

function testDetectionAndGeometry() {
  for (const file of ["aruco_dict_4x4_50.js", "aruco.js", "polygon-geometry.js",
    "node_modules/js-aruco2/src/cv.js", "node_modules/js-aruco2/src/aruco.js", "marker-detection.js"]) {
    vm.runInThisContext(fs.readFileSync(path.join(root, file), "utf8"), { filename: file });
  }
  for (const dictionary of ["DICT_4X4_50", "ARUCO_ORIGINAL"]) {
    const ids = dictionary === "DICT_4X4_50" ? Array.from({ length: 50 }, (_, i) => i) : [0, 1, 155, 600, 1023];
    for (const id of ids) {
      let cells = ArucoMarker.matrix(id, dictionary);
      for (let rotation = 0; rotation < 4; rotation++) {
        const width = cells.length * 20;
        const data = new Uint8ClampedArray(width * width * 4);
        for (let y = 0; y < width; y++) {
          for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4;
            data[offset] = data[offset + 1] = data[offset + 2] = cells[Math.floor(y / 20)][Math.floor(x / 20)] * 255;
            data[offset + 3] = 255;
          }
        }
        const markers = MarkerDetection.getDetector(dictionary).detect({ width, height: width, data });
        assert.deepEqual(markers.map(marker => marker.id), [id], dictionary + " / " + id + " / " + rotation);
        cells = cells[0].map((_, x) => cells.map(row => row[x]).reverse());
      }
    }
  }
  const rectangle = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }];
  assert(PolygonGeometry.isSimple(rectangle));
  assert.equal(PolygonGeometry.area(rectangle), 8000);
  assert(!PolygonGeometry.isSimple([rectangle[0], rectangle[2], rectangle[1], rectangle[3]], false));
  assert(!PolygonGeometry.isSimple([rectangle[0], rectangle[1], rectangle[3], rectangle[2]]));
  assert(!PolygonGeometry.isSimple([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 40, y: 0 }]));
  assert(!PolygonGeometry.isSimple([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 0 }], false));
  const perspective = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 80, y: 100 }, { x: 20, y: 100 }];
  assert.deepEqual(PolygonGeometry.markerCenter(perspective), { x: 50, y: 62.5 });
  const crossed = [rectangle[0], rectangle[1], rectangle[3], rectangle[2]];
  assert.deepEqual(PolygonGeometry.repairOrder(crossed), rectangle);
  assert.deepEqual(crossed, [rectangle[0], rectangle[1], rectangle[3], rectangle[2]], "Repair must not mutate the original order");
  assert.equal(PolygonGeometry.repairOrder([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 40, y: 0 }]), null);
  assert.equal(PolygonGeometry.repairOrder([rectangle[0], rectangle[1], rectangle[0]]), null);
  const concave = [rectangle[0], rectangle[1], { x: 45, y: 35 }, rectangle[2], rectangle[3]];
  assert.deepEqual(PolygonGeometry.repairOrder(concave), concave, "A valid concave boundary stays unchanged");
  function permutations(points) {
    return points.length ? points.flatMap((point, i) => permutations(points.filter((_, j) => i !== j)).map(rest => [point, ...rest])) : [[]];
  }
  for (const points of permutations(concave)) {
    const repaired = PolygonGeometry.repairOrder(points);
    assert(repaired && PolygonGeometry.isSimple(repaired));
    assert.equal(repaired[0], points[0]);
    assert.equal(repaired.length, points.length);
    assert.equal(new Set(repaired).size, points.length);
    assert(points.every(point => repaired.includes(point)), "Every marker and its coordinates must survive repair");
  }
  console.log("PASS: 220 marker detections; polygon geometry, screenshot crossing and 120 vertex orders including concave vertices.");
}

function makeCameraFixture() {
  const script = `
from pathlib import Path
import json
import cv2
import numpy as np
out = Path('test-output')
image = np.full((640, 960, 3), 195, dtype=np.uint8)
dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
centres = [(180, 150), (780, 150), (780, 490), (180, 490)]
expected = []
for marker_id, (cx, cy) in enumerate(centres):
    image[cy-78:cy+78, cx-78:cx+78] = 255
    marker = cv2.aruco.generateImageMarker(dictionary, marker_id, 108)
    if marker_id == 1:
        marker = np.rot90(marker).copy()
    if marker_id == 2:
        source = np.float32([[0,0], [107,0], [107,107], [0,107]])
        target = np.float32([[725,430], [839,442], [827,548], [735,532]])
        transform = cv2.getPerspectiveTransform(source, target)
        warped = cv2.warpPerspective(marker, transform, (960,640), borderValue=255)
        image = np.minimum(image, cv2.cvtColor(warped, cv2.COLOR_GRAY2BGR))
        centre = cv2.perspectiveTransform(np.float32([[[53.5,53.5]]]), transform)[0,0]
        expected.append({'id': marker_id, 'x': float(centre[0]), 'y': float(centre[1])})
    else:
        image[cy-54:cy+54, cx-54:cx+54] = cv2.cvtColor(marker, cv2.COLOR_GRAY2BGR)
        expected.append({'id': marker_id, 'x': cx-0.5, 'y': cy-0.5})
cv2.imencode('.png', image)[1].tofile(str(out / 'polygon-camera.png'))
yuv = cv2.cvtColor(image, cv2.COLOR_BGR2YUV_I420)
with (out / 'polygon-camera.y4m').open('wb') as video:
    video.write(b'YUV4MPEG2 W960 H640 F10:1 Ip A1:1 C420jpeg\\n')
    video.write(b'FRAME\\n')
    video.write(yuv.tobytes())
(out / 'polygon-expected.json').write_text(json.dumps(expected), encoding='utf-8')
`;
  execFileSync("python", ["-c", script], { cwd: root, stdio: "inherit" });
}

async function main() {
  testDetectionAndGeometry();
  makeCameraFixture();
  const server = http.createServer((request, response) => {
    let pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    if (basePath && !pathname.startsWith(basePath + "/")) { response.writeHead(404); response.end(); return; }
    pathname = pathname.slice(basePath.length);
    const file = path.resolve(siteRoot, "." + pathname);
    if (!file.startsWith(siteRoot + path.sep)) { response.writeHead(403); response.end(); return; }
    const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
    fs.readFile(file, (error, data) => {
      response.writeHead(error ? 404 : 200, { "Content-Type": type[path.extname(file)] || "application/octet-stream" });
      response.end(error ? "Not found" : data);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || "msedge", headless: true, args: [
      "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
      "--use-file-for-fake-video-capture=" + path.join(output, "polygon-camera.y4m")
    ] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, acceptDownloads: true });
    await context.addInitScript(() => Object.defineProperty(globalThis, "ROI_CLOUD", {
      value: Object.freeze({ url: "", publishableKey: "" }), writable: false
    }));
    await context.addInitScript(({ blockedWorker, failedWorker }) => {
      globalThis.workerAttempts = 0;
      if (typeof Worker === "undefined") return;
      globalThis.Worker = new Proxy(Worker, {
        construct(target, args) {
          globalThis.workerAttempts++;
          if (blockedWorker) throw new DOMException("Worker blocked", "SecurityError");
          if (failedWorker) {
            const url = URL.createObjectURL(new Blob(["throw new Error('Test worker load failure');"], { type: "text/javascript" }));
            return new target(url);
          }
          return Reflect.construct(target, args);
        }
      });
    }, { blockedWorker, failedWorker });
    const external = [], errors = [];
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.protocol.startsWith("http") && url.hostname !== "127.0.0.1") {
        external.push(url.href); return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => dialog.accept());
    const base = localFiles ? pathToFileURL(siteRoot).href : "http://127.0.0.1:" + server.address().port + basePath;
    await page.goto(base + "/polygon.html");
    await page.waitForURL("**/login.html");
    await page.locator("#loginUser").fill("admin");
    await page.locator("#loginPass").fill("admin123");
    await page.locator('#loginForm button[type="submit"]').click();
    await page.waitForURL("**/welcome.html");
    assert.equal(await page.locator(".steps a").count(), 2);
    await page.locator('a[href="polygon.html"]').click();
    assert(await page.locator("#closePolygonBtn").isDisabled());
    await page.locator("#startCameraBtn").click();
    await page.waitForFunction(() => document.getElementById("modeLabel").textContent === "Прямой эфир");
    const dimensions = await page.locator("#scene").evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
    assert.deepEqual(dimensions, { width: 960, height: 640 });
    const expected = JSON.parse(fs.readFileSync(path.join(output, "polygon-expected.json"), "utf8"));
    async function clickAt(x, y) {
      const bounds = await page.locator("#scene").boundingBox();
      await page.locator("#scene").click({ position: { x: x * bounds.width / 960, y: y * bounds.height / 640 } });
      await page.waitForFunction(() => !document.getElementById("status").textContent.startsWith("Ищем"));
    }
    // The first click freezes the frame; no marker means no fabricated vertex.
    await clickAt(480, 320);
    assert.equal(await page.locator("#modeLabel").innerText(), "Кадр зафиксирован");
    assert.equal(await page.locator("#vertexCount").innerText(), "0");
    assert.match(await page.locator("#status").innerText(), /не найдена/);
    const selectionOrder = [0, 1, 3, 2];
    for (let position = 0; position < selectionOrder.length; position++) {
      const i = selectionOrder[position];
      await clickAt(expected[i].x + 20, expected[i].y + 15);
      assert.equal(await page.locator("#vertexCount").innerText(), String(position + 1), await page.locator("#status").innerText());
      if (i === 1) {
        await clickAt(expected[i].x, expected[i].y);
        assert.equal(await page.locator("#vertexCount").innerText(), "2");
        assert.match(await page.locator("#status").innerText(), /уже добавлена/);
        assert(await page.locator("#closePolygonBtn").isDisabled());
      }
    }
    const listIds = () => page.locator(".vertex-label").evaluateAll(labels => labels.map(label => Number(label.textContent.match(/ArUco ID (\d+)/)[1])));
    assert.deepEqual(await listIds(), selectionOrder);
    await page.locator("#closePolygonBtn").click();
    assert.match(await page.locator("#status").innerText(), /Исправить порядок/);
    assert(await page.locator("#downloadJsonBtn").isDisabled());
    await page.locator("#fixOrderBtn").click();
    assert.deepEqual(await listIds(), [0, 1, 2, 3]);
    await page.locator("#undoBtn").click();
    assert.deepEqual(await listIds(), selectionOrder);
    await page.locator('#vertexList li').last().locator('[data-direction="-1"]').click();
    assert.deepEqual(await listIds(), [0, 1, 2, 3]);
    await page.locator("#undoBtn").click();
    assert.deepEqual(await listIds(), selectionOrder);
    await page.locator("#fixOrderBtn").click();
    assert.deepEqual(await listIds(), [0, 1, 2, 3]);
    // Close by selecting the first physical marker again.
    await clickAt(expected[0].x, expected[0].y);
    assert.match(await page.locator("#status").innerText(), /Полигон готов/);
    const attempts = await page.evaluate(() => globalThis.workerAttempts);
    assert.equal(attempts, localFiles ? 0 : 1, "Use direct detection for file://; use at most one worker when blocked");
    assert(await page.locator("#downloadJsonBtn").isEnabled());
    const jsonPromise = page.waitForEvent("download");
    await page.locator("#downloadJsonBtn").click();
    await (await jsonPromise).saveAs(path.join(output, "polygon.json"));
    const polygon = JSON.parse(fs.readFileSync(path.join(output, "polygon.json"), "utf8"));
    assert.equal(polygon.closed, true);
    assert.equal(polygon.dictionary, "DICT_4X4_50");
    assert.deepEqual(polygon.image, dimensions);
    polygon.vertices.forEach((vertex, i) => {
      assert.equal(vertex.markerId, expected[i].id);
      assert(Math.hypot(vertex.x - expected[i].x, vertex.y - expected[i].y) < 2,
        "Vertex must match marker centre, not click location: " + JSON.stringify(vertex));
    });
    const pngPromise = page.waitForEvent("download");
    await page.locator("#downloadPngBtn").click();
    await (await pngPromise).saveAs(path.join(output, "polygon.png"));
    assert.equal(fs.readFileSync(path.join(output, "polygon.png")).subarray(1, 4).toString(), "PNG");
    await page.locator('#vertexList li').last().locator('[data-direction="-1"]').click();
    assert(await page.locator("#downloadJsonBtn").isDisabled());
    await page.locator("#undoBtn").click();
    assert(await page.locator("#downloadJsonBtn").isEnabled(), "Undo must restore the closed polygon too");
    await page.screenshot({ path: path.join(output, "polygon-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, "polygon-mobile.png"), fullPage: true });
    // Clicking remains accurate after responsive resizing.
    await page.locator("#closePolygonBtn").click();
    await page.locator(".remove-vertex").last().click();
    assert.equal(await page.locator("#vertexCount").innerText(), "3");
    await page.locator("#undoBtn").click();
    assert.equal(await page.locator("#vertexCount").innerText(), "4");
    await page.locator(".remove-vertex").last().click();
    assert.equal(await page.locator("#vertexCount").innerText(), "3");
    await clickAt(expected[3].x + 10, expected[3].y);
    assert.equal(await page.locator("#vertexCount").innerText(), "4");
    await page.locator("#clearBtn").click();
    assert.equal(await page.locator("#vertexCount").innerText(), "0");
    await page.locator("#undoBtn").click();
    assert.equal(await page.locator("#vertexCount").innerText(), "4");
    await page.locator("#clearBtn").click();
    await page.setViewportSize({ width: 1440, height: 1080 });
    for (const i of [0, 2, 1]) await clickAt(expected[i].x, expected[i].y);
    await clickAt(expected[3].x, expected[3].y);
    assert.equal(await page.locator("#vertexCount").innerText(), "3");
    assert.match(await page.locator("#status").innerText(), /пересекает/);
    // Removing a single item reopens the boundary.
    await page.locator(".remove-vertex").first().click();
    assert.equal(await page.locator("#vertexCount").innerText(), "2");
    await page.locator(".settings summary").click();
    await page.locator("#dictionarySelect").selectOption("ARUCO_ORIGINAL");
    assert.equal(await page.locator("#vertexCount").innerText(), "0");
    await page.evaluate(() => { globalThis.testTrack = document.getElementById("cameraVideo").srcObject.getVideoTracks()[0]; });
    await page.locator("#stopCameraBtn").click();
    assert.equal(await page.evaluate(() => globalThis.testTrack.readyState), "ended");
    assert(await page.locator("#scene").isVisible());
    await page.locator("#logoutBtn").click();
    await page.waitForURL("**/login.html");
    // Permission refusal is actionable and allows retry without a broken promise.
    await page.addInitScript(() => {
      localStorage.setItem("app_users_v1", JSON.stringify({ camera_test: { name: "Camera test", role: "operator", passHash: "a".repeat(64) } }));
      localStorage.setItem("app_session_v1", JSON.stringify({ login: "camera_test" }));
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("Denied", "NotAllowedError"); };
    });
    await page.goto(base + "/polygon.html");
    await page.locator("#startCameraBtn").click();
    await page.waitForFunction(() => document.getElementById("status").classList.contains("error"));
    assert.match(await page.locator("#status").innerText(), /Доступ к камере запрещён/);
    assert(await page.locator("#startCameraBtn").isEnabled());
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log("PASS (" + (localFiles ? "file://" : blockedWorker ? "blocked worker" : failedWorker ? "failed worker" : "HTTP worker") + "): welcome has exactly two sections; simulated camera, click-to-find, perspective centres, polygon closure/validation, deletion/undo, responsive coordinates, PNG/JSON export, camera cleanup, login and permission refusal. No external requests or JavaScript errors.");
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
