/* Local demo accounts. A deployed service needs server-side authentication. */
(function (global) {
  "use strict";
  const USERS_KEY = "app_users_v1";
  const SESSION_KEY = "app_session_v1";
  function loadUsers() {
    try {
      const value = JSON.parse(localStorage.getItem(USERS_KEY));
      if (!value || typeof value !== "object" || Array.isArray(value)) return Object.create(null);
      const users = Object.create(null);
      Object.keys(value).forEach(function (login) {
        const user = value[login];
        if (user && typeof user === "object" && typeof user.passHash === "string" &&
            /^[a-f0-9]{64}$/.test(user.passHash) &&
            ["admin", "operator", "master"].includes(user.role)) users[login] = user;
      });
      return users;
    } catch (error) { return Object.create(null); }
  }
  function loadSession() {
    if (global.AppCloud?.configured) {
      const user=AppCloud.session()?.user, profile=AppCloud.profile();
      return user&&profile ? {login:user.email,id:user.id,name:profile.name,role:profile.role,registrationStatus:profile.registration_status} : null;
    }
    try {
      const session = JSON.parse(localStorage.getItem(SESSION_KEY));
      if (!session || typeof session.login !== "string" || !session.login.trim()) return null;
      const user = loadUsers()[session.login];
      if (!user) return null;
      return { login: session.login, role: user.role,
        name: typeof user.name === "string" && user.name.trim() ? user.name : session.login };
    } catch (error) { return null; }
  }
  global.AppAuth = Object.freeze({ USERS_KEY, SESSION_KEY, loadUsers, loadSession });
})(globalThis);
