"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const NS = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK = 7 * DAY;
  const LS_KEY = "nafas.v3", LS_OLD = ["nafas.v2", "nafas.v1"], LS_IOS = "nafas.iosHint", LS_THEME = "nafas.theme";
  const STATE_CACHE = "nafas-state", STATE_URL = "./__state.json";

  /* ================= data ================= */
  const MILESTONES = [
    { ms: 20 * MIN, when: "٢٠ دقيقة", t: "النبض وضغط الدم يبدون ينزلون" },
    { ms: 12 * HOUR, when: "١٢ ساعة", t: "أول أكسيد الكربون بالدم يرجع لمستواه الطبيعي" },
    { ms: 2 * DAY, when: "يومين", t: "النيكوتين يطلع من جسمك، والشم والتذوق يتحسنون" },
    { ms: 3 * DAY, when: "٣ أيام", t: "التنفس أسهل والشعب الهوائية ترتخي" },
    { ms: 14 * DAY, when: "أسبوعين", t: "الدورة الدموية تتحسن والمشي أخف" },
    { ms: 90 * DAY, when: "٣ شهور", t: "وظائف الرئة تتحسن بشكل واضح" },
    { ms: 270 * DAY, when: "٩ شهور", t: "الكحة وضيق النفس يقلّون كثير" },
    { ms: 365 * DAY, when: "سنة", t: "خطر أمراض القلب التاجية صار نص خطر المدخن" },
    { ms: 5 * 365 * DAY, when: "٥ سنوات", t: "خطر الجلطة الدماغية ينزل بشكل كبير" },
    { ms: 10 * 365 * DAY, when: "١٠ سنوات", t: "خطر سرطان الرئة تقريباً نص خطر المدخن" },
    { ms: 15 * 365 * DAY, when: "١٥ سنة", t: "خطر أمراض القلب مثل اللي عمره ما دخّن" }
  ];

  const BADGES = [
    { kind: "time", v: DAY, m: "١", n: "أول يوم" },
    { kind: "time", v: 3 * DAY, m: "٣", n: "٣ أيام" },
    { kind: "time", v: 7 * DAY, m: "٧", n: "أسبوع" },
    { kind: "time", v: 14 * DAY, m: "١٤", n: "أسبوعين" },
    { kind: "time", v: 30 * DAY, m: "٣٠", n: "شهر" },
    { kind: "time", v: 90 * DAY, m: "٩٠", n: "٣ شهور" },
    { kind: "time", v: 182 * DAY, m: "½", n: "نص سنة" },
    { kind: "time", v: 365 * DAY, m: "١س", n: "سنة كاملة" },
    { kind: "money", v: 10, m: "١٠", n: "أول ١٠" },
    { kind: "money", v: 50, m: "٥٠", n: "وفّرت ٥٠" },
    { kind: "money", v: 100, m: "١٠٠", n: "وفّرت ١٠٠" },
    { kind: "money", v: 500, m: "٥٠٠", n: "وفّرت ٥٠٠" },
    { kind: "crave", v: 1, m: "١", n: "أول رغبة قاومتها" },
    { kind: "crave", v: 10, m: "١٠", n: "١٠ رغبات" },
    { kind: "crave", v: 50, m: "٥٠", n: "٥٠ رغبة" },
    { kind: "log", v: 7, m: "٧", n: "سجّلت ٧ رغبات بالتفصيل" }
  ];

  const TRIGGERS = [
    { k: "coffee", n: "قهوة/شاي", tip: "غيّر روتين القهوة أسبوعين: مكان ثاني، كوب ثاني، أو مشروب بداله." },
    { k: "meal", n: "بعد الأكل", tip: "بعد الأكل على طول قوم من مكانك، تسوّك، أو امشِ خمس دقايق." },
    { k: "stress", n: "توتر", tip: "التوتر يعدّي أسرع مع التنفس. افتح تمرين التنفس أول ما تحس فيه." },
    { k: "bored", n: "ملل", tip: "جهّز شي يشغل يدك ووقتك: لعبة على الجوال، مسبحة، أو مشوار قصير." },
    { k: "car", n: "بالسيارة", tip: "خلّ بالسيارة علك أو حب شمسي، وشغّل شي تحبه تسمعه." },
    { k: "friends", n: "مع الربع", tip: "قول للربع إنك وقفت، واقعد بعيد عن اللي يدخنون أول كم أسبوع." },
    { k: "wake", n: "بعد الصحيان", tip: "أول ما تصحى اشرب ماي وغيّر ترتيب صباحك عن أيام التدخين." },
    { k: "angry", n: "زعل", tip: "لما تزعل اطلع من المكان دقيقتين وتنفّس، الرغبة تخف مع الوقت." },
    { k: "work", n: "الدوام", tip: "استراحة الدوام بدون سيجارة: امشِ، اشرب شي، أو كلّم أحد." },
    { k: "phone", n: "جوال/سوشال", tip: "حط الجوال بعيد شوي لما تحس بالرغبة، وغيّر نشاطك." },
    { k: "other", n: "غيره", tip: "" }
  ];
  const TRIG = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(TRIGGERS.map(t => [t.k, t]))));
  const isTrig = k => typeof k === "string" && Object.prototype.hasOwnProperty.call(TRIG, k);

  const HOUR_BUCKETS = ["١٢–٣ ف", "٣–٦ ص", "٦–٩ ص", "٩–١٢ ظ", "١٢–٣ ظ", "٣–٦ ع", "٦–٩ م", "٩–١٢ ل"];
  const HOUR_NAMES = ["بعد نص الليل", "الفجر", "الصبح", "قبل الظهر", "الظهر", "العصر", "المغرب", "الليل"];

  const TIPS = [
    "اشرب كوب ماي بارد ببطء.",
    "قوم امشِ خمس دقايق، حتى لو داخل البيت.",
    "الرغبة موجة، ترتفع وتنزل. أنت بس اركبها.",
    "كل رغبة تقاومها تضعّف اللي بعدها.",
    "شغّل يدك بشي: جوالك، قلم، مسبحة.",
    "تسوّك أو اغسل أسنانك، طعم النظافة يطفّي الرغبة."
  ];

  // NRT plans per common product leaflets
  const NRT = Object.assign(Object.create(null), {
    patch: {
      n: "لزقات", unit: "لزقة", doses: [["21", "٢١ ملغ"], ["14", "١٤ ملغ"], ["7", "٧ ملغ"]], max: 1,
      plan: dose => {
        const all = [{ d: "لزقة ٢١ ملغ", s: "لزقة وحدة باليوم", w: 6 }, { d: "لزقة ١٤ ملغ", s: "لزقة وحدة باليوم", w: 2 }, { d: "لزقة ٧ ملغ", s: "لزقة وحدة باليوم", w: 2 }];
        if (dose === "14") return [{ ...all[1], w: 6 }, all[2]];
        if (dose === "7") return [{ ...all[2], w: 4 }];
        return all;
      }
    },
    gum: {
      n: "علك", unit: "قطعة", doses: [["2", "٢ ملغ"], ["4", "٤ ملغ"]], max: 24,
      plan: () => [{ d: "قطعة كل ١–٢ ساعة", s: "على الأقل ٩ باليوم، والحد الأعلى ٢٤", w: 6 },
        { d: "قطعة كل ٢–٤ ساعات", s: "خفّف تدريجياً", w: 3 }, { d: "قطعة كل ٤–٨ ساعات", s: "بعدها وقّف", w: 3 }]
    },
    lozenge: {
      n: "أقراص مص", unit: "قرص", doses: [["2", "٢ ملغ"], ["4", "٤ ملغ"]], max: 20,
      plan: () => [{ d: "قرص كل ١–٢ ساعة", s: "على الأقل ٩ باليوم، والحد الأعلى ٢٠", w: 6 },
        { d: "قرص كل ٢–٤ ساعات", s: "خفّف تدريجياً", w: 3 }, { d: "قرص كل ٤–٨ ساعات", s: "بعدها وقّف", w: 3 }]
    },
    vape: { n: "فيب", unit: "مرة", doses: null, max: 0, plan: null }
  });

  /* ================= storage ================= */
  function readLS(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function writeLS(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } }

  const clampNum = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
  const cleanStr = (v, max) => (typeof v === "string" ? v : "").replace(/[\u0000-\u0008\u000B-\u001F<>]/g, "").trim().slice(0, max);
  const validTs = (t, now) => Number.isFinite(t) && t > Date.UTC(1950, 0, 1) && t <= now + DAY;

  function sanitize(raw) {
    if (!raw || typeof raw !== "object") return null;
    const now = Date.now();
    const quit = Number(raw.quit);
    if (!validTs(quit, now) || quit > now + MIN) return null;

    const cravings = (Array.isArray(raw.cravings) ? raw.cravings : []).map(c => {
      if (typeof c === "number") return { t: c, trig: [], int: 0, note: "" };
      if (!c || typeof c !== "object") return null;
      return {
        t: Number(c.t),
        trig: (Array.isArray(c.trig) ? c.trig : []).filter(isTrig).slice(0, 11),
        int: Math.round(clampNum(c.int, 0, 5, 0)),
        note: cleanStr(c.note, 140)
      };
    }).filter(c => c && validTs(c.t, now)).sort((a, b) => a.t - b.t).slice(-5000);

    const attempts = (Array.isArray(raw.attempts) ? raw.attempts : [])
      .filter(a => a && validTs(+a.start, now) && validTs(+a.end, now)).map(a => ({ start: +a.start, end: +a.end })).slice(-200);

    const reasons = (Array.isArray(raw.reasons) ? raw.reasons : []).map(r => cleanStr(r, 120)).filter(Boolean).slice(0, 12);
    const photo = typeof raw.photo === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(raw.photo) && raw.photo.length < 1.5e6 ? raw.photo : "";

    const n = raw.nrt && typeof raw.nrt === "object" ? raw.nrt : {};
    const type = NRT[n.type] ? n.type : "none";
    const doseOk = type !== "none" && NRT[type].doses && NRT[type].doses.some(d => d[0] === n.dose);
    const nrt = {
      type,
      start: validTs(+n.start, now) ? +n.start : 0,
      dose: doseOk ? n.dose : (type !== "none" && NRT[type].doses ? NRT[type].doses[0][0] : ""),
      target: Math.round(clampNum(n.target, 0, 500, 0)),
      logs: (Array.isArray(n.logs) ? n.logs : []).map(Number).filter(t => validTs(t, now)).slice(-20000)
    };

    const r = raw.rem && typeof raw.rem === "object" ? raw.rem : {};
    const rem = {
      on: !!r.on, ms: !!r.ms,
      time: typeof r.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time) ? r.time : "21:00",
      lastDaily: typeof r.lastDaily === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.lastDaily) ? r.lastDaily : "",
      seenMs: Math.round(clampNum(r.seenMs, -1, 99, -1)),
      seenBadges: typeof r.seenBadges === "string" && /^[tf]{0,40}$/.test(r.seenBadges) ? r.seenBadges : ""
    };

    return {
      v: 3, quit,
      perDay: clampNum(raw.perDay, 1, 200, 20),
      packSize: clampNum(raw.packSize, 1, 100, 20),
      price: clampNum(raw.price, 0, 1000, 0),
      cur: cleanStr(raw.cur, 6) || "د.ك",
      goalName: cleanStr(raw.goalName, 40),
      goalAmt: clampNum(raw.goalAmt, 0, 1e7, 0),
      best: clampNum(raw.best, 0, 1e13, 0),
      cravings, attempts, reasons, photo, nrt, rem
    };
  }

  function loadStored() {
    for (const k of [LS_KEY, ...LS_OLD]) {
      const s = readLS(k); if (!s) continue;
      try { const st = sanitize(JSON.parse(s)); if (st) return st; } catch { /* ignore */ }
    }
    return null;
  }

  function example() {
    const now = Date.now();
    const keys = ["coffee", "meal", "stress", "car", "bored", "coffee", "friends", "meal", "coffee", "stress"];
    const hours = [8, 14, 21, 17, 22, 9, 20, 13, 7, 23];
    const cr = []; let s = 7;
    for (let d = 9; d >= 0; d--) {
      const n = Math.max(1, 6 - Math.floor((9 - d) * 0.55));
      for (let i = 0; i < n; i++) {
        s = (s * 31 + 7) % 97;
        const day = new Date(now - d * DAY); day.setHours(hours[(s + i) % 10], (s * 7) % 60, 0, 0);
        if (day.getTime() < now) cr.push({ t: day.getTime(), trig: [keys[(s + i) % 10]].concat(s % 3 === 0 ? [keys[(s + 3) % 10]] : []), int: 1 + (s + d) % 5, note: "" });
      }
    }
    return sanitize({ quit: now - (9 * DAY + 5 * HOUR + 17 * MIN), perDay: 20, packSize: 20, price: 1.25, cur: "د.ك",
      goalName: "سفرة لندن", goalAmt: 300, cravings: cr, reasons: ["عشان صحتي ونفَسي", "عشان عيالي", "أبي أوفّر فلوس السفرة"],
      nrt: { type: "none" } });
  }

  let state = null, isExample = false;

  function persist() {
    if (isExample) return;
    if (!writeLS(LS_KEY, JSON.stringify(state))) toast("ما قدرت أحفظ. تأكد إن المتصفح مو بالوضع الخاص، أو صغّر الصورة.");
    writeSnapshot();
  }

  /* ================= format ================= */
  const fmtMoney = v => v.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const fmtInt = v => Math.floor(v).toLocaleString("en-US");
  function fmtDur(ms) {
    const d = Math.floor(ms / DAY);
    if (d >= 1) return `${fmtInt(d)} يوم`;
    const h = Math.floor(ms / HOUR); if (h >= 1) return `${h} ساعة`;
    return `${Math.max(0, Math.floor(ms / MIN))} دقيقة`;
  }
  const pad = n => String(n).padStart(2, "0");
  const toLocalInput = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const toDateInput = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayStart = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const fmtWhen = t => {
    const d = new Date(t), today = dayStart();
    const time = d.toLocaleTimeString("ar-KW", { hour: "numeric", minute: "2-digit" });
    if (t >= today) return `اليوم ${time}`;
    if (t >= today - DAY) return `أمس ${time}`;
    return `${d.toLocaleDateString("ar-KW", { weekday: "long", day: "numeric", month: "long" })} ${time}`;
  };

  function calc() {
    const elapsed = Math.max(0, Date.now() - state.quit);
    const cigs = elapsed / DAY * state.perDay;
    const saved = cigs * (state.price / state.packSize);
    const since = state.cravings.filter(c => c.t >= state.quit);
    return { el: elapsed, cigs, saved, resisted: since.length, detailed: since.filter(c => c.trig.length || c.int).length };
  }

  /* ================= toast ================= */
  let toastTimer;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
  }
  function guard() {
    if (!isExample) return true;
    toast("احفظ بياناتك أول من الإعدادات.");
    go("settings");
    return false;
  }

  /* ================= router ================= */
  const VIEWS = ["home", "journal", "nrt", "health", "settings"];
  let current = "home";
  function go(v) { if (location.hash !== "#" + v) location.hash = v; else show(v); }
  function show(v) {
    if (!VIEWS.includes(v)) v = "home";
    current = v;
    document.querySelectorAll(".view").forEach(s => { s.hidden = s.dataset.view !== v; });
    document.querySelectorAll(".tabbar a").forEach(a => {
      if (a.dataset.tab === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    window.scrollTo(0, 0);
    if (v === "journal") renderJournal();
    if (v === "nrt") renderNrt();
    if (v === "health") { lastTlKey = ""; lastBadgeKey = ""; render(); }
  }
  window.addEventListener("hashchange", () => show(location.hash.slice(1)));
  $("openSettings").addEventListener("click", () => go("settings"));
  $("closeSettings").addEventListener("click", () => { if (history.length > 1) history.back(); else go("home"); });
  $("demoBanner").addEventListener("click", () => go("settings"));

  /* ================= home ================= */
  function fillForm() {
    $("f_quit").value = toLocalInput(new Date(state.quit));
    $("f_perDay").value = state.perDay; $("f_packSize").value = state.packSize;
    $("f_price").value = state.price; $("f_cur").value = state.cur;
    $("f_goalName").value = state.goalName; $("f_goalAmt").value = state.goalAmt || "";
    $("remOn").checked = state.rem.on; $("remMs").checked = state.rem.ms; $("remTime").value = state.rem.time;
  }

  function render() {
    if (!state) return;
    const { el: elapsed, cigs, saved } = calc();
    const days = Math.floor(elapsed / DAY), rem = elapsed - days * DAY;
    $("days").textContent = fmtInt(days);
    $("clock").textContent = `${pad(Math.floor(rem / HOUR))}:${pad(Math.floor(rem % HOUR / MIN))}:${pad(Math.floor(rem % MIN / 1000))}`;

    const cur = state.cur;
    $("saved").textContent = fmtMoney(saved); $("cur1").textContent = cur;
    const daily = state.perDay * state.price / state.packSize;
    $("proj").textContent = `يعني ${fmtMoney(daily * 30.44)} ${cur} بالشهر، و${fmtInt(daily * 365)} ${cur} بالسنة`;
    $("cigs").textContent = fmtInt(cigs);
    $("packs").textContent = (cigs / state.packSize).toLocaleString("en-US", { maximumFractionDigits: 1 });
    $("life").textContent = fmtDur(cigs * 11 * MIN);
    $("best").textContent = fmtDur(Math.max(state.best, elapsed));

    const nextIdx = MILESTONES.findIndex(m => elapsed < m.ms);
    const prevMs = nextIdx <= 0 ? 0 : MILESTONES[nextIdx - 1].ms;
    const frac = nextIdx === -1 ? 1 : (elapsed - prevMs) / (MILESTONES[nextIdx].ms - prevMs);
    $("ringProg").style.strokeDashoffset = String(578 * (1 - frac));
    $("nextMs").textContent = nextIdx === -1 ? "وصلت كل المراحل الصحية. فخر." :
      `باقي ${fmtDur(MILESTONES[nextIdx].ms - elapsed)} على: ${MILESTONES[nextIdx].t}`;

    const gAmt = state.goalAmt;
    $("goalCard").hidden = !(gAmt > 0);
    if (gAmt > 0) {
      const pct = Math.min(100, saved / gAmt * 100);
      $("goalTitle").textContent = state.goalName ? `هدفك: ${state.goalName}` : "هدفك";
      $("goalBar").style.width = pct.toFixed(1) + "%";
      $("goalPct").textContent = pct.toFixed(1) + "%";
      if (saved >= gAmt) $("goalLeft").textContent = "تحقق الهدف!";
      else {
        const left = gAmt - saved;
        $("goalLeft").textContent = `باقي ${fmtMoney(left)} ${cur}` + (daily > 0 ? ` · تقريباً ${fmtInt(Math.ceil(left / daily))} يوم` : "");
      }
    }
    if (current === "health") { renderTimeline(elapsed); renderBadges(); }
  }

  let lastTlKey = "";
  function renderTimeline(elapsed) {
    const key = MILESTONES.map(m => elapsed >= m.ms ? "d" : Math.floor(Math.min(1, elapsed / m.ms) * 100)).join(",");
    if (key === lastTlKey) return; lastTlKey = key;
    const ol = $("timeline"); ol.replaceChildren();
    const firstFuture = MILESTONES.findIndex(m => elapsed < m.ms);
    MILESTONES.forEach((m, i) => {
      const done = elapsed >= m.ms;
      const li = el("li", done ? "done" : (i === firstFuture ? "now" : "future"));
      const box = el("div");
      box.append(el("div", "when", m.when), el("div", "t", m.t));
      if (!done && i === firstFuture) {
        const mini = el("div", "mini"), bar = el("i");
        bar.style.width = Math.min(100, elapsed / m.ms * 100).toFixed(1) + "%";
        mini.append(bar); box.append(mini);
      }
      li.append(el("span", "dot"), box); ol.append(li);
    });
  }

  function badgeFlags(c = calc()) {
    return BADGES.map(b => b.kind === "time" ? c.el >= b.v : b.kind === "money" ? c.saved >= b.v : b.kind === "crave" ? c.resisted >= b.v : c.detailed >= b.v);
  }
  const badgeName = b => b.kind === "money" ? `${b.n} ${state.cur}` : b.n;

  let lastBadgeKey = "";
  function renderBadges() {
    const flags = badgeFlags();
    const key = flags.map(f => f ? "t" : "f").join("") + state.cur;
    if (key === lastBadgeKey) return; lastBadgeKey = key;
    const ul = $("badges"); ul.replaceChildren();
    BADGES.forEach((b, i) => {
      const li = el("li", "badge" + (flags[i] ? " on" : "") + (b.kind === "time" ? " health" : ""));
      const name = badgeName(b);
      li.append(el("span", "medal", b.m), el("span", null, name));
      li.setAttribute("aria-label", (flags[i] ? "حصلت عليه: " : "مقفل: ") + name);
      ul.append(li);
    });
    $("badgeCount").textContent = `${flags.filter(Boolean).length} من ${BADGES.length}`;
  }

  function renderCravingCounts() {
    const now = Date.now(), t0 = dayStart();
    const cr = state.cravings;
    $("cravToday").textContent = cr.filter(c => c.t >= t0).length;
    $("cravWeek").textContent = cr.filter(c => c.t >= now - 7 * DAY).length;
    $("cravTotal").textContent = cr.filter(c => c.t >= state.quit).length;
  }

  function renderAttempts() {
    const n = state.attempts.length;
    $("attempts").textContent = n ? `هذي محاولتك رقم ${n + 1}. كل محاولة تقرّبك.` : "";
  }

  /* ================= reasons ================= */
  function renderReasons() {
    const ul = $("reasonList"); ul.replaceChildren();
    state.reasons.forEach(r => ul.append(el("li", null, r)));
    const img = $("reasonPhoto");
    if (state.photo) { img.src = state.photo; img.hidden = false; } else { img.removeAttribute("src"); img.hidden = true; }
    $("reasonsEmpty").hidden = !!(state.reasons.length || state.photo);
    $("removePhoto").hidden = !pendingPhoto;
  }
  let pendingPhoto = "";
  $("editReasons").addEventListener("click", () => {
    if (!guard()) return;
    const ed = $("reasonEditor"); ed.hidden = !ed.hidden;
    if (!ed.hidden) { $("reasonText").value = state.reasons.join("\n"); pendingPhoto = state.photo; $("removePhoto").hidden = !pendingPhoto; $("reasonText").focus(); }
  });
  $("reasonPhotoInput").addEventListener("change", async e => {
    const f = e.target.files && e.target.files[0]; e.target.value = "";
    if (!f) return;
    if (!/^image\//.test(f.type) || f.size > 25 * 1024 * 1024) return toast("اختار صورة (أقل من ٢٥ ميغا).");
    try {
      pendingPhoto = await shrinkImage(f, 720, 0.8);
      $("reasonPhoto").src = pendingPhoto; $("reasonPhoto").hidden = false; $("removePhoto").hidden = false;
      toast("اضغط «احفظ» عشان تنحفظ الصورة.");
    } catch { toast("ما قدرت أفتح الصورة. جرّب صورة ثانية."); }
  });
  $("removePhoto").addEventListener("click", () => { pendingPhoto = ""; $("reasonPhoto").hidden = true; $("removePhoto").hidden = true; });
  $("saveReasons").addEventListener("click", () => {
    const list = $("reasonText").value.split("\n").map(r => cleanStr(r, 120)).filter(Boolean).slice(0, 12);
    const next = sanitize({ ...state, reasons: list, photo: pendingPhoto });
    if (!next) return;
    state = next; persist();
    $("reasonEditor").hidden = true; renderReasons(); toast("انحفظت أسبابك ✓");
  });
  function shrinkImage(file, max, q) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        let out = c.toDataURL("image/jpeg", q);
        if (out.length > 1.4e6) out = c.toDataURL("image/jpeg", 0.6);
        out.length < 1.5e6 ? resolve(out) : reject(new Error("big"));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("load")); };
      img.src = url;
    });
  }

  /* ================= settings form ================= */
  function setStatus(id, msg, err) { const s = $(id); s.textContent = msg; s.classList.toggle("err", !!err); }

  $("form").addEventListener("submit", e => {
    e.preventDefault();
    const q = new Date($("f_quit").value).getTime();
    if (!Number.isFinite(q)) return setStatus("status", "حدد تاريخ ووقت آخر سيجارة.", true);
    if (q > Date.now()) return setStatus("status", "التاريخ لازم يكون قبل الحين.", true);
    const perDay = +$("f_perDay").value, packSize = +$("f_packSize").value, price = +$("f_price").value;
    if (!(perDay > 0) || !(packSize > 0) || !($("f_price").value !== "" && price >= 0))
      return setStatus("status", "عبّي عدد السجاير وحجم العلبة والسعر.", true);
    const base = isExample ? { best: 0, cravings: [], attempts: [], reasons: [], photo: "", nrt: { type: "none" }, rem: state.rem } : state;
    const next = sanitize({ ...base, quit: q, perDay, packSize, price, cur: $("f_cur").value, goalName: $("f_goalName").value, goalAmt: $("f_goalAmt").value });
    if (!next) return setStatus("status", "في قيمة مو منطقية، راجع البيانات.", true);
    const wasExample = isExample;
    load(next, false);
    markSeen();
    persist();
    setStatus("status", "انحفظ ✓");
    setTimeout(() => { setStatus("status", ""); if (wasExample) go("home"); }, 900);
  });

  /* ================= relapse ================= */
  $("relapseBtn").addEventListener("click", () => { if (!guard()) return; $("relapseBox").hidden = false; $("relapseBtn").hidden = true; });
  $("relapseNo").addEventListener("click", () => { $("relapseBox").hidden = true; $("relapseBtn").hidden = false; });
  $("relapseYes").addEventListener("click", () => {
    const now = Date.now(), elapsed = now - state.quit;
    const next = sanitize({ ...state, best: Math.max(state.best, elapsed), quit: now, attempts: [...state.attempts, { start: state.quit, end: now }] });
    load(next, false); markSeen(); persist();
    $("relapseBox").hidden = true; $("relapseBtn").hidden = false;
    toast("بدأنا من جديد. أنت قدها.");
  });

  /* ================= breathing ================= */
  const PHASES = [{ n: "شهيق", s: 4, scale: 1 }, { n: "اكتم", s: 4, scale: 1 }, { n: "زفير", s: 6, scale: .6 }];
  const TOTAL = 60;
  let bTimer = null, bStart = 0, lastFocus = null;

  function breathTick() {
    const elapsed = (Date.now() - bStart) / 1000;
    const cycle = PHASES.reduce((a, p) => a + p.s, 0);
    let t = ((elapsed % cycle) + cycle) % cycle, idx = 0;
    while (t >= PHASES[idx].s) { t -= PHASES[idx].s; idx++; }
    const p = PHASES[idx];
    $("breathPhase").textContent = p.n;
    $("breathCount").textContent = Math.ceil(p.s - t);
    const c = $("breathCircle");
    if (c.dataset.phase !== String(idx)) {
      c.dataset.phase = String(idx);
      c.style.transitionDuration = p.s + "s";
      c.style.transform = `scale(${p.scale})`;
    }
    $("breathBar").style.width = Math.min(100, Math.max(0, elapsed) / TOTAL * 100) + "%";
    if (elapsed >= TOTAL && !breathEnded) { breathEnded = true; setTip(null, "خلصت دقيقة. كيف الرغبة الحين؟"); }
  }
  let breathEnded = false;
  function setTip(lead, text) {
    const tip = $("breathTip"); tip.replaceChildren();
    if (lead) tip.append(lead, document.createElement("br"));
    tip.append(el("b", null, text));
  }
  function openBreath() {
    lastFocus = document.activeElement; breathEnded = false;
    const c = $("breathCircle"); c.style.transitionDuration = "0s"; c.style.transform = "scale(.6)"; delete c.dataset.phase;
    if (state.reasons.length && Math.random() < 0.65) setTip("تذكّر ليش وقفت:", state.reasons[Math.floor(Math.random() * state.reasons.length)]);
    else setTip(null, TIPS[Math.floor(Math.random() * TIPS.length)]);
    const ph = $("breathPhoto");
    if (state.photo) { ph.src = state.photo; ph.hidden = false; } else ph.hidden = true;
    $("breath").hidden = false;
    bStart = Date.now() + 50;
    requestAnimationFrame(() => { breathTick(); bTimer = setInterval(breathTick, 250); });
    $("breathDone").focus();
  }
  function closeBreath(resisted) {
    clearInterval(bTimer); bTimer = null;
    $("breath").hidden = true;
    if (resisted) { if (isExample) toast("احفظ بياناتك أول عشان تنحسب الرغبات."); else openLog(); }
    else if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  $("cravingBtn").addEventListener("click", openBreath);
  $("breathDone").addEventListener("click", () => closeBreath(true));
  $("breathClose").addEventListener("click", () => closeBreath(false));

  /* ================= craving log ================= */
  const chipBox = $("trigChips");
  TRIGGERS.forEach(t => {
    const b = el("button", "chip", t.n); b.type = "button"; b.dataset.k = t.k; b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true"));
    chipBox.append(b);
  });
  const scaleBox = $("intScale");
  for (let i = 1; i <= 5; i++) {
    const b = el("button", i >= 4 ? "hi" : "", String(i)); b.type = "button"; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", "false"); b.dataset.v = String(i);
    b.setAttribute("aria-label", `الشدة ${i} من 5`);
    b.addEventListener("click", () => scaleBox.querySelectorAll("button").forEach(x => x.setAttribute("aria-checked", String(x === b))));
    scaleBox.append(b);
  }
  function openLog() {
    chipBox.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed", "false"));
    scaleBox.querySelectorAll("button").forEach(x => x.setAttribute("aria-checked", "false"));
    $("logNote").value = "";
    $("logSheet").hidden = false;
    chipBox.querySelector(".chip").focus();
  }
  function saveCraving(entry) {
    state.cravings.push(entry);
    persist();
    renderCravingCounts();
    if (current === "journal") renderJournal();
    checkAchievements();
  }
  $("logForm").addEventListener("submit", e => {
    e.preventDefault();
    const trig = [...chipBox.querySelectorAll('.chip[aria-pressed="true"]')].map(c => c.dataset.k);
    const sel = scaleBox.querySelector('[aria-checked="true"]');
    saveCraving({ t: Date.now(), trig, int: sel ? +sel.dataset.v : 0, note: cleanStr($("logNote").value, 140) });
    $("logSheet").hidden = true;
    toast("قاومتها وانسجلت. عاش!");
  });
  $("logCancel").addEventListener("click", () => {
    saveCraving({ t: Date.now(), trig: [], int: 0, note: "" });
    $("logSheet").hidden = true;
    toast("قاومتها. عاش!");
  });
  $("logCravingBtn").addEventListener("click", () => { if (guard()) openLog(); });

  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (!$("breath").hidden) closeBreath(false);
    else if (!$("logSheet").hidden) $("logSheet").hidden = true;
  });

  /* ================= journal ================= */
  let entryLimit = 15;
  function barChart(svg, counts, opts = {}) {
    svg.replaceChildren();
    const H = opts.h || 70, W = 280, n = counts.length, bw = W / n;
    const max = Math.max(opts.min || 4, opts.target || 0, ...counts);
    svg.append(svgEl("line", { x1: 0, x2: W, y1: H - 1, y2: H - 1, class: "gridline" }));
    counts.forEach((c, i) => {
      const h = c === 0 ? 2 : Math.max(3, c / max * (H - 8));
      const x = (n - 1 - i) * bw + 3; // RTL: today at left edge
      const r = svgEl("rect", { x: x.toFixed(1), width: (bw - 6).toFixed(1), y: (H - 1 - h).toFixed(1), height: h.toFixed(1), rx: 2,
        class: "barmark" + (c === 0 ? " zero" : i === n - 1 ? " today" : "") });
      const tt = svgEl("title", {}); tt.textContent = String(c); r.append(tt); svg.append(r);
    });
    if (opts.target) {
      const y = (H - 1 - opts.target / max * (H - 8)).toFixed(1);
      svg.append(svgEl("line", { x1: 0, x2: W, y1: y, y2: y, class: "tline" }));
    }
  }
  const dailyCounts = (times, days) => {
    const t0 = dayStart();
    return Array.from({ length: days }, (_, i) => { const a = t0 - (days - 1 - i) * DAY, b = a + DAY; return times.filter(t => t >= a && t < b).length; });
  };

  function renderJournal() {
    if (!state) return;
    const now = Date.now(), cr = state.cravings;
    barChart($("cravChart"), dailyCounts(cr.map(c => c.t), 14));

    const wk = cr.filter(c => c.t >= now - 7 * DAY), prev = cr.filter(c => c.t >= now - 14 * DAY && c.t < now - 7 * DAY);
    const rated = wk.filter(c => c.int);
    let note = `عدد الرغبات هالأسبوع: ${wk.length}`;
    if (prev.length) {
      const diff = Math.round((wk.length - prev.length) / prev.length * 100);
      note += diff < 0 ? `، أقل ${Math.abs(diff)}٪ من الأسبوع اللي قبله.` : diff > 0 ? `، أكثر ${diff}٪ من الأسبوع اللي قبله.` : `، نفس الأسبوع اللي قبله.`;
    } else note += ".";
    if (rated.length) note += ` متوسط الشدة ${(rated.reduce((a, c) => a + c.int, 0) / rated.length).toFixed(1)} من ٥.`;
    $("trendNote").textContent = note;

    // triggers (30 days)
    const recent = cr.filter(c => c.t >= now - 30 * DAY);
    const counts = {};
    recent.forEach(c => c.trig.forEach(k => { counts[k] = (counts[k] || 0) + 1; }));
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const ul = $("trigBars"); ul.replaceChildren();
    const tmax = ranked.length ? ranked[0][1] : 1;
    ranked.forEach(([k, n]) => {
      const li = el("li"), tr = el("div", "track"), bar = el("i");
      bar.style.width = (n / tmax * 100).toFixed(1) + "%"; tr.append(bar);
      li.append(el("span", null, TRIG[k].n), tr, el("span", "n num", String(n)));
      ul.append(li);
    });
    $("trigEmpty").hidden = ranked.length > 0;
    const tagged = recent.filter(c => c.trig.length).length;
    if (ranked.length && TRIG[ranked[0][0]].tip && recent.filter(c => c.trig.length).length >= 3) {
      const pct = Math.round(ranked[0][1] / Math.max(1, tagged) * 100);
      $("trigInsight").textContent = `«${TRIG[ranked[0][0]].n}» وراء ${pct}٪ من رغباتك. ${TRIG[ranked[0][0]].tip}`;
      $("trigInsight").hidden = false;
    } else $("trigInsight").hidden = true;

    // hours
    const hb = Array(8).fill(0);
    recent.forEach(c => { hb[Math.floor(new Date(c.t).getHours() / 3)]++; });
    const hmax = Math.max(1, ...hb), peak = hb.indexOf(Math.max(...hb));
    const box = $("hourBars"); box.replaceChildren();
    hb.forEach((n, i) => {
      const col = el("div", "col" + (n && i === peak ? " peak" : "")), cb = el("div", "colbar"), bar = el("i");
      bar.style.height = (n / hmax * 100).toFixed(1) + "%"; cb.append(bar);
      col.append(el("span", "cn num", String(n)), cb, el("span", "cl", HOUR_BUCKETS[i]));
      col.setAttribute("aria-label", `${HOUR_NAMES[i]}: ${n}`);
      box.append(col);
    });
    if (recent.length >= 3 && hb[peak]) {
      $("hourInsight").textContent = `أكثر وقت تجيك فيه الرغبة: ${HOUR_NAMES[peak]} (${HOUR_BUCKETS[peak]}). جهّز بديلك قبل هالوقت: ماي، علك، أو مشي.`;
      $("hourInsight").hidden = false;
    } else $("hourInsight").hidden = true;

    // entries
    const list = $("entries"); list.replaceChildren();
    const all = cr.slice().reverse();
    $("entryCount").textContent = all.length ? `${fmtInt(all.length)} تسجيل` : "";
    all.slice(0, entryLimit).forEach(c => {
      const li = el("li");
      const dot = el("span", "int-dot num" + (c.int >= 4 ? " hi" : ""), c.int ? String(c.int) : "–");
      dot.setAttribute("aria-label", c.int ? `الشدة ${c.int}` : "بدون شدة");
      const main = el("div", "entry-main");
      main.append(el("div", "entry-when", fmtWhen(c.t)));
      if (c.trig.length) { const tg = el("div", "entry-tags"); c.trig.forEach(k => tg.append(el("span", null, TRIG[k].n))); main.append(tg); }
      if (c.note) main.append(el("div", "entry-note", c.note));
      if (!c.trig.length && !c.note) main.append(el("div", "entry-note muted", "قاومتها"));
      const del = el("button", "btn icon", "احذف"); del.type = "button";
      del.addEventListener("click", () => {
        if (isExample) return guard();
        if (del.dataset.armed) {
          const idx = state.cravings.indexOf(c);
          if (idx > -1) state.cravings.splice(idx, 1);
          persist(); renderJournal(); renderCravingCounts();
        } else {
          del.dataset.armed = "1"; del.textContent = "متأكد؟";
          setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = "احذف"; } }, 3000);
        }
      });
      li.append(dot, main, del); list.append(li);
    });
    if (!all.length) list.append(el("li", "muted", "ما في تسجيلات للحين."));
    $("moreEntries").hidden = all.length <= entryLimit;
  }
  $("moreEntries").addEventListener("click", () => { entryLimit += 30; renderJournal(); });

  /* ================= NRT ================= */
  function setSeg(box, v) { box.querySelectorAll("button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.v === v))); }
  let nrtDraftType = null;
  $("nrtType").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (!guard()) return;
    const v = b.dataset.v;
    if (v === "none") {
      state.nrt = { ...state.nrt, type: "none" }; persist(); nrtDraftType = null; renderNrt(); return;
    }
    nrtDraftType = v; setSeg($("nrtType"), v); fillNrtForm(v);
  });
  function fillNrtForm(type) {
    const cfg = NRT[type];
    $("nrtForm").hidden = false;
    const same = state.nrt.type === type;
    $("nrtStart").value = toDateInput(new Date(same && state.nrt.start ? state.nrt.start : Date.now()));
    $("nrtStart").max = toDateInput(new Date());
    const sel = $("nrtDose"); sel.replaceChildren();
    $("nrtDoseWrap").hidden = !cfg.doses;
    if (cfg.doses) cfg.doses.forEach(([v, n]) => { const o = el("option", null, n); o.value = v; sel.append(o); });
    if (cfg.doses) sel.value = same && state.nrt.dose ? state.nrt.dose : (type === "patch" ? (state.perDay > 10 ? "21" : "14") : cfg.doses[0][0]);
    $("nrtTargetWrap").hidden = type !== "vape";
    $("nrtTarget").value = same && state.nrt.target ? state.nrt.target : "";
  }
  $("nrtForm").addEventListener("submit", e => {
    e.preventDefault();
    const type = nrtDraftType || state.nrt.type;
    const parts = $("nrtStart").value.split("-").map(Number);
    const start = parts.length === 3 ? new Date(parts[0], parts[1] - 1, parts[2]).getTime() : NaN;
    if (!Number.isFinite(start) || start > Date.now()) return setStatus("nrtStatus", "حدد تاريخ بداية صحيح.", true);
    if (type === "vape" && !($("nrtTarget").value !== "" && +$("nrtTarget").value >= 0)) return setStatus("nrtStatus", "حط هدفك اليومي.", true);
    const keepLogs = state.nrt.type === type ? state.nrt.logs : [];
    const next = sanitize({ ...state, nrt: { type, start, dose: $("nrtDose").value, target: $("nrtTarget").value, logs: keepLogs } });
    if (!next) return;
    state = next; persist(); nrtDraftType = null;
    setStatus("nrtStatus", "انحفظ ✓"); setTimeout(() => setStatus("nrtStatus", ""), 1500);
    renderNrt();
  });

  function nrtStep(plan, start) {
    const weeks = (Date.now() - start) / WEEK;
    let acc = 0;
    for (let i = 0; i < plan.length; i++) {
      if (weeks < acc + plan[i].w) return { i, weekIn: Math.floor(weeks - acc) + 1, left: Math.ceil((acc + plan[i].w) * WEEK - (Date.now() - start)) };
      acc += plan[i].w;
    }
    return { i: plan.length, weekIn: 0, left: 0 };
  }

  function renderNrt() {
    if (!state) return;
    const n = state.nrt, type = nrtDraftType || n.type;
    setSeg($("nrtType"), type);
    if (!nrtDraftType) {
      $("nrtForm").hidden = type === "none";
      if (type !== "none") fillNrtForm(type);
    }
    const active = n.type !== "none" && !nrtDraftType;
    $("nrtPlanCard").hidden = !active || !NRT[n.type].plan;
    $("nrtLogCard").hidden = !active;
    if (!active) return;
    const cfg = NRT[n.type];

    if (cfg.plan) {
      const plan = cfg.plan(n.dose), st = nrtStep(plan, n.start);
      const ol = $("nrtSteps"); ol.replaceChildren();
      let acc = 0;
      plan.forEach((p, i) => {
        const li = el("li", i === st.i ? "cur" : i < st.i ? "past" : "");
        const txt = el("div"); txt.append(el("div", "sd", p.d), el("div", "ss", p.s));
        li.append(el("span", "sn num", String(i + 1)), txt, el("span", "sw num", `أسبوع ${acc + 1}–${acc + p.w}`));
        acc += p.w; ol.append(li);
      });
      if (st.i >= plan.length) {
        $("nrtStepPill").textContent = "خلصت الخطة";
        $("nrtPlanNote").textContent = "خلصت مدة الخطة. المفروض توقف البديل الحين، وإذا تحتاج تمديد استشر الصيدلي.";
      } else {
        $("nrtStepPill").textContent = `المرحلة ${st.i + 1} · الأسبوع ${st.weekIn}`;
        $("nrtPlanNote").textContent = st.i + 1 < plan.length ? `باقي ${fmtDur(st.left)} وتنتقل لـ «${plan[st.i + 1].d}».` : `باقي ${fmtDur(st.left)} وتخلص الخطة.`;
      }
    }

    const t0 = dayStart();
    const today = n.logs.filter(t => t >= t0).length;
    $("nrtToday").textContent = today;
    $("nrtUnit").textContent = cfg.unit + " اليوم";
    $("nrtLogTitle").textContent = `${cfg.n}: اليوم`;
    const lim = n.type === "vape" ? n.target : cfg.max;
    const wrap = $("nrtBarWrap");
    wrap.hidden = !lim;
    if (lim) {
      $("nrtBar").style.width = Math.min(100, today / lim * 100).toFixed(1) + "%";
      wrap.classList.toggle("over", today > lim);
      $("nrtLogSub").textContent = n.type === "vape" ? `هدفك ${lim} باليوم` : `الحد الأعلى ${lim} باليوم`;
    } else $("nrtLogSub").textContent = "";
    barChart($("nrtChart"), dailyCounts(n.logs, 14), { h: 60, min: 2, target: n.type === "vape" ? n.target : 0 });
  }
  $("nrtPlus").addEventListener("click", () => {
    if (!guard()) return;
    state.nrt.logs.push(Date.now()); persist(); renderNrt();
    const n = state.nrt, cfg = NRT[n.type], lim = n.type === "vape" ? n.target : cfg.max;
    const today = n.logs.filter(t => t >= dayStart()).length;
    if (lim && today > lim) toast(n.type === "vape" ? "تعديت هدفك اليوم. بكرة يوم جديد." : "تعديت الحد الأعلى بالنشرة. استشر الصيدلي.");
  });
  $("nrtMinus").addEventListener("click", () => {
    if (!guard()) return;
    const t0 = dayStart(), logs = state.nrt.logs;
    for (let i = logs.length - 1; i >= 0; i--) if (logs[i] >= t0) { logs.splice(i, 1); break; }
    persist(); renderNrt();
  });

  /* ================= notifications & reminders ================= */
  const canNotify = () => "Notification" in window;
  function renderNotifState() {
    const s = $("notifState");
    if (!canNotify()) { s.textContent = "متصفحك ما يدعم الإشعارات. على الآيفون ثبّت التطبيق على الشاشة الرئيسية أول، أو استخدم التقويم."; return; }
    const p = Notification.permission;
    s.textContent = p === "granted" ? "الإشعارات مفعّلة. التذكير يوصلك لما يكون التطبيق مفتوح أو بالخلفية، وعلى أندرويد حتى لو مسكّر (حسب الجهاز)."
      : p === "denied" ? "الإشعارات مرفوضة من المتصفح. فعّلها من إعدادات الموقع، أو استخدم التقويم."
      : "";
  }
  async function ensurePermission() {
    if (!canNotify()) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    try { return (await Notification.requestPermission()) === "granted"; } catch { return false; }
  }
  async function notify(title, body, tag) {
    if (canNotify() && Notification.permission === "granted") {
      try {
        const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
        const opts = { body, tag, lang: "ar", dir: "rtl", icon: "icons/icon-192.png", badge: "icons/icon-192.png" };
        if (reg) { await reg.showNotification(title, opts); return; }
        new Notification(title, opts); return;
      } catch { /* fall through */ }
    }
    toast(`${title}: ${body}`);
  }
  function dailyMessage() {
    const { el: e, saved } = calc();
    return `صار لك ${fmtInt(e / DAY)} يوم بدون تدخين ووفّرت ${fmtMoney(saved)} ${state.cur}. كمّل!`;
  }
  async function onRemChange() {
    if (!guard()) { fillForm(); return; }
    const on = $("remOn").checked, ms = $("remMs").checked;
    if ((on || ms) && !(await ensurePermission())) toast("الإشعارات مو متاحة، بيوصلك التذكير داخل التطبيق. للتذكير المضمون استخدم التقويم.");
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test($("remTime").value) ? $("remTime").value : "21:00";
    state.rem = { ...state.rem, on, ms, time };
    if (ms) markSeen();
    persist(); renderNotifState(); registerPeriodic(); runChecks();
  }
  ["remOn", "remMs", "remTime"].forEach(id => $(id).addEventListener("change", onRemChange));

  function markSeen() {
    const c = calc();
    state.rem.seenMs = MILESTONES.filter(m => c.el >= m.ms).length;
    state.rem.seenBadges = badgeFlags(c).map(f => f ? "t" : "f").join("");
  }

  function checkAchievements() {
    if (isExample || !state) return;
    const c = calc();
    const ms = MILESTONES.filter(m => c.el >= m.ms).length;
    const flags = badgeFlags(c).map(f => f ? "t" : "f").join("");
    const r = state.rem;
    if (r.seenMs < 0 || r.seenBadges.length !== flags.length) { markSeen(); persist(); return; }
    let changed = false;
    if (ms > r.seenMs) {
      const m = MILESTONES[ms - 1];
      r.ms ? notify(`نَفَس · ${m.when}`, m.t, "ms") : toast(`مرحلة جديدة: ${m.t}`);
      r.seenMs = ms; changed = true;
    }
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "t" && r.seenBadges[i] !== "t") {
        const name = badgeName(BADGES[i]);
        r.ms ? notify("نَفَس · وسام جديد", name, "badge" + i) : toast(`وسام جديد: ${name}`);
        changed = true;
      }
    }
    r.seenBadges = flags;
    if (changed) { persist(); lastBadgeKey = ""; }
  }

  // pick up what the background worker already notified
  async function mergeSnapshot() {
    if (isExample || !state) return;
    const snap = await readSnapshot();
    if (!snap || snap.quit !== state.quit) return;
    if (snap.lastDaily && snap.lastDaily > state.rem.lastDaily) state.rem.lastDaily = snap.lastDaily;
    if (Number.isFinite(snap.seenMs) && snap.seenMs > state.rem.seenMs) state.rem.seenMs = snap.seenMs;
  }
  async function runChecks() { await mergeSnapshot(); checkAchievements(); checkDaily(); }

  function checkDaily() {
    if (isExample || !state || !state.rem.on) return;
    const now = new Date(), today = toDateInput(now);
    const [h, m] = state.rem.time.split(":").map(Number);
    if (state.rem.lastDaily === today) return;
    if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return;
    state.rem.lastDaily = today; persist();
    notify("نَفَس", dailyMessage(), "daily");
  }

  // snapshot the SW can read for background reminders (Android periodic sync)
  async function writeSnapshot() {
    if (!("caches" in window) || isExample || !state) return;
    try {
      const snap = { quit: state.quit, perDay: state.perDay, packSize: state.packSize, price: state.price, cur: state.cur,
        rem: { on: state.rem.on, ms: state.rem.ms, time: state.rem.time }, lastDaily: state.rem.lastDaily, seenMs: state.rem.seenMs };
      const c = await caches.open(STATE_CACHE);
      await c.put(STATE_URL, new Response(JSON.stringify(snap), { headers: { "Content-Type": "application/json" } }));
    } catch { /* ignore */ }
  }
  async function readSnapshot() {
    if (!("caches" in window)) return null;
    try { const c = await caches.open(STATE_CACHE); const r = await c.match(STATE_URL); return r ? await r.json() : null; } catch { return null; }
  }
  async function registerPeriodic() {
    try {
      const reg = await navigator.serviceWorker?.ready;
      if (!reg || !("periodicSync" in reg)) return;
      if (state.rem.on || state.rem.ms) {
        const st = await navigator.permissions.query({ name: "periodic-background-sync" });
        if (st.state === "granted") await reg.periodicSync.register("nafas-daily", { minInterval: 6 * HOUR });
      } else await reg.periodicSync.unregister("nafas-daily");
    } catch { /* unsupported */ }
  }

  /* ---------- calendar (.ics) ---------- */
  const icsEsc = s => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const icsLocal = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
  const icsUtc = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  $("icsBtn").addEventListener("click", () => {
    if (!guard()) return;
    const now = new Date(), stamp = icsUtc(now), uid = Math.random().toString(36).slice(2);
    const [h, m] = state.rem.time.split(":").map(Number);
    const first = new Date(); first.setHours(h, m, 0, 0); if (first < now) first.setDate(first.getDate() + 1);
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//nafas//ar", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:نَفَس",
      "BEGIN:VEVENT", `UID:daily-${uid}@nafas`, `DTSTAMP:${stamp}`, `DTSTART:${icsLocal(first)}`, "DURATION:PT5M", "RRULE:FREQ=DAILY",
      `SUMMARY:${icsEsc("نَفَس: يوم جديد بدون تدخين")}`, `DESCRIPTION:${icsEsc("افتح نَفَس وشوف إنجازك. إذا جتك رغبة، تنفّس دقيقة.")}`,
      "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEsc("نَفَس")}`, "TRIGGER:PT0M", "END:VALARM", "END:VEVENT"];
    const items = [
      ...MILESTONES.map(x => ({ at: state.quit + x.ms, s: `نَفَس: ${x.when} بدون تدخين`, d: x.t })),
      ...BADGES.filter(b => b.kind === "time").map(b => ({ at: state.quit + b.v, s: `نَفَس: وسام «${b.n}»`, d: "وصلت مرحلة جديدة. افتح التطبيق وشوف وسامك." }))
    ].filter(x => x.at > now.getTime()).sort((a, b) => a.at - b.at)
      .filter((x, i, arr) => !i || Math.abs(x.at - arr[i - 1].at) > HOUR).slice(0, 12);
    items.forEach((x, i) => {
      lines.push("BEGIN:VEVENT", `UID:ms-${i}-${uid}@nafas`, `DTSTAMP:${stamp}`, `DTSTART:${icsLocal(new Date(x.at))}`, "DURATION:PT15M",
        `SUMMARY:${icsEsc(x.s)}`, `DESCRIPTION:${icsEsc(x.d)}`, "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEsc(x.s)}`, "TRIGGER:PT0M", "END:VALARM", "END:VEVENT");
    });
    lines.push("END:VCALENDAR");
    download(new Blob([lines.join("\r\n") + "\r\n"], { type: "text/calendar;charset=utf-8" }), "nafas-reminders.ics");
    toast("نزل ملف التقويم. افتحه وأضفه لتقويمك.");
  });

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  /* ================= backup ================= */
  $("exportBtn").addEventListener("click", () => {
    if (isExample) return setStatus("backupStatus", "احفظ بياناتك أول.", true);
    download(new Blob([JSON.stringify({ app: "nafas", exported: new Date().toISOString(), data: state })], { type: "application/json" }),
      `nafas-backup-${toDateInput(new Date())}.json`);
    setStatus("backupStatus", "نزلت النسخة ✓");
  });
  $("importFile").addEventListener("change", async e => {
    const f = e.target.files && e.target.files[0]; e.target.value = "";
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return setStatus("backupStatus", "الملف كبير، مو نسخة من نَفَس.", true);
    try {
      const j = JSON.parse(await f.text());
      const s = sanitize(j && j.app === "nafas" ? j.data : j);
      if (!s) throw new Error("bad");
      load(s, false); persist();
      setStatus("backupStatus", "رجعت بياناتك ✓");
    } catch { setStatus("backupStatus", "الملف مو نسخة صحيحة من نَفَس.", true); }
  });

  /* ================= share ================= */
  $("shareBtn").addEventListener("click", async () => {
    const { el: e, saved } = calc();
    const text = `صار لي ${fmtInt(e / DAY)} يوم بدون تدخين، ووفّرت ${fmtMoney(saved)} ${state.cur}.`;
    const url = location.origin + location.pathname;
    try { if (navigator.share) { await navigator.share({ title: "نَفَس", text, url }); return; } }
    catch (err) { if (err && err.name === "AbortError") return; }
    try { await navigator.clipboard.writeText(`${text}\n${url}`); toast("انسخ النص، الصقه وين ما تبي."); }
    catch { toast(text); }
  });

  /* ================= theme ================= */
  function applyTheme(v) {
    if (v === "light" || v === "dark") document.documentElement.setAttribute("data-theme", v);
    else document.documentElement.removeAttribute("data-theme");
    setSeg($("themeSeg"), v || "system");
  }
  applyTheme(readLS(LS_THEME));
  $("themeSeg").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    writeLS(LS_THEME, b.dataset.v); applyTheme(b.dataset.v);
  });

  /* ================= PWA ================= */
  let deferredPrompt = null;
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredPrompt = e; if (!standalone) $("installBanner").hidden = false; });
  $("installBtn").addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch { /* ignore */ }
    deferredPrompt = null; $("installBanner").hidden = true;
  });
  window.addEventListener("appinstalled", () => { $("installBanner").hidden = true; toast("تم التثبيت ✓"); });
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isIOS && !standalone && !readLS(LS_IOS)) $("iosHint").hidden = false;
  $("iosHintClose").addEventListener("click", () => { $("iosHint").hidden = true; writeLS(LS_IOS, "1"); });

  const secure = location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if ("serviceWorker" in navigator && secure) {
    window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").then(() => registerPeriodic()).catch(() => {}); });
  }

  /* ================= boot ================= */
  function load(s, ex) {
    state = s; isExample = !!ex;
    $("demoBanner").hidden = !ex; $("relapseBtn").hidden = !!ex;
    nrtDraftType = null; $("reasonEditor").hidden = true;
    fillForm(); lastTlKey = ""; lastBadgeKey = "";
    render(); renderCravingCounts(); renderAttempts(); renderReasons(); renderNotifState();
    if (current === "journal") renderJournal();
    if (current === "nrt") renderNrt();
  }

  const stored = loadStored();
  load(stored || example(), !stored);
  if (stored && !readLS(LS_KEY)) persist(); // migrate older versions
  show(location.hash.slice(1) || "home");
  runChecks();
  setInterval(render, 1000);
  setInterval(runChecks, 30e3);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    render(); renderCravingCounts(); runChecks();
    if (current === "nrt") renderNrt();
  });
})();
