/* ==========================================================================
   Nativoya — shared.js
   Injects header + footer, handles AR/EN toggle (RTL/LTR mirroring), and
   provides a small mock data / mock-auth layer (localStorage-based) so the
   whole demo works standalone on GitHub Pages with no backend.
   ========================================================================== */

const NM = (() => {

  const SERVICES = [
    { slug: "tour-guides",   icon: "🧭", ar: "مرشدين سياحيين", en: "Tour Guides" },
    { slug: "translation",   icon: "🌐", ar: "ترجمة",           en: "Translation" },
    { slug: "transcription", icon: "📝", ar: "تفريغ صوتي",      en: "Transcription" },
    { slug: "dubbing",       icon: "🎙️", ar: "دبلجة",           en: "Dubbing" },
    { slug: "annotation",    icon: "🏷️", ar: "توسيم بيانات",    en: "Annotation" },
    { slug: "subtitling",    icon: "🎬", ar: "ترجمة أفلام",     en: "Subtitling" },
  ];

  const I18N = {
    ar: {
      home: "الرئيسية", services: "الخدمات", groups: "الجروبات",
      login: "تسجيل الدخول", signup: "إنشاء حساب", dashboard: "لوحتي",
      footer_tagline: "منصة الأدلاء السياحيين وخدمات اللغة — مصر والعالم العربي.",
      footer_platform: "المنصة", footer_services: "الخدمات", footer_account: "الحساب",
      footer_about: "من نحن", footer_contact: "تواصل معنا", footer_groups: "الجروبات",
      footer_login: "دخول", footer_signup: "تسجيل", footer_dashboard: "لوحة التحكم",
      rights: "جميع الحقوق محفوظة.",
    },
    en: {
      home: "Home", services: "Services", groups: "Groups",
      login: "Log in", signup: "Sign up", dashboard: "Dashboard",
      footer_tagline: "The tourism-guide & language-services platform for Egypt and the Arab world.",
      footer_platform: "Platform", footer_services: "Services", footer_account: "Account",
      footer_about: "About", footer_contact: "Contact", footer_groups: "Groups",
      footer_login: "Log in", footer_signup: "Sign up", footer_dashboard: "Dashboard",
      rights: "All rights reserved.",
    }
  };

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
  }

  function svgIcon(name) {
    const icons = {
      menu: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>',
    };
    return icons[name] || "";
  }

  function renderHeader(activePath) {
    const header = document.createElement("header");
    header.className = "site-header";
    header.innerHTML = `
      <nav class="nav">
        <a href="${rel('index.html')}" class="logo" aria-label="Nativoya">
          <span class="part-1">Nativ</span><span class="part-2">oya</span>
        </a>
        <ul class="nav-links">
          <li><a href="${rel('index.html')}" data-i18n="home">الرئيسية</a></li>
          <li><a href="${rel('pages/services.html')}" data-i18n="services">الخدمات</a></li>
          <li><a href="${rel('pages/groups.html')}" data-i18n="groups">الجروبات</a></li>
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
    const footer = document.createElement("footer");
    footer.className = "site-footer";
    footer.innerHTML = `
      <div class="container">
        <div class="footer-grid">
          <div>
            <a href="${rel('index.html')}" class="logo" style="margin-bottom:10px;">
              <span class="part-1">Nativ</span><span class="part-2">oya</span>
            </a>
            <p data-i18n="footer_tagline" class="text-muted" style="max-width:280px;">منصة الأدلاء السياحيين وخدمات اللغة — مصر والعالم العربي.</p>
          </div>
          <div>
            <h4 data-i18n="footer_platform">المنصة</h4>
            <ul>
              <li><a href="${rel('pages/groups.html')}" data-i18n="footer_groups">الجروبات</a></li>
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

  function mockLogout() { localStorage.removeItem("nm_user"); }

  function init(opts = {}) {
    renderHeader();
    renderFooter();
    setLang(getLang());
    document.body.classList.add("nm-ready");
  }

  return { init, setLang, getLang, toggleMobileNav, SERVICES, seedCounters, currentUser, mockSignup, mockLogout, rel };
})();

document.addEventListener("DOMContentLoaded", () => NM.init());
