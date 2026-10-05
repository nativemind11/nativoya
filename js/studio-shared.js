// Nativoya Studio — shared auth/API helpers. Completely separate token
// storage from the main site's js/shared.js (different localStorage keys),
// so being logged into nativoya.click and the Studio are two independent
// sessions, exactly as designed.
(function () {
  const API_BASE_URL = "https://nativoya.vercel.app";

  function authToken() { return localStorage.getItem("studio_token"); }
  function currentUser() {
    const raw = localStorage.getItem("studio_user");
    return raw ? JSON.parse(raw) : null;
  }
  function currentRole() { return localStorage.getItem("studio_role"); }

  function saveSession(token, studioRole, user) {
    localStorage.setItem("studio_token", token);
    localStorage.setItem("studio_role", studioRole);
    localStorage.setItem("studio_user", JSON.stringify(user));
  }

  function logout() {
    localStorage.removeItem("studio_token");
    localStorage.removeItem("studio_role");
    localStorage.removeItem("studio_user");
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

  async function login(email, password, studioRole) {
    const data = await apiFetch("/api/studio/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, studioRole }),
    });
    saveSession(data.token, data.studioRole, data.user);
    return data;
  }

  async function leaderSignup(name, email, password) {
    const data = await apiFetch("/api/studio/auth/leader/signup", {
      method: "POST",
      body: JSON.stringify({ name, email, password }),
    });
    saveSession(data.token, data.studioRole, data.user);
    return data;
  }

  async function refreshMe() {
    const data = await apiFetch("/api/studio/auth/me");
    localStorage.setItem("studio_user", JSON.stringify(data.user));
    return data;
  }

  // Every dashboard page calls this first: bounces to login if there's no
  // session, or if the session isn't for the role that page is meant for.
  function requireStudioRole(expectedRole) {
    const role = currentRole();
    if (!authToken() || !role) { location.href = rel("login.html"); return null; }
    if (expectedRole && role !== expectedRole) { location.href = rel("login.html"); return null; }
    return currentUser();
  }

  // Same trick as the main site's shared.js: pages live one level under
  // /studio/, so a relative link works whether the page is served from
  // /studio/index.html or a subfolder.
  function rel(path) { return path; }

  // ---- head_leader: tasks -------------------------------------------
  function apiCreateTask(payload) {
    return apiFetch("/api/studio/headleader/tasks", { method: "POST", body: JSON.stringify(payload) });
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

  function apiUploadFakeNames(taskId, file) {
    return apiUploadFile(`/api/studio/headleader/tasks/${taskId}/fake-names`, file);
  }
  function apiUploadScript(taskId, file) {
    return apiUploadFile(`/api/studio/headleader/tasks/${taskId}/script`, file);
  }
  function apiUploadSampleAudio(taskId, sampleId, file, duration) {
    return apiUploadFile(`/api/studio/headleader/tasks/${taskId}/samples/${sampleId}/audio`, file, duration ? { duration } : {});
  }
  function apiUploadBulkSampleAudio(taskId, sampleIds, file, duration) {
    const extra = { sampleIds: JSON.stringify(sampleIds) };
    if (duration) extra.duration = duration;
    return apiUploadFile(`/api/studio/headleader/tasks/${taskId}/samples/bulk-audio`, file, extra);
  }
  function apiPublishTask(taskId) {
    return apiFetch(`/api/studio/headleader/tasks/${taskId}/publish`, { method: "POST" });
  }
  function apiGetLeaders() {
    return apiFetch("/api/studio/headleader/leaders");
  }
  function apiGetMyTasks() {
    return apiFetch("/api/studio/headleader/tasks");
  }
  function apiGetTaskDetail(taskId) {
    return apiFetch(`/api/studio/headleader/tasks/${taskId}`);
  }

  // ---- qa: review queue -----------------------------------------------
  function apiGetPendingReviews() { return apiFetch("/api/studio/qa/pending"); }
  function apiGetReviewDetail(sessionId) { return apiFetch(`/api/studio/qa/sessions/${sessionId}`); }
  function apiApproveSession(sessionId) {
    return apiFetch(`/api/studio/qa/sessions/${sessionId}/approve`, { method: "POST" });
  }
  function apiRejectAllSession(sessionId, reason) {
    return apiFetch(`/api/studio/qa/sessions/${sessionId}/reject-all`, {
      method: "POST", body: JSON.stringify({ reason }),
    });
  }
  function apiSubmitReview(sessionId, decisions) {
    return apiFetch(`/api/studio/qa/sessions/${sessionId}/review`, {
      method: "POST", body: JSON.stringify({ decisions }),
    });
  }
  // A plain <audio src="..."> can't send an Authorization header, and this
  // endpoint needs one (it's QA-only) — so we fetch it ourselves with the
  // token attached and hand back a blob: URL the <audio> tag CAN use.
  async function qaFetchSampleAudioUrl(sessionSampleId) {
    const token = authToken();
    const res = await fetch(`${API_BASE_URL}/api/studio/qa/samples/${sessionSampleId}/audio`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error("تعذر تحميل التسجيل الصوتي");
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  window.NMStudio = {
    authToken, currentUser, currentRole, login, leaderSignup, logout,
    apiFetch, refreshMe, requireStudioRole,
    apiCreateTask, apiUploadScript, apiUploadFakeNames, apiUploadSampleAudio, apiUploadBulkSampleAudio, apiPublishTask,
    apiGetMyTasks, apiGetTaskDetail, apiGetLeaders,
    apiGetPendingReviews, apiGetReviewDetail, apiApproveSession, apiRejectAllSession,
    apiSubmitReview, qaFetchSampleAudioUrl,
  };
})();
