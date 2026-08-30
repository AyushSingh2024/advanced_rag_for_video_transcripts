"use strict";

/* ------------------------------------------------------------------ state */
const state = {
  curriculum: null,
  lessons: [],
  modules: [],
  position: 0,
  citedOrders: new Set(),
  conversationId: null,
  history: [],
};

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

function announce(message) { $("sr-status").textContent = message; }

/* --------------------------------------------------- greeting and streak ---
 * Two quiet facts, stated once, in the smallest type on the page. There is no
 * milestone toast and no celebration animation any more: a study tool that
 * congratulates you for dragging a slider is a study tool you stop reading.
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 5) return "Late session.";
  if (hour < 12) return "Good morning.";
  if (hour < 17) return "Good afternoon.";
  if (hour < 22) return "Good evening.";
  return "Late session.";
}

function updateStreak() {
  const badge = $("streak-badge");
  const today = new Date().toDateString();
  const lastVisit = localStorage.getItem("vla-last-visit");
  let streak = Number.parseInt(localStorage.getItem("vla-streak") || "0", 10) || 0;

  if (!lastVisit) {
    streak = 1;
  } else {
    // Both sides are midnight, so this counts calendar days rather than hours.
    // The previous version compared "now" against midnight, which meant an
    // 11pm session followed by a 1am one read as the same day.
    const days = Math.floor((new Date(today) - new Date(lastVisit)) / 86400000);
    if (days === 1) streak += 1;
    else if (days > 1 || streak < 1) streak = 1;
  }

  localStorage.setItem("vla-last-visit", today);
  localStorage.setItem("vla-streak", String(streak));

  // A one-day streak is just "today", which is not worth a line of type.
  badge.textContent = streak > 1 ? `${streak} days running` : "";
  badge.style.display = streak > 1 ? "inline" : "none";
}

/* ------------------------------------------------------------------ API */
async function api(path, options) {
  let response;
  try {
    response = await fetch(path, options);
  } catch (cause) {
    throw new Error(`Cannot reach the server at ${location.origin}. Is \`npm run serve\` still running?`);
  }
  const body = await response.text();
  let parsed = null;
  try { parsed = body ? JSON.parse(body) : null; } catch { /* non-JSON error page */ }
  if (!response.ok) {
    throw new Error(parsed?.error ? `${parsed.error}${parsed.message ? ` — ${parsed.message}` : ""}` : `${response.status} ${response.statusText}`);
  }
  return parsed;
}

function errorCard(error, hints) {
  return `<div class="card"><div class="error"><strong>Oops, that didn't work.</strong> ${esc(error.message)}
    ${hints?.length ? `<ul>${hints.map((hint) => `<li>${hint}</li>`).join("")}</ul>` : ""}</div></div>`;
}

/* ------------------------------------------------------------------ health */
async function loadHealth() {
  const pills = [];
  try {
    const response = await fetch("/health");
    const health = await response.json();
    pills.push(`<span class="pill ${health.postgres ? "ok" : "bad"}"><i class="dot"></i>Postgres</span>`);
    pills.push(`<span class="pill ${health.qdrant ? "ok" : "bad"}"><i class="dot"></i>Qdrant</span>`);
  } catch {
    pills.push('<span class="pill bad"><i class="dot"></i>server unreachable</span>');
  }
  try {
    const probe = await api("/concepts?kind=core&limit=1");
    const ok = Array.isArray(probe.concepts) && probe.concepts.length > 0;
    pills.push(`<span class="pill ${ok ? "ok" : "bad"}"><i class="dot"></i>concept graph</span>`);
  } catch {
    pills.push('<span class="pill bad"><i class="dot"></i>concept graph</span>');
  }
  $("health").innerHTML = pills.join("");
}

/* ------------------------------------------------------------------ spine */
async function loadCurriculum() {
  const view = await api("/curriculum");
  state.curriculum = view;
  state.lessons = view.lessons ?? [];
  state.modules = view.modules ?? [];

  const indexed = view.course?.indexedLessons;
  $("course-meta").innerHTML = `${esc(view.course?.title ?? "Course")} · ${state.lessons.length} lessons · ${esc(view.course?.duration ?? "")}`
    + (indexed == null ? "" : ` · <span style="color:var(--vla-${indexed === state.lessons.length ? "ok" : "alarm"})">${indexed} indexed</span>`);

  $("position").max = String(state.lessons.length);

  renderSpine();
  renderStarters();
}

function renderSpine() {
  const total = state.lessons.length;
  if (!total) {
    $("rail").innerHTML = '<div class="empty">No curriculum yet — run <code>npm run curriculum</code>.</div>';
    return;
  }

  $("modules").innerHTML = state.modules.map((module) => {
    const count = state.lessons.filter((lesson) => lesson.moduleOrder === module.order).length;
    const name = module.bonus ? "B" : String(module.order);
    return `<div class="module-label" style="flex:${count} 1 0" title="${esc(module.title)}">${esc(name)}</div>`;
  }).join("");

  $("rail").innerHTML = state.modules.map((module) => {
    const inModule = state.lessons.filter((lesson) => lesson.moduleOrder === module.order);
    const ticks = inModule.map((lesson) => {
      const classes = ["tick"];
      if (state.position > 0 && lesson.order <= state.position) classes.push("reached");
      if (state.position === lesson.order) classes.push("here");
      if (state.citedOrders.has(lesson.order)) {
        classes.push("cited");
        if (state.position > 0 && lesson.order > state.position) classes.push("ahead");
      }
      return `<button class="${classes.join(" ")}" data-order="${lesson.order}"
        title="${esc(lesson.label)} — ${esc(lesson.title)} (${esc(lesson.duration)})"
        aria-label="Set position to ${esc(lesson.label)}"></button>`;
    }).join("");
    return `<div class="rail-module" style="flex:${inModule.length} 1 0">${ticks}</div>`;
  }).join("");

  const current = state.lessons.find((lesson) => lesson.order === state.position);
  $("position-readout").innerHTML = state.position === 0
    ? "Searching the whole course — no spoiler filter"
    : `You are up to <strong>${esc(current?.label ?? `lesson ${state.position}`)}</strong> · ${state.position} of ${total}`;
  $("position").value = String(state.position);
}

function setPosition(order) {
  state.position = Math.max(0, Math.min(Number(order) || 0, state.lessons.length));
  renderSpine();
  if (location.hash !== `#lesson=${state.position}`) {
    history.replaceState(null, "", state.position ? `#lesson=${state.position}` : location.pathname);
  }
}

/* ------------------------------------------------------------------ ask */
function renderStarters() {
  const starters = [
    ["ask", "How do I store an auth token securely?"],
    ["plan", "What should I watch before building a login screen?"],
    ["catch_up", "Catch me up on everything so far."],
    ["ask", "How does file-based routing work?"],
    ["quiz", "Quiz me on what I have covered."],
  ];
  $("starters").innerHTML = starters
    .map(([mode, text], index) => `<button class="chip" data-starter="${index}" data-mode="${mode}">${esc(text)}</button>`)
    .join("");
  $("starters").querySelectorAll("[data-starter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      $("question").value = chip.textContent;
      $("mode").value = chip.dataset.mode;
      $("question").focus();
    });
  });
}

function scopeOf(lessonOrder) {
  if (state.position === 0 || lessonOrder == null) return "unbounded";
  if (lessonOrder > state.position) return "ahead";
  if (lessonOrder === state.position) return "current";
  return "covered";
}

function locator(citation) {
  const scope = scopeOf(citation.lessonOrder);
  const chapter = citation.lessonLabel ?? citation.sourceTitle ?? "source";
  const time = citation.startTime == null ? null : formatTime(citation.startTime);

  if (scope === "ahead") {
    return `<span class="loc ahead" title="You have not reached this lesson yet, so it is named but not timed.">${esc(chapter)}</span>`;
  }

  const text = scope === "current" && time ? time : [chapter, time].filter(Boolean).join(" · ");
  const source = citation.sourceTitle ? `<span class="who">${esc(citation.sourceTitle)}</span>` : "";
  const pop = citation.quote || citation.sourceTitle
    ? `<span class="cite-pop" role="tooltip">${source}${citation.quote ? `“${esc(citation.quote)}”` : ""}</span>`
    : "";
  return `<span class="loc" tabindex="0">${esc(text)}${pop}</span>`;
}

function renderAnswer(text, citations) {
  const byNumber = new Map((citations ?? []).map((citation) => [citation.number, citation]));
  const resolveMarkers = (value) => value.replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g, (whole, group) => {
    const chips = group.split(",").map((part) => byNumber.get(Number(part.trim()))).filter(Boolean).map(locator);
    return chips.length ? chips.join("") : whole;
  });

  const blocks = esc(text).trim().split(/\n{2,}/);
  return blocks.map((block) => {
    const lines = block.split("\n");
    const bulleted = lines.every((line) => /^\s*[-*•]\s+/.test(line));
    const numbered = lines.every((line) => /^\s*\d+[.)]\s+/.test(line));
    const inline = (value) => resolveMarkers(value
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>"));
    if (bulleted || numbered) {
      const items = lines.map((line) => `<li>${inline(line.replace(/^\s*([-*•]|\d+[.)])\s+/, ""))}</li>`).join("");
      return bulleted ? `<ul>${items}</ul>` : `<ol>${items}</ol>`;
    }
    return `<p>${inline(lines.join("<br>"))}</p>`;
  }).join("");
}

function renderResult(payload) {
  const banner = payload.insufficientContext
    ? `<div class="banner thin">The pipeline judged the retrieved material insufficient and said so rather than guessing.</div>`
    : "";

  /* One notice, and only when it says something the locators cannot. How many
   * citations sit past your playhead is worth a sentence, because it explains
   * why those ones carry no timestamp. "Everything is covered" needs no banner:
   * the locators are already ember, which is the same information for free. */
  const ahead = (payload.citations ?? []).filter((citation) => scopeOf(citation.lessonOrder) === "ahead").length;
  const aheadBanner = ahead > 0 && !payload.insufficientContext
    ? `<div class="banner ahead">${ahead} citation${ahead === 1 ? "" : "s"} ${ahead === 1 ? "sits" : "sit"} past where you have watched, so ${
        ahead === 1 ? "it is" : "they are"} named without a timestamp or a quote.</div>`
    : "";

  const metrics = [
    ["score", payload.score ?? "—"],
    ["attempts", payload.attempts ?? "—"],
    ["bound", payload.upToLesson == null ? "whole course" : `≤ lesson ${payload.upToLesson}`],
    ["citations", payload.citations?.length ?? 0],
    ...(payload.lookahead?.lessonLabel ? [["introduced in", payload.lookahead.lessonLabel]] : []),
  ].map(([key, value]) => `<span class="pill">${key} <strong>${esc(value)}</strong></span>`).join("");

  return `<div class="card">
    ${banner}
    ${aheadBanner}
    <div class="answer">${renderAnswer(payload.answer ?? "", payload.citations)}</div>
    <details class="trace">
      <summary>Retrieval trace and grading</summary>
      <div class="metrics">${metrics}</div>
      <pre>${esc(JSON.stringify({ grade: payload.grade, trace: payload.trace }, null, 2))}</pre>
    </details>
  </div>`;
}

async function ask() {
  const question = $("question").value.trim();
  if (!question) { $("question").focus(); return; }

  const button = $("ask");
  button.disabled = true;
  // A sentence naming the actual stages, rather than three bouncing dots and a
  // shimmering fake answer. It tells you why the wait is what it is.
  $("ask-hint").textContent = "Retrieving, grading, checking citations…";
  $("answer-slot").innerHTML = '<div class="card"><div class="empty">Working on it.</div></div>';
  announce("Working on your question.");

  const body = {
    question,
    mode: $("mode").value,
    conversationId: state.conversationId ?? undefined,
    history: state.history.slice(-8),
  };
  if (state.position > 0) body.upToLesson = state.position;

  try {
    const payload = await api("/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    state.conversationId = payload.conversationId ?? state.conversationId;
    state.history.push({ role: "user", content: question });
    state.history.push({ role: "assistant", content: payload.answer ?? "" });
    $("clear-thread").hidden = false;

    const orders = [...new Set((payload.citations ?? [])
      .map((citation) => citation.lessonOrder).filter((order) => order != null))].sort((a, b) => a - b);
    state.citedOrders = new Set(orders);
    renderSpine();

    $("answer-slot").innerHTML = renderResult(payload);
    announce(payload.insufficientContext ? "Answered, but the context was judged insufficient." : "Answer ready.");
  } catch (error) {
    $("answer-slot").innerHTML = errorCard(error, [
      "Is Docker up? <code>docker compose up -d</code>",
      "Were the transcripts ingested? <code>npm run ingest -- transcripts/class-subtitle</code>",
      "Check the terminal running <code>npm run serve</code> for the real stack trace.",
    ]);
    announce("That request failed.");
  } finally {
    button.disabled = false;
    $("ask-hint").textContent = "";
  }
}

/* ------------------------------------------------------------------ concepts */
async function loadConcepts() {
  const query = $("concept-q").value.trim();
  const kind = $("concept-kind").value;
  const params = new URLSearchParams({ limit: "200" });
  if (query) params.set("q", query);
  if (kind) params.set("kind", kind);
  if (state.position > 0) params.set("upToLesson", String(state.position));

  $("concept-list").innerHTML = '<div class="empty">Loading…</div>';
  try {
    const payload = await api(`/concepts?${params}`);
    if (!payload.concepts.length) {
      $("concept-list").innerHTML = `<div class="empty">Nothing matched. ${
        query ? "Try a shorter word." : "Has <code>npm run concepts</code> been run?"}</div>`;
      return;
    }
    const rows = payload.concepts.map((concept) => `<tr class="clickable" data-concept="${esc(concept.concept_id)}">
      <td>${esc(concept.label)}${concept.reached === false ? ' <span class="ahead-flag">· ahead of you</span>' : ""}</td>
      <td><span class="kind ${esc(concept.kind)}">${esc(concept.kind)}</span></td>
      <td class="mono">${esc(concept.lesson_label ?? "never taught")}</td>
      <td class="mono">${esc(concept.lessons ?? 0)}</td>
      <td class="mono">${esc(concept.dependents ?? 0)}</td>
    </tr>`).join("");
    $("concept-list").innerHTML = `<table>
      <thead><tr><th>Concept</th><th>Kind</th><th>First taught</th><th>Lessons</th><th>Depended on by</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    $("concept-list").querySelectorAll("[data-concept]").forEach((row) => {
      row.addEventListener("click", () => openConcept(row.dataset.concept));
    });
  } catch (error) {
    $("concept-list").innerHTML = errorCard(error, ["Run <code>npm run migrate</code> then <code>npm run concepts</code>."]);
  }
}

async function openConcept(conceptId) {
  const slot = $("concept-detail");
  slot.innerHTML = '<div class="card"><div class="empty">Loading…</div></div>';

  const params = state.position > 0 ? `?upToLesson=${state.position}` : "";
  try {
    const payload = await api(`/concepts/${encodeURIComponent(conceptId)}${params}`);
    const concept = payload.concept;

    const list = (items, empty) => items?.length
      ? `<ul>${items.map((item) => `<li>${esc(item.label)}${item.lesson_label ? ` <span class="mono">· ${esc(item.lesson_label)}</span>` : ""}</li>`).join("")}</ul>`
      : `<div class="empty">${empty}</div>`;

    slot.innerHTML = `<div class="card">
      <h2 class="concept-title">${esc(concept.label)}</h2>
      <div class="mono concept-meta">${concept.first_taught_order == null
        ? "Never taught — this is assumed background"
        : `First taught in ${esc(concept.lesson_label ?? `lesson ${concept.first_taught_order}`)}`}
        · <span class="kind ${esc(concept.kind)}">${esc(concept.kind)}</span></div>
      ${concept.summary ? `<p class="concept-summary">${esc(concept.summary)}</p>` : ""}

      ${payload.gaps?.length ? `<div class="banner thin"><strong>${payload.gaps.length} prerequisite${
        payload.gaps.length === 1 ? "" : "s"}</strong> you have not reached yet. Watch these first:
        ${list(payload.gaps, "")}</div>` : payload.gaps ? '<div class="banner ahead">You have covered everything this depends on.</div>' : ""}

      <h3 class="subhead">Depends on, transitively</h3>
      ${list(payload.prerequisites?.filter((row) => row.first_taught_order != null), "Nothing the course teaches.")}

      <h3 class="subhead">Assumed background</h3>
      ${list(payload.assumedBackground, "None.")}

      <h3 class="subhead">Covered in</h3>
      <table><tbody>${(payload.coveredIn ?? []).map((row) => `<tr>
        <td class="mono">${esc(row.lesson_label ?? row.video_id)}</td>
        <td>${esc(row.source_title ?? "")}</td>
        <td class="mono">${row.start_time == null ? "" : formatTime(row.start_time)}</td>
        <td class="mono">${esc(row.role)}</td></tr>`).join("")}</tbody></table>
    </div>`;
    // Jump, not glide: the wave band is the only motion on this page.
    slot.scrollIntoView({ block: "start" });
  } catch (error) {
    slot.innerHTML = errorCard(error);
  }
}

function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const pad = (value) => String(value).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const body = `${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
  return hours ? `${hours}:${body}` : body;
}

/* ------------------------------------------------------------------ tabs */
const TABS = [["tab-ask", "panel-ask"], ["tab-concepts", "panel-concepts"]];
let conceptsLoaded = false;

/* The selected tab is marked by aria-selected, and CSS draws the underline off
 * that attribute — so there is no sliding indicator to keep in sync, and no
 * measurement to redo on resize. */
function selectTab(tabId) {
  for (const [tab, panel] of TABS) {
    const active = tab === tabId;
    $(tab).setAttribute("aria-selected", String(active));
    $(panel).hidden = !active;
  }
  if (tabId === "tab-concepts" && !conceptsLoaded) { conceptsLoaded = true; loadConcepts(); }
}

/* ------------------------------------------------------------------ wiring */
$("rail").addEventListener("click", (event) => {
  const tick = event.target.closest("[data-order]");
  if (tick) setPosition(tick.dataset.order);
});
$("position").addEventListener("input", (event) => setPosition(event.target.value));
$("ask").addEventListener("click", ask);
$("question").addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") ask();
});
$("clear-thread").addEventListener("click", () => {
  state.conversationId = null;
  state.history = [];
  state.citedOrders = new Set();
  $("answer-slot").innerHTML = "";
  $("clear-thread").hidden = true;
  renderSpine();
  announce("Started a new thread.");
});
$("concept-q").addEventListener("input", debounce(loadConcepts, 250));
$("concept-kind").addEventListener("change", loadConcepts);
for (const [tab] of TABS) $(tab).addEventListener("click", () => selectTab(tab));

// Keyboard Shortcuts
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "k") {
    e.preventDefault();
    $("question").focus();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "n") {
    e.preventDefault();
    if (!$("clear-thread").hidden) $("clear-thread").click();
  }
});

function debounce(fn, ms) {
  let timer = null;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

/* ------------------------------------------------------------------ boot */
(async function boot() {
  $("greeting-text").textContent = getGreeting();
  updateStreak();
  loadHealth();
  try {
    await loadCurriculum();
    const fromHash = /^#lesson=(\d+)$/.exec(location.hash);
    if (fromHash) setPosition(fromHash[1]);
  } catch (error) {
    $("course-meta").textContent = "Could not load the course spine.";
    $("answer-slot").innerHTML = errorCard(error, [
      "Run <code>npm run curriculum -- transcripts/class-subtitle</code> to build the spine.",
      "Check the terminal running <code>npm run serve</code>.",
    ]);
  }
})();
