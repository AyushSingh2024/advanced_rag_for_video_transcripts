/**
 * Locating a concept in spoken words.
 *
 * A citation is only useful if it points at a moment, so every concept needs a
 * timestamp. Matching the label against the transcript is harder than it looks,
 * because three things differ between how a concept is *written* and how it is
 * *said*:
 *
 *   - punctuation: the label is "expo-secure-store", the instructor says
 *     "expo secure store"
 *   - camelCase: the label is "useState", the instructor says "use state"
 *   - cue boundaries: "file-based routing" is routinely split across two cues,
 *     so no single cue contains the phrase
 *
 * So both sides are flattened to bare words, camelCase is split at the
 * boundary, and the search runs over the whole lesson joined into one string
 * with an offset table mapping a hit back to the cue that started it. A second
 * space-stripped index catches the reverse case, where the transcript jams
 * together a term the label spaces out.
 *
 * This is deliberately deterministic and free: a bug here should cost nothing
 * to fix, which is why it lives outside the LLM extraction pass.
 */

/** Minimum length, ignoring spaces — shorter needles match far too much. */
const MIN_NEEDLE = 4;

export function normalizeForSearch(text) {
  return String(text ?? "")
    // useState -> use State, so the words separate when punctuation is dropped.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // APIRoute -> API Route, without shattering a run of capitals.
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Flattens a lesson's cues into two searchable strings plus the offset tables
 * needed to get back to a cue index.
 */
export function buildSearchIndex(segments = []) {
  let haystack = "";
  let squashed = "";
  const offsets = [];
  const squashedOffsets = [];
  for (const [index, segment] of segments.entries()) {
    const piece = normalizeForSearch(segment.text ?? segment.content);
    if (!piece) continue;
    offsets.push({ offset: haystack.length, index });
    haystack += `${piece} `;
    squashedOffsets.push({ offset: squashed.length, index });
    squashed += piece.replace(/ /g, "");
  }
  return { haystack, offsets, squashed, squashedOffsets, segments };
}

/** The cue that was being spoken at a given position in a flattened string. */
function segmentAt(offsets, position) {
  let segmentIndex = null;
  for (const entry of offsets) {
    if (entry.offset > position) break;
    segmentIndex = entry.index;
  }
  return segmentIndex;
}

/**
 * The start time of the earliest cue where any of these labels is spoken.
 *
 * @param {object} searchIndex from `buildSearchIndex`
 * @param {string[]} labels the concept label and its aliases
 * @returns {number|null} seconds, or null when the phrase is never said
 */
export function firstMentionAt(searchIndex, labels) {
  let best = null;
  for (const label of labels) {
    const needle = normalizeForSearch(label);
    if (needle.replace(/ /g, "").length < MIN_NEEDLE) continue;

    let index = null;
    const spaced = searchIndex.haystack.indexOf(needle);
    if (spaced >= 0) {
      index = segmentAt(searchIndex.offsets, spaced);
    } else {
      const jammed = searchIndex.squashed.indexOf(needle.replace(/ /g, ""));
      if (jammed >= 0) index = segmentAt(searchIndex.squashedOffsets, jammed);
    }
    if (index != null && (best == null || index < best)) best = index;
  }
  if (best == null) return null;
  const start = Number(searchIndex.segments[best]?.startTime);
  return Number.isFinite(start) ? Math.round(start) : null;
}
