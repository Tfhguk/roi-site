(() => {
  "use strict";
  const video = document.getElementById("camVideo");
  const canvas = document.getElementById("camCanvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const offscreen = document.createElement("canvas");
  const offCtx = offscreen.getContext("2d", { willReadFrequently: true });

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
  let activeRobotId = null;
  let manualTakeover = false;
  let loopRunning = false;
  let detectorErrorShown = false;

  const $ = id => document.getElementById(id);

  function setStatus(text, type = "") {
    const el = $("syncStatus");
    if (!el) return;
    el.textContent = text;
    el.className = "badge " + type;
  }

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

  function detectFrame(w, h) {
    offCtx.drawImage(video, 0, 0, w, h);
    const imgData = offCtx.getImageData(0, 0, w, h);
    if (!window.AR || !window.MarkerDetection || !window.ArucoMarker) {
      throw new Error("Не подключены скрипты js-aruco2 (cv.js / aruco.js)");
    }
    const detector = MarkerDetection.getDetector(ArucoMarker.DEFAULT_DICTIONARY);
    const raw = detector.detect(imgData) || [];

    const scaleM = ARENA_WIDTH_M / w;
    detectedMarkers = raw.map(m => {
      const cx = m.corners.reduce((s, p) => s + p.x, 0) / 4;
      const cy = m.corners.reduce((s, p) => s + p.y, 0) / 4;
      const dx = m.corners[1].x - m.corners[0].x;
      const dy = m.corners[1].y - m.corners[0].y;
      const heading = Math.atan2(dy, dx);
      return {
        id: m.id,
        cx,
        cy,
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
        ctx.fillStyle = "rgba(56, 189, 248, 0.12)";
        ctx.fill();
      }
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
      ctx.save();
      ctx.beginPath();
      m.corners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
      ctx.closePath();
      ctx.strokeStyle = isRobot ? "#22c55e" : "#facc15";
      ctx.lineWidth = 3;
      ctx.stroke();

      if (isRobot) {
        const len = 42;
        ctx.beginPath();
        ctx.moveTo(m.cx, m.cy);
        ctx.lineTo(m.cx + Math.cos(m.heading) * len, m.cy + Math.sin(m.heading) * len);
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
      ctx.fillRect(m.cx - 28, m.cy - 26, 56, 18);
      ctx.fillStyle = isRobot ? "#4ade80" : "#fde047";
      ctx.font = "bold 12px monospace";
      ctx.fillText((isRobot ? "🤖#" : "ID ") + m.id, m.cx - 24, m.cy - 13);
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

  canvas.addEventListener("click", e => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clickX = (e.clientX - rect.left) * scaleX;
    const clickY = (e.clientY - rect.top) * scaleY;

    let hit = null;
    let bestDist = 45;
    for (const m of detectedMarkers) {
      const d = Math.hypot(m.cx - clickX, m.cy - clickY);
      if (d < bestDist) { bestDist = d; hit = m; }
    }
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
      body: JSON.stringify({ lengthWeight: 0.5, elevationWeight: 0.5 })
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
