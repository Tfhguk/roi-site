(() => {
  "use strict";
  const video = document.getElementById("camVideo");
  const canvas = document.getElementById("camCanvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const offscreen = document.createElement("canvas");
  const offCtx = offscreen.getContext("2d", { willReadFrequently: true });
  const boostCanvas = document.createElement("canvas");
  const boostCtx = boostCanvas.getContext("2d", { willReadFrequently: true });
  const depthSampleCanvas = document.createElement("canvas");
  const depthSampleCtx = depthSampleCanvas.getContext("2d", { willReadFrequently: true });

  if (video) {
    video.style.cssText =
      "position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;display:block;";
  }

  const ZONE_COLORS = {
    transport: "#38bdf8",
    mining: "#f59e0b",
    warehouse: "#a855f7",
    charging: "#22c55e"
  };
  const ZONE_LABELS = {
    transport: "Зона транспортировки",
    mining: "Зона добычи",
    warehouse: "Склад",
    charging: "Зарядная станция"
  };

  const ARENA_WIDTH_M = 2.0;

  let mode = "polygon";
  let polygon = { points: [], closed: false };
  let zones = [];
  let zoneDraft = { kind: "transport", points: [] };
  let detectedMarkers = [];
  let detectedRobots = [];
  let hoveredMarkerId = null;
  let activeRobotId = null;
  let manualTakeover = false;
  let loopRunning = false;
  let detectorErrorShown = false;

  // Depth preview state (ARproject / depth_http_preview.py)
  const depthState = {
    connected: false,
    url: "http://localhost:8765",
    calibrated: false,
    stage: "disconnected",
    projectionRevision: null,
    settingsRevision: 0,
    projectionWidth: 1280,
    projectionHeight: 800,
    lastSnapshotId: -1,
    pollingTimer: null,
    busy: false,
    elevationGrid: null
  };

  const $ = id => document.getElementById(id);

  function setStatus(text, type = "") {
    const el = $("syncStatus");
    if (!el) return;
    el.textContent = text;
    el.className = "badge " + type;
  }

  // --- Tabs switching ---
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.onclick = () => {
      const target = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b === btn));
      $("tabCamera").classList.toggle("active", target === "camera");
      $("tabDepth").classList.toggle("active", target === "depth");
      if (target === "depth" && !depthState.pollingTimer) {
        startDepthPolling();
      }
    };
  });

  function updateModeButtons() {
    const polyBtn = $("stepPolyBtn");
    if (polyBtn) {
      polyBtn.classList.toggle("primary", mode === "polygon");
    }
  }

  function isInsidePolygon(pt, poly) {
    if (window.SetupGeometry && typeof window.SetupGeometry.inside === "function") {
      return window.SetupGeometry.inside(pt, poly);
    }
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
        (pt.x < ((xj - xi) * (pt.y - yi)) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function triggerManualTakeover(reason) {
    manualTakeover = true;
    $("manualReason").textContent = reason;
    $("manualPanel").classList.add("active");
    setStatus("Ручное управление: " + reason, "warn");
  }

  async function initCameras(preferredId = "") {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === "videoinput");
    const sel = $("cameraSelect");
    const current = preferredId || sel.value;
    sel.innerHTML = "";
    cams.forEach((c, i) => {
      const opt = document.createElement("option");
      opt.value = c.deviceId;
      opt.textContent = c.label || `Камера ${i + 1}`;
      sel.append(opt);
    });
    if (current && cams.some(c => c.deviceId === current)) {
      sel.value = current;
    }
  }

  async function openStream(deviceId) {
    const attempts = [];
    if (deviceId) {
      attempts.push({
        video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
    }
    attempts.push(
      { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: true, audio: false }
    );

    let lastError = null;
    for (const constraints of attempts) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error("Не удалось открыть видеопоток");
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("Браузер заблокировал камеру (нужен HTTPS или localhost)", "warn");
      return;
    }
    try {
      setStatus("Подключение камеры...");
      if (video.srcObject) {
        video.srcObject.getTracks().forEach(t => t.stop());
        video.srcObject = null;
      }
      const selectedId = $("cameraSelect").value;
      const stream = await openStream(selectedId);
      video.srcObject = stream;
      await video.play();

      if (!video.videoWidth) {
        await new Promise(resolve => {
          const done = () => resolve();
          video.addEventListener("loadedmetadata", done, { once: true });
          setTimeout(done, 1000);
        });
      }

      const activeTrack = stream.getVideoTracks()[0];
      const activeDeviceId = activeTrack?.getSettings?.().deviceId || selectedId;
      await initCameras(activeDeviceId);

      detectorErrorShown = false;
      setStatus(`Камера активна (${video.videoWidth || 1280}×${video.videoHeight || 720})`, "ok");

      if (!loopRunning) {
        loopRunning = true;
        requestAnimationFrame(loop);
      }
    } catch (err) {
      const msg = err?.name === "NotReadableError"
        ? "Камера занята другой программой (закройте aruco-tracker.py)"
        : (err?.message || err?.name || "ошибка доступа");
      setStatus("Ошибка камеры: " + msg, "warn");
    }
  }

  function usedMarkerIds() {
    const ids = new Set(polygon.points.map(p => p.markerId));
    for (const z of zones) z.points.forEach(p => ids.add(p.markerId));
    zoneDraft.points.forEach(p => ids.add(p.markerId));
    return ids;
  }

  function runArucoPass(imgData, dictMode) {
    const dicts = dictMode === "AUTO"
      ? [ArucoMarker.DEFAULT_DICTIONARY, ArucoMarker.LEGACY_DICTIONARY]
      : [dictMode];

    const byId = new Map();
    for (const dictName of dicts) {
      const detector = MarkerDetection.getDetector(dictName);
      const found = detector.detect(imgData) || [];
      for (const m of found) {
        if (!byId.has(m.id)) {
          byId.set(m.id, { ...m, dictionary: dictName });
        }
      }
      if (dictMode === "AUTO" && byId.size > 0) break;
    }
    return [...byId.values()];
  }

  function detectFrame(w, h) {
    offCtx.drawImage(video, 0, 0, w, h);
    let imgData = offCtx.getImageData(0, 0, w, h);

    if (!window.AR || !window.MarkerDetection || !window.ArucoMarker) {
      throw new Error("Не подключены скрипты js-aruco2 (cv.js / aruco.js)");
    }

    const dictMode = $("dictSelect")?.value || "AUTO";
    let raw = runArucoPass(imgData, dictMode);

    // Fallback high-contrast pass for dim/low-contrast webcams
    if (raw.length === 0) {
      if (boostCanvas.width !== w || boostCanvas.height !== h) {
        boostCanvas.width = w;
        boostCanvas.height = h;
      }
      boostCtx.save();
      boostCtx.filter = "contrast(1.45) brightness(1.06)";
      boostCtx.drawImage(video, 0, 0, w, h);
      boostCtx.restore();
      raw = runArucoPass(boostCtx.getImageData(0, 0, w, h), dictMode);
    }

    const countBadge = $("markerDetectCount");
    if (countBadge) {
      countBadge.textContent = `Маркеров в кадре: ${raw.length}`;
      countBadge.className = "badge " + (raw.length > 0 ? "ok" : "");
    }

    const scaleM = ARENA_WIDTH_M / w;
    detectedMarkers = raw.map(m => {
      const cx = m.corners.reduce((s, p) => s + p.x, 0) / 4;
      const cy = m.corners.reduce((s, p) => s + p.y, 0) / 4;
      const dx = m.corners[1].x - m.corners[0].x;
      const dy = m.corners[1].y - m.corners[0].y;
      const heading = Math.atan2(dy, dx);
      const radiusPx = Math.max(
        28,
        Math.hypot(m.corners[2].x - m.corners[0].x, m.corners[2].y - m.corners[0].y) * 0.65
      );
      return {
        id: m.id,
        dictionary: m.dictionary,
        cx,
        cy,
        radiusPx,
        xM: cx * scaleM,
        yM: cy * scaleM,
        normX: (cx / w) * 1000,
        normY: (cy / h) * 700,
        heading,
        corners: m.corners
      };
    });

    const byId = new Map(detectedMarkers.map(m => [m.id, m]));
    for (const p of polygon.points) {
      const m = byId.get(p.markerId);
      if (m) { p.cx = m.cx; p.cy = m.cy; p.xM = m.xM; p.yM = m.yM; p.normX = m.normX; p.normY = m.normY; }
    }
    for (const z of zones) {
      for (const p of z.points) {
        const m = byId.get(p.markerId);
        if (m) { p.cx = m.cx; p.cy = m.cy; p.xM = m.xM; p.yM = m.yM; p.normX = m.normX; p.normY = m.normY; }
      }
    }

    const reserved = usedMarkerIds();
    detectedRobots = detectedMarkers
      .filter(m => !reserved.has(m.id))
      .map(m => ({
        marker_id: m.id,
        x: Math.round(m.xM * 10000) / 10000,
        y: Math.round(m.yM * 10000) / 10000,
        heading: Math.round(m.heading * 10000) / 10000,
        cx: m.cx,
        cy: m.cy,
        normX: m.normX,
        normY: m.normY
      }));

    updateRobotsUI();
    checkSafetyOnClient();
  }

  function checkSafetyOnClient() {
    if (!polygon.closed || manualTakeover) return;
    const transportZones = zones.filter(z => z.kind === "transport" && z.points.length >= 3);
    if (!transportZones.length) return;

    for (const r of detectedRobots) {
      const insideTransport = transportZones.some(z =>
        isInsidePolygon({ x: r.normX, y: r.normY }, z.points.map(p => ({ x: p.normX, y: p.normY })))
      );
      if (!insideTransport) {
        fetch("/robot-api/stop-all", { method: "POST" }).catch(() => {});
        triggerManualTakeover(`Робот (ID ${r.marker_id}) выехал за транспортную зону!`);
        return;
      }
    }
  }

  function drawScene() {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    if (polygon.points.length) {
      ctx.save();
      ctx.beginPath();
      polygon.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.cx, p.cy) : ctx.lineTo(p.cx, p.cy)));
      if (polygon.closed) ctx.closePath();
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 3;
      ctx.stroke();
      if (polygon.closed) {
        ctx.fillStyle = "rgba(56, 189, 248, 0.14)";
        ctx.fill();
      }
      polygon.points.forEach((p, idx) => {
        ctx.beginPath();
        ctx.arc(p.cx, p.cy, 7, 0, Math.PI * 2);
        ctx.fillStyle = "#38bdf8";
        ctx.fill();
        ctx.fillStyle = "#0f172a";
        ctx.font = "bold 10px sans-serif";
        ctx.fillText(String(idx + 1), p.cx - 3, p.cy + 3.5);
      });
      ctx.restore();
    }

    for (const z of zones) {
      const color = ZONE_COLORS[z.kind] || "#fff";
      ctx.save();
      if (z.kind === "charging") {
        const p = z.points[0];
        ctx.beginPath();
        ctx.arc(p.cx, p.cy, 16, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.fillStyle = "#000";
        ctx.font = "bold 12px sans-serif";
        ctx.fillText("⚡", p.cx - 6, p.cy + 4);
      } else if (z.points.length >= 3) {
        ctx.beginPath();
        z.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.cx, p.cy) : ctx.lineTo(p.cx, p.cy)));
        ctx.closePath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.fillStyle = color + "33";
        ctx.fill();
      }
      ctx.restore();
    }

    if (zoneDraft.points.length) {
      const color = ZONE_COLORS[zoneDraft.kind];
      ctx.save();
      ctx.beginPath();
      zoneDraft.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.cx, p.cy) : ctx.lineTo(p.cx, p.cy)));
      ctx.strokeStyle = color;
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.restore();
    }

    const reserved = usedMarkerIds();
    for (const m of detectedMarkers) {
      const isRobot = polygon.closed && !reserved.has(m.id);
      const isHovered = hoveredMarkerId === m.id;
      ctx.save();
      ctx.beginPath();
      m.corners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
      ctx.closePath();
      ctx.strokeStyle = isHovered ? "#38bdf8" : (isRobot ? "#22c55e" : "#facc15");
      ctx.lineWidth = isHovered ? 4 : 3;
      ctx.stroke();

      if (isHovered) {
        ctx.beginPath();
        ctx.arc(m.cx, m.cy, m.radiusPx, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(56, 189, 248, 0.7)";
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (isRobot) {
        const len = 42;
        ctx.beginPath();
        ctx.moveTo(m.cx, m.cy);
        ctx.lineTo(m.cx + Math.cos(m.heading) * len, m.cy + Math.sin(m.heading) * len);
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      ctx.fillStyle = "rgba(15, 23, 42, 0.88)";
      ctx.fillRect(m.cx - 32, m.cy - 28, 64, 19);
      ctx.fillStyle = isHovered ? "#38bdf8" : (isRobot ? "#4ade80" : "#fde047");
      ctx.font = "bold 12px monospace";
      ctx.fillText((isRobot ? "🤖#" : "ID ") + m.id, m.cx - 27, m.cy - 14);
      ctx.restore();
    }
  }

  function loop() {
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        offscreen.width = w;
        offscreen.height = h;
      }
      try {
        detectFrame(w, h);
        if (detectorErrorShown) {
          detectorErrorShown = false;
          setStatus(`Камера активна (${w}×${h})`, "ok");
        }
      } catch (err) {
        if (!detectorErrorShown) {
          detectorErrorShown = true;
          setStatus("Видео работает, ошибка ArUco: " + (err?.message || err), "warn");
        }
      }
      drawScene();
    }
    requestAnimationFrame(loop);
  }

  function findMarkerAtEvent(e) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clickX = (e.clientX - rect.left) * scaleX;
    const clickY = (e.clientY - rect.top) * scaleY;

    let hit = null;
    let bestDist = Infinity;
    for (const m of detectedMarkers) {
      const d = Math.hypot(m.cx - clickX, m.cy - clickY);
      const limit = Math.max(55, m.radiusPx || 45);
      if (d <= limit && d < bestDist) {
        bestDist = d;
        hit = m;
      }
    }
    return hit;
  }

  canvas.addEventListener("mousemove", e => {
    const hit = findMarkerAtEvent(e);
    hoveredMarkerId = hit ? hit.id : null;
    canvas.style.cursor = hit ? "pointer" : "crosshair";
  });

  canvas.addEventListener("mouseleave", () => {
    hoveredMarkerId = null;
  });

  canvas.addEventListener("click", e => {
    const hit = findMarkerAtEvent(e);
    if (!hit) return;

    const pt = {
      markerId: hit.id,
      cx: hit.cx,
      cy: hit.cy,
      xM: hit.xM,
      yM: hit.yM,
      normX: hit.normX,
      normY: hit.normY
    };

    if (mode === "polygon" && !polygon.closed) {
      if (polygon.points.some(p => p.markerId === hit.id)) return;
      polygon.points.push(pt);
      $("polyInfo").textContent = `Вершин: ${polygon.points.length} (ID: ${polygon.points.map(p => p.markerId).join(", ")})`;
      $("closePolyBtn").disabled = polygon.points.length < 3;
    } else if (mode === "zones" && polygon.closed) {
      const kind = $("zoneKindSelect").value;
      zoneDraft.kind = kind;
      if (kind === "charging") {
        zones = zones.filter(z => z.kind !== "charging");
        zones.push({ kind: "charging", name: ZONE_LABELS.charging, points: [pt] });
        zoneDraft = { kind, points: [] };
        renderZonesList();
        syncToLocalServer();
      } else {
        if (zoneDraft.points.some(p => p.markerId === hit.id)) return;
        zoneDraft.points.push(pt);
        $("zoneDraftInfo").textContent = `${ZONE_LABELS[kind]}: выбрано вершин ${zoneDraft.points.length}`;
        $("closeZoneBtn").disabled = zoneDraft.points.length < 3;
        $("clearZoneDraftBtn").disabled = false;
      }
    }
  });

  if ($("stepPolyBtn")) {
    $("stepPolyBtn").onclick = () => {
      mode = "polygon";
      if (polygon.closed) {
        polygon.closed = false;
        $("closePolyBtn").disabled = polygon.points.length < 3;
        $("zoneKindSelect").disabled = true;
      }
      updateModeButtons();
      $("polyInfo").textContent = polygon.points.length
        ? `Выбор вершин: ${polygon.points.length} (ID: ${polygon.points.map(p => p.markerId).join(", ")})`
        : "Нажимайте на подсвеченные ArUco-маркеры на видео";
    };
  }

  $("closePolyBtn").onclick = () => {
    if (polygon.points.length < 3) return;
    polygon.closed = true;
    mode = "zones";
    updateModeButtons();
    $("polyInfo").textContent = `Полигон замкнут (${polygon.points.length} вершин)`;
    $("closePolyBtn").disabled = true;
    $("zoneKindSelect").disabled = false;
    $("zoneDraftInfo").textContent = "Выберите тип зоны и нажимайте на ArUco-маркеры.";
    $("startMissionBtn").disabled = false;
    syncToLocalServer();
    if (depthState.connected) applyDepthSettings();
  };

  $("clearPolyBtn").onclick = () => {
    polygon = { points: [], closed: false };
    zones = [];
    zoneDraft = { kind: "transport", points: [] };
    mode = "polygon";
    updateModeButtons();
    $("polyInfo").textContent = "Вершин: 0 (не замкнут)";
    $("closePolyBtn").disabled = true;
    $("zoneKindSelect").disabled = true;
    $("closeZoneBtn").disabled = true;
    $("startMissionBtn").disabled = true;
    renderZonesList();
  };

  $("closeZoneBtn").onclick = () => {
    if (zoneDraft.points.length < 3) return;
    zones.push({
      kind: zoneDraft.kind,
      name: ZONE_LABELS[zoneDraft.kind],
      points: [...zoneDraft.points]
    });
    zoneDraft = { kind: $("zoneKindSelect").value, points: [] };
    $("closeZoneBtn").disabled = true;
    $("clearZoneDraftBtn").disabled = true;
    $("zoneDraftInfo").textContent = "Зона сохранена. Можно добавить следующую.";
    renderZonesList();
    syncToLocalServer();
  };

  $("clearZoneDraftBtn").onclick = () => {
    zoneDraft.points = [];
    $("closeZoneBtn").disabled = true;
    $("clearZoneDraftBtn").disabled = true;
  };

  function renderZonesList() {
    $("zonesList").innerHTML = zones.map(z =>
      `<div>• <strong>${z.name}</strong> (${z.points.length} т., ID: ${z.points.map(p => p.markerId).join(",")})</div>`
    ).join("");
  }

  function updateRobotsUI() {
    if (!polygon.closed) return;
    if (!detectedRobots.length) {
      $("robotsList").textContent = "Свободные ArUco-маркеры машин не обнаружены.";
      return;
    }
    $("robotsList").innerHTML = detectedRobots.map(r =>
      `<div>🤖 Маркер <strong>#${r.marker_id}</strong>: X=${r.x.toFixed(2)}м, Y=${r.y.toFixed(2)}м, курс=${Math.round(r.heading * 180 / Math.PI)}°</div>`
    ).join("");
  }

  // --- Depth Preview Integration (ARproject / depth_http_preview.py) ---
  function normalizeDepthBaseUrl() {
    const raw = ($("depthUrlInput")?.value || "http://localhost:8765").trim().replace(/\/+$/, "");
    depthState.url = raw || "http://localhost:8765";
    return depthState.url;
  }

  function sampleElevationFromDepthImage(img) {
    if (!img || !img.naturalWidth || !img.naturalHeight) return null;
    const cols = 16;
    const rows = 12;
    depthSampleCanvas.width = cols;
    depthSampleCanvas.height = rows;
    depthSampleCtx.drawImage(img, 0, 0, cols, rows);
    const data = depthSampleCtx.getImageData(0, 0, cols, rows).data;
    const maxH = Number($("depthMaxHeight")?.value || 0.5) || 0.5;
    const grid = [];
    let validSamples = 0;

    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        const idx = (r * cols + c) * 4;
        const red = data[idx];
        const green = data[idx + 1];
        const blue = data[idx + 2];
        // Black pixels represent invalid/above-range depth in rendering.py
        if (red + green + blue < 18) {
          row.push(null);
        } else {
          validSamples++;
          // Approximate Turbo colormap height estimate (warm red/yellow = higher)
          const normalized = Math.max(0, Math.min(1, (red - blue + 255) / 510));
          row.push(Math.round(normalized * maxH * 1000) / 1000);
        }
      }
      grid.push(row);
    }

    depthState.elevationGrid = { cols, rows, maxHeightM: maxH, validSamples, grid };
    if ($("depthRouteSummary")) {
      $("depthRouteSummary").textContent =
        `Сетка рельефа ${cols}×${rows}: валидных ячеек ${validSamples}/${cols * rows} (диапазон 0.00–${maxH.toFixed(2)} м). Передаётся в /robot-api/vision-sync.`;
    }
    return depthState.elevationGrid;
  }

  async function pollDepthOnce() {
    if (depthState.busy) return;
    depthState.busy = true;
    const baseUrl = normalizeDepthBaseUrl();
    try {
      let stateData = null;
      const stateRes = await fetch(baseUrl + "/api/v1/state", { cache: "no-store" });
      if (stateRes.ok) {
        stateData = await stateRes.json();
      } else {
        const statusRes = await fetch(baseUrl + "/status", { cache: "no-store" });
        if (!statusRes.ok) throw new Error("HTTP " + statusRes.status);
        const st = await statusRes.json();
        stateData = {
          stage: st.calibrated ? "ready" : "stereo_required",
          projection: { width: 1280, height: 800, calibration_3d_accepted: Boolean(st.calibrated) },
          snapshot: st.frame_ready ? { id: Date.now() } : null,
          metrics: {}
        };
      }

      depthState.connected = true;
      depthState.projectionRevision = stateData.projection_revision || depthState.projectionRevision;
      depthState.settingsRevision = Number(stateData.settings_revision || 0);
      if (stateData.projection) {
        depthState.projectionWidth = stateData.projection.width || 1280;
        depthState.projectionHeight = stateData.projection.height || 800;
        depthState.calibrated = Boolean(stateData.projection.calibration_3d_accepted) || stateData.stage === "ready";
        if ($("depthProjSize")) {
          $("depthProjSize").value = `${depthState.projectionWidth}×${depthState.projectionHeight}`;
        }
      }
      depthState.stage = stateData.stage || "unknown";

      const badge = $("depthStatusBadge");
      if (badge) {
        badge.textContent = depthState.calibrated ? "Подключено · метрическая глубина" : "Подключено · disparity / калибровка";
        badge.className = "badge ok";
      }
      if ($("depthStageBadge")) {
        $("depthStageBadge").textContent = "Стадия: " + depthState.stage;
      }
      const m = stateData.metrics || {};
      if ($("depthMetricsText")) {
        const meas = typeof m.measured_fraction === "number" ? Math.round(m.measured_fraction * 100) + "%" : "—";
        const fill = typeof m.filled_fraction === "number" ? Math.round(m.filled_fraction * 100) + "%" : "—";
        $("depthMetricsText").textContent =
          `Кадров: ${m.update_count ?? "—"} · Измерено: ${meas} · Заполнено: ${fill}`;
      }

      if (stateData.snapshot) {
        const img = $("depthPreviewImg");
        const endpoint = stateData.projection_revision ? "/api/v1/preview.jpg" : "/frame.jpg";
        img.onload = () => {
          img.classList.add("visible");
          if ($("depthPlaceholder")) $("depthPlaceholder").style.display = "none";
          sampleElevationFromDepthImage(img);
        };
        img.src = `${baseUrl}${endpoint}?t=${Date.now()}`;
      }
    } catch {
      depthState.connected = false;
      const badge = $("depthStatusBadge");
      if (badge) {
        badge.textContent = "Нет связи с depth_http_preview.py";
        badge.className = "badge warn";
      }
    } finally {
      depthState.busy = false;
    }
  }

  function startDepthPolling() {
    if (depthState.pollingTimer) clearInterval(depthState.pollingTimer);
    pollDepthOnce();
    depthState.pollingTimer = setInterval(pollDepthOnce, 1000);
  }

  async function applyDepthSettings() {
    const baseUrl = normalizeDepthBaseUrl();
    const maxH = Math.min(0.5, Math.max(0.05, Number($("depthMaxHeight")?.value || 0.5)));
    const gamma = Math.min(3.0, Math.max(0.1, Number($("depthGamma")?.value || 0.5)));
    const interval = Math.min(10, Math.max(0.5, Number($("depthInterval")?.value || 1.0)));

    if ($("turboMaxLabel")) $("turboMaxLabel").textContent = `${maxH.toFixed(2)} м (ниже / пол)`;

    const w = canvas.width || 1280;
    const h = canvas.height || 720;
    const vertices = polygon.closed && polygon.points.length >= 3
      ? polygon.points.map(p => [
          Math.max(0, Math.min(1, Number((p.cx / w).toFixed(4)))),
          Math.max(0, Math.min(1, Number((p.cy / h).toFixed(4))))
        ])
      : [[0, 0], [1, 0], [1, 1], [0, 1]];

    try {
      const res = await fetch(baseUrl + "/api/v1/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "roi-web-" + Date.now(),
          schema_version: 1,
          projection_revision: depthState.projectionRevision,
          expected_settings_revision: depthState.settingsRevision,
          height_range_m: [0.0, maxH],
          above_range: "black",
          palette_gamma: gamma,
          update_interval_s: interval,
          roi: {
            coordinate_space: "projector_normalized",
            vertices
          }
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        depthState.settingsRevision = data.settings_revision ?? depthState.settingsRevision + 1;
        if ($("depthActionMsg")) {
          $("depthActionMsg").textContent = `Настройки и ROI (${vertices.length} т.) применены (rev ${depthState.settingsRevision}).`;
        }
      } else if ($("depthActionMsg")) {
        $("depthActionMsg").textContent = data.error?.message || "Сервер глубины отклонил настройки.";
      }
    } catch {
      if ($("depthActionMsg")) $("depthActionMsg").textContent = "Ошибка отправки настроек на сервер глубины.";
    }
  }

  async function triggerDepthRescan() {
    const baseUrl = normalizeDepthBaseUrl();
    try {
      const res = await fetch(baseUrl + "/api/v1/actions/rescan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: "rescan-" + Date.now(),
          projection_revision: depthState.projectionRevision
        })
      });
      const data = await res.json().catch(() => ({}));
      if ($("depthActionMsg")) {
        $("depthActionMsg").textContent = res.ok
          ? "Команда пересканирования отправлена."
          : (data.error?.message || "Не удалось выполнить rescan.");
      }
    } catch {
      if ($("depthActionMsg")) $("depthActionMsg").textContent = "Нет связи с сервером глубины.";
    }
  }

  if ($("depthConnectBtn")) $("depthConnectBtn").onclick = startDepthPolling;
  if ($("depthApplySettingsBtn")) $("depthApplySettingsBtn").onclick = applyDepthSettings;
  if ($("depthRescanBtn")) $("depthRescanBtn").onclick = triggerDepthRescan;

  async function syncToLocalServer() {
    if (!polygon.closed) return;
    const payload = {
      polygon: polygon.points.map(p => ({ x: p.xM, y: p.yM, marker_id: p.markerId })),
      zones: zones.map(z => ({
        kind: z.kind,
        name: z.name,
        points: z.points.map(p => ({ x: p.xM, y: p.yM, marker_id: p.markerId }))
      })),
      robots: detectedRobots.map(r => ({
        marker_id: r.marker_id,
        x: r.x,
        y: r.y,
        heading: r.heading
      })),
      depth: {
        connected: depthState.connected,
        url: depthState.url,
        calibrated: depthState.calibrated,
        stage: depthState.stage,
        elevation_grid: depthState.elevationGrid
      },
      priority: { lengthWeight: 0.5, elevationWeight: 0.5 }
    };

    try {
      const res = await fetch("/robot-api/vision-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const state = await res.json();
        if (state.active_robot_id) activeRobotId = state.active_robot_id;
        if (state.manual_required && !manualTakeover) {
          triggerManualTakeover(state.fault_message || "Локальный сервер передал управление человеку");
        } else if (!manualTakeover) {
          setStatus(`Синхронизировано (роботов: ${detectedRobots.length})`, "ok");
        }
      }
    } catch {
      setStatus("Нет связи с локальным сервером", "warn");
    }
  }

  setInterval(syncToLocalServer, 2000);

  $("startMissionBtn").onclick = async () => {
    await syncToLocalServer();
    const res = await fetch("/robot-api/auto-route/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lengthWeight: 0.5,
        elevationWeight: 0.5,
        depthUrl: depthState.connected ? depthState.url : null
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      triggerManualTakeover(data.detail || data.error || "Не удалось запустить маршрут");
    } else {
      setStatus(`Маршрут запущен (${data.waypoints || 0} точек)`, "ok");
    }
  };

  $("stopAllBtn").onclick = () => {
    fetch("/robot-api/stop-all", { method: "POST" }).catch(() => {});
    triggerManualTakeover("Остановлено оператором");
  };

  document.querySelectorAll(".dpad button").forEach(btn => {
    btn.onclick = async () => {
      const kind = btn.dataset.cmd;
      const command = kind === "stop"
        ? { kind: "stop" }
        : { kind, value: (kind === "left" || kind === "right") ? 10 : 0.03, unit: (kind === "left" || kind === "right") ? "deg" : "m" };
      await fetch("/robot-api/manual-drive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ robot_id: activeRobotId, command })
      }).catch(() => {});
    };
  });

  $("resumeAutoBtn").onclick = async () => {
    const res = await fetch("/robot-api/resume-auto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ robot_id: activeRobotId })
    });
    if (res.ok) {
      manualTakeover = false;
      $("manualPanel").classList.remove("active");
      setStatus("Автопилот восстановлен", "ok");
    }
  };

  $("startCamBtn").onclick = startCamera;
  updateModeButtons();
  initCameras().catch(() => {});
})();
