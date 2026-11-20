(function () {
  "use strict";
  const user = AppAuth.loadSession();
  if (!user) { location.replace("login.html"); return; }
  const $ = id => document.getElementById(id);
  $("userName").textContent = user.name;
  const video = $("cameraVideo"), canvas = $("scene");
  const context = canvas.getContext("2d");
  const frame = document.createElement("canvas");
  const frameContext = frame.getContext("2d");
  let stream = null, live = false, starting = false, captured = false;
  let animation = 0, sourceVersion = 0, vertices = [], closed = false;
  let worker = null, pending = null, requestId = 0, search = null;
  let workerUnavailable = location.protocol === "file:" || typeof Worker !== "function";
  let history = [];

  function remember() {
    history.push({ vertices: vertices.slice(), closed });
    if (history.length > 100) history.shift();
  }

  function status(message, type = "") {
    $("status").textContent = message;
    $("status").className = "status" + (type ? " " + type : "");
  }
  function controls() {
    const busy = Boolean(pending);
    $("startCameraBtn").disabled = starting || Boolean(stream);
    $("startCameraBtn").textContent = starting ? "Подключение…" : "Включить камеру";
    $("stopCameraBtn").disabled = !stream && !starting;
    $("captureBtn").disabled = !stream || busy;
    $("captureBtn").textContent = live ? "Зафиксировать кадр" : "Новый кадр";
    $("closePolygonBtn").disabled = busy || vertices.length < 3;
    $("closePolygonBtn").textContent = closed ? "Редактировать границу" : "Замкнуть полигон";
    $("undoBtn").disabled = busy || !history.length;
    $("clearBtn").disabled = busy || !vertices.length;
    $("fixOrderBtn").disabled = busy || vertices.length < 3;
    $("dictionarySelect").disabled = busy;
    $("cameraSelect").disabled = starting || busy;
    $("downloadPngBtn").disabled = !closed || busy;
    $("downloadJsonBtn").disabled = !closed || busy;
    $("stage").classList.toggle("busy", busy);
    $("modeLabel").textContent = live ? "Прямой эфир" : captured ? "Кадр зафиксирован" : "Камера выключена";
    $("vertexCount").textContent = String(vertices.length);
    const invalid = vertices.length >= 3 && !PolygonGeometry.isSimple(vertices);
    $("polygonHint").classList.toggle("invalid", invalid);
    $("polygonHint").textContent = closed ? "Граница замкнута. Можно сохранить результат." :
      invalid ? "Граница пересекается или вырождается. Нажмите «Исправить порядок» или используйте стрелки у вершин." :
      vertices.length >= 3 ? "Замкните границу. Стрелками у вершин можно изменить порядок обхода." :
      "Нужно не менее трёх арукомаркеров.";
  }
  function renderList() {
    $("vertexList").replaceChildren();
    vertices.forEach((vertex, index) => {
      const item = document.createElement("li");
      const number = document.createElement("span");
      number.className = "vertex-number";
      number.textContent = String(index + 1);
      const label = document.createElement("div");
      label.textContent = "ArUco ID " + vertex.id;
      const coordinates = document.createElement("div");
      coordinates.className = "vertex-coordinates";
      coordinates.textContent = "x: " + vertex.x.toFixed(1) + " · y: " + vertex.y.toFixed(1);
      label.appendChild(coordinates);
      label.className = "vertex-label";
      const actions = document.createElement("div");
      actions.className = "vertex-actions";
      [-1, 1].forEach(direction => {
        const move = document.createElement("button");
        move.className = "move-vertex";
        move.textContent = direction < 0 ? "↑" : "↓";
        move.setAttribute("aria-label", "Переместить вершину " + (index + 1) + (direction < 0 ? " выше" : " ниже"));
        move.title = direction < 0 ? "Раньше в порядке обхода" : "Позже в порядке обхода";
        move.dataset.direction = String(direction);
        move.disabled = Boolean(pending) || index + direction < 0 || index + direction >= vertices.length;
        move.addEventListener("click", () => {
          remember();
          const next = index + direction;
          [vertices[index], vertices[next]] = [vertices[next], vertices[index]];
          closed = false; search = null;
          update(); status("Порядок вершин изменён. Проверьте границу и замкните полигон.");
        });
        actions.appendChild(move);
      });
      const remove = document.createElement("button");
      remove.className = "remove-vertex";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "Удалить вершину " + (index + 1));
      remove.disabled = Boolean(pending);
      remove.addEventListener("click", () => {
        remember();
        vertices.splice(index, 1); closed = false; search = null;
        update(); status("Вершина удалена. Проверьте порядок обхода границы.");
      });
      actions.appendChild(remove);
      item.append(number, label, actions);
      $("vertexList").appendChild(item);
    });
  }
  function draw() {
    if (!captured) return;
    context.drawImage(frame, 0, 0);
    const scale = canvas.width / Math.max(canvas.getBoundingClientRect().width, 1);
    context.save();
    context.lineJoin = "round";
    if (vertices.length > 1) {
      context.beginPath();
      vertices.forEach((v, i) => i ? context.lineTo(v.x, v.y) : context.moveTo(v.x, v.y));
      context.strokeStyle = vertices.length >= 3 && !PolygonGeometry.isSimple(vertices) ? "#fb923c" : "#38bdf8";
      context.lineWidth = 3 * scale;
      if (closed) {
        context.closePath();
        context.fillStyle = "rgba(56,189,248,.18)";
        context.fill();
      }
      context.stroke();
      if (!closed && vertices.length >= 3) {
        context.beginPath();
        context.setLineDash([6 * scale, 5 * scale]);
        context.moveTo(vertices.at(-1).x, vertices.at(-1).y);
        context.lineTo(vertices[0].x, vertices[0].y);
        context.stroke();
        context.setLineDash([]);
      }
    }
    vertices.forEach((vertex, index) => {
      context.beginPath();
      vertex.corners.forEach((p, i) => i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y));
      context.closePath();
      context.lineWidth = scale;
      context.strokeStyle = "#86efac";
      context.stroke();
      context.beginPath();
      context.arc(vertex.x, vertex.y, 5 * scale, 0, Math.PI * 2);
      context.fillStyle = index === 0 ? "#fbbf24" : "#38bdf8";
      context.fill();
      context.strokeStyle = "#0f172a";
      context.lineWidth = 2 * scale;
      context.stroke();
      const label = (index + 1) + " / ID " + vertex.id;
      context.font = "600 " + (12 * scale) + "px sans-serif";
      const width = context.measureText(label).width + 12 * scale;
      const labelX = Math.min(Math.max(0, vertex.x + 9 * scale), canvas.width - width);
      const labelY = Math.max(23 * scale, vertex.y - 13 * scale);
      context.fillStyle = "rgba(15,23,42,.9)";
      context.fillRect(labelX, labelY - 19 * scale, width, 25 * scale);
      context.fillStyle = "white";
      context.fillText(label, labelX + 6 * scale, labelY);
    });
    if (search) {
      context.beginPath();
      context.arc(search.x, search.y, search.radius, 0, Math.PI * 2);
      context.strokeStyle = search.failed ? "#f87171" : "#fbbf24";
      context.lineWidth = 2 * scale;
      context.setLineDash([5 * scale, 5 * scale]);
      context.stroke();
    }
    context.restore();
  }
  function update() { controls(); renderList(); draw(); }
  function cancelSearch() {
    if (worker) worker.terminate();
    worker = null;
    if (pending) {
      clearTimeout(pending.timeout);
      clearTimeout(pending.fallbackTimer);
      pending.reject(new Error("Поиск отменён"));
      pending = null;
    }
  }
  function releaseCamera() {
    sourceVersion++;
    cancelAnimationFrame(animation);
    live = false; starting = false;
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
    cancelSearch();
    controls();
  }
  function liveFrame() {
    if (!live) return;
    if (video.readyState >= 2) context.drawImage(video, 0, 0, canvas.width, canvas.height);
    animation = requestAnimationFrame(liveFrame);
  }
  function resume() {
    if (!stream || video.readyState < 2) return;
    if (vertices.length && !confirm("Начать новый кадр? Текущая граница будет очищена.")) return;
    cancelSearch();
    vertices = []; history = []; closed = false; captured = false; search = null;
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.hidden = false; $("placeholder").hidden = true;
    live = true;
    cancelAnimationFrame(animation);
    liveFrame(); update();
    status("Нажмите рядом с первым арукомаркером: кадр зафиксируется, а поиск найдёт его центр.");
  }
  function freeze() {
    if (!live || video.readyState < 2) return false;
    cancelAnimationFrame(animation);
    canvas.width = frame.width = video.videoWidth;
    canvas.height = frame.height = video.videoHeight;
    frameContext.drawImage(video, 0, 0);
    live = false; captured = true;
    update();
    status("Кадр зафиксирован. Выбирайте арукомаркеры по порядку обхода границы.");
    return true;
  }
  async function startCamera() {
    if (starting || stream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status("Камера недоступна. Откройте приложение через http://localhost:8000 или HTTPS.", "error"); return;
    }
    starting = true; controls();
    const version = ++sourceVersion;
    status("Ожидаем разрешение на использование камеры…");
    let acquired = null;
    try {
      const deviceId = $("cameraSelect").value;
      acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } }),
        width: { ideal: 1920 }, height: { ideal: 1080 }
      } });
      if (version !== sourceVersion) { acquired.getTracks().forEach(track => track.stop()); return; }
      video.srcObject = acquired;
      await video.play();
      if (version !== sourceVersion) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired; starting = false;
      stream.getVideoTracks().forEach(track => track.addEventListener("ended", () => {
        releaseCamera(); status("Камера отключилась. Зафиксированный кадр можно продолжить размечать.", "error");
      }));
      resume();
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (version !== sourceVersion) return;
        $("cameraSelect").replaceChildren(new Option("Автоматически (задняя камера)", ""));
        devices.filter(device => device.kind === "videoinput").forEach((device, i) => {
          $("cameraSelect").add(new Option(device.label || "Камера " + (i + 1), device.deviceId));
        });
        $("cameraSelect").value = deviceId;
      } catch (error) { /* Camera can work even when device names are unavailable. */ }
    } catch (error) {
      if (acquired) acquired.getTracks().forEach(track => track.stop());
      if (version !== sourceVersion) return;
      releaseCamera();
      const messages = {
        NotAllowedError: "Доступ к камере запрещён. Разрешите его в настройках сайта и нажмите «Включить камеру».",
        NotFoundError: "Камера не найдена. Подключите камеру и повторите попытку.",
        NotReadableError: "Не удалось открыть камеру. Проверьте, не занята ли она другим приложением.",
        OverconstrainedError: "Выбранная камера недоступна. Выберите другую в настройках."
      };
      status(messages[error.name] || "Не удалось включить камеру. Проверьте подключение и разрешения браузера.", "error");
    }
  }
  function finishDetection(task, markers, error) {
    if (pending !== task) return;
    pending = null;
    clearTimeout(task.timeout);
    clearTimeout(task.fallbackTimer);
    error ? task.reject(error) : task.resolve(markers);
  }
  function detectOnPage(task) {
    // file:// pages cannot load a worker. Yield once so the searching status paints.
    task.fallbackTimer = setTimeout(() => {
      if (pending !== task) return;
      try {
        if (typeof MarkerDetection === "undefined") {
          throw new Error("Детектор не загружен. Выполните npm.cmd install в папке проекта и обновите страницу.");
        }
        const markers = MarkerDetection.getDetector(task.dictionary).detect(task.imageData);
        finishDetection(task, markers);
      } catch (error) {
        finishDetection(task, null, error);
      }
    }, 20);
  }
  function usePageDetector(task) {
    workerUnavailable = true;
    if (worker) worker.terminate();
    worker = null;
    if (pending === task) detectOnPage(task);
  }
  function detect(imageData) {
    return new Promise((resolve, reject) => {
      const task = { id: ++requestId, resolve, reject, imageData,
        dictionary: $("dictionarySelect").value,
        timeout: setTimeout(() => cancelSearch(), 12000) };
      pending = task;
      if (workerUnavailable) { detectOnPage(task); return; }
      try {
        if (!worker) {
          worker = new Worker("polygon-worker.js");
          worker.onmessage = event => {
            if (!pending || event.data.requestId !== pending.id) return;
            finishDetection(pending, event.data.markers,
              event.data.error ? new Error(event.data.error) : null);
          };
          worker.onerror = event => {
            event.preventDefault();
            if (pending) usePageDetector(pending);
          };
        }
        // Keep the original crop available if the worker fails to load asynchronously.
        worker.postMessage({ requestId: task.id, dictionary: task.dictionary,
          width: imageData.width, height: imageData.height, buffer: imageData.data.buffer });
      } catch (error) {
        usePageDetector(task);
      }
    });
  }
  function closePolygon() {
    if (pending) return;
    if (closed) { closed = false; update(); status("Добавьте или удалите вершины, затем снова замкните границу."); return; }
    if (vertices.length < 3) { status("Для полигона нужны минимум три вершины.", "error"); return; }
    if (!PolygonGeometry.isSimple(vertices)) {
      status("Граница пересекает сама себя или вершины лежат на одной прямой. Нажмите «Исправить порядок» или переставьте вершины стрелками.", "error"); return;
    }
    closed = true; search = null; update(); status("Полигон готов: " + vertices.length + " вершин. Можно сохранить кадр и координаты.", "success");
  }
  async function selectMarker(event) {
    if (pending || (!live && !captured)) return;
    if (closed) { status("Граница уже замкнута. Нажмите «Редактировать границу», чтобы изменить её."); return; }
    const bounds = canvas.getBoundingClientRect();
    const click = { x: (event.clientX - bounds.left) * canvas.width / bounds.width,
      y: (event.clientY - bounds.top) * canvas.height / bounds.height };
    if (live && !freeze()) return;
    const radius = Number($("searchRadius").value) * canvas.width / bounds.width;
    search = { ...click, radius };
    draw(); status("Ищем арукомаркер рядом с выбранной точкой…");
    const version = sourceVersion;
    const half = radius * 1.6;
    const left = Math.max(0, Math.floor(click.x - half)), top = Math.max(0, Math.floor(click.y - half));
    const width = Math.min(frame.width, Math.ceil(click.x + half)) - left;
    const height = Math.min(frame.height, Math.ceil(click.y + half)) - top;
    const crop = document.createElement("canvas");
    const scale = Math.min(1, 1200 / Math.max(width, height));
    crop.width = Math.max(1, Math.round(width * scale));
    crop.height = Math.max(1, Math.round(height * scale));
    const cropContext = crop.getContext("2d", { willReadFrequently: true });
    cropContext.drawImage(frame, left, top, width, height, 0, 0, crop.width, crop.height);
    try {
      const detection = detect(cropContext.getImageData(0, 0, crop.width, crop.height));
      controls(); renderList();
      const markers = await detection;
      if (version !== sourceVersion) return;
      const candidates = markers.map(marker => {
        const corners = marker.corners.map(point => ({ x: left + point.x * width / crop.width,
          y: top + point.y * height / crop.height }));
        const centre = PolygonGeometry.markerCenter(corners);
        return { id: marker.id, corners, ...centre, distance: Math.hypot(centre.x - click.x, centre.y - click.y) };
      }).filter(marker => marker.distance <= radius).sort((a, b) => a.distance - b.distance);
      if (!candidates.length) {
        search.failed = true; draw();
        status("Арукомаркер рядом не найдена. Нажмите ближе к её центру, увеличьте радиус поиска или проверьте выбранный словарь.", "error"); return;
      }
      const marker = candidates[0];
      const duplicate = vertices.findIndex(vertex => Math.hypot(vertex.x - marker.x, vertex.y - marker.y) < 8);
      search = null;
      if (duplicate === 0 && vertices.length >= 3) { closePolygon(); return; }
      if (duplicate >= 0) { draw(); status("Этот арукомаркер уже добавлен как вершина " + (duplicate + 1) + "."); return; }
      if (!PolygonGeometry.isSimple([...vertices, marker], false)) {
        draw(); status("Новое ребро пересекает границу. Выбирайте арукомаркеры по порядку обхода полигона.", "error"); return;
      }
      remember();
      vertices.push({ id: marker.id, x: marker.x, y: marker.y, corners: marker.corners });
      update(); status("Добавлена вершина " + vertices.length + " — центр ArUco ID " + marker.id + ".", "success");
    } catch (error) {
      if (version === sourceVersion) status(error.message || "Ошибка поиска арукомаркера. Повторите клик.", "error");
    } finally {
      controls(); renderList();
    }
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = name;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $("startCameraBtn").addEventListener("click", startCamera);
  $("captureBtn").addEventListener("click", () => live ? freeze() : resume());
  $("stopCameraBtn").addEventListener("click", () => {
    releaseCamera();
    status(captured ? "Камера выключена. Продолжайте размечать зафиксированный кадр." : "Камера выключена.");
  });
  $("cameraSelect").addEventListener("change", async () => {
    if (!stream) return;
    if (vertices.length && !confirm("Сменить камеру и очистить текущую границу?")) {
      $("cameraSelect").value = stream.getVideoTracks()[0].getSettings().deviceId || ""; return;
    }
    vertices = []; history = []; closed = false; search = null;
    releaseCamera(); update(); await startCamera();
  });
  $("dictionarySelect").addEventListener("change", () => {
    vertices = []; history = []; closed = false; search = null;
    update(); status("Словарь изменён. Выберите арукомаркеры заново на этом кадре.");
  });
  $("searchRadius").addEventListener("input", () => { $("radiusValue").textContent = $("searchRadius").value; });
  $("closePolygonBtn").addEventListener("click", closePolygon);
  $("fixOrderBtn").addEventListener("click", () => {
    if (pending || vertices.length < 3) return;
    const ordered = PolygonGeometry.repairOrder(vertices);
    if (!ordered) {
      status("Не удалось исправить границу: нужны минимум три различных арукомаркера, расположенных не на одной прямой. Измените выбор вершин.", "error"); return;
    }
    if (ordered.every((vertex, index) => vertex === vertices[index])) {
      status(closed ? "Порядок вершин уже правильный. Полигон готов." : "Порядок вершин уже правильный. Можно замкнуть полигон.", "success"); return;
    }
    remember();
    vertices = ordered; closed = false; search = null;
    update(); status("Порядок исправлен: пересечения устранены, все арукомаркеры сохранены. Нажмите «Замкнуть полигон».", "success");
  });
  $("undoBtn").addEventListener("click", () => {
    if (pending || !history.length) return;
    const previous = history.pop();
    vertices = previous.vertices; closed = previous.closed; search = null;
    update(); status("Последнее изменение отменено.");
  });
  $("clearBtn").addEventListener("click", () => {
    remember();
    vertices = []; closed = false; search = null; update(); status("Граница очищена. Можно выбрать арукомаркеры заново.");
  });
  $("downloadPngBtn").addEventListener("click", () => {
    if (!closed) return;
    search = null; draw();
    canvas.toBlob(blob => blob ? download(blob, "polygon.png") : status("Не удалось сохранить изображение.", "error"), "image/png");
  });
  $("downloadJsonBtn").addEventListener("click", () => {
    if (!closed) return;
    const result = { version: 1, dictionary: $("dictionarySelect").value, closed: true,
      image: { width: frame.width, height: frame.height }, coordinateSystem: "image-pixels-top-left",
      vertices: vertices.map((v, i) => ({ index: i + 1, markerId: v.id, x: v.x, y: v.y, corners: v.corners })) };
    download(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }), "polygon.json");
  });
  $("logoutBtn").addEventListener("click", () => {
    releaseCamera(); localStorage.removeItem(AppAuth.SESSION_KEY); location.href = "login.html";
  });
  canvas.addEventListener("click", selectMarker);
  window.addEventListener("resize", () => { if (captured) draw(); });
  window.addEventListener("pagehide", releaseCamera);
  controls();
})();
