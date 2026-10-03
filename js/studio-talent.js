// Nativoya Studio — talent-side helpers. No auth token at all: a talent's
// only identity is the opaque session_token returned when they start a
// session, kept in localStorage AND in the URL so a bookmark/reload works.
(function () {
  const API_BASE_URL = "https://nativoya.vercel.app";

  async function apiFetch(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
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
    const res = await fetch(`${API_BASE_URL}${path}`, { method: "POST", body: form });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error((data && data.error) || "تعذر رفع الملف");
    return data;
  }

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
  };
})();
