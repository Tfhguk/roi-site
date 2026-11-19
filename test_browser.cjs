const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");

async function main() {
  const root = __dirname;
  const siteRoot = process.argv.includes("--dist") ? path.join(root, "dist") : root;
  const basePath = process.argv.includes("--subpath") ? "/roi-site" : "";
  const output = path.join(root, "test-output");
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((request, response) => {
    let pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    if (basePath && !pathname.startsWith(basePath + "/")) { response.writeHead(404); response.end(); return; }
    pathname = pathname.slice(basePath.length);
    const file = path.resolve(siteRoot, "." + pathname);
    if (!file.startsWith(siteRoot + path.sep)) { response.writeHead(403); response.end(); return; }
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png" };
    fs.readFile(file, (error, data) => {
      response.writeHead(error ? 404 : 200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
      response.end(error ? "Not found" : data);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || "msedge", headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, acceptDownloads: true });
    const external = [];
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.protocol.startsWith("http") && url.hostname !== "127.0.0.1") {
        external.push(url.href); return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const dialogs = [];
    page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    const base = "http://127.0.0.1:" + server.address().port + basePath;
    await page.goto(base + "/markers.html");
    await page.waitForURL("**/login.html");
    // Submit immediately: initialization must finish before the lookup.
    await page.locator("#loginUser").fill("admin");
    await page.locator("#loginPass").fill("admin123");
    await page.locator('#loginForm button[type="submit"]').click();
    await page.waitForURL("**/welcome.html");
    assert.match(await page.locator("#helloName").innerText(), /Администратор/);
    await page.locator('a[href="markers.html"]').click();
    await page.locator("#newFileBtn").click();
    await page.locator("#markerContainer svg").waitFor();
    assert.equal(await page.locator("#fileId").inputValue(), "0");
    assert.equal(await page.locator("#markerContainer svg").getAttribute("viewBox"), "0 0 8 8");
    await page.locator("#markerContainer svg").screenshot({ path: path.join(output, "browser-marker-0.png") });
    for (const invalid of ["50", "-1", "1.5", ""]) {
      await page.locator("#fileId").fill(invalid);
      assert.equal(await page.locator("#markerContainer svg").count(), 0);
      const before = dialogs.length;
      await page.locator("#saveBtn").click();
      assert.equal(dialogs.length, before + 1);
    }
    await page.locator("#fileId").fill("49");
    await page.locator("#markerContainer svg").waitFor();
    await page.locator("#markerContainer svg").screenshot({ path: path.join(output, "browser-marker-49.png") });
    await page.locator("#fileTitle").fill('<img src=x onerror="throw 123"> Бульдозер');
    await page.locator("#saveBtn").click();
    await page.locator("#editorModal").waitFor({ state: "hidden" });
    assert.equal(await page.locator(".file-card").count(), 1);
    assert.equal(await page.locator(".info h3 img").count(), 0);
    await page.reload();
    assert.equal(await page.locator(".file-card .thumb img").evaluate(img => img.complete && img.naturalWidth > 0), true);
    await page.locator("#newFileBtn").click();
    await page.locator("#fileId").fill("49");
    const duplicatesBefore = dialogs.length;
    await page.locator("#saveBtn").click();
    assert.equal(dialogs.length, duplicatesBefore + 1);
    assert.equal(await page.locator(".file-card").count(), 1);
    await page.locator("#fileDictionary").selectOption("ARUCO_ORIGINAL");
    await page.locator("#fileId").fill("1023");
    assert.equal(await page.locator("#markerContainer svg").getAttribute("viewBox"), "0 0 9 9");
    await page.locator("#saveBtn").click();
    await page.locator("#editorModal").waitFor({ state: "hidden" });
    assert.equal(await page.locator(".file-card").count(), 2);
    const svgDownload = page.waitForEvent("download");
    await page.locator("[data-download]").last().click();
    const svg = await svgDownload;
    await svg.saveAs(path.join(output, "marker-49.svg"));
    assert.match(fs.readFileSync(path.join(output, "marker-49.svg"), "utf8"), /viewBox="0 0 8 8"/);

    // Keep untagged legacy IDs, normalize numeric record IDs, and prune stale selection.
    await page.evaluate(() => {
      const files = JSON.parse(localStorage.getItem("app_files_v1"));
      files.push({ id: 123, markerId: 600, title: "Legacy", tech: "dump", author: "Test", created: new Date().toISOString() });
      localStorage.setItem("app_files_v1", JSON.stringify(files));
      localStorage.setItem("app_selected_v1", JSON.stringify([123, "missing"]));
    });
    await page.reload();
    assert.equal(await page.locator(".file-card").count(), 3);
    assert.equal(await page.locator("#selCounter").innerText(), "Выбрано: 1");
    await page.locator("#techFilter").selectOption("dump");
    assert.equal(await page.locator(".file-card").count(), 1);
    await page.locator("#selectAllBtn").click();
    await page.locator("#clearSelBtn").click();
    assert.equal(await page.locator("#downloadTableBtn").isDisabled(), true);
    await page.locator("[data-delete]").click();
    assert.equal(await page.locator(".file-card").count(), 0);
    await page.locator("#techFilter").selectOption("");
    assert.equal(await page.locator(".file-card").count(), 2);

    await page.locator("#selectAllBtn").click();
    const mixedDownload = page.waitForEvent("download");
    await page.locator("#downloadTableBtn").click();
    await (await mixedDownload).saveAs(path.join(output, "mixed-markers.pdf"));

    await page.evaluate(() => {
      const files = Array.from({ length: 50 }, (_, markerId) => ({
        id: "test_" + markerId, markerId, dictionary: "DICT_4X4_50", title: "Test " + markerId,
        tech: "bulldozer", author: "Test", created: new Date().toISOString()
      }));
      localStorage.setItem("app_files_v1", JSON.stringify(files));
    });
    await page.reload();
    await page.locator("#selectAllBtn").click();
    assert.equal(await page.locator("#selCounter").innerText(), "Выбрано: 50");
    const pdfDownload = page.waitForEvent("download");
    await page.locator("#downloadTableBtn").click();
    const pdf = await pdfDownload;
    const pdfPath = path.join(output, "all-50-markers.pdf");
    await pdf.saveAs(pdfPath);
    const bytes = fs.readFileSync(pdfPath);
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    const contents = bytes.toString("latin1");
    assert.equal((contents.match(/\/Type \/Page\b/g) || []).length, 9);
    for (let id = 0; id < 50; id++) assert(contents.includes("DICT_4X4_50 / ID " + id + ")"), "Missing PDF marker " + id);
    await page.locator("#clearSelBtn").click();
    await page.screenshot({ path: path.join(output, "markers-desktop.png"), fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#newFileBtn").click();
    await page.locator("#fileId").fill("7");
    await page.locator("#markerContainer svg").waitFor();
    const markerBounds = await page.locator("#markerContainer svg").boundingBox();
    const wrapperBounds = await page.locator(".canvas-wrap").boundingBox();
    assert(markerBounds.x >= wrapperBounds.x && markerBounds.x + markerBounds.width <= wrapperBounds.x + wrapperBounds.width);
    await page.screenshot({ path: path.join(output, "markers-mobile.png"), fullPage: false });
    await page.locator("#markerContainer svg").screenshot({ path: path.join(output, "browser-mobile-marker-7.png") });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.keyboard.press("Escape");
    await page.locator("#logoutBtn").click();
    await page.waitForURL("**/login.html");
    // A prototype property is a valid ordinary login, never an inherited account.
    await page.locator("#tabRegister").click();
    await page.locator("#regLogin").fill("constructor");
    await page.locator("#regName").fill("Тестовый пользователь");
    await page.locator("#regPass").fill("secret123");
    await page.locator("#regPass2").fill("secret123");
    await page.locator('#registerForm button[type="submit"]').click();
    await page.waitForURL("**/welcome.html");
    assert.equal(await page.locator("#helloName").innerText(), "Тестовый пользователь");
    // Missing names and forged role fields cannot crash welcome or override the account role.
    await page.evaluate(() => {
      const users = JSON.parse(localStorage.getItem("app_users_v1"));
      users.constructor.name = null;
      localStorage.setItem("app_users_v1", JSON.stringify(users));
      localStorage.setItem("app_session_v1", JSON.stringify({ login: "constructor", role: "admin" }));
    });
    await page.reload();
    assert.equal(await page.locator("#helloName").innerText(), "constructor");
    assert.equal(await page.locator("#userRole").innerText(), "operator");
    await page.evaluate(() => localStorage.setItem("app_session_v1", '{"login":"missing"}'));
    await page.reload();
    await page.waitForURL("**/login.html");
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    require("node:child_process").execFileSync("python", [path.join(root, "verify_browser_output.py")], { stdio: "inherit", cwd: root });
    console.log("PASS: browser login/registration, ID validation, SVG display/download, persistence, legacy markers, filtering, selection, deletion, mobile layout, and 50-marker PDF (9 pages, 2 columns). No external requests or JavaScript errors.");
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
