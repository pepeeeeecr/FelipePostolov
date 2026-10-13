// A deliberately small, conservative word-list filter — catches hateful
// slurs and the handful of severest general profanity, nothing milder.
// Golf itself supplies plenty of words that would trip up a careless
// filter (balls, shaft, stroke, hole, wood, driver, shank) — whole-word
// matching against a short, specific list avoids ever touching those,
// rather than trying to out-think every possible golf phrase.
//
// This is intentionally not exhaustive and not evasion-proof (it won't
// catch "f*ck" or creative spacing) — extend BLOCKED_TERMS below if real
// moderation experience shows a gap. Err toward conservative: a missed
// slur is a report away from being caught by a human; a false positive on
// an innocent word erodes trust in the product every time it happens.
const BLOCKED_TERMS = [
  // Slurs (racial, ethnic, homophobic, ableist)
  'nigger', 'nigga', 'chink', 'spic', 'kike', 'wetback', 'beaner', 'gook',
  'faggot', 'fag', 'tranny', 'retard', 'retarded',
  // Severe general profanity / sexual degradation
  'fuck', 'motherfucker', 'cunt', 'cocksucker', 'cock sucker',
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matches whole words only (plus a trailing s/es/ing/er for simple
// inflections) so e.g. "fag" doesn't match inside "fagot" the cooking
// term or "assist" doesn't match on substrings that aren't in the list
// anyway — \b keeps every term from matching as part of a longer word.
const BLOCKED_PATTERN = new RegExp(
  '\\b(' + BLOCKED_TERMS.map(escapeRegExp).join('|') + ')(s|es|ing|er)?\\b',
  'i'
);

// Returns the matched term (lowercased, as written in the blocklist) or
// null if the text is clean. Checked against plain text only — no HTML
// stripping needed since none of the fields this guards accept markup.
function findBlockedTerm(text) {
  if (!text) return null;
  const match = BLOCKED_PATTERN.exec(String(text));
  return match ? match[1].toLowerCase() : null;
}

const MODERATION_ERROR_MESSAGE = "That contains language we don't allow — please rephrase and try again.";

// Checks several fields at once (e.g. a profile's name + bio, or a round's
// course + notes) and returns a 400-ready error object for the first one
// that's blocked, or null if everything's clean.
function moderateFields(fields) {
  for (const value of fields) {
    if (findBlockedTerm(value)) {
      return { error: MODERATION_ERROR_MESSAGE };
    }
  }
  return null;
}

module.exports = { findBlockedTerm, moderateFields, MODERATION_ERROR_MESSAGE, BLOCKED_TERMS };
