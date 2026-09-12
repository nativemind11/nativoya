/* ==========================================================================
   Nativoya — shared.js
   Injects header + footer, handles AR/EN toggle (RTL/LTR mirroring), and
   provides a small mock data / mock-auth layer (localStorage-based) so the
   whole demo works standalone on GitHub Pages with no backend.
   ========================================================================== */

const NM = (() => {

  const SERVICES = [
    { slug: "translation",   icon: "🌐", ar: "ترجمة",           en: "Translation" },
    { slug: "transcription", icon: "📝", ar: "تفريغ صوتي",      en: "Transcription" },
    { slug: "dubbing",       icon: "🎙️", ar: "دبلجة",           en: "Dubbing" },
    { slug: "subtitling",    icon: "🎬", ar: "ترجمة أفلام",     en: "Subtitling" },
    { slug: "annotation",    icon: "🏷️", ar: "توسيم بيانات",    en: "Annotation" },
    { slug: "tour-guides",   icon: "🧭", ar: "مرشدين سياحيين", en: "Tour Guides" },
  ];

  const I18N = {
    ar: {
      home: "الرئيسية", services: "الخدمات", groups: "الجروبات", my_group: "جروبي",
      login: "تسجيل الدخول", signup: "إنشاء حساب", dashboard: "لوحتي",
      footer_tagline: "منصة ترجمة احترافية، وأبواب عمل أونلاين في مجالات لغوية تانية — لكل ناطقي العربية.",
      footer_platform: "المنصة", footer_services: "الخدمات", footer_account: "الحساب",
      footer_about: "من نحن", footer_contact: "تواصل معنا", footer_groups: "الجروبات",
      footer_login: "دخول", footer_signup: "تسجيل", footer_dashboard: "لوحة التحكم",
      rights: "جميع الحقوق محفوظة.",

      hero_eyebrow: "منصة الترجمة الاحترافية لمتحدثي العربية",
      hero_title: "ترجمة دقيقة، من مترجمين تقدر تثق فيهم",
      hero_lead: "Nativoya منصة ترجمة تربطك بمترجمين محترفين لأي لغة أو مجال. وبمجرد ما تنضم، بتتفتحلك أبواب عمل أونلاين إضافية — تفريغ صوتي، دبلجة، توسيم بيانات، ترجمة أفلام، وحتى الإرشاد السياحي — كل ده تحت منصة واحدة.",
      hero_cta_specialist: "انضم كمترجم",
      hero_cta_tourist: "اطلب خدمة ترجمة",
      stat_guides: "مترجم ومتخصص لغة",
      stat_languages: "لغة متاحة",
      stat_countries: "دولة يوصلها المحتوى",

      dual_cta_1_title: "للمترجمين ومتخصصي اللغة",
      dual_cta_1_body: "سجّل كمترجم، انضم لجروب لغتك، وابدأ تستلم مهام ترجمة حقيقية — وبعدين اكتشف مجالات عمل أونلاين تانية زي التفريغ الصوتي، الدبلجة، وتوسيم البيانات.",
      dual_cta_1_btn: "سجّل كمترجم",
      dual_cta_2_title: "عايز تترجم مستند أو محتوى؟",
      dual_cta_2_body: "اطلب ترجمة من مترجمين معتمدين لأي لغة، وتابع تقدم طلبك أول بأول.",
      dual_cta_2_btn: "اطلب ترجمة الآن",

      services_title: "الترجمة... وأكتر",
      services_subtitle: "الترجمة هي جوهر Nativoya — وبجانبها بتفتح المنصة أبواب عمل أونلاين في مجالات لغوية تانية.",
      services_cta: "اعرف التفاصيل وسجّل دلوقتي",
      featured_service_badge: "الخدمة الأساسية",
      other_fields_title: "مجالات عمل أونلاين تانية",

      activity_title: "نشاط مباشر على المنصة",
      activity_subtitle: "شوف بنفسك إن المنصة حية ونشطة كل لحظة.",
      matching_title: "مطابقة ذكية بسيطة",
      matching_body: "لما شركة سياحة أو عميل ينشر مهمة، النظام بيقترح أنسب مرشد أو متخصص لغة بناءً على اللغة، التخصص، ومعدل السمعة (Reputation Score) — أول نسخة MVP بمنطق بسيط قائم على قواعد، وهنطورها لنموذج ذكاء اصطناعي كامل في المرحلة التالية.",
      match_pill_1: "لغة مطابقة", match_pill_2: "تخصص مطابق", match_pill_3: "أعلى سمعة",

      activity_1: "٣ مترجمين جدد انضموا للجروب الفرنسي اليوم",
      activity_2: "تم إنجاز ١٢ مهمة تفريغ صوتي خلال آخر ساعة",
      activity_3: "مرشد سياحي جديد اتفعّل في جروب الإسبانية",
      activity_4: "شركة سياحة نشرت مهمة جديدة: مرشد لجولة الأقصر",
    },
    en: {
      home: "Home", services: "Services", groups: "Groups", my_group: "My Group",
      login: "Log in", signup: "Sign up", dashboard: "Dashboard",
      footer_tagline: "A professional translation platform, and a gateway to online-work opportunities in other language fields — for Arabic speakers everywhere.",
      footer_platform: "Platform", footer_services: "Services", footer_account: "Account",
      footer_about: "About", footer_contact: "Contact", footer_groups: "Groups",
      footer_login: "Log in", footer_signup: "Sign up", footer_dashboard: "Dashboard",
      rights: "All rights reserved.",

      hero_eyebrow: "A professional translation platform for Arabic speakers",
      hero_title: "Accurate translation, from translators you can trust",
      hero_lead: "Nativoya is a translation platform connecting you with professional translators for any language or field. Once you join, more online-work opportunities open up — transcription, dubbing, data annotation, subtitling, even tour guiding — all under one platform.",
      hero_cta_specialist: "Join as a translator",
      hero_cta_tourist: "Request a translation",
      stat_guides: "Translators & specialists", stat_languages: "Languages available", stat_countries: "Countries reached",

      dual_cta_1_title: "For translators & language specialists",
      dual_cta_1_body: "Register as a translator, join your language group, and start taking on real translation tasks — then discover more online-work fields like transcription, dubbing, and data annotation.",
      dual_cta_1_btn: "Join as a translator",
      dual_cta_2_title: "Need something translated?",
      dual_cta_2_body: "Request a translation from certified translators in any language, and track your request every step of the way.",
      dual_cta_2_btn: "Request a translation",

      services_title: "Translation... and more",
      services_subtitle: "Translation is the heart of Nativoya — and alongside it, the platform opens doors to other online-work language fields.",
      services_cta: "See details and register now",
      featured_service_badge: "Core service",
      other_fields_title: "More online-work fields",

      activity_title: "Live activity on the platform",
      activity_subtitle: "See for yourself that the platform is active every moment.",
      matching_title: "Simple smart matching",
      matching_body: "When a tour company or client posts a task, the system suggests the best-fit guide or language specialist based on language, specialty, and reputation score — a simple rules-based MVP today, evolving into a full AI model in the next phase.",
      match_pill_1: "Language match", match_pill_2: "Specialty match", match_pill_3: "Top reputation",

      activity_1: "3 new translators joined the French group today",
      activity_2: "12 transcription tasks completed in the last hour",
      activity_3: "A new tour guide was activated in the Spanish group",
      activity_4: "A tour company posted a new task: guide for a Luxor tour",
    }
  };

  // ---- real backend API ----
  const API_BASE_URL = "https://nativoya.vercel.app";

  function authToken() { return localStorage.getItem("nm_token"); }

  async function apiFetch(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    const token = authToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
    } catch (err) {
      throw new Error("تعذر الوصول للسيرفر. تأكد إن رابط الباك إند صحيح وشغال.");
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* empty body */ }
    if (!res.ok) {
      throw new Error((data && data.error) || `فشل الطلب (${res.status})`);
    }
    return data;
  }

  async function apiSignup({ firstName, email, password, whatsappNumber, country, role }) {
    const data = await apiFetch("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ firstName, email, password, whatsappNumber, country, role }),
    });
    localStorage.setItem("nm_token", data.token);
    localStorage.setItem("nm_user", JSON.stringify(data.user));
    return data.user;
  }

  async function apiLogin(email, password) {
    const data = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    localStorage.setItem("nm_token", data.token);
    localStorage.setItem("nm_user", JSON.stringify(data.user));
    return data.user;
  }

  async function apiJoinGroup(language, asLeader, groupNumber) {
    const data = await apiFetch("/api/groups/join", {
      method: "POST",
      body: JSON.stringify({ language, asLeader, groupNumber }),
    });
    // refresh the cached user so language/group/role are correct everywhere
    await apiRefreshMe();
    return data;
  }

  // pulls the current profile from the DB (role, language, group_number...)
  // and updates the localStorage cache used by currentUser().
  async function apiRefreshMe() {
    const me = await apiFetch("/api/auth/me");
    const cached = currentUser() || {};
    const merged = {
      ...cached,
      id: me.id, firstName: me.first_name, email: me.email, role: me.role,
      language: me.language, groupNumber: me.group_number, groupId: me.group_id,
    };
    localStorage.setItem("nm_user", JSON.stringify(merged));
    return merged;
  }

  // ---- tasks ----
  function apiGetOpenTasks() { return apiFetch("/api/tasks/open"); }
  function apiCreateTask({ serviceSlug, title, instructions, totalQuantity }) {
    return apiFetch("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ serviceSlug, title, instructions, totalQuantity }),
    });
  }
  function apiClaimTask(taskId, quantity) {
    return apiFetch(`/api/tasks/${taskId}/claim`, {
      method: "POST",
      body: JSON.stringify({ quantity }),
    });
  }
  function apiMyClaims() { return apiFetch("/api/tasks/claims/mine"); }
  function apiClaimsForMyGroup() { return apiFetch("/api/tasks/claims/for-my-group"); }
  function apiSubmitFile(claimId, fileUrl) {
    return apiFetch(`/api/tasks/claims/${claimId}/submissions`, {
      method: "POST",
      body: JSON.stringify({ fileUrl }),
    });
  }
  function apiReviewQueue() { return apiFetch("/api/tasks/review-queue"); }
  function apiReviewSubmission(submissionId, approve) {
    return apiFetch(`/api/tasks/submissions/${submissionId}/review`, {
      method: "POST",
      body: JSON.stringify({ approve }),
    });
  }
  function apiMySubmissions() { return apiFetch("/api/tasks/my-submissions"); }

  // ---- leadership requests (becoming a leader needs head_leader approval) ----
  function apiRequestLeadership(language) {
    return apiFetch("/api/groups/leader-requests", {
      method: "POST",
      body: JSON.stringify({ language }),
    });
  }
  function apiMyLeaderRequest() { return apiFetch("/api/groups/leader-requests/mine"); }
  function apiPendingLeaderRequests() { return apiFetch("/api/groups/leader-requests/pending"); }
  function apiApproveLeaderRequest(id) {
    return apiFetch(`/api/groups/leader-requests/${id}/approve`, { method: "POST" });
  }
  function apiRejectLeaderRequest(id) {
    return apiFetch(`/api/groups/leader-requests/${id}/reject`, { method: "POST" });
  }

  // ---- groups (admin) ----
  function apiGetGroups() { return apiFetch("/api/groups"); }
  function apiGetRoster() { return apiFetch("/api/groups/roster"); }

  // FormData upload — can't reuse apiFetch since it always forces JSON headers
  async function apiUploadSubmission(claimId, file) {
    const token = authToken();
    const formData = new FormData();
    formData.append("file", file);
    let res;
    try {
      res = await fetch(`${API_BASE_URL}/api/tasks/claims/${claimId}/upload`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
    } catch (err) {
      throw new Error("تعذر الوصول للسيرفر. تأكد إن رابط الباك إند صحيح وشغال.");
    }
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error((data && data.error) || `فشل رفع الملف (${res.status})`);
    return data;
  }

  function apiGetGoogleStatus() { return apiFetch("/api/auth/google/status"); }
  function apiGoogleConnectUrl() {
    const token = authToken();
    return `${API_BASE_URL}/api/auth/google/connect?token=${encodeURIComponent(token || "")}`;
  }

  // ---- payments (head_leader only) ----
  function apiGetPendingPayments() { return apiFetch("/api/payments/pending"); }
  function apiCreatePayment({ recipientId, amount, currency, payoutMethod, payoutIdentifier }) {
    return apiFetch("/api/payments", {
      method: "POST",
      body: JSON.stringify({ recipientId, amount, currency, payoutMethod, payoutIdentifier }),
    });
  }
  function apiMarkTransferred(paymentId) {
    return apiFetch(`/api/payments/${paymentId}/mark-transferred`, { method: "POST" });
  }

  function getLang() { return localStorage.getItem("nm_lang") || "ar"; }

  function setLang(lang) {
    localStorage.setItem("nm_lang", lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    applyI18n();
  }

  function applyI18n() {
    const lang = getLang();
    const dict = I18N[lang];
    document.querySelectorAll("[data-i18n]").forEach(el => {
      const key = el.getAttribute("data-i18n");
      if (dict[key]) el.textContent = dict[key];
    });
    document.querySelectorAll(".lang-switch button").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.lang === lang);
    });
    document.dispatchEvent(new CustomEvent("nm:langchange", { detail: { lang } }));
  }

  function t(key) { return I18N[getLang()][key] || key; }

  function svgIcon(name) {
    const icons = {
      menu: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>',
    };
    return icons[name] || "";
  }

  function renderHeader(activePath) {
    const user = currentUser();
    const groupsLink = user && user.role === "head_leader"
      ? `<li><a href="${rel('pages/groups.html')}" data-i18n="groups">الجروبات</a></li>`
      : user
        ? `<li><a href="${rel('pages/my-group.html')}" data-i18n="my_group">جروبي</a></li>`
        : "";
    const header = document.createElement("header");
    header.className = "site-header";
    header.innerHTML = `
      <nav class="nav">
        <a href="${rel('index.html')}" class="logo" aria-label="Nativoya">
          <img src="${rel('assets/logo-icon.svg')}" alt="" width="30" height="30" style="border-radius:8px;">
          <span class="part-1">Nativ</span><span class="part-2">oya</span>
        </a>
        <ul class="nav-links">
          <li><a href="${rel('index.html')}" data-i18n="home">الرئيسية</a></li>
          <li><a href="${rel('pages/services.html')}" data-i18n="services">الخدمات</a></li>
          ${groupsLink}
        </ul>
        <div class="nav-actions">
          <div class="lang-switch" role="group" aria-label="Language">
            <button data-lang="ar" onclick="NM.setLang('ar')">AR</button>
            <button data-lang="en" onclick="NM.setLang('en')">EN</button>
          </div>
          <a href="${rel('pages/login.html')}" class="btn btn-secondary" data-i18n="login">تسجيل الدخول</a>
          <a href="${rel('pages/signup.html')}" class="btn btn-primary" data-i18n="signup">إنشاء حساب</a>
        </div>
        <button class="nav-toggle" aria-label="menu" onclick="NM.toggleMobileNav()">${svgIcon('menu')}</button>
      </nav>
    `;
    document.body.prepend(header);
  }

  function renderFooter() {
    const user = currentUser();
    const footerGroupsLink = user && user.role === "head_leader"
      ? `<li><a href="${rel('pages/groups.html')}" data-i18n="footer_groups">الجروبات</a></li>`
      : `<li><a href="${rel('pages/my-group.html')}" data-i18n="my_group">جروبي</a></li>`;
    const footer = document.createElement("footer");
    footer.className = "site-footer";
    footer.innerHTML = `
      <div class="container">
        <div class="footer-grid">
          <div>
            <a href="${rel('index.html')}" class="logo" style="margin-bottom:10px;">
              <img src="${rel('assets/logo-icon.svg')}" alt="" width="30" height="30" style="border-radius:8px;">
              <span class="part-1">Nativ</span><span class="part-2">oya</span>
            </a>
            <p data-i18n="footer_tagline" class="text-muted" style="max-width:280px;">منصة الأدلاء السياحيين وخدمات اللغة — مصر والعالم العربي.</p>
          </div>
          <div>
            <h4 data-i18n="footer_platform">المنصة</h4>
            <ul>
              ${footerGroupsLink}
              <li><a href="${rel('pages/services.html')}" data-i18n="footer_services">الخدمات</a></li>
            </ul>
          </div>
          <div>
            <h4 data-i18n="footer_account">الحساب</h4>
            <ul>
              <li><a href="${rel('pages/login.html')}" data-i18n="footer_login">دخول</a></li>
              <li><a href="${rel('pages/signup.html')}" data-i18n="footer_signup">تسجيل</a></li>
              <li><a href="${rel('pages/dashboard-member.html')}" data-i18n="footer_dashboard">لوحة التحكم</a></li>
            </ul>
          </div>
          <div>
            <h4 data-i18n="footer_services">الخدمات</h4>
            <ul>
              ${SERVICES.slice(0,4).map(s => `<li><a href="${rel('pages/service.html?s=' + s.slug)}">${s.ar}</a></li>`).join('')}
            </ul>
          </div>
        </div>
        <div class="footer-bottom">
          <span>© <span id="nm-year"></span> Nativoya. <span data-i18n="rights">جميع الحقوق محفوظة.</span></span>
          <span class="text-muted">Made for guides, translators & native speakers everywhere 🌍</span>
        </div>
      </div>
    `;
    document.body.appendChild(footer);
    const y = footer.querySelector("#nm-year");
    if (y) y.textContent = new Date().getFullYear();
  }

  // resolve relative paths whether the current page lives in /pages/ or at root
  function rel(path) {
    const inPages = location.pathname.includes("/pages/");
    return inPages ? "../" + path : path;
  }

  function toggleMobileNav() {
    const links = document.querySelector(".nav-links");
    if (links) links.classList.toggle("hidden");
  }

  // ---- tiny mock backend (localStorage) ----
  function seedCounters() {
    if (!localStorage.getItem("nm_stats")) {
      localStorage.setItem("nm_stats", JSON.stringify({ guides: 482, languages: 34, countries: 61 }));
    }
    return JSON.parse(localStorage.getItem("nm_stats"));
  }

  function currentUser() {
    const raw = localStorage.getItem("nm_user");
    return raw ? JSON.parse(raw) : null;
  }

  function mockSignup(data) {
    const user = { ...data, id: crypto.randomUUID(), role: "member", createdAt: Date.now() };
    localStorage.setItem("nm_user", JSON.stringify(user));
    return user;
  }

  function mockLogout() {
    localStorage.removeItem("nm_user");
    localStorage.removeItem("nm_token");
  }

  // ---- language group assignment (members join the ORIGINAL group per
  // language; leaders always get a brand-new group for that language) ----
  function joinLanguageGroup(language, isLeader) {
    const registryKey = `nm_groups_registry_${language}`;
    let groups = JSON.parse(localStorage.getItem(registryKey) || "[]");
    if (groups.length === 0) {
      groups.push(1); // the "original" group for this language
    }
    let groupNumber;
    let isNewGroup = false;
    if (isLeader) {
      groupNumber = Math.max(...groups) + 1;
      groups.push(groupNumber);
      isNewGroup = true;
    } else {
      groupNumber = groups[0]; // everyone else joins the original group
    }
    localStorage.setItem(registryKey, JSON.stringify(groups));

    const user = currentUser() || {};
    user.language = language;
    user.groupNumber = groupNumber;
    if (isLeader) user.role = "leader";
    localStorage.setItem("nm_user", JSON.stringify(user));
    return { language, groupNumber, isNewGroup };
  }

  const LANGUAGES = [
    { name: "العربية (مصرية)", code: "AR-EG" },
    { name: "الإنجليزية", code: "EN" },
    { name: "الفرنسية", code: "FR" },
    { name: "الإسبانية", code: "ES" },
    { name: "الألمانية", code: "DE" },
    { name: "الإيطالية", code: "IT" },
    { name: "الصينية", code: "ZH" },
    { name: "الروسية", code: "RU" },
  ];

  // ---- invite links: a leader's group is identified by "<langCode>-<groupNumber>" ----
  function generateInviteCode(language, groupNumber) {
    const lang = LANGUAGES.find(l => l.name === language);
    const code = lang ? lang.code : language;
    return `${code}-${groupNumber}`;
  }

  function resolveInviteCode(inviteCode) {
    if (!inviteCode) return null;
    const parts = inviteCode.split("-");
    const groupNumber = parseInt(parts[parts.length - 1], 10);
    const langCode = parts.slice(0, -1).join("-");
    const lang = LANGUAGES.find(l => l.code === langCode);
    if (!lang || !groupNumber) return null;
    return { language: lang.name, groupNumber };
  }

  function inviteUrl(language, groupNumber) {
    const code = generateInviteCode(language, groupNumber);
    const inPages = location.pathname.includes("/pages/");
    const base = inPages
      ? location.href.substring(0, location.href.lastIndexOf("/pages/") + 1) + "pages/"
      : location.href.substring(0, location.href.lastIndexOf("/") + 1) + "pages/";
    return `${base}signup.html?invite=${code}`;
  }

  function init(opts = {}) {
    renderHeader();
    renderFooter();
    setLang(getLang());
    document.body.classList.add("nm-ready");
  }

  return {
    init, setLang, getLang, toggleMobileNav, SERVICES, LANGUAGES, seedCounters,
    currentUser, mockSignup, mockLogout, rel, t, joinLanguageGroup,
    generateInviteCode, resolveInviteCode, inviteUrl,
    // real API
    apiSignup, apiLogin, apiJoinGroup, apiRefreshMe, authToken, apiFetch,
    apiGetOpenTasks, apiCreateTask, apiClaimTask, apiMyClaims, apiClaimsForMyGroup,
    apiSubmitFile, apiUploadSubmission, apiReviewQueue, apiReviewSubmission, apiMySubmissions,
    apiGetGroups, apiGetRoster,
    apiRequestLeadership, apiMyLeaderRequest, apiPendingLeaderRequests,
    apiApproveLeaderRequest, apiRejectLeaderRequest,
    apiGetGoogleStatus, apiGoogleConnectUrl,
    apiGetPendingPayments, apiCreatePayment, apiMarkTransferred,
  };
})();

document.addEventListener("DOMContentLoaded", () => NM.init());
