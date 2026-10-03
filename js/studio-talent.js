// Nativoya Studio — talent-side helpers. No auth token at all: a talent's
// only identity is the opaque session_token returned when they start a
// session, kept in localStorage AND in the URL so a bookmark/reload works.
(function () {
  const API_BASE_URL = "https://nativoya.vercel.app";

  // Separate token storage from js/studio-shared.js (leader/qa/head_leader)
  // — a talent account is its own thing, never mixed up with those.
  function authToken() { return localStorage.getItem("studio_talent_token"); }
  function currentTalent() {
    const raw = localStorage.getItem("studio_talent_user");
    return raw ? JSON.parse(raw) : null;
  }
  function saveSession(token, user) {
    localStorage.setItem("studio_talent_token", token);
    localStorage.setItem("studio_talent_user", JSON.stringify(user));
  }
  function logout() {
    localStorage.removeItem("studio_talent_token");
    localStorage.removeItem("studio_talent_user");
  }
  function requireLogin(returnTo) {
    if (!authToken()) {
      location.href = `talent-login.html?return=${encodeURIComponent(returnTo || location.pathname + location.search)}`;
      return null;
    }
    return currentTalent();
  }

  async function apiFetch(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    const token = authToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
    } catch (err) {
      throw new Error("تعذر الاتصال بالسيرفر. اتأكد من اتصالك بالنت وحاول تاني.");
    }
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error((data && data.error) || "حصل خطأ غير متوقع.");
    return data;
  }

  async function apiUploadFile(path, file, extraFields) {
    const form = new FormData();
    form.append("file", file);
    Object.entries(extraFields || {}).forEach(([k, v]) => form.append(k, v));
    const headers = {};
    const token = authToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE_URL}${path}`, { method: "POST", headers, body: form });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error((data && data.error) || "تعذر رفع الملف");
    return data;
  }

  async function signup(name, email, password, whatsapp) {
    const data = await apiFetch("/api/studio/auth/talent/signup", {
      method: "POST",
      body: JSON.stringify({ name, email, password, whatsapp }),
    });
    saveSession(data.token, data.user);
    return data;
  }

  async function login(email, password) {
    const data = await apiFetch("/api/studio/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, studioRole: "talent" }),
    });
    saveSession(data.token, data.user);
    return data;
  }

  function getMySessions() { return apiFetch("/api/studio/talent/me/sessions"); }

  function getTasks() { return apiFetch("/api/studio/talent/tasks"); }
  function getTaskDetail(taskId) { return apiFetch(`/api/studio/talent/tasks/${taskId}`); }
  function getAvailableFakeNames(taskId) { return apiFetch(`/api/studio/talent/tasks/${taskId}/fake-names`); }

  function createSession(payload) {
    return apiFetch("/api/studio/talent/sessions", { method: "POST", body: JSON.stringify(payload) });
  }
  function getSession(token) { return apiFetch(`/api/studio/talent/sessions/${token}`); }
  function uploadSampleAudio(token, sampleId, file, duration) {
    return apiUploadFile(`/api/studio/talent/sessions/${token}/samples/${sampleId}/audio`, file, duration ? { duration } : {});
  }
  function submitSession(token) {
    return apiFetch(`/api/studio/talent/sessions/${token}/submit`, { method: "POST" });
  }

  function saveSessionToken(taskId, token) {
    localStorage.setItem(`studio_talent_session_${taskId}`, token);
  }
  function loadSessionToken(taskId) {
    return localStorage.getItem(`studio_talent_session_${taskId}`);
  }

  window.NMTalent = {
    getTasks, getTaskDetail, getAvailableFakeNames,
    createSession, getSession, uploadSampleAudio, submitSession,
    saveSessionToken, loadSessionToken,
    authToken, currentTalent, saveSession, logout, requireLogin,
    signup, login, getMySessions,
  };
})();
