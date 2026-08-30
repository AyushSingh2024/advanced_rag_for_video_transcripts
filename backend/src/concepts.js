/**
 * The concept graph: what the course teaches, where each idea is introduced,
 * and what each idea assumes you already know.
 *
 * This module holds only the deterministic part — turning per-lesson
 * extractions into a graph. The LLM extraction lives in
 * `src/cli/buildConceptGraph.js` so this logic can be tested without a network
 * call, and so a bad extraction can be re-resolved without paying again.
 */

/**
 * Strips the hedging the model wraps prerequisite labels in.
 *
 * The extraction happily emits "basic understanding of React", "React basics"
 * and "React" as three separate prerequisites of three different lessons. They
 * are one concept, and left unmerged they show up as three entries in the
 * course's assumed-background list — which is the list a student reads first.
 */
const NOISE_PREFIX = /^(a\s+)?(basic|basics of|introductory|introduction to|intro to|fundamentals of|understanding( of)?|knowledge of|familiarity with|working knowledge of|solid understanding of)\s+/i;
const NOISE_SUFFIX = /\s+(basics|fundamentals|concepts?|knowledge|experience)$/i;
/** "React hooks (useState, useEffect)" and the same list in the other order are one concept. */
const PARENTHETICAL = /\s*\([^)]*\)\s*$/;

export function canonicalLabel(label) {
  let text = String(label ?? "").trim();
  // Applied repeatedly: "basic understanding of React basics" needs two passes.
  for (let pass = 0; pass < 3; pass += 1) {
    const before = text;
    text = text.replace(PARENTHETICAL, "").replace(NOISE_PREFIX, "").replace(NOISE_SUFFIX, "").trim();
    if (text === before) break;
  }
  return text || String(label ?? "").trim();
}

/**
 * Labels that are a filename rather than an idea.
 *
 * `index.tsx`, `package.json` and `app.json` all appear in the extraction
 * because lessons genuinely spend time in those files. But the concept being
 * taught is file-based routing or dependency management — the filename is where
 * it happens, not what it is, and nothing can meaningfully require `_layout.tsx`.
 *
 * Matched on the extension so it stays closed: a new label has to end in one of
 * these to be dropped, which no real concept name does.
 */
const FILE_EXTENSION = /\.(tsx?|jsx?|json|md|ya?ml|lock|env|gitignore|css|html|sh|ps1|plist|gradle|podfile)$/i;

/**
 * A slash alone does not make a path: `async/await` is a concept — and one of
 * the course's real forward references — while `app/(tabs)` is a directory. The
 * difference is that a path segment carries an extension or a route group, so
 * that is what this requires rather than just the separator.
 */
const PATH_SHAPED = /\//;
const PATH_SEGMENT = /(\.[a-z]{2,6}(\/|$))|\([^)]+\)/i;

export function isFileName(label) {
  const text = String(label ?? "").trim();
  if (FILE_EXTENSION.test(text)) return true;
  return PATH_SHAPED.test(text) && PATH_SEGMENT.test(text) && !/\s/.test(text);
}

/**
 * Labels shaped like a function call from a lesson's own code.
 *
 * `getPokemonDetail` and `fetchWeatherByCoords` are helpers written on screen in
 * a mini-project. They are only worth excluding where the course never teaches
 * them — a helper cannot be a course *entry requirement* — so this is applied
 * to assumed background only. Library methods the course does teach, like
 * `getItemAsync`, arrive through `introduces` and are never touched by it.
 */
const FUNCTION_SHAPED = /^(fetch|get|set|handle|load|render|create|update|delete|toggle|save|open|close|add|remove|pick|start|stop|show|hide)[A-Z]/;

export function isLessonHelper(label) {
  return FUNCTION_SHAPED.test(String(label ?? "").trim());
}

/**
 * Variant spellings of a slug, tried only against ids that already exist.
 *
 * Guarded on purpose: these never invent a concept, they only unify a label
 * with something the course demonstrably teaches. Over-merging is worse than
 * under-merging — "react" and "react-native" must stay apart — so this is a
 * short list of endings that genuinely name the same thing.
 */
function slugVariants(slug) {
  const variants = new Set();
  const add = (value) => { if (value && value !== slug) variants.add(value); };
  add(slug.endsWith("s") ? slug.slice(0, -1) : `${slug}s`);
  for (const suffix of ["-api", "-library", "-package", "-module", "-hook", "-sdk"]) {
    if (slug.endsWith(suffix)) {
      const base = slug.slice(0, -suffix.length);
      add(base);
      add(`${base}s`);
    } else {
      add(`${slug}${suffix}`);
    }
  }
  return [...variants];
}

/**
 * Individual style properties are not concepts.
 *
 * The extraction emits "margin", "font size" and "border radius" alongside real
 * ideas, because a styling lesson does spend time on them. But nothing is ever
 * a prerequisite of `margin`, and nobody asks which lesson introduced it — the
 * concept being taught is styling, which is captured separately. An exact-match
 * list rather than a prefix rule, because "color scheme" (light/dark mode) and
 * "Flexbox" are real concepts that a `color`/`flex` prefix would swallow.
 */
const STYLE_PROPERTIES = new Set([
  "margin", "margin-top", "margin-bottom", "margin-left", "margin-right", "margin-horizontal", "margin-vertical",
  "padding", "padding-top", "padding-bottom", "padding-left", "padding-right", "padding-horizontal", "padding-vertical",
  "font-size", "font-weight", "font-style", "font-family", "line-height", "letter-spacing", "text-align",
  "border-radius", "border-color", "border-width", "border-style",
  "background-color", "color", "opacity", "width", "height", "min-width", "max-width", "min-height", "max-height",
  "flex-direction", "align-items", "align-self", "justify-content", "flex-wrap", "flex-grow", "flex-shrink", "gap",
  "position", "top", "left", "right", "bottom", "z-index", "overflow", "resize-mode",
  "shadow-color", "shadow-offset", "shadow-opacity", "shadow-radius", "elevation",
]);

export function isStyleProperty(label) {
  return STYLE_PROPERTIES.has(conceptSlug(label));
}

/**
 * Labels that cannot be concepts at all, wherever they appear.
 *
 * Distinct from `isLessonHelper`, which only applies to labels nothing in the
 * course teaches: a style property or a filename is noise even when a lesson
 * spends ten minutes on it, whereas `getItemAsync` is a real API the moment the
 * course teaches it.
 */
function isNotAConcept(label) {
  return isStyleProperty(label) || isFileName(label);
}

/**
 * Sorts concepts by how load-bearing they are in the course.
 *
 * The extraction is deliberately generous, so most of what it finds is a
 * one-off implementation detail: a helper function from a mini-project, a prop
 * mentioned once. Those are real — the lesson did discuss them — but they
 * cannot participate in either feature the graph exists to serve, because
 * nothing depends on them and they recur nowhere.
 *
 * Rather than delete them and lose the ability to answer "where was this
 * mentioned", each concept is labelled:
 *
 *   - `background` — never taught by the course; the entry requirements
 *   - `core`       — something depends on it, or more than one lesson covers it
 *   - `detail`     — taught once, nothing builds on it
 *
 * Prerequisite reasoning and the default concept listing use `core`; `detail` is
 * still searchable, just not presented as course structure.
 */
export function classifyConcepts({ concepts, mentions, edges }) {
  const lessonsPerConcept = new Map();
  for (const mention of mentions) {
    lessonsPerConcept.set(mention.conceptId, (lessonsPerConcept.get(mention.conceptId) ?? 0) + 1);
  }
  const dependents = new Map();
  for (const edge of edges) {
    dependents.set(edge.requiresId, (dependents.get(edge.requiresId) ?? 0) + 1);
  }

  return concepts.map((concept) => {
    const lessons = lessonsPerConcept.get(concept.conceptId) ?? 0;
    const dependentCount = dependents.get(concept.conceptId) ?? 0;
    let kind = "detail";
    if (concept.firstTaughtOrder == null) kind = "background";
    else if (dependentCount > 0 || lessons > 1) kind = "core";
    return { ...concept, kind, lessons, dependents: dependentCount };
  });
}

/**
 * Canonical id for a concept label. Aliases collapse onto the same slug.
 *
 * camelCase and PascalCase are split at the boundary, because the extraction is
 * inconsistent about how it writes a component: one lesson yields "FlatList",
 * another "flat list". Without the split those are two concepts with separate
 * first-taught lessons, which is how `ActivityIndicator` and "activity
 * indicator" both appeared in the graph.
 */
export function conceptSlug(label) {
  return String(label ?? "")
    .replace(/[’']/g, "")
    // useState -> use State; APIRoute -> API Route, without shattering capitals.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * How many lessons to extract, given a raw `--limit` flag value.
 *
 * Exported only so it can be tested: the obvious spelling of this
 * (`Number.isFinite(Number(flag))`) silently selected zero lessons, because
 * `Number(null)` is `0` and `0` is finite. The whole graph came back empty and
 * the run still reported success.
 *
 * @param {Array} lessons the full course spine
 * @param {string|boolean|null} raw the flag value: null when absent, true when valueless
 */
export function selectLessons(lessons, raw) {
  if (raw == null || raw === true) return lessons;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer, got "${raw}"`);
  }
  return lessons.slice(0, limit);
}

/**
 * Resolves per-lesson extractions into concepts, mentions and prerequisite edges.
 *
 * Lessons are walked in course order, which is what makes "first taught"
 * meaningful: the earliest lesson that introduces a concept owns it, and every
 * later appearance is a revisit.
 *
 * @param {Array} extractions per-lesson `{ lessonId, order, introduces, revisits }`
 * @returns {{concepts: Array, mentions: Array, edges: Array, assumed: Array, forwardReferences: Array}}
 */
export function resolveConceptGraph(extractions) {
  const concepts = new Map();
  const aliasToId = new Map();
  const mentions = [];
  const pendingEdges = [];

  const register = (label) => {
    const id = conceptSlug(label);
    if (!id) return null;
    aliasToId.set(id, id);
    // The de-hedged form points at the same concept, so "React basics" as a
    // prerequisite later resolves to the "React" the course teaches.
    const canonical = conceptSlug(canonicalLabel(label));
    if (canonical && !aliasToId.has(canonical)) aliasToId.set(canonical, id);
    return id;
  };

  const lookup = (label) => aliasToId.get(conceptSlug(label)) ?? null;

  /**
   * Resolves a prerequisite label to a concept, widening the search only as far
   * as ids that already exist. Order matters: exact, then de-hedged, then
   * guarded spelling variants.
   */
  const resolveLabel = (label) => {
    const direct = lookup(label);
    if (direct) return direct;

    const canonical = conceptSlug(canonicalLabel(label));
    if (canonical && aliasToId.has(canonical)) return aliasToId.get(canonical);

    for (const candidate of [conceptSlug(label), canonical]) {
      if (!candidate) continue;
      for (const variant of slugVariants(candidate)) {
        // Only unify with a concept the course actually teaches — never with
        // another piece of assumed background, which would chain merges.
        const existing = aliasToId.get(variant);
        if (existing && concepts.get(existing)?.firstTaughtOrder != null) return existing;
      }
    }
    return null;
  };

  const ordered = [...extractions].sort((a, b) => a.order - b.order);

  for (const lesson of ordered) {
    for (const introduced of lesson.introduces ?? []) {
      if (isNotAConcept(introduced.label)) continue;
      const id = register(introduced.label);
      if (!id) continue;
      for (const alias of introduced.aliases ?? []) {
        const aliasId = conceptSlug(alias);
        // An alias never steals an id that is already a concept in its own right.
        if (aliasId && !aliasToId.has(aliasId)) aliasToId.set(aliasId, id);
      }

      if (!concepts.has(id)) {
        concepts.set(id, {
          conceptId: id,
          label: introduced.label,
          aliases: [...new Set(introduced.aliases ?? [])],
          summary: introduced.summary ?? null,
          firstTaughtOrder: lesson.order,
          firstTaughtVideoId: lesson.lessonId,
          firstTaughtAt: introduced.at ?? null,
        });
        mentions.push({ conceptId: id, videoId: lesson.lessonId, lessonOrder: lesson.order, startTime: introduced.at ?? null, role: "introduce" });
      } else {
        const existing = concepts.get(id);
        existing.aliases = [...new Set([...existing.aliases, ...(introduced.aliases ?? [])])];
        mentions.push({ conceptId: id, videoId: lesson.lessonId, lessonOrder: lesson.order, startTime: introduced.at ?? null, role: "revisit" });
      }

      for (const requirement of introduced.requires ?? []) {
        if (isNotAConcept(requirement)) continue;
        pendingEdges.push({ from: id, toLabel: requirement, order: lesson.order });
      }
    }

    for (const revisited of lesson.revisits ?? []) {
      const id = resolveLabel(revisited.label ?? revisited);
      if (!id) continue;
      mentions.push({ conceptId: id, videoId: lesson.lessonId, lessonOrder: lesson.order, startTime: revisited.at ?? null, role: "revisit" });
    }
  }

  /**
   * Prerequisites the course never teaches. These are the assumed background —
   * JavaScript, React, the terminal — and naming them is useful in its own
   * right: it is exactly the list a student needs before starting.
   */
  const assumed = [];
  const edges = [];
  const forwardReferences = [];

  for (const pending of pendingEdges) {
    let target = resolveLabel(pending.toLabel);
    if (!target) {
      // Nothing in the course teaches this. A helper function from a lesson's own
      // code therefore cannot be a real prerequisite — it is extraction noise
      // that would otherwise show up in the course's entry requirements.
      if (isLessonHelper(pending.toLabel)) continue;
      // Genuinely absent from the course: record it under its de-hedged name so
      // the assumed-background list reads as concepts, not as hedged phrases.
      const label = canonicalLabel(pending.toLabel);
      target = conceptSlug(label);
      if (!target || target === pending.from) continue;
      aliasToId.set(target, target);
      aliasToId.set(conceptSlug(pending.toLabel), target);
      if (!concepts.has(target)) {
        concepts.set(target, {
          conceptId: target, label, aliases: [], summary: null,
          firstTaughtOrder: null, firstTaughtVideoId: null, firstTaughtAt: null,
        });
        assumed.push(target);
      }
    }
    if (target === pending.from) continue;

    const prerequisite = concepts.get(target);
    /**
     * A prerequisite taught *after* the lesson that needs it is a contradiction
     * in the graph, but not noise: it means the course genuinely uses an idea
     * before introducing it. Worth reporting, not worth encoding as an edge.
     */
    if (prerequisite.firstTaughtOrder != null && prerequisite.firstTaughtOrder > pending.order) {
      forwardReferences.push({ conceptId: pending.from, requiresId: target, usedAtOrder: pending.order, taughtAtOrder: prerequisite.firstTaughtOrder });
      continue;
    }
    edges.push({ conceptId: pending.from, requiresId: target });
  }

  const deduped = new Map(edges.map((edge) => [`${edge.conceptId}->${edge.requiresId}`, edge]));
  const resolvedMentions = dedupeMentions(mentions);
  const resolvedEdges = [...deduped.values()];
  const sorted = [...concepts.values()].sort((a, b) => (a.firstTaughtOrder ?? Infinity) - (b.firstTaughtOrder ?? Infinity) || a.conceptId.localeCompare(b.conceptId));

  return {
    concepts: classifyConcepts({ concepts: sorted, mentions: resolvedMentions, edges: resolvedEdges }),
    mentions: resolvedMentions,
    edges: resolvedEdges,
    assumed: [...new Set(assumed)],
    forwardReferences,
  };
}

/** One row per concept, lesson and role — matching the table's primary key. */
function dedupeMentions(mentions) {
  const seen = new Map();
  for (const mention of mentions) {
    const key = `${mention.conceptId}|${mention.videoId}|${mention.role}`;
    if (!seen.has(key)) seen.set(key, mention);
  }
  return [...seen.values()].sort((a, b) => a.lessonOrder - b.lessonOrder || a.conceptId.localeCompare(b.conceptId));
}

/**
 * The prerequisites of a concept that the student has not reached yet.
 *
 * This is the question that matters when someone asks about something out of
 * order: not just "is this taught later" but "what are you missing that makes
 * it hard right now".
 */
export function prerequisiteGaps(graph, conceptId, upToLesson) {
  const byId = new Map(graph.concepts.map((concept) => [concept.conceptId, concept]));
  const requires = new Map();
  for (const edge of graph.edges) {
    if (!requires.has(edge.conceptId)) requires.set(edge.conceptId, []);
    requires.get(edge.conceptId).push(edge.requiresId);
  }

  const gaps = [];
  const seen = new Set([conceptId]);
  const queue = [...(requires.get(conceptId) ?? [])];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const concept = byId.get(id);
    if (!concept) continue;
    // Never taught by the course, so it cannot be a gap the course can close.
    if (concept.firstTaughtOrder == null) continue;
    if (upToLesson == null || concept.firstTaughtOrder <= upToLesson) continue;
    gaps.push(concept);
    queue.push(...(requires.get(id) ?? []));
  }
  return gaps.sort((a, b) => a.firstTaughtOrder - b.firstTaughtOrder);
}
