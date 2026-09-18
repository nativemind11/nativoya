/* ==========================================================================
   Nativoya — shared.js
   Injects header + footer, handles AR/EN toggle (RTL/LTR mirroring), and
   provides a small mock data / mock-auth layer (localStorage-based) so the
   whole demo works standalone on GitHub Pages with no backend.
   ========================================================================== */

const NM = (() => {

  // the 8 AI-data-training skill categories a member can offer / a task can be
  const SERVICES = [
    { slug: "voice_recording",     icon: "🎙️", ar: "تسجيل صوتي",        en: "Voice Recording" },
    { slug: "transcription",       icon: "📝", ar: "تفريغ نصي",         en: "Transcription" },
    { slug: "data_annotation",     icon: "🏷️", ar: "توسيم بيانات",      en: "Data Annotation" },
    { slug: "translation",         icon: "🌐", ar: "ترجمة",             en: "Translation" },
    { slug: "subtitling",          icon: "🎬", ar: "ترجمة أفلام",       en: "Subtitling" },
    { slug: "dubbing",             icon: "🔊", ar: "دبلجة",             en: "Dubbing" },
    { slug: "conversational_data", icon: "💬", ar: "بيانات محادثة",     en: "Conversational Data" },
    { slug: "copywriting_nlp",     icon: "✍️", ar: "كتابة محتوى / NLP", en: "Copywriting / NLP" },
  ];

  const I18N = {
    ar: {
      home: "الرئيسية", services: "الخدمات", groups: "الجروبات", my_group: "جروبي",
      login: "تسجيل الدخول", signup: "إنشاء حساب", dashboard: "لوحتي", logout: "خروج",
      footer_tagline: "منصة عمل أونلاين تربطك بمهام حقيقية في تدريب نماذج الذكاء الاصطناعي العالمية.",
      footer_platform: "المنصة", footer_services: "الخدمات", footer_account: "الحساب",
      footer_about: "من نحن", footer_contact: "تواصل معنا", footer_groups: "الجروبات",
      footer_login: "دخول", footer_signup: "تسجيل", footer_dashboard: "لوحة التحكم",
      rights: "جميع الحقوق محفوظة.",

      hero_eyebrow: "منصة عمل أونلاين لتدريب نماذج الذكاء الاصطناعي",
      hero_title: "اشتغل في تدريب نماذج زي Gemini وChatGPT من مكانك",
      hero_lead: "Nativoya منصة بتوصّلك بمهام حقيقية ومدفوعة في تدريب نماذج الذكاء الاصطناعي العالمية — تسجيل صوتي، تفريغ نصي، توسيم بيانات، ترجمة، دبلجة، ترجمة أفلام، بيانات محادثة، وكتابة محتوى. سجّل، حدد لغاتك ومهاراتك، وابدأ تستلم مهام من جروبك.",
      hero_cta_specialist: "سجّل وابدأ الشغل",
      hero_cta_tourist: "عندي حساب بالفعل",
      stat_guides: "متخصص مسجل",
      stat_languages: "لغة ولهجة متاحة",
      stat_countries: "دولة نشط فيها أعضاؤنا",

      dual_cta_1_title: "للمتخصصين اللي عايزين يشتغلوا أونلاين",
      dual_cta_1_body: "سجّل، حدد اللغات واللهجات اللي بتتكلمها والمهارات اللي تقدمها، وهتنضم تلقائيًا لجروبات لغاتك وتبدأ تشوف المهام المتاحة ليك أول بأول.",
      dual_cta_1_btn: "سجّل دلوقتي",
      dual_cta_2_title: "عندك حساب بالفعل؟",
      dual_cta_2_body: "ادخل على لوحة التحكم وشوف المهام المتاحة لجروبك، وكل مهمة فيها فيديو شرح وسامبل صوتي والسعر قبل ما تبدأ.",
      dual_cta_2_btn: "دخول للوحة التحكم",

      services_title: "أنواع المهام على المنصة",
      services_subtitle: "كل نوع مهمة ليه تفاصيله الخاصة — وبتشوف الفيديو، السامبل الصوتي، والسعر قبل ما تبدأ أي تاسك.",
      services_cta: "اعرف التفاصيل وسجّل دلوقتي",
      featured_service_badge: "الأكتر طلبًا",
      other_fields_title: "مجالات عمل تانية على المنصة",

      activity_title: "نشاط مباشر على المنصة",
      activity_subtitle: "شوف بنفسك إن المنصة حية ونشطة كل لحظة.",
      matching_title: "توزيع مهام بسيط وواضح",
      matching_body: "الهيد ليدر بينشر التاسك — إما لكل الجروبات، أو لجروبات لغات محددة بس. كل تاسك بيوصلك بفيديو شرح، سامبل صوتي، والسعر، عشان تقرر قبل ما تبدأ.",
      match_pill_1: "لغة مطابقة", match_pill_2: "مهارة مطابقة", match_pill_3: "أعلى سمعة",

      activity_1: "٣ أعضاء جدد انضموا لجروب الفرنسية اليوم",
      activity_2: "تم إنجاز ١٢ مهمة توسيم بيانات خلال آخر ساعة",
      activity_3: "تاسك جديد اتنشر لكل الجروبات: بيانات محادثة",
      activity_4: "عضو جديد اتفعّل في جروب العربية الخليجية",

      signup_title: "إنشاء حساب جديد", signup_subtitle: "ثواني وتبقى جزء من مجتمع Nativoya",
      label_name: "الاسم بالكامل", label_email: "البريد الإلكتروني",
      label_password: "كلمة المرور", hint_password: "6 أحرف على الأقل",
      label_whatsapp: "رقم واتساب", label_country: "الدولة", placeholder_select_country: "اختر الدولة",
      label_gender: "النوع", gender_male: "ذكر", gender_female: "أنثى",
      label_payout: "رقم/حساب استلام التحويلات",
      placeholder_payout: "رقم فودافون كاش / إنستاباي أو إيميل PayPal",
      hint_payout: "ده اللي هيتحول عليه مستحقاتك من المهام.",
      label_languages: "اللغات واللهجات اللي بتتكلمها",
      hint_languages: "هتنضم تلقائيًا لجروب كل لغة تختارها — تقدر تختار أكتر من واحدة.",
      label_skills: "المهارات اللي تقدر تقدمها", hint_skills: "اختار كل اللي ينطبق عليك.",
      btn_create_account: "إنشاء الحساب", btn_creating_account: "جاري الإنشاء...",
      already_have_account: "عندك حساب بالفعل؟", login_link: "سجّل دخول",
      error_select_gender: "من فضلك اختار النوع.",
      error_select_language: "من فضلك اختار لغة واحدة على الأقل.",
      error_select_skill: "من فضلك اختار مهارة واحدة على الأقل.",
      invite_join_note: "هتنضم تلقائيًا لجروب {language} رقم #{groupNumber}",

      service_view_details: "اعرف التفاصيل",
      services_ready_title: "مستعد تبدأ؟",
      services_ready_body: "سجّل واحدة، حدد لغاتك ومهاراتك، وابدأ تشوف المهام المتاحة ليك.",
      services_seen_task_title: "شايف مهمة عايز تبدأها؟",
      services_seen_task_body: "روح لوحة التحكم بتاعتك وشوف المهام المتاحة ليك دلوقتي.",
      services_go_dashboard: "روح لوحة التحكم",

      task_back_link: "→ رجوع للوحة التحكم",
      task_loading: "جاري تحميل تفاصيل المهمة...",
      task_video_title: "🎬 فيديو الشرح",
      task_audio_title: "🔊 سامبل صوتي",
      task_instructions_title: "📋 التعليمات",
      task_no_instructions: "لا توجد تعليمات إضافية.",
      task_instructions_file_label: "الملف",
      task_price_label: "السعر", task_price_unset: "غير محدد",
      task_member_price_label: "سعر الميمبر", task_leader_price_label: "سعر الليدر",
      task_remaining_label: "المتبقي على المنصة",
      task_submit_title: "📎 تسليم شغلك على المهمة دي",
      task_submit_hint_default: "لو جروبك استلم كمية من المهمة دي، هتقدر ترفع شغلك من هنا.",
      task_submit_hint_no_claim: "جروبك لسه ما استلمش كمية من المهمة دي — استنى الليدر أو الهيد ليدر يستلمها الأول.",
      task_submit_hint_available: "متاح لجروبك {n} وحدة لسه محتاجة تسليم.",
      task_naming_notice: "📎 ملاحظة: ملفك هيتسمى تلقائيًا: \"{name} - {whatsapp} - {gender} - اسم الملف الأصلي\" — مش محتاج تسميه بنفسك، النظام بيعمل ده تلقائيًا.",
      task_upload_btn: "📎 رفع الشغل", task_uploading: "⏳ جاري الرفع...",
      task_upload_success: "✅ اترفع شغلك بنجاح!",
      task_video_single: "افتح الفيديو", task_video_n: "فيديو {n}",
      task_error_default: "تعذّر تحميل المهمة.",

      // shared across all dashboards
      loading_text: "جاري التحميل...", col_task: "المهمة", col_type: "النوع", col_status: "الحالة",
      btn_details: "التفاصيل", btn_submit_work: "📎 تسليم عمل",
      status_in_review: "بانتظار المراجعة", status_completed: "✅ اتقبلت", status_rejected: "❌ اترفضت",
      dm_rejection_reason_label: "سبب الرفض",

      dm_role: "عضو",
      nav_home: "🏠 الرئيسية", nav_my_group: "💬 جروبي", nav_tasks: "📋 المهام",
      nav_certs: "🏆 الشهادات", nav_profile: "👤 الملف الشخصي", nav_logout: "🚪 خروج",
      dm_welcome: "أهلاً بيك يا {name} 👋",
      dm_group_info_member_of: "عضو في: {list}",
      dm_group_info_none: "لسه مش منضم لأي جروب لغة",
      dm_leader_request_pending: "⏳ طلبك تبقى ليدر جروب {lang} لسه قيد المراجعة من الهيد ليدر.",
      dm_leader_request_rejected: "طلبك تبقى ليدر جروب {lang} اترفض حاليًا. تقدر تكمل كعضو عادي أو تتواصل مع الهيد ليدر.",
      stat_available: "مهام متاحة", stat_completed: "مهام مكتملة", stat_certs: "شهادات",
      dm_tasks_title: "مهام متاحة ليك",
      dm_tasks_subtitle: "افتح أي مهمة عشان تشوف فيديو الشرح، السامبل الصوتي، والسعر قبل ما تبدأ.",
      dm_no_tasks: "مفيش مهام متاحة ليك دلوقتي",
      dm_claims_title: "مهام متاحة لتسليم شغل عليها",
      dm_claims_subtitle: "مهام استلمها جروبك (أو الهيد ليدر) وتقدر ترفع شغلك عليها.",
      col_remaining_for_group: "المتبقي لجروبي",
      dm_no_claims: "مفيش مهام متاحة تسلّم عليها دلوقتي — استنى جروبك يستلم مهام جديدة",
      dm_submissions_title: "تسليماتي",
      dm_no_submissions: "لسه ماسلمتش أي شغل",
      dm_become_leader_title: "عايز تبقى ليدر؟",
      dm_become_leader_body: "لما تبقى ليدر لجروب لغة، بيتعمللك جروب جديد لوحدك تحت اللغة دي، وهتاخد رابط دعوة تبعته لأي حد عايز يشتغل معاك — وهما هينضموا لجروبك انت بالتحديد (مش أي جروب تاني في نفس اللغة). الطلب محتاج موافقة الهيد ليدر الأول.",
      dm_become_leader_btn: "اطلب تبقى ليدر",
      dm_become_leader_select_placeholder: "سجّل في لغة الأول من صفحة جروباتي",
      dm_certs_title: "شهاداتي", cert_completion_label: "شهادة إتمام",
      cert_transcription: "تفريغ صوتي", cert_translation: "ترجمة", cert_annotation: "توسيم بيانات",
    },
    en: {
      home: "Home", services: "Services", groups: "Groups", my_group: "My Group",
      login: "Log in", signup: "Sign up", dashboard: "Dashboard", logout: "Log out",
      footer_tagline: "An online-work platform connecting you with real tasks that help train the world's AI models.",
      footer_platform: "Platform", footer_services: "Services", footer_account: "Account",
      footer_about: "About", footer_contact: "Contact", footer_groups: "Groups",
      footer_login: "Log in", footer_signup: "Sign up", footer_dashboard: "Dashboard",
      rights: "All rights reserved.",

      hero_eyebrow: "Online work training the world's AI models",
      hero_title: "Help train models like Gemini and ChatGPT, from anywhere",
      hero_lead: "Nativoya connects you with real, paid tasks that help train AI models — voice recording, transcription, data annotation, translation, dubbing, subtitling, conversational data, and copywriting. Sign up, pick your languages and skills, and start receiving tasks through your group.",
      hero_cta_specialist: "Sign up & start working",
      hero_cta_tourist: "I already have an account",
      stat_guides: "Registered specialists", stat_languages: "Languages & dialects available", stat_countries: "Countries our members work from",

      dual_cta_1_title: "For anyone who wants to work online",
      dual_cta_1_body: "Sign up, pick the languages/dialects you speak and the skills you can offer, and you'll be joined into your language groups automatically — then start seeing tasks made for you.",
      dual_cta_1_btn: "Sign up now",
      dual_cta_2_title: "Already have an account?",
      dual_cta_2_body: "Open your dashboard to see tasks available to your group — every task comes with a walkthrough video, an audio sample, and its price before you start.",
      dual_cta_2_btn: "Go to dashboard",

      services_title: "Task types on the platform",
      services_subtitle: "Each task type has its own details — you'll see the video, audio sample, and price before starting any task.",
      services_cta: "See details and register now",
      featured_service_badge: "Most requested",
      other_fields_title: "More work fields on the platform",

      activity_title: "Live activity on the platform",
      activity_subtitle: "See for yourself that the platform is active every moment.",
      matching_title: "Simple, clear task distribution",
      matching_body: "The Head Leader publishes each task — either to every group, or to specific language groups only. Every task comes with a walkthrough video, an audio sample, and its price, so you can decide before you start.",
      match_pill_1: "Language match", match_pill_2: "Skill match", match_pill_3: "Top reputation",

      activity_1: "3 new members joined the French group today",
      activity_2: "12 data annotation tasks completed in the last hour",
      activity_3: "A new task was published to all groups: conversational data",
      activity_4: "A new member was activated in the Gulf Arabic group",

      signup_title: "Create a new account", signup_subtitle: "A few seconds and you're part of the Nativoya community",
      label_name: "Full name", label_email: "Email",
      label_password: "Password", hint_password: "At least 6 characters",
      label_whatsapp: "WhatsApp number", label_country: "Country", placeholder_select_country: "Select your country",
      label_gender: "Gender", gender_male: "Male", gender_female: "Female",
      label_payout: "Account/number to receive transfers",
      placeholder_payout: "Vodafone Cash / InstaPay number or PayPal email",
      hint_payout: "This is where your task earnings will be transferred.",
      label_languages: "Languages & dialects you speak",
      hint_languages: "You'll automatically join the group for each language you pick — you can pick more than one.",
      label_skills: "Skills you can offer", hint_skills: "Pick everything that applies to you.",
      btn_create_account: "Create account", btn_creating_account: "Creating...",
      already_have_account: "Already have an account?", login_link: "Log in",
      error_select_gender: "Please select your gender.",
      error_select_language: "Please select at least one language.",
      error_select_skill: "Please select at least one skill.",
      invite_join_note: "You'll automatically join the {language} group #{groupNumber}",

      service_view_details: "See details",
      services_ready_title: "Ready to start?",
      services_ready_body: "Sign up, pick your languages and skills, and start seeing tasks made for you.",
      services_seen_task_title: "Seen a task you want to start?",
      services_seen_task_body: "Go to your dashboard and see the tasks available to you right now.",
      services_go_dashboard: "Go to dashboard",

      task_back_link: "→ Back to dashboard",
      task_loading: "Loading task details...",
      task_video_title: "🎬 Walkthrough video",
      task_audio_title: "🔊 Audio sample",
      task_instructions_title: "📋 Instructions",
      task_no_instructions: "No extra instructions.",
      task_instructions_file_label: "File",
      task_price_label: "Price", task_price_unset: "Not set",
      task_member_price_label: "Member price", task_leader_price_label: "Leader price",
      task_remaining_label: "Remaining on the platform",
      task_submit_title: "📎 Submit your work on this task",
      task_submit_hint_default: "If your group has claimed some of this task, you'll be able to upload your work here.",
      task_submit_hint_no_claim: "Your group hasn't claimed any of this task yet — wait for your leader or the Head Leader to claim it first.",
      task_submit_hint_available: "{n} units are available for your group to still submit.",
      task_naming_notice: "📎 Note: your file will be automatically named: \"{name} - {whatsapp} - {gender} - original file name\" — you don't need to name it yourself, the system does this automatically.",
      task_upload_btn: "📎 Upload work", task_uploading: "⏳ Uploading...",
      task_upload_success: "✅ Your work was uploaded successfully!",
      task_video_single: "Open video", task_video_n: "Video {n}",
      task_error_default: "Couldn't load the task.",

      // shared across all dashboards
      loading_text: "Loading...", col_task: "Task", col_type: "Type", col_status: "Status",
      btn_details: "Details", btn_submit_work: "📎 Submit work",
      status_in_review: "Awaiting review", status_completed: "✅ Accepted", status_rejected: "❌ Rejected",
      dm_rejection_reason_label: "Rejection reason",

      dm_role: "Member",
      nav_home: "🏠 Home", nav_my_group: "💬 My Group", nav_tasks: "📋 Tasks",
      nav_certs: "🏆 Certificates", nav_profile: "👤 Profile", nav_logout: "🚪 Log out",
      dm_welcome: "Welcome, {name} 👋",
      dm_group_info_member_of: "Member of: {list}",
      dm_group_info_none: "You haven't joined any language group yet",
      dm_leader_request_pending: "⏳ Your request to become a leader for the {lang} group is still under review by the Head Leader.",
      dm_leader_request_rejected: "Your request to become a leader for the {lang} group was declined. You can keep working as a regular member or reach out to the Head Leader.",
      stat_available: "Available tasks", stat_completed: "Completed tasks", stat_certs: "Certificates",
      dm_tasks_title: "Tasks available to you",
      dm_tasks_subtitle: "Open any task to see the walkthrough video, audio sample, and price before you start.",
      dm_no_tasks: "No tasks available to you right now",
      dm_claims_title: "Tasks available for you to submit work on",
      dm_claims_subtitle: "Tasks your group (or the Head Leader) has claimed — you can upload your work on them.",
      col_remaining_for_group: "Remaining for my group",
      dm_no_claims: "No tasks available to submit right now — wait for your group to claim new tasks",
      dm_submissions_title: "My submissions",
      dm_no_submissions: "You haven't submitted any work yet",
      dm_become_leader_title: "Want to become a leader?",
      dm_become_leader_body: "When you become a leader for a language group, you get your own new group under that language, and an invite link you can send to anyone who wants to work with you — they'll join YOUR specific group (not just any group in that language). The request needs Head Leader approval first.",
      dm_become_leader_btn: "Request to become a leader",
      dm_become_leader_select_placeholder: "Join a language first from your groups page",
      dm_certs_title: "My certificates", cert_completion_label: "Completion certificate",
      cert_transcription: "Transcription", cert_translation: "Translation", cert_annotation: "Data Annotation",
    }
  };

  // ---- real backend API ----
  const API_BASE_URL = "https://nativoya.vercel.app";

  function authToken() { return localStorage.getItem("nm_token"); }

  // Maps raw/technical backend error strings to plain, user-facing Arabic.
  // Any backend message not listed here falls back to a generic sentence
  // instead of leaking English/technical text to end users.
  const ERROR_MESSAGES = {
    "firstName, email and password are required": "من فضلك املأ كل الحقول المطلوبة.",
    "Email already registered": "البريد الإلكتروني ده مسجّل بالفعل. جرّب تسجّل دخول أو استخدم بريد تاني.",
    "Signup failed": "حصل خطأ أثناء إنشاء الحساب. حاول تاني بعد شوية.",
    "Invalid credentials": "البريد الإلكتروني أو كلمة المرور غلط.",
    "Login failed": "حصل خطأ أثناء تسجيل الدخول. حاول تاني بعد شوية.",
    "User not found": "الحساب ده مش موجود.",
    "Could not load profile": "تعذّر تحميل بيانات الحساب. حاول تاني.",
    "Could not start a chat session": "تعذّر فتح الشات دلوقتي. حاول تاني بعد شوية.",
    "language is required": "من فضلك اختار اللغة الأول.",
    "Invite group not found": "رابط الدعوة ده مش صحيح أو الجروب مش موجود.",
    "Could not join group": "تعذّر الانضمام للجروب. حاول تاني بعد شوية.",
    "Already have a pending leader request": "عندك طلب ليدر قيد المراجعة بالفعل.",
    "Could not submit leader request": "تعذّر إرسال طلب الترقية لليدر. حاول تاني بعد شوية.",
    "Request not found or already decided": "الطلب ده مش موجود أو اتحسم فيه قبل كده.",
    "Could not approve request": "تعذّر الموافقة على الطلب. حاول تاني بعد شوية.",
    "Could not load roster": "تعذّر تحميل قائمة الأعضاء. حاول تاني.",
    "Payment not found or already transferred": "الدفعة دي مش موجودة أو اتحوّلت بالفعل.",
    "Leader has no group assigned": "الليدر ده لسه ملوش جروب متعيّن.",
    "No file was attached": "من فضلك اختار ملف قبل الرفع.",
    "Claim not found": "المهمة دي مش موجودة.",
    "This claim doesn't belong to your group": "المهمة دي مش تابعة لجروبك.",
    "Upload failed": "حصل خطأ أثناء رفع الملف. حاول تاني.",
    "Could not publish task": "تعذّر نشر المهمة. حاول تاني بعد شوية.",
    "Could not load tasks": "تعذّر تحميل المهام. حاول تاني.",
    "Could not load task": "تعذّر تحميل تفاصيل المهمة. حاول تاني.",
    "Task not found": "المهمة دي مش موجودة.",
    "Could not load your claims": "تعذّر تحميل مهامك. حاول تاني.",
    "Could not load available claims": "تعذّر تحميل المهام المتاحة. حاول تاني.",
    "Could not load the review queue": "تعذّر تحميل قائمة المراجعة. حاول تاني.",
    "Could not load your submissions": "تعذّر تحميل تسليماتك. حاول تاني.",
    "Enter a valid quantity greater than zero": "من فضلك اكتب عدد صحيح أكبر من صفر.",
    "Could not claim this task": "تعذّر استلام المهمة. حاول تاني بعد شوية.",
    "Could not submit your work": "تعذّر إرسال شغلك. حاول تاني بعد شوية.",
    "Submission not found": "التسليم ده مش موجود.",
    "Could not review this submission": "تعذّر مراجعة التسليم ده. حاول تاني.",
    "groupIds is required when targetAll is false": "اختار جروب واحد على الأقل، أو اختار \"كل الجروبات\".",
    "Forbidden — insufficient role": "الحساب ده معندوش صلاحية للإجراء ده. لو دورك اتغيّر مؤخرًا، جرّب تسجّل خروج ودخول تاني.",
    "Missing token": "لازم تسجّل دخول الأول.",
    "Invalid or expired token": "جلستك انتهت. سجّل دخول تاني.",
    "You don't lead this group": "انت مش الليدر بتاع الجروب ده.",
    "You already lead a group for this language": "انت بالفعل ليدر لجروب في اللغة دي.",
    "Could not update this task": "تعذّر تعديل المهمة. حاول تاني.",
    "Could not delete this task": "تعذّر حذف المهمة. حاول تاني.",
  };

  function friendlyErrorMessage(rawMessage) {
    if (rawMessage && ERROR_MESSAGES[rawMessage]) return ERROR_MESSAGES[rawMessage];
    // Backend messages written in Arabic (like the Firebase-not-configured
    // notice) are already user-facing, so pass them through as-is.
    if (rawMessage && /[\u0600-\u06FF]/.test(rawMessage)) return rawMessage;
    console.error("[Nativoya] Unmapped backend error:", rawMessage);
    return "حصل خطأ غير متوقع. حاول تاني بعد شوية.";
  }

  async function apiFetch(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    const token = authToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
    } catch (err) {
      console.error("[Nativoya] Network/CORS error calling", path, err);
      throw new Error("مفيش اتصال بالسيرفر دلوقتي. تأكد من اتصالك بالإنترنت وحاول تاني.");
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* empty body */ }
    if (!res.ok) {
      throw new Error(friendlyErrorMessage(data && data.error));
    }
    return data;
  }

  async function apiSignup({ firstName, email, password, whatsappNumber, country, gender, payoutIdentifier, languages, skills }) {
    const data = await apiFetch("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ firstName, email, password, whatsappNumber, country, gender, payoutIdentifier, languages, skills }),
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

  async function apiForgotPassword(email) {
    return apiFetch("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  }

  async function apiResetPassword(token, newPassword) {
    return apiFetch("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, newPassword }),
    });
  }

  async function apiJoinGroup(language, groupNumber) {
    const data = await apiFetch("/api/groups/join", {
      method: "POST",
      body: JSON.stringify({ language, groupNumber }),
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
      whatsappNumber: me.whatsapp_number, gender: me.gender, payoutIdentifier: me.payout_identifier,
      language: me.language, groupNumber: me.group_number, groupId: me.group_id,
      languages: me.languages || [], skills: me.skills || [], groups: me.groups || [],
      ledGroup: me.led_group || null, ledGroups: me.led_groups || [],
    };
    localStorage.setItem("nm_user", JSON.stringify(merged));
    return merged;
  }

  // ---- tasks ----
  function apiGetOpenTasks() { return apiFetch("/api/tasks/open"); }
  function apiGetTask(id) { return apiFetch(`/api/tasks/${id}`); }
  function apiCreateTask({ skillSlug, title, instructions, totalQuantity, memberPrice, leaderPrice, currency, videoUrls, audioSampleUrls, targetAll, groupIds }) {
    return apiFetch("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ skillSlug, title, instructions, totalQuantity, memberPrice, leaderPrice, currency, videoUrls, audioSampleUrls, targetAll, groupIds }),
    });
  }
  function apiClaimTask(taskId, quantity, groupId) {
    return apiFetch(`/api/tasks/${taskId}/claim`, {
      method: "POST",
      body: JSON.stringify({ quantity, groupId }),
    });
  }
  function apiMyClaims(groupId) { return apiFetch(`/api/tasks/claims/mine${groupId ? `?groupId=${groupId}` : ""}`); }
  function apiClaimsForMyGroup() { return apiFetch("/api/tasks/claims/for-my-group"); }
  function apiSubmitFile(claimId, fileUrl) {
    return apiFetch(`/api/tasks/claims/${claimId}/submissions`, {
      method: "POST",
      body: JSON.stringify({ fileUrl }),
    });
  }
  function apiReviewQueue(groupId) { return apiFetch(`/api/tasks/review-queue${groupId ? `?groupId=${groupId}` : ""}`); }
  function apiUpdateTask(taskId, payload) {
    return apiFetch(`/api/tasks/${taskId}`, { method: "PUT", body: JSON.stringify(payload) });
  }
  async function apiUploadTaskInstructionsFile(taskId, file) {
    const token = authToken();
    const formData = new FormData();
    formData.append("file", file);
    let res;
    try {
      res = await fetch(`${API_BASE_URL}/api/tasks/${taskId}/instructions-file`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
    } catch (err) {
      console.error("[Nativoya] Network/CORS error uploading instructions file", err);
      throw new Error("تعذر رفع الملف. تأكد من اتصالك بالإنترنت وحاول تاني.");
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* empty body */ }
    if (!res.ok) throw new Error(friendlyErrorMessage(data && data.error));
    return data;
  }
  function apiDeleteTask(taskId) {
    return apiFetch(`/api/tasks/${taskId}`, { method: "DELETE" });
  }
  function apiGetAllTasks() { return apiFetch("/api/tasks/manage"); }
  function apiGetTaskClaims(taskId) { return apiFetch(`/api/tasks/${taskId}/claims`); }
  function apiReviewSubmission(submissionId, approve, reason) {
    return apiFetch(`/api/tasks/submissions/${submissionId}/review`, {
      method: "POST",
      body: JSON.stringify({ approve, reason }),
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
  function apiGetRoster(groupId) { return apiFetch(`/api/groups/roster${groupId ? `?groupId=${groupId}` : ""}`); }

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
      console.error("[Nativoya] Network/CORS error uploading file", err);
      throw new Error("تعذر رفع الملف. تأكد من اتصالك بالإنترنت وحاول تاني.");
    }
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error(friendlyErrorMessage(data && data.error) || "حصل خطأ أثناء رفع الملف، حاول تاني.");
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
    document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
      const key = el.getAttribute("data-i18n-placeholder");
      if (dict[key]) el.setAttribute("placeholder", dict[key]);
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
    const dashboardPath = user
      ? user.role === "head_leader" ? "pages/dashboard-admin.html"
        : user.role === "leader" ? "pages/dashboard-leader.html"
        : "pages/dashboard-member.html"
      : null;

    const accountActions = user
      ? `<a href="${rel(dashboardPath)}" class="btn btn-secondary" data-i18n="dashboard">لوحتي</a>
         <a href="#" class="btn btn-primary" data-i18n="logout" onclick="NM.mockLogout(); location.href='${rel('index.html')}'; return false;">خروج</a>`
      : `<a href="${rel('pages/login.html')}" class="btn btn-secondary" data-i18n="login">تسجيل الدخول</a>
         <a href="${rel('pages/signup.html')}" class="btn btn-primary" data-i18n="signup">إنشاء حساب</a>`;

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
          ${accountActions}
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
            <p data-i18n="footer_tagline" class="text-muted" style="max-width:280px;">منصة عمل أونلاين تربطك بمهام حقيقية في تدريب نماذج الذكاء الاصطناعي العالمية.</p>
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

  // dialects/languages a member can pick at signup — each becomes its own group
  // `name` is the CANONICAL value — it's what gets saved as a group's
  // language in the database and must never change with the UI language.
  // `en` is ONLY a display label for when the site is switched to English.
  const LANGUAGES = [
    { name: "العربية (مصرية)", en: "Arabic (Egyptian)", code: "AR-EG" },
    { name: "العربية (خليجية)", en: "Arabic (Gulf)", code: "AR-GULF" },
    { name: "العربية (شامية)", en: "Arabic (Levantine)", code: "AR-LEV" },
    { name: "العربية (مغاربية)", en: "Arabic (Maghrebi)", code: "AR-MAG" },
    { name: "العربية (تونسية)", en: "Arabic (Tunisian)", code: "AR-TN" },
    { name: "العربية (جزائرية)", en: "Arabic (Algerian)", code: "AR-DZ" },
    { name: "العربية (ليبية)", en: "Arabic (Libyan)", code: "AR-LY" },
    { name: "العربية (سودانية)", en: "Arabic (Sudanese)", code: "AR-SD" },
    { name: "العربية (يمنية)", en: "Arabic (Yemeni)", code: "AR-YE" },
    { name: "العربية الفصحى (MSA)", en: "Arabic (MSA)", code: "AR-MSA" },
    { name: "الإنجليزية (بريطانية)", en: "English (UK)", code: "EN-GB" },
    { name: "الإنجليزية (أمريكية)", en: "English (US)", code: "EN-US" },
    { name: "الفرنسية", en: "French", code: "FR" },
    { name: "الإسبانية", en: "Spanish", code: "ES" },
    { name: "الألمانية", en: "German", code: "DE" },
    { name: "الإيطالية", en: "Italian", code: "IT" },
    { name: "البرتغالية", en: "Portuguese", code: "PT" },
    { name: "الروسية", en: "Russian", code: "RU" },
    { name: "التركية", en: "Turkish", code: "TR" },
    { name: "الصينية", en: "Chinese", code: "ZH" },
    { name: "اليابانية", en: "Japanese", code: "JA" },
    { name: "الكورية", en: "Korean", code: "KO" },
    { name: "الهندية", en: "Hindi", code: "HI" },
    { name: "الأردية", en: "Urdu", code: "UR" },
    { name: "الفارسية", en: "Persian", code: "FA" },
  ];

  // the 8 AI-training skills a member can offer at signup (alias of SERVICES,
  // kept as its own name so signup forms read cleanly)
  const SKILLS = SERVICES;

  // countries dropdown for signup. COUNTRIES stays the canonical value saved
  // to the database (unchanged, always Arabic) — COUNTRIES_EN is the exact
  // same list, same order, ONLY used to show an English label when the site
  // is switched to English.
  const COUNTRIES = [
    "مصر", "السعودية", "الإمارات", "الكويت", "قطر", "البحرين", "عمان",
    "الأردن", "لبنان", "سوريا", "العراق", "فلسطين", "اليمن",
    "المغرب", "الجزائر", "تونس", "ليبيا", "السودان", "موريتانيا",
    "الولايات المتحدة", "المملكة المتحدة", "كندا", "فرنسا", "ألمانيا",
    "إسبانيا", "إيطاليا", "تركيا", "الهند", "باكستان", "أخرى",
  ];
  const COUNTRIES_EN = [
    "Egypt", "Saudi Arabia", "UAE", "Kuwait", "Qatar", "Bahrain", "Oman",
    "Jordan", "Lebanon", "Syria", "Iraq", "Palestine", "Yemen",
    "Morocco", "Algeria", "Tunisia", "Libya", "Sudan", "Mauritania",
    "United States", "United Kingdom", "Canada", "France", "Germany",
    "Spain", "Italy", "Turkey", "India", "Pakistan", "Other",
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
    init, setLang, getLang, toggleMobileNav, SERVICES, SKILLS, LANGUAGES, COUNTRIES, COUNTRIES_EN, seedCounters,
    currentUser, mockSignup, mockLogout, rel, t, joinLanguageGroup,
    generateInviteCode, resolveInviteCode, inviteUrl,
    // real API
    apiSignup, apiLogin, apiForgotPassword, apiResetPassword, apiJoinGroup, apiRefreshMe, authToken, apiFetch,
    apiGetOpenTasks, apiGetTask, apiCreateTask, apiUpdateTask, apiUploadTaskInstructionsFile, apiDeleteTask, apiGetAllTasks, apiGetTaskClaims,
    apiClaimTask, apiMyClaims, apiClaimsForMyGroup,
    apiSubmitFile, apiUploadSubmission, apiReviewQueue, apiReviewSubmission, apiMySubmissions,
    apiGetGroups, apiGetRoster,
    apiRequestLeadership, apiMyLeaderRequest, apiPendingLeaderRequests,
    apiApproveLeaderRequest, apiRejectLeaderRequest,
    apiGetGoogleStatus, apiGoogleConnectUrl,
    apiGetPendingPayments, apiCreatePayment, apiMarkTransferred,
  };
})();

document.addEventListener("DOMContentLoaded", () => NM.init());
