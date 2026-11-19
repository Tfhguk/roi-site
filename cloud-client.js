(function (global) {
  "use strict";
  const KEY = "roi_cloud_session_v1", PROFILE = "roi_cloud_profile_v1";
  const config = global.ROI_CLOUD || {};
  const configured = Boolean(config.url && config.publishableKey);
  let refreshing;
  function read(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
  function session() { return read(KEY); }
  function profile() { return read(PROFILE); }
  function cache(value) { localStorage.setItem(PROFILE, JSON.stringify(value)); return value; }
  function saveSession(value) {
    localStorage.setItem(KEY, JSON.stringify({ ...value, expires_at: value.expires_at || Date.now() / 1000 + value.expires_in }));
  }
  async function request(endpoint, { method = "GET", body, auth = true } = {}) {
    if (!configured) throw Error("Сервер ещё не подключён. Нужны URL проекта Supabase и публичный ключ.");
    if (auth) await refresh();
    const token = session()?.access_token;
    if (auth && !token) throw Error("Сессия завершена. Войдите снова.");
    const response = await fetch(config.url.replace(/\/$/, "") + endpoint, {
      method, headers: { apikey: config.publishableKey, "Content-Type": "application/json",
        ...(token && auth ? { Authorization: "Bearer " + token } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000)
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      if (auth && response.status === 401) { localStorage.removeItem(KEY); localStorage.removeItem(PROFILE); }
      const message=result?.msg || result?.error_description || result?.message || "Ошибка сервера: " + response.status;
      if(message.includes("polygons_name_check"))throw Error("Введите название полигона: от 1 до 100 символов.");
      throw Error(message);
    }
    return result;
  }
  async function refresh() {
    const current = session();
    if (!current || current.expires_at > Date.now() / 1000 + 60) return;
    if (!refreshing) refreshing = request("/auth/v1/token?grant_type=refresh_token", {
      method: "POST", auth: false, body: { refresh_token: current.refresh_token }
    }).then(saveSession).catch(error => {
      localStorage.removeItem(KEY); localStorage.removeItem(PROFILE); throw error;
    }).finally(() => { refreshing = null; });
    await refreshing;
  }
  async function me() {
    const id = session()?.user?.id;
    if (!id) throw Error("Войдите в аккаунт.");
    const rows = await request("/rest/v1/profiles?id=eq." + encodeURIComponent(id) + "&select=*");
    if (!rows?.[0]) throw Error("Профиль не найден. Выполните настройку базы supabase/schema.sql.");
    return cache(rows[0]);
  }
  async function signIn(email, password) {
    const result = await request("/auth/v1/token?grant_type=password", { method: "POST", auth: false, body: { email, password } });
    saveSession(result); return me();
  }
  async function signUp(email, password, name, role) {
    const result = await request("/auth/v1/signup", { method: "POST", auth: false,
      body: { email, password, data: { name, role } } });
    if (!result.access_token) return null;
    saveSession(result); return me();
  }
  async function logout() {
    try { if (session()) await request("/auth/v1/logout", { method: "POST" }); }
    finally { localStorage.removeItem(KEY); localStorage.removeItem(PROFILE); localStorage.removeItem("app_session_v1"); }
  }
  async function rpc(name, body) {
    const result=await request("/rest/v1/rpc/" + name, { method: "POST", body });
    return Array.isArray(result)&&result.length===1?result[0]:result;
  }
  const labels = { polygon: "Создание/выбор полигона", garage: "Создание техники", zones: "Создание зон", routes: "Создание допустимых траекторий", ready: "Регистрация завершена" };
  global.AppCloud = Object.freeze({ configured, session, profile, me, signIn, signUp, logout, request, rpc, labels,
    async polygons() { return request("/rest/v1/polygons?select=*&order=created_at.desc"); },
    async equipment() { return request("/rest/v1/equipment?select=*&order=created_at.asc"); },
    async workspace() { const rows = await request("/rest/v1/workspaces?select=*"); return rows[0] || null; },
    async advance() { const value = await rpc("advance_setup", {}); return cache(value); },
    async selectPolygon(id) { const value = await rpc("select_polygon", { p_polygon: id }); return cache(value); },
    async saveWorkspace(value) { return rpc("save_workspace", { p_zones: value.zones, p_routes: value.routes, p_depth: value.depth, p_revision: value.revision }); }
  });
})(globalThis);
