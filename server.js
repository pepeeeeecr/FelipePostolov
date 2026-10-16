// Foursome backend — now the single source of truth for everything:
// profiles, tee times, and real Stripe payment verification. Also serves
// the app itself as a real website (see /public/index.html), which is
// what makes the payment button actually work — no more sandboxed
// artifact blocking outbound requests.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const webpush = require('web-push');
const { moderateFields } = require('./moderation');
const legal = require('./legalContent');

const app = express();
const PORT = process.env.PORT || 3000;

const stripeConfigured = !!process.env.STRIPE_SECRET_KEY;
const stripe = stripeConfigured ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (!stripeConfigured) {
  console.warn('STRIPE_SECRET_KEY not set — payment routes are disabled until STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_ID are configured.');
}

// Web push (VAPID) needs our own keys; Expo's push service doesn't — any
// server can POST a notification for a valid Expo push token with no setup,
// so mobile push has no equivalent "configured" gate below.
const webPushConfigured = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (webPushConfigured) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn('VAPID keys not set — web push is disabled until VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are configured. Mobile (Expo) push is unaffected.');
}

// --- Database ---------------------------------------------------------
// Supabase (Postgres). Tables are created once via the SQL Editor — see
// the migration SQL — not on every boot. The service role key bypasses
// RLS, which is fine here since this server is the only thing that ever
// talks to Supabase directly.
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment. Set them before starting the server.');
  process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

async function getUser(userId) {
  const { data, error } = await supabase.from('users').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertProStatus(userId, isPro, stripeCustomerId) {
  const existing = await getUser(userId);
  if (existing) {
    const { error } = await supabase.from('users').update({
      is_pro: isPro,
      stripe_customer_id: stripeCustomerId || existing.stripe_customer_id,
      updated_at: Date.now()
    }).eq('user_id', userId);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('users').insert({
      user_id: userId,
      name: 'Unknown',
      is_pro: isPro,
      stripe_customer_id: stripeCustomerId || null,
      updated_at: Date.now()
    });
    if (error) throw error;
  }
}

function teetimeRowToJson(row) {
  return {
    id: row.id,
    hostId: row.host_id,
    hostName: row.host_name,
    hostIsPro: !!row.host_is_pro,
    hostHandicap: row.host_handicap,
    course: row.course,
    lat: row.lat,
    lng: row.lng,
    date: row.date,
    time: row.time,
    totalSpots: row.total_spots,
    openSpots: row.open_spots,
    hcpRange: row.hcp_range,
    pace: row.pace,
    notes: row.notes,
    status: row.status || 'active',
    requests: row.requests || [],
    viewedBy: row.viewed_by || [],
    createdAt: row.created_at
  };
}

async function getRatingSummary(userId) {
  const { data: rows, error } = await supabase.from('ratings').select('rating').eq('ratee_id', userId);
  if (error) throw error;
  if (!rows || rows.length === 0) return { avgRating: null, ratingCount: 0 };
  const avg = rows.reduce((s, r) => s + r.rating, 0) / rows.length;
  return { avgRating: Math.round(avg * 10) / 10, ratingCount: rows.length };
}

async function getRatingsForTeetime(teetimeId) {
  const { data, error } = await supabase
    .from('ratings')
    .select('raterId:rater_id, rateeId:ratee_id, rating, comment')
    .eq('teetime_id', teetimeId);
  if (error) throw error;
  return data || [];
}

// Courses have no id anywhere in this app — keyed by name throughout (see
// supabase-course-ratings.sql). One rating per (course, rater) — an
// editable review, not tied to a specific round the way player ratings are.
async function getCourseRatingSummary(courseName) {
  const { data: rows, error } = await supabase.from('course_ratings').select('rating').eq('course_name', courseName);
  if (error) throw error;
  if (!rows || rows.length === 0) return { avgRating: null, ratingCount: 0 };
  const avg = rows.reduce((s, r) => s + r.rating, 0) / rows.length;
  return { avgRating: Math.round(avg * 10) / 10, ratingCount: rows.length };
}

// Batch version for enriching a whole list of search results in one query
// instead of one round-trip per course.
async function getCourseRatingSummaries(courseNames) {
  const summaries = new Map(courseNames.map(name => [name, { avgRating: null, ratingCount: 0 }]));
  if (courseNames.length === 0) return summaries;
  const { data: rows, error } = await supabase.from('course_ratings').select('course_name, rating').in('course_name', courseNames);
  if (error) throw error;
  const byName = new Map();
  (rows || []).forEach(r => {
    if (!byName.has(r.course_name)) byName.set(r.course_name, []);
    byName.get(r.course_name).push(r.rating);
  });
  byName.forEach((ratings, name) => {
    const avg = ratings.reduce((s, r) => s + r, 0) / ratings.length;
    summaries.set(name, { avgRating: Math.round(avg * 10) / 10, ratingCount: ratings.length });
  });
  return summaries;
}

// How many rounds this user has been approved into, across every round —
// the "N confirmed rounds" trust signal a host sees next to a join request.
// Computed here because non-hosts no longer receive other people's request
// entries, so the client can't count them itself anymore.
async function getConfirmedRoundsCount(userId) {
  const { count, error } = await supabase
    .from('teetimes')
    .select('id', { count: 'exact', head: true })
    // JSON string, not a JS array — supabase-js would serialize an array as
    // a Postgres array literal, which jsonb containment rejects.
    .filter('requests', 'cs', JSON.stringify([{ userId, status: 'approved' }]));
  if (error) throw error;
  return count || 0;
}

// viewerId must be a verified identity (verifiedUserId), never a
// client-supplied id — it decides how much of the round this viewer gets.
// The host sees everything: every request (with ids, needed to approve,
// rate and open profiles), who viewed it, all ratings. Anyone else sees only
// their own request entry and ratings they gave or got, so participant ids
// aren't public — they used to be enough to read a round's chat.
async function buildTeetimeResponse(row, viewerId, blockedIds) {
  const json = teetimeRowToJson(row);
  json.ratings = await getRatingsForTeetime(row.id);
  const hostSummary = await getRatingSummary(row.host_id);
  json.hostAvgRating = hostSummary.avgRating;
  json.hostRatingCount = hostSummary.ratingCount;
  if (viewerId && viewerId === row.host_id) {
    let requests = json.requests;
    if (blockedIds && blockedIds.size) {
      requests = requests.filter(r => r.status !== 'pending' || !blockedIds.has(r.userId));
    }
    json.requests = await Promise.all(requests.map(async r => ({
      ...r,
      playedTogether: await getPlayedTogetherCount(viewerId, r.userId),
      confirmedRounds: await getConfirmedRoundsCount(r.userId),
    })));
  } else {
    json.requests = viewerId ? json.requests.filter(r => r.userId === viewerId) : [];
    json.ratings = viewerId ? json.ratings.filter(r => r.raterId === viewerId || r.rateeId === viewerId) : [];
    json.viewedBy = [];
  }
  return json;
}

// The only valid availability tags — enforced on write (POST /api/profiles)
// so GET /api/availability never has to deal with garbage values.
const AVAILABILITY_TAGS = new Set([
  'weekday_mornings', 'weekday_afternoons', 'weekday_evenings',
  'weekend_mornings', 'weekend_afternoons', 'weekend_evenings',
]);

// viewerId is who's looking, not who the profile belongs to — when it's
// someone other than the profile owner, we add "mutual rounds" and whether
// the viewer has blocked this person, both scoped to that specific pairing.
async function toProfileJson(row, viewerId) {
  const summary = await getRatingSummary(row.user_id);
  const json = {
    id: row.user_id,
    name: row.name,
    homeCourse: row.home_course,
    handicap: row.handicap,
    bio: row.bio || '',
    isPro: !!row.is_pro,
    availability: row.availability || [],
    avgRating: summary.avgRating,
    ratingCount: summary.ratingCount
  };
  if (viewerId && viewerId !== row.user_id) {
    json.mutualRounds = await getPlayedTogetherCount(viewerId, row.user_id);
    json.blockedByMe = await blockedByViewer(viewerId, row.user_id);
  }
  return json;
}

// Sends one notification via Expo's push service — no API key needed for
// basic use (see https://docs.expo.dev/push-notifications/sending-notifications/).
// A "DeviceNotRegistered" ticket means the token is dead (app uninstalled,
// or the OS revoked it) — same cleanup idea as a 410/404 from web-push below.
async function sendExpoPush(row, title, body) {
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Accept-Encoding': 'gzip, deflate' },
      body: JSON.stringify({ to: row.endpoint, title, body, sound: 'default' }),
    });
    const data = await res.json();
    const ticket = data && data.data;
    if (ticket && ticket.status === 'error') {
      console.error('Expo push error for', row.user_id, ticket.message);
      if (ticket.details && ticket.details.error === 'DeviceNotRegistered') {
        await supabase.from('push_subscriptions').delete().eq('endpoint', row.endpoint);
      }
    } else if (ticket && ticket.id) {
      // A "ok" ticket only means Expo accepted the request — it does NOT
      // confirm Apple/Google actually delivered it to the device. Logging
      // the ticket id so it can be checked against getReceipts when a push
      // is reported as sent-but-not-received.
      console.log('Expo push ticket ok for', row.user_id, 'ticket id:', ticket.id);
    }
  } catch (err) {
    console.error('Expo push request failed for', row.user_id, err.message);
  }
}

async function notifyUser(userId, title, body) {
  const { data: subs, error } = await supabase.from('push_subscriptions').select('*').eq('user_id', userId);
  if (error) {
    console.error('Failed to load push subscriptions for', userId, error.message);
    return;
  }
  for (const row of subs || []) {
    if (row.platform === 'expo') {
      await sendExpoPush(row, title, body);
      continue;
    }
    if (!webPushConfigured) continue;
    try {
      await webpush.sendNotification(row.subscription, JSON.stringify({ title, body }));
    } catch (err) {
      console.error('Push failed for', userId, err.statusCode || err.message);
      if (err.statusCode === 410 || err.statusCode === 404) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', row.endpoint);
      }
    }
  }
}

// --- Admin notification email --------------------------------------------
// Uses Resend (resend.com) over its plain HTTP API — no SDK, no SMTP setup,
// just one fetch call. Without RESEND_API_KEY set, this silently no-ops
// (logging a warning) rather than failing the report itself; filing a
// report must never depend on email being configured.
//
// Every outcome logs a distinct, greppable line — search Render's Logs for
// "notifyAdminOfReport" to see every attempt (configured-at-boot check,
// each send attempt, success or failure). Never logs RESEND_API_KEY itself,
// only whether one was found and how long it is (to catch "pasted the
// wrong thing" without ever printing a usable secret).
const RESEND_API_KEY = process.env.RESEND_API_KEY;
if (RESEND_API_KEY) {
  console.log(`notifyAdminOfReport: RESEND_API_KEY detected at boot (${RESEND_API_KEY.length} chars) — report emails enabled.`);
} else {
  console.warn('notifyAdminOfReport: RESEND_API_KEY not set at boot — report emails disabled until it is configured.');
}

async function notifyAdminOfReport(reporterId, reportedId, reason) {
  if (!RESEND_API_KEY) {
    console.warn('notifyAdminOfReport: skipped — RESEND_API_KEY not set.');
    return;
  }
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Foursome Reports <onboarding@resend.dev>',
        to: [legal.ADMIN_EMAIL],
        subject: 'New Foursome user report',
        text: [
          'A user was reported in Foursome.',
          '',
          `Reporter: ${reporterId}`,
          `Reported: ${reportedId}`,
          `Reason: ${reason}`,
          '',
          'Review and act on it in Supabase Dashboard > Table Editor > user_reports',
          '(ban by setting the reported user\'s "banned" column to true in the users table).',
        ].join('\n'),
      }),
    });
  } catch (e) {
    // Network-level failure (DNS, timeout, fetch itself missing/misbehaving
    // on this Node runtime) — never got an HTTP response at all.
    console.error('notifyAdminOfReport: request to Resend failed before a response came back:', e.message);
    return;
  }
  let bodyText = '';
  try { bodyText = await res.text(); } catch (e) { /* ignore — log what we have */ }
  if (!res.ok) {
    // Resend's error responses are JSON with a "message" field — most
    // common real-world cause: no domain verified, so onboarding@resend.dev
    // can only send TO the email address the Resend account itself was
    // signed up with. If ADMIN_EMAIL isn't that exact address, every send
    // gets rejected here with exactly that explanation.
    console.error(`notifyAdminOfReport: Resend rejected the email — HTTP ${res.status}: ${bodyText}`);
    return;
  }
  let emailId = '(no id in response)';
  try { emailId = JSON.parse(bodyText).id || emailId; } catch (e) { /* non-JSON success body, unlikely */ }
  console.log(`notifyAdminOfReport: Resend accepted the email, id=${emailId}, to=${legal.ADMIN_EMAIL}`);
}

function isParticipant(teetimeRow, userId) {
  if (teetimeRow.host_id === userId) return true;
  const requests = teetimeRow.requests || [];
  return requests.some(r => r.userId === userId && r.status === 'approved');
}

// --- Blocking & "played together" ----------------------------------------
// The blocked id in a block row is user-controlled (whoever they chose to
// block), so these always use parameterized filters
// (.eq/.in) rather than building a filter string with ids interpolated into
// it, which would otherwise be an injection vector into PostgREST's filter
// syntax.
async function getBlockedUserIds(userId) {
  const [{ data: asBlocker, error: e1 }, { data: asBlocked, error: e2 }] = await Promise.all([
    supabase.from('blocks').select('blocked_id').eq('blocker_id', userId),
    supabase.from('blocks').select('blocker_id').eq('blocked_id', userId),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  const ids = new Set();
  (asBlocker || []).forEach(r => ids.add(r.blocked_id));
  (asBlocked || []).forEach(r => ids.add(r.blocker_id));
  return ids;
}

// --- Moderation: banned users --------------------------------------------
// Flipped by hand in Supabase's Table Editor (users.banned) — no admin UI
// in the app itself yet. Checked on every write a user makes (profile,
// rounds, requests, ratings, messages) and used to filter banned hosts out
// of anything other users browse, same shape as the blocking filter above.
// Fails open (treats everyone as not-banned) if the `banned` column doesn't
// exist yet — i.e. before supabase-banned-flag.sql has been run. That keeps
// a deploy of this code from breaking every write/listing endpoint on a
// database that hasn't been migrated yet; it just means banning silently
// doesn't work until the migration runs, which the warning log makes
// obvious the moment someone actually looks.
async function isBanned(userId) {
  if (!userId) return false;
  try {
    const user = await getUser(userId);
    return !!(user && user.banned);
  } catch (e) {
    console.warn('isBanned check failed (has supabase-banned-flag.sql been run?):', e.message);
    return false;
  }
}
const BANNED_ERROR = { error: 'Your account has been suspended.' };

async function getBannedUserIds() {
  const { data, error } = await supabase.from('users').select('user_id').eq('banned', true);
  if (error) {
    console.warn('getBannedUserIds failed (has supabase-banned-flag.sql been run?):', error.message);
    return new Set();
  }
  return new Set((data || []).map(r => r.user_id));
}

// True if either user has blocked the other — used to gate join requests,
// where a block in any direction should stop the interaction.
async function isBlocked(userA, userB) {
  const blocked = await getBlockedUserIds(userA);
  return blocked.has(userB);
}

// Whether viewer specifically blocked target (not the reverse) — used to
// drive the Block/Unblock toggle on a profile without revealing to the
// viewer whether the other person has blocked them.
async function blockedByViewer(viewerId, targetId) {
  const { data, error } = await supabase
    .from('blocks').select('id').eq('blocker_id', viewerId).eq('blocked_id', targetId).maybeSingle();
  if (error) throw error;
  return !!data;
}

// Counts past, non-cancelled rounds where both users were confirmed
// participants (host, or an approved request) — the basis for "You've
// played N rounds with this person" and a profile's "N mutual rounds".
// Fetches the whole teetimes table and filters in JS, same tradeoff
// GET /api/teetimes already makes — fine at this prototype's scale, and
// there's no efficient way to ask Postgres "does this JSONB array contain
// an approved entry for either of these two users" without a much heavier
// index than this app needs yet.
async function getPlayedTogetherCount(userA, userB) {
  if (!userA || !userB || userA === userB) return 0;
  const { data: rows, error } = await supabase.from('teetimes').select('host_id, requests, date, status');
  if (error) throw error;
  const today = new Date().toISOString().slice(0, 10);
  const wasConfirmed = (row, userId) =>
    row.host_id === userId || (row.requests || []).some(r => r.userId === userId && r.status === 'approved');
  return (rows || []).filter(row =>
    row.status !== 'cancelled' &&
    row.date < today &&
    wasConfirmed(row, userA) &&
    wasConfirmed(row, userB)
  ).length;
}

// Free geocoding via OpenStreetMap's Nominatim — no API key needed. Goes
// through nominatimFetch (below) so it shares the same User-Agent and
// one-request-per-second limit as course search.
async function geocodeCourse(courseName) {
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
      encodeURIComponent(courseName + ' golf course');
    const res = await nominatimFetch(url);
    if (!res.ok) return null;
    const results = await res.json();
    if (results.length === 0) return null;
    return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
  } catch (err) {
    console.error('Geocoding failed for', courseName, err.message);
    return null;
  }
}

// Wraps an async route handler so a rejected promise (e.g. a Supabase
// query error) reaches Express's error handling instead of becoming an
// unhandled rejection that crashes the whole process.
function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// --- Auth ---------------------------------------------------------------
// Sessions come from Supabase Auth (created client-side, directly against
// Supabase — see public/index.html and the Expo app's authClient). The
// client sends the resulting access token as "Authorization: Bearer <jwt>";
// we verify it here with the service-role client, which can validate any
// user's token. When there's no token (or it's invalid), req.authUser stays
// null; guests are identified by their signed guest token instead (see
// below), never by a client-supplied id.
async function attachAuthUser(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  req.authUser = null;
  if (token) {
    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data && data.user) req.authUser = data.user;
    } catch (err) {
      console.error('Auth token verification failed:', err.message);
    }
  }
  req.guestId = verifyGuestToken(req.headers['x-guest-token']);
  next();
}

// --- Guest tokens -----------------------------------------------------------
// Guests have no Supabase session, and their ids aren't secret (they show
// up in teetimes.requests/viewedBy), so a bare ?userId= can't prove who's
// asking. Instead, the one POST /api/profiles call that first creates a
// guest's users row hands back a signed token for that id, which the app
// keeps on the device and sends as "X-Guest-Token". It's stateless (an HMAC
// over the id), so nothing new is stored. GUEST_TOKEN_SECRET can be set on
// its own; otherwise it's derived from the service-role key, so rotating
// that key also invalidates every guest token.
const GUEST_ID_PATTERN = /^u_[a-z0-9]{6,40}$/;
const guestTokenSecret = process.env.GUEST_TOKEN_SECRET
  || crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY || '').update('foursome-guest-token-v1').digest();
if (!process.env.GUEST_TOKEN_SECRET) {
  console.warn('GUEST_TOKEN_SECRET not set — guest tokens are signed with a key derived from the service-role key.');
}

function signGuestId(guestId) {
  return crypto.createHmac('sha256', guestTokenSecret).update(guestId).digest('base64url');
}

function issueGuestToken(guestId) {
  return 'g1.' + guestId + '.' + signGuestId(guestId);
}

function verifyGuestToken(token) {
  if (typeof token !== 'string') return null;
  const [version, guestId, sig] = token.split('.');
  if (version !== 'g1' || !GUEST_ID_PATTERN.test(guestId || '') || !sig) return null;
  const expected = Buffer.from(signGuestId(guestId));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return guestId;
}

// For routes that must never trust a client-supplied id: the verified
// session's user id, or a guest id proven by a valid guest token — else
// null, and the route answers 401.
function verifiedUserId(req) {
  if (req.authUser) return req.authUser.id;
  return req.guestId || null;
}

// The verified session's user id when one exists, otherwise whatever id the
// client sent. Only POST /api/profiles still uses this, and only to name the
// brand-new guest profile it creates (which is what issues the guest
// token); every other route uses verifiedUserId.
function resolveUserId(req, bodyUserId) {
  return req.authUser ? req.authUser.id : bodyUserId;
}

// --- Middleware ---------------------------------------------------------
app.use(cors()); // relax to your real domain before a public launch
app.use(attachAuthUser);

// Stripe webhook needs the raw body for signature verification, so it's
// registered before the global JSON parser.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), ah(async (req, res) => {
  if (!stripeConfigured || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Stripe is not configured on this server yet' });
  }
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id;
    if (userId) {
      await upsertProStatus(userId, true, session.customer);
      console.log(`Marked ${userId} as Pro after real Stripe payment.`);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const customerId = subscription.customer;
    const { data: user, error } = await supabase.from('users').select('*').eq('stripe_customer_id', customerId).maybeSingle();
    if (error) {
      console.error('Failed to look up user for cancelled subscription:', error.message);
    } else if (user) {
      await upsertProStatus(user.user_id, false, customerId);
      console.log(`Revoked Pro for ${user.user_id} after subscription cancellation.`);
    }
  }

  res.json({ received: true });
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Stripe checkout ---------------------------------------------------
app.post('/api/checkout', ah(async (req, res) => {
  if (!stripeConfigured) {
    return res.status(503).json({ error: 'Stripe is not configured on this server yet' });
  }
  const { successUrl, cancelUrl } = req.body;
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  if (!userId || !successUrl || !cancelUrl) {
    return res.status(400).json({ error: 'userId, successUrl and cancelUrl are required' });
  }
  if (!process.env.STRIPE_PRICE_ID) {
    return res.status(500).json({ error: 'STRIPE_PRICE_ID not configured on the server' });
  }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: userId,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Failed to create checkout session:', err.message);
    res.status(500).json({ error: 'Could not start checkout' });
  }
}));

app.get('/api/pro-status', ah(async (req, res) => {
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  const user = await getUser(userId);
  res.json({ isPro: !!(user && user.is_pro) });
}));

app.post('/api/portal', ah(async (req, res) => {
  if (!stripeConfigured) {
    return res.status(503).json({ error: 'Stripe is not configured on this server yet' });
  }
  const { returnUrl } = req.body;
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  if (!userId || !returnUrl) {
    return res.status(400).json({ error: 'userId and returnUrl are required' });
  }
  const user = await getUser(userId);
  if (!user || !user.stripe_customer_id) {
    return res.status(400).json({ error: 'No Stripe customer found for this user — nothing to manage yet' });
  }
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: returnUrl
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Failed to create portal session:', err.message);
    res.status(500).json({ error: 'Could not open subscription management' });
  }
}));

app.get('/checkout-success', (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif; text-align:center; padding:60px 20px;">
      <h2>Payment complete 🎉</h2>
      <p>Close this tab and go back to Foursome — tap "I've paid, check status" there.</p>
    </body></html>
  `);
});

app.get('/checkout-cancel', (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif; text-align:center; padding:60px 20px;">
      <h2>Checkout cancelled</h2>
      <p>No charge was made. You can close this tab and go back to Foursome.</p>
    </body></html>
  `);
});

// --- Auth -----------------------------------------------------------------
// Sign-up/login themselves happen client-side against Supabase Auth
// directly (so adding Google/Apple later is just another provider call on
// the client — no backend changes). The one thing that needs the server is
// folding a guest's existing data into the account they just created or
// signed into, since that requires the service-role key.

// Who the request is verified as (session or guest token) — lets the apps
// spot a stored guest whose token is missing or no longer valid before
// letting them back in. Never issues a token.
app.get('/api/auth/me', (req, res) => {
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  res.json({ userId, isGuest: !req.authUser });
});
app.post('/api/auth/migrate-guest', ah(async (req, res) => {
  if (!req.authUser) return res.status(401).json({ error: 'Sign in required' });
  const { guestId, guestToken } = req.body;
  if (!guestId) return res.status(400).json({ error: 'guestId is required' });
  if (guestId === req.authUser.id) return res.json({ migrated: false, profile: null });
  // Guest ids are visible to others, so the caller must also prove they
  // are that guest — otherwise any signed-in user could absorb anyone's
  // guest data into their own account.
  if (verifyGuestToken(guestToken) !== guestId) {
    return res.status(403).json({ error: 'Not authorized to move this guest profile' });
  }

  const { error } = await supabase.rpc('migrate_guest_to_user', {
    p_guest_id: guestId,
    p_auth_id: req.authUser.id,
  });
  if (error) {
    console.error('Guest migration failed:', error.message);
    return res.status(500).json({ error: 'Could not migrate guest data' });
  }
  // migrate_guest_to_user predates course_requests and doesn't move them.
  const { error: crError } = await supabase.from('course_requests')
    .update({ user_id: req.authUser.id }).eq('user_id', guestId);
  if (crError) console.error('Failed to move guest course requests:', crError.message);

  const user = await getUser(req.authUser.id);
  res.json({ migrated: true, profile: user ? await toProfileJson(user) : null });
}));

// Permanently deletes a user's data — profile, rounds they hosted (and
// those rounds' chat history), their ratings, push subscriptions, and their
// entries inside other people's teetimes.requests/viewedBy, and their course
// requests. Only ever acts on the verified caller — a signed-in user's own
// id, or a guest proven by their guest token. When signed in, also deletes the actual Supabase
// Auth account — from that point the access token they were using is dead.
app.delete('/api/account', ah(async (req, res) => {
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });

  const { error: rpcError } = await supabase.rpc('delete_user_account', { p_user_id: userId });
  if (rpcError) {
    console.error('Failed to delete account data:', rpcError.message);
    return res.status(500).json({ error: 'Could not delete account data' });
  }
  // delete_user_account predates course_requests and leaves them behind.
  const { error: crError } = await supabase.from('course_requests').delete().eq('user_id', userId);
  if (crError) {
    console.error('Failed to delete course requests:', crError.message);
    return res.status(500).json({ error: 'Could not delete account data' });
  }

  if (req.authUser) {
    const { error: authError } = await supabase.auth.admin.deleteUser(req.authUser.id);
    if (authError) {
      console.error('Failed to delete auth user:', authError.message);
      return res.status(500).json({ error: 'Your data was deleted, but the login itself could not be removed — contact support' });
    }
  }

  res.json({ ok: true });
}));

// --- Profiles ------------------------------------------------------------
app.post('/api/profiles', ah(async (req, res) => {
  const { name, homeCourse, handicap, bio, availability, termsAgreedAt, policyVersion } = req.body;
  const userId = resolveUserId(req, req.body.userId);
  if (!userId || !name || !homeCourse || handicap == null) {
    return res.status(400).json({ error: 'userId, name, homeCourse and handicap are required' });
  }
  const modError = moderateFields([name, bio]);
  if (modError) return res.status(400).json(modError);
  const cleanAvailability = Array.isArray(availability)
    ? [...new Set(availability.filter(tag => AVAILABILITY_TAGS.has(tag)))]
    : [];
  const existing = await getUser(userId);
  // Without a login, only two things are allowed: creating a brand-new
  // guest profile (which is what issues the guest token), or editing a
  // guest profile with that guest's own token. A bare id is never enough.
  if (!req.authUser) {
    const allowed = existing ? req.guestId === userId : GUEST_ID_PATTERN.test(userId);
    if (!allowed) return res.status(401).json({ error: 'Sign in required' });
  }
  if (existing && existing.banned) return res.status(403).json(BANNED_ERROR);
  if (existing) {
    const { error } = await supabase.from('users').update({
      name, home_course: homeCourse, handicap: parseFloat(handicap), bio: bio || '', availability: cleanAvailability, updated_at: Date.now()
    }).eq('user_id', userId);
    if (error) return res.status(500).json({ error: 'Could not save profile' });
  } else {
    // Consent (terms_agreed_at/terms_policy_version) is only ever set here,
    // at first profile creation — editing a profile later never touches it,
    // so it stays an honest record of when the box was actually checked.
    const { error } = await supabase.from('users').insert({
      user_id: userId, name, home_course: homeCourse, handicap: parseFloat(handicap), bio: bio || '', availability: cleanAvailability, updated_at: Date.now(),
      terms_agreed_at: termsAgreedAt || null, terms_policy_version: policyVersion || null
    });
    if (error) return res.status(500).json({ error: 'Could not save profile' });
    // Only ever issued here, when a guest's row is first created — never
    // on an update, which would hand a token to anyone who knows the id.
    if (!req.authUser && GUEST_ID_PATTERN.test(userId)) {
      return res.json({ ...(await toProfileJson(await getUser(userId))), guestToken: issueGuestToken(userId) });
    }
  }
  res.json(await toProfileJson(await getUser(userId)));
}));

// Standing availability, separate from one-off posted rounds — everyone who
// has set at least one tag, for Discover's "Available players" section.
// Prototype-scale, so no pagination; the client filters out its own id.
app.get('/api/availability', ah(async (req, res) => {
  // Filtering "availability is non-empty" in JS rather than via a JSONB
  // PostgREST filter — same fetch-then-filter tradeoff already used
  // elsewhere in this file (e.g. getPlayedTogetherCount), and avoids
  // relying on JSONB array equality/containment filter syntax working the
  // way it looks like it should.
  const { data, error } = await supabase
    .from('users')
    .select('user_id, name, home_course, handicap, availability')
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) {
    console.error('Failed to load availability:', error.message);
    return res.status(500).json({ error: 'Could not load availability' });
  }
  const bannedIds = await getBannedUserIds();
  const users = (data || [])
    .filter(u => !bannedIds.has(u.user_id))
    .filter(u => Array.isArray(u.availability) && u.availability.length > 0)
    .slice(0, 100)
    .map(u => ({ id: u.user_id, name: u.name, homeCourse: u.home_course, handicap: u.handicap, availability: u.availability }));
  res.json({ users });
}));

app.get('/api/profiles/:userId', ah(async (req, res) => {
  const user = await getUser(req.params.userId);
  // Treated identically to "not found" for everyone, including the banned
  // user's own client — this is what makes a ban actually stick without
  // needing viewer-aware special-casing: their own app can't load their
  // profile either, so it falls back to onboarding, and re-creating it
  // hits the banned check in POST /api/profiles.
  if (!user || user.banned) return res.status(404).json({ error: 'Not found' });
  // Verified only — blockedByMe/mutualRounds describe the viewer's own
  // relationships, so a ?viewerId= would let anyone check who blocked whom.
  res.json(await toProfileJson(user, verifiedUserId(req)));
}));

// --- Tee times -------------------------------------------------------------
app.get('/api/teetimes', ah(async (req, res) => {
  const viewerId = verifiedUserId(req);
  const { data: rows, error } = await supabase.from('teetimes').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Could not load tee times' });

  // Banned hosts' rounds are hidden from everyone, not just this viewer —
  // unlike blocking, this isn't viewer-specific, so it's not gated on
  // viewerId being present.
  const bannedIds = await getBannedUserIds();
  let visibleRows = bannedIds.size ? rows.filter(r => !bannedIds.has(r.host_id)) : rows;

  // Blocking hides rounds in both directions: a blocked-or-blocking host's
  // rounds disappear from this viewer's Discover, same as this viewer's
  // rounds disappear from theirs (via the same check on their own request).
  let blockedIds = null;
  if (viewerId) {
    blockedIds = await getBlockedUserIds(viewerId);
    if (blockedIds.size) visibleRows = visibleRows.filter(r => !blockedIds.has(r.host_id));
  }
  res.json(await Promise.all(visibleRows.map(r => buildTeetimeResponse(r, viewerId, blockedIds))));
}));

app.post('/api/teetimes', ah(async (req, res) => {
  const { hostName, hostHandicap, course, date, time, totalSpots, hcpRange, pace, notes } = req.body;
  const hostId = verifiedUserId(req);
  if (!hostId) return res.status(401).json({ error: 'Sign in required' });
  if (!hostId || !hostName || !course || !date || !time || !totalSpots) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const modError = moderateFields([hostName, course, hcpRange, notes]);
  if (modError) return res.status(400).json(modError);
  if (await isBanned(hostId)) return res.status(403).json(BANNED_ERROR);

  // Pro gating is disabled for now (see is_pro on the users table) — this
  // is still read for host_is_pro's display badge, just not used to limit
  // anything. Never trust a client-supplied "isPro" flag either way.
  const hostUser = await getUser(hostId);
  const reallyIsPro = !!(hostUser && hostUser.is_pro);

  const id = 'tt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const geo = await geocodeCourse(course); // null if not found — round still posts, just without distance
  const { data: row, error } = await supabase.from('teetimes').insert({
    id,
    host_id: hostId,
    host_name: hostName,
    host_is_pro: reallyIsPro,
    host_handicap: hostHandicap || null,
    course,
    lat: geo ? geo.lat : null,
    lng: geo ? geo.lng : null,
    date,
    time,
    total_spots: totalSpots,
    open_spots: totalSpots,
    hcp_range: hcpRange || '',
    pace: pace || '',
    notes: notes || '',
    requests: [],
    viewed_by: [],
    created_at: Date.now()
  }).select().single();
  if (error) return res.status(500).json({ error: 'Could not create tee time' });
  res.json(await buildTeetimeResponse(row, verifiedUserId(req)));
}));

app.post('/api/teetimes/:id/request', ah(async (req, res) => {
  const { name, handicap } = req.body;
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  const { data: row, error } = await supabase.from('teetimes').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not load tee time' });
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (await isBanned(userId)) return res.status(403).json(BANNED_ERROR);
  if (await isBlocked(userId, row.host_id)) {
    return res.status(403).json({ error: "You can't request to join this round" });
  }
  const requests = row.requests || [];
  if (requests.some(r => r.userId === userId)) {
    return res.json(await buildTeetimeResponse(row, verifiedUserId(req))); // already requested, no-op
  }
  requests.push({ userId, name, handicap, status: 'pending' });
  await supabase.from('teetimes').update({ requests }).eq('id', req.params.id);
  notifyUser(row.host_id, 'New join request', `${name} wants to join your round at ${row.course}`).catch(() => {});
  const { data: updated } = await supabase.from('teetimes').select('*').eq('id', req.params.id).single();
  res.json(await buildTeetimeResponse(updated, verifiedUserId(req)));
}));

// Lets a requester withdraw their own still-pending request — scoped to
// 'pending' only; an already-approved/denied entry is a decided outcome,
// not something this route un-does (leaving a confirmed round is a
// different action this doesn't attempt to cover).
app.delete('/api/teetimes/:id/request', ah(async (req, res) => {
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  const { data: row, error } = await supabase.from('teetimes').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not load tee time' });
  if (!row) return res.status(404).json({ error: 'Not found' });
  const requests = row.requests || [];
  const existing = requests.find(r => r.userId === userId);
  if (!existing) return res.status(404).json({ error: 'Request not found' });
  if (existing.status !== 'pending') return res.status(400).json({ error: 'Only a pending request can be withdrawn' });
  const nextRequests = requests.filter(r => r.userId !== userId);
  await supabase.from('teetimes').update({ requests: nextRequests }).eq('id', req.params.id);
  const { data: updated } = await supabase.from('teetimes').select('*').eq('id', req.params.id).single();
  res.json(await buildTeetimeResponse(updated, verifiedUserId(req)));
}));

app.post('/api/teetimes/:id/respond', ah(async (req, res) => {
  const { userId, decision } = req.body;
  const hostId = verifiedUserId(req);
  if (!hostId) return res.status(401).json({ error: 'Sign in required' });
  if (decision !== 'approved' && decision !== 'denied') {
    return res.status(400).json({ error: "decision must be 'approved' or 'denied'" });
  }
  const { data: row, error } = await supabase.from('teetimes').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not load tee time' });
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (hostId !== row.host_id) {
    return res.status(403).json({ error: 'Only the host can respond to requests' });
  }
  if (await isBanned(row.host_id)) return res.status(403).json(BANNED_ERROR);
  const requests = row.requests || [];
  const reqEntry = requests.find(r => r.userId === userId);
  if (!reqEntry) return res.status(404).json({ error: 'Request not found' });
  reqEntry.status = decision;
  let openSpots = row.open_spots;
  if (decision === 'approved') openSpots = Math.max(0, openSpots - 1);
  await supabase.from('teetimes').update({ requests, open_spots: openSpots }).eq('id', req.params.id);
  const notifyTitle = decision === 'approved' ? "You're in!" : 'Request update';
  const notifyBody = decision === 'approved'
    ? `You're confirmed for the round at ${row.course}`
    : `Your request for ${row.course} was declined`;
  notifyUser(userId, notifyTitle, notifyBody).catch(() => {});
  const { data: updated } = await supabase.from('teetimes').select('*').eq('id', req.params.id).single();
  res.json(await buildTeetimeResponse(updated, verifiedUserId(req)));
}));

app.post('/api/teetimes/:id/rate', ah(async (req, res) => {
  const { rateeId, rating, comment } = req.body;
  const raterId = verifiedUserId(req);
  if (!raterId) return res.status(401).json({ error: 'Sign in required' });
  if (!raterId || !rateeId || !rating) {
    return res.status(400).json({ error: 'raterId, rateeId and rating are required' });
  }
  const r = parseInt(rating);
  if (r < 1 || r > 5) return res.status(400).json({ error: 'rating must be between 1 and 5' });
  if (await isBanned(raterId)) return res.status(403).json(BANNED_ERROR);
  const { data: row, error } = await supabase.from('teetimes').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not load tee time' });
  if (!row) return res.status(404).json({ error: 'Not found' });
  // Only people who actually played this round (host + approved players)
  // can rate each other — never yourself, never a stranger.
  if (raterId === rateeId || !isParticipant(row, raterId) || !isParticipant(row, rateeId)) {
    return res.status(403).json({ error: 'You can only rate players from this round' });
  }
  // Upsert: remove any existing rating from this rater to this ratee for this round, then insert fresh
  await supabase.from('ratings').delete().match({ teetime_id: req.params.id, rater_id: raterId, ratee_id: rateeId });
  await supabase.from('ratings').insert({
    teetime_id: req.params.id, rater_id: raterId, ratee_id: rateeId, rating: r, comment: comment || '', created_at: Date.now()
  });
  res.json(await buildTeetimeResponse(row, verifiedUserId(req)));
}));

app.post('/api/teetimes/:id/view', ah(async (req, res) => {
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  const { data: row, error } = await supabase.from('teetimes').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not load tee time' });
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.host_id === userId) return res.json({ ok: true }); // don't count self-views
  const viewedBy = row.viewed_by || [];
  if (!viewedBy.includes(userId)) {
    viewedBy.push(userId);
    await supabase.from('teetimes').update({ viewed_by: viewedBy }).eq('id', req.params.id);
  }
  res.json({ ok: true });
}));

app.delete('/api/teetimes/:id', ah(async (req, res) => {
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  const { data: row, error } = await supabase.from('teetimes').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not load tee time' });
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.host_id !== userId) return res.status(403).json({ error: 'Only the host can cancel this round' });

  const requests = row.requests || [];
  requests
    .filter(r => r.status === 'approved' || r.status === 'pending')
    .forEach(r => {
      notifyUser(r.userId, 'Round cancelled', `The round at ${row.course} on ${row.date} was cancelled by the host.`).catch(() => {});
    });

  await supabase.from('messages').delete().eq('teetime_id', req.params.id);
  await supabase.from('teetimes').update({ status: 'cancelled' }).eq('id', req.params.id);
  res.json({ ok: true });
}));

// Chat is participants-only (host + approved players), and "who's asking"
// comes only from a verified login or guest token — a ?userId= or body
// userId is ignored, since participant ids were never secret.
app.get('/api/teetimes/:id/messages', ah(async (req, res) => {
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  const { data: row, error } = await supabase.from('teetimes').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not load tee time' });
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!isParticipant(row, userId)) {
    return res.status(403).json({ error: 'Not authorized for this chat' });
  }
  const { data: messages, error: msgError } = await supabase
    .from('messages')
    .select('senderId:sender_id, senderName:sender_name, text, createdAt:created_at')
    .eq('teetime_id', req.params.id)
    .order('created_at', { ascending: true });
  if (msgError) return res.status(500).json({ error: 'Could not load messages' });
  res.json(messages);
}));

app.post('/api/teetimes/:id/messages', ah(async (req, res) => {
  const { name, text } = req.body;
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  if (!name || !text || !text.trim()) {
    return res.status(400).json({ error: 'name and text are required' });
  }
  const modError = moderateFields([text]);
  if (modError) return res.status(400).json(modError);
  if (await isBanned(userId)) return res.status(403).json(BANNED_ERROR);
  const { data: row, error } = await supabase.from('teetimes').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not load tee time' });
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!isParticipant(row, userId)) return res.status(403).json({ error: 'Not authorized for this chat' });

  await supabase.from('messages').insert({
    teetime_id: req.params.id, sender_id: userId, sender_name: name, text: text.trim(), created_at: Date.now()
  });

  const requests = row.requests || [];
  const recipientIds = new Set();
  if (row.host_id !== userId) recipientIds.add(row.host_id);
  requests.forEach(r => { if (r.status === 'approved' && r.userId !== userId) recipientIds.add(r.userId); });
  const preview = text.trim().slice(0, 60);
  recipientIds.forEach(rid => {
    notifyUser(rid, `${name} · ${row.course}`, preview).catch(() => {});
  });

  const { data: messages, error: msgError } = await supabase
    .from('messages')
    .select('senderId:sender_id, senderName:sender_name, text, createdAt:created_at')
    .eq('teetime_id', req.params.id)
    .order('created_at', { ascending: true });
  if (msgError) return res.status(500).json({ error: 'Could not load messages' });
  res.json(messages);
}));

app.get('/health', (req, res) => res.json({ ok: true }));

// --- Public legal/support pages -------------------------------------------
// Plain server-rendered HTML — reachable at a stable URL with no JS
// required, which is what App Store Connect's Privacy Policy field (and a
// human reviewer) actually need. Content matches public/index.html's and
// foursome-mobile's in-app copies (see legalContent.js's header comment).
function legalEscapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderLegalSections(sections) {
  return sections.map(s => `
    <section>
      ${s.h ? `<h2>${legalEscapeHtml(s.h)}</h2>` : ''}
      ${(s.p || []).map(p => `<p>${legalEscapeHtml(p)}</p>`).join('')}
      ${s.list ? `<ul>${s.list.map(i => `<li>${legalEscapeHtml(i)}</li>`).join('')}</ul>` : ''}
    </section>
  `).join('');
}

function renderLegalPage(title, innerHtml, effectiveDate = legal.LEGAL_EFFECTIVE_DATE) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${legalEscapeHtml(title)} — Foursome</title>
<style>
  body{ margin:0; background:#F6F3EC; color:#1C2A1F; font-family:'Helvetica Neue', Arial, sans-serif; }
  .wrap{ max-width:640px; margin:0 auto; padding:32px 20px 60px; }
  h1{ font-size:26px; margin:0 0 4px; }
  .effective{ font-size:13px; opacity:0.68; margin-bottom:28px; }
  h2{ font-size:16px; margin:24px 0 6px; }
  p{ font-size:14.5px; line-height:1.6; margin:0 0 10px; }
  ul{ margin:6px 0 10px; padding-left:20px; }
  li{ font-size:14.5px; line-height:1.6; margin-bottom:4px; }
  a{ color:#16281B; }
  .nav{ margin-bottom:28px; font-size:13px; }
  .nav a{ margin-right:16px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="nav"><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Service</a><a href="/support">Support</a></div>
  <h1>${legalEscapeHtml(title)}</h1>
  <div class="effective">Effective ${legalEscapeHtml(effectiveDate)}</div>
  ${innerHtml}
</div>
</body>
</html>`;
}

app.get('/privacy', (req, res) => {
  res.send(renderLegalPage('Privacy Policy', renderLegalSections(legal.PRIVACY_SECTIONS)));
});

app.get('/terms', (req, res) => {
  res.send(renderLegalPage('Terms of Service', renderLegalSections(legal.TERMS_SECTIONS), legal.TERMS_EFFECTIVE_DATE));
});

app.get('/cookies', (req, res) => {
  res.send(renderLegalPage('Cookie Policy', renderLegalSections(legal.COOKIE_SECTIONS)));
});

app.get('/refund', (req, res) => {
  res.send(renderLegalPage('Refund Policy', renderLegalSections(legal.REFUND_SECTIONS)));
});

app.get('/support', (req, res) => {
  const body = `
    <section>
      <p>Have a question, found a bug, or need help with your Foursome account? Email us and we'll get back to you.</p>
      <p><a href="mailto:${legalEscapeHtml(legal.ADMIN_EMAIL)}">${legalEscapeHtml(legal.ADMIN_EMAIL)}</a></p>
    </section>
    <section>
      <h2>Report a user or piece of content</h2>
      <p>You can report another user directly from their profile in the app. If you'd rather reach us directly, email the address above with what happened and we'll look into it.</p>
    </section>
    <section>
      <h2>Delete your account</h2>
      <p>Go to Settings &gt; Delete account in the app. This permanently removes your profile, hosted rounds and their chat history, and ratings.</p>
    </section>
  `;
  res.send(renderLegalPage('Support', body));
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: webPushConfigured ? process.env.VAPID_PUBLIC_KEY : '' });
});

app.post('/api/push/subscribe', async (req, res) => {
  const { subscription } = req.body;
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  if (!userId || !subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'userId and subscription are required' });
  }
  try {
    const { data: existing } = await supabase.from('push_subscriptions').select('id').eq('endpoint', subscription.endpoint).maybeSingle();
    if (existing) {
      const { error } = await supabase.from('push_subscriptions')
        .update({ user_id: userId, subscription, platform: 'web' })
        .eq('endpoint', subscription.endpoint);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('push_subscriptions')
        .insert({ user_id: userId, endpoint: subscription.endpoint, subscription, platform: 'web', created_at: Date.now() });
      if (error) throw error;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to save push subscription:', err.message);
    res.status(500).json({ error: 'Could not save subscription' });
  }
});

// Mobile (Expo) push — the token itself is the unique id, so it plays the
// role "endpoint" plays for a web subscription. See supabase-expo-push.sql.
app.post('/api/push/subscribe-expo', ah(async (req, res) => {
  const { token } = req.body;
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  if (!userId || !token) {
    return res.status(400).json({ error: 'userId and token are required' });
  }
  const { data: existing, error: fetchError } = await supabase.from('push_subscriptions').select('id').eq('endpoint', token).maybeSingle();
  if (fetchError) {
    console.error('Failed to look up Expo push subscription:', fetchError.message);
    return res.status(500).json({ error: 'Could not save subscription' });
  }
  if (existing) {
    const { error } = await supabase.from('push_subscriptions')
      .update({ user_id: userId, subscription: { token }, platform: 'expo' })
      .eq('endpoint', token);
    if (error) {
      console.error('Failed to update Expo push subscription:', error.message);
      return res.status(500).json({ error: 'Could not save subscription' });
    }
  } else {
    const { error } = await supabase.from('push_subscriptions')
      .insert({ user_id: userId, endpoint: token, subscription: { token }, platform: 'expo', created_at: Date.now() });
    if (error) {
      console.error('Failed to insert Expo push subscription:', error.message);
      return res.status(500).json({ error: 'Could not save subscription' });
    }
  }
  res.json({ ok: true });
}));

// Generic unsubscribe for either platform — needed for a real "off" toggle:
// unlike a browser subscription, an Expo push token doesn't self-invalidate
// just because someone flips a preference in Settings, so notifyUser's lazy
// dead-token cleanup alone wouldn't actually stop mobile push on toggle-off.
app.delete('/api/push/unsubscribe', ah(async (req, res) => {
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  const { endpoint } = req.body;
  if (!userId || !endpoint) return res.status(400).json({ error: 'userId and endpoint are required' });
  const { error } = await supabase.from('push_subscriptions').delete().match({ user_id: userId, endpoint });
  if (error) return res.status(500).json({ error: 'Could not remove subscription' });
  res.json({ ok: true });
}));

// --- Blocking & reporting --------------------------------------------------
// Returns names alongside ids — a bare list of ids isn't renderable as a
// "Blocked users" list in Settings on its own.
app.get('/api/blocks/mine', ah(async (req, res) => {
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  const { data, error } = await supabase.from('blocks').select('blocked_id').eq('blocker_id', userId);
  if (error) return res.status(500).json({ error: 'Could not load blocked users' });
  const blockedIds = (data || []).map(r => r.blocked_id);
  if (blockedIds.length === 0) return res.json({ blocked: [] });
  const { data: users, error: usersError } = await supabase.from('users').select('user_id, name').in('user_id', blockedIds);
  if (usersError) return res.status(500).json({ error: 'Could not load blocked users' });
  const nameById = new Map((users || []).map(u => [u.user_id, u.name]));
  res.json({ blocked: blockedIds.map(id => ({ id, name: nameById.get(id) || 'Unknown user' })) });
}));

app.post('/api/blocks', ah(async (req, res) => {
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  const { blockedId } = req.body;
  if (!userId || !blockedId) return res.status(400).json({ error: 'userId and blockedId are required' });
  if (userId === blockedId) return res.status(400).json({ error: "You can't block yourself" });
  const { error } = await supabase.from('blocks')
    .upsert({ blocker_id: userId, blocked_id: blockedId, created_at: Date.now() }, { onConflict: 'blocker_id,blocked_id' });
  if (error) return res.status(500).json({ error: 'Could not block user' });
  res.json({ ok: true });
}));

app.delete('/api/blocks/:blockedId', ah(async (req, res) => {
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  const { error } = await supabase.from('blocks').delete().match({ blocker_id: userId, blocked_id: req.params.blockedId });
  if (error) return res.status(500).json({ error: 'Could not unblock user' });
  res.json({ ok: true });
}));

// Still no in-app review dashboard — reports land in Supabase (user_reports)
// and now also trigger an email to ADMIN_EMAIL so they don't just sit
// silently; acting on one (banning) is still a manual Table Editor flip.
app.post('/api/reports', ah(async (req, res) => {
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  const { reportedId, reason } = req.body;
  if (!userId || !reportedId || !reason || !reason.trim()) {
    return res.status(400).json({ error: 'reportedId and reason are required' });
  }
  if (userId === reportedId) return res.status(400).json({ error: "You can't report yourself" });
  const cleanReason = reason.trim().slice(0, 500);
  const { error } = await supabase.from('user_reports').insert({
    reporter_id: userId, reported_id: reportedId, reason: cleanReason, created_at: Date.now()
  });
  if (error) return res.status(500).json({ error: 'Could not submit report' });
  notifyAdminOfReport(userId, reportedId, cleanReason).catch(() => {});
  res.json({ ok: true });
}));

// --- Course ratings/reviews -------------------------------------------------
// Keyed by course name (see supabase-course-ratings.sql) — one editable
// review per (course, rater), same upsert pattern as player ratings.
app.get('/api/course-ratings', ah(async (req, res) => {
  const courseName = (req.query.courseName || '').trim();
  if (!courseName) return res.status(400).json({ error: 'courseName is required' });
  const summary = await getCourseRatingSummary(courseName);
  const { data: rows, error } = await supabase
    .from('course_ratings')
    .select('raterId:rater_id, raterName:rater_name, rating, comment, createdAt:created_at')
    .eq('course_name', courseName)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Could not load course ratings' });
  res.json({ avgRating: summary.avgRating, ratingCount: summary.ratingCount, ratings: rows || [] });
}));

app.post('/api/course-ratings', ah(async (req, res) => {
  const { courseName, rating, comment, raterName } = req.body;
  const raterId = verifiedUserId(req);
  if (!raterId) return res.status(401).json({ error: 'Sign in required' });
  if (!raterId || !courseName || !courseName.trim() || !rating || !raterName) {
    return res.status(400).json({ error: 'raterId, courseName, rating and raterName are required' });
  }
  const r = parseInt(rating);
  if (r < 1 || r > 5) return res.status(400).json({ error: 'rating must be between 1 and 5' });
  if (await isBanned(raterId)) return res.status(403).json(BANNED_ERROR);
  const { error } = await supabase.from('course_ratings').upsert({
    course_name: courseName.trim(), rater_id: raterId, rater_name: raterName,
    rating: r, comment: comment || '', created_at: Date.now(),
  }, { onConflict: 'course_name,rater_id' });
  if (error) {
    console.error('Failed to save course rating:', error.message);
    return res.status(500).json({ error: 'Could not save your rating' });
  }
  const summary = await getCourseRatingSummary(courseName.trim());
  res.json({ ok: true, avgRating: summary.avgRating, ratingCount: summary.ratingCount });
}));

// --- Book a Tee Time (course request / waitlist) --------------------------
// No real booking integration yet — this just collects demand signal on
// which courses people actually want, and when. Every submission is logged
// as-is (no dedup) since requesting the same course again with a different
// date is a normal thing to do; /mine returns the user's own pending
// requests in full so the UI can list and let them cancel any of them.
function courseRequestJson(row) {
  return {
    id: row.id,
    courseName: row.course_name,
    preferredDate: row.preferred_date,
    preferredTime: row.preferred_time,
    createdAt: row.created_at,
  };
}

app.get('/api/course-requests/mine', ah(async (req, res) => {
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  const { data, error } = await supabase
    .from('course_requests')
    .select('id, course_name, preferred_date, preferred_time, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('Failed to load course requests:', error.message);
    return res.status(500).json({ error: 'Could not load your requests' });
  }
  res.json({ requests: (data || []).map(courseRequestJson) });
}));

app.post('/api/course-requests', ah(async (req, res) => {
  const { courseName, preferredDate, preferredTime } = req.body;
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  if (!userId || !courseName || !courseName.trim()) {
    return res.status(400).json({ error: 'userId and courseName are required' });
  }
  if (await isBanned(userId)) return res.status(403).json(BANNED_ERROR);
  const { data, error } = await supabase.from('course_requests').insert({
    course_name: courseName.trim(),
    user_id: userId,
    preferred_date: preferredDate || null,
    preferred_time: preferredTime || null,
    created_at: Date.now()
  }).select().single();
  if (error) {
    console.error('Failed to save course request:', error.message);
    return res.status(500).json({ error: 'Could not save your request' });
  }
  res.json({ ok: true, request: courseRequestJson(data) });
}));

app.delete('/api/course-requests/:id', ah(async (req, res) => {
  const userId = verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required' });
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  const { data: existing, error: fetchError } = await supabase
    .from('course_requests').select('id, user_id').eq('id', req.params.id).maybeSingle();
  if (fetchError) {
    console.error('Failed to load course request:', fetchError.message);
    return res.status(500).json({ error: 'Could not load request' });
  }
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.user_id !== userId) return res.status(403).json({ error: 'Not your request' });
  const { error } = await supabase.from('course_requests').delete().eq('id', req.params.id);
  if (error) {
    console.error('Failed to cancel course request:', error.message);
    return res.status(500).json({ error: 'Could not cancel request' });
  }
  res.json({ ok: true });
}));

// --- Find a course: live course search (OpenStreetMap) --------------------
// Nearby search uses Overpass's `around:` spatial filter; name search uses
// Nominatim (OSM's search index), since Overpass regex name searches time
// out on the public instances.
//
// The public Overpass server (overpass-api.de) is often at capacity — it
// answers "502 ... All query workers are busy and the request queue is
// full" — and was the cause of "Course search is temporarily unavailable".
// So nearby search tries overpass-api.de first. If that fails, or hasn't
// answered within a few seconds, it also asks a backup Overpass server and
// a Nominatim search bounded to the area around the user, and answers with
// whichever returns courses first — Nominatim usually wins within a second (capped at 40 results),
// while the backup Overpass server is slower (often 20s+) but more
// complete, so its answer still lands in the cache for the next request.
// If every source fails, a recent cached answer for that spot is served
// instead of an error.
//
// OSM usage rules followed here (operations.osmfoundation.org/policies):
// an identifying User-Agent with contact details on every request, at most
// one Nominatim request per second across the whole server, one query at
// a time per Overpass server, identical in-flight lookups shared rather than repeated,
// and results cached so popular searches don't re-hit OSM at all.
const OSM_USER_AGENT = 'FoursomeApp/1.0 (+https://felipepostolov.onrender.com; foursomeapp.golf@gmail.com)';
const OVERPASS_SERVERS = [
  { url: 'https://overpass-api.de/api/interpreter', timeoutMs: 10000 },
  { url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', timeoutMs: 25000 },
];
const NOMINATIM_TIMEOUT_MS = 10000;

// Golf courses barely change, so results stay fresh for a day; anything up
// to a week old is still served as a last resort when OSM is unreachable.
const OSM_CACHE_FRESH_MS = 24 * 60 * 60 * 1000;
const OSM_CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const OSM_CACHE_MAX = 1000;
const osmCache = new Map();

function getCachedOsm(key, maxAgeMs = OSM_CACHE_FRESH_MS) {
  const hit = osmCache.get(key);
  if (!hit) return null;
  const age = Date.now() - hit.at;
  if (age > OSM_CACHE_STALE_MS) { osmCache.delete(key); return null; }
  if (age > maxAgeMs) return null;
  // Re-insert so popular entries stay at the "recent" end of the Map and
  // the oldest-first eviction below drops rarely used ones instead.
  osmCache.delete(key);
  osmCache.set(key, hit);
  return hit.data;
}
function setCachedOsm(key, data) {
  osmCache.delete(key);
  osmCache.set(key, { at: Date.now(), data });
  if (osmCache.size > OSM_CACHE_MAX) osmCache.delete(osmCache.keys().next().value);
}

// Identical lookups that arrive while one is already running share its
// result instead of each hitting OSM.
const osmInFlight = new Map();
function sharedLookup(key, fn) {
  if (osmInFlight.has(key)) return osmInFlight.get(key);
  const p = fn().finally(() => osmInFlight.delete(key));
  osmInFlight.set(key, p);
  return p;
}

// Runs tasks one at a time, at least `gapMs` apart.
function serialQueue(gapMs) {
  let tail = Promise.resolve();
  let last = 0;
  return (task) => {
    const run = tail.then(async () => {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      try { return await task(); } finally { last = Date.now(); }
    });
    tail = run.catch(() => {});
    return run;
  };
}
const nominatimQueue = serialQueue(1100); // Nominatim: max 1 request/second
const overpassQueues = new Map();          // Overpass: one query at a time per server
function overpassQueue(url) {
  if (!overpassQueues.has(url)) overpassQueues.set(url, serialQueue(0));
  return overpassQueues.get(url);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

// One retry after a short pause for a quick failure (busy/rate-limited
// server or a dropped connection). A timeout is not retried against the
// same server — it already used up its time budget.
async function fetchWithOneRetry(doFetch, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await doFetch();
      if (attempt === 1 && isRetryableStatus(res.status)) {
        console.warn(`${label}: HTTP ${res.status}, retrying once`);
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt === 1 && err.name !== 'AbortError') {
        console.warn(`${label}: ${err.message}, retrying once`);
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      throw err.name === 'AbortError' ? new Error('timed out') : err;
    }
  }
}

function nominatimFetch(url) {
  return fetchWithOneRetry(
    () => nominatimQueue(() => fetchWithTimeout(url, { headers: { 'User-Agent': OSM_USER_AGENT } }, NOMINATIM_TIMEOUT_MS)),
    'Nominatim'
  );
}

async function overpassQuery(query, servers) {
  const errors = [];
  for (const server of servers) {
    const host = new URL(server.url).host;
    try {
      const r = await fetchWithOneRetry(() => overpassQueue(server.url)(() => fetchWithTimeout(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': OSM_USER_AGENT },
        body: 'data=' + encodeURIComponent(query),
      }, server.timeoutMs)), 'Overpass ' + host);
      if (!r.ok) {
        const text = (await r.text()).replace(/\s+/g, ' ').slice(0, 120);
        throw new Error(`HTTP ${r.status}: ${text}`);
      }
      const data = await r.json();
      if (data.remark && !(data.elements || []).length) throw new Error(data.remark);
      return data;
    } catch (err) {
      console.error(`Overpass ${host} failed: ${err.message}`);
      errors.push(`${host}: ${err.message}`);
    }
  }
  throw new Error(errors.join(' | '));
}

// Everything OSM returns here is already tagged leisure=golf_course, but
// that tag is also used for driving ranges, mini golf and the like, so the
// tag alone can't separate real courses. Instead:
// - a golf=driving_range / miniature_golf tag, or a name that says
//   driving range, mini golf, footgolf, disc golf etc., always drops it —
//   even "Bergen Point Golf Course - Driving Range" is just the range;
// - a name that looks like a boardwalk, beach, park, pier or playground
//   drops it unless the name also says golf, course, country club or
//   links (so "Forest Park Golf Course" and "South Gleason Park Course"
//   stay);
// - an unnamed entry is dropped (its "name" would only be the first part
//   of its street address, which is how "Jones Beach Boardwalk" showed up).
const NOT_A_COURSE_NAME = /\b(driving[\s-]*range|golf[\s-]*range|practice[\s-]*range|mini(ature)?[\s-]*golf|putt[\s-]*putt|foot[\s-]*golf|disc[\s-]*golf|frisbee|top[\s-]*golf|drive[\s-]*shack|golf[\s-]*simulator)\b/i;
const NOT_A_COURSE_TAG = new Set(['driving_range', 'miniature_golf', 'practice', 'range']);
const NON_GOLF_PLACE_NAME = /\b(boardwalk|beach|park|pier|playground)\b/i;
const GOLF_COURSE_NAME = /\b(golf|course|country[\s-]*club|links|cc)\b/i;

function isRealGolfCourse(name, tags = {}) {
  if (!name || !name.trim()) return false;
  if (NOT_A_COURSE_TAG.has(tags.golf) || tags.leisure === 'miniature_golf') return false;
  if (NOT_A_COURSE_NAME.test(name)) return false;
  if (NON_GOLF_PLACE_NAME.test(name) && !GOLF_COURSE_NAME.test(name)) return false;
  return true;
}

function overpassElementToCourse(el) {
  const tags = el.tags || {};
  const lat = el.lat != null ? el.lat : (el.center ? el.center.lat : null);
  const lng = el.lon != null ? el.lon : (el.center ? el.center.lon : null);
  if (lat == null || lng == null || !isRealGolfCourse(tags.name, tags)) return null;
  return { name: tags.name, lat, lng };
}

// Needs the request to ask for extratags=1, so a golf=driving_range tag
// is visible here.
function nominatimPlaceToCourse(p) {
  if (!isRealGolfCourse(p.name, p.extratags || {})) return null;
  return { name: p.name, lat: parseFloat(p.lat), lng: parseFloat(p.lon) };
}

function isGolfCourse(p) {
  return (p.class || p.category) === 'leisure' && p.type === 'golf_course';
}

function uniqueByName(courses) {
  const seen = new Set();
  return courses.filter(c => c && !seen.has(c.name) && seen.add(c.name));
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function nearbyFromOverpass(lat, lng, radiusMiles, servers) {
  const radiusMeters = Math.round(radiusMiles * 1609.34);
  const query = `[out:json][timeout:25];nwr["leisure"="golf_course"](around:${radiusMeters},${lat},${lng});out center 60;`;
  const data = await overpassQuery(query, servers);
  return uniqueByName((data.elements || []).map(overpassElementToCourse));
}

// Last-resort nearby source: Nominatim limited to a box around the point.
async function nearbyFromNominatim(lat, lng, radiusMiles) {
  const dLat = radiusMiles / 69;
  const dLng = radiusMiles / (69 * Math.max(Math.cos(lat * Math.PI / 180), 0.1));
  const viewbox = [lng - dLng, lat + dLat, lng + dLng, lat - dLat].map(n => n.toFixed(4)).join(',');
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=40&bounded=1&extratags=1&viewbox=' + viewbox + '&q=golf%20course';
  const r = await nominatimFetch(url);
  if (!r.ok) throw new Error('Nominatim HTTP ' + r.status);
  const results = await r.json();
  return uniqueByName(results.filter(isGolfCourse).map(nominatimPlaceToCourse))
    .filter(c => haversineMiles(lat, lng, c.lat, c.lng) <= radiusMiles);
}

// How long the primary Overpass server gets on its own before the
// fallbacks start too. A healthy server answers well within this; when
// it's overloaded it either fails fast or hangs, and nobody should wait
// out the hang.
const OVERPASS_HEAD_START_MS = 4000;

async function nearbyFallbacks(lat, lng, radiusMiles, cacheKey) {
  const backup = nearbyFromOverpass(lat, lng, radiusMiles, OVERPASS_SERVERS.slice(1));
  // Whenever the backup finishes, its fuller list replaces what's cached.
  backup.then(courses => setCachedOsm(cacheKey, courses), () => {});
  const nominatim = nearbyFromNominatim(lat, lng, radiusMiles);
  try {
    return await Promise.any([
      backup.then(courses => ({ courses, source: 'overpass-backup' })),
      nominatim.then(courses => {
        if (!courses.length) throw new Error('no results');
        return { courses, source: 'nominatim' };
      }),
    ]);
  } catch (err) {
    // Neither found anything; an empty Nominatim answer is still an answer.
    const courses = await nominatim.catch(() => null);
    if (courses) return { courses, source: 'nominatim' };
    throw new Error('every fallback course source failed');
  }
}

async function nearbyWithFallbacks(lat, lng, radiusMiles, cacheKey) {
  const primary = nearbyFromOverpass(lat, lng, radiusMiles, OVERPASS_SERVERS.slice(0, 1))
    .then(courses => ({ courses, source: 'overpass' }));
  // If the primary answers after a fallback already did, keep its list.
  primary.then(r => setCachedOsm(cacheKey, r.courses), () => {});

  let startFallbacks;
  const gate = new Promise(resolve => { startFallbacks = resolve; });
  const timer = setTimeout(startFallbacks, OVERPASS_HEAD_START_MS);
  primary.catch(() => startFallbacks());
  const fallbacks = gate.then(() => nearbyFallbacks(lat, lng, radiusMiles, cacheKey));
  try {
    return await Promise.any([primary, fallbacks]);
  } catch (err) {
    throw new Error('every course source failed');
  } finally {
    clearTimeout(timer);
  }
}

async function searchFromNominatim(term) {
  // Biasing toward "<term> golf course" matters: a bare distinctive name
  // (e.g. "Cariari") often matches a village/neighborhood in Nominatim's
  // general ranking before it matches the golf venue at that same name.
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=10&extratags=1&q=' + encodeURIComponent(term + ' golf course');
  const r = await nominatimFetch(url);
  if (!r.ok) throw new Error('Nominatim HTTP ' + r.status);
  const results = await r.json();
  return uniqueByName(results.filter(isGolfCourse).map(nominatimPlaceToCourse));
}

// Attaches Foursome's own course ratings to OpenStreetMap search results —
// done at response time rather than baked into the OSM cache entry, so
// cached course lists stay reusable while ratings are always read fresh.
async function enrichCoursesWithRatings(courses) {
  const summaries = await getCourseRatingSummaries(courses.map(c => c.name));
  return courses.map(c => ({ ...c, ...summaries.get(c.name) }));
}

const COURSE_SEARCH_UNAVAILABLE = "Course search isn't responding right now. Try again in a minute, or search by course name.";

app.get('/api/golf-courses/nearby', ah(async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }
  const radiusMiles = Math.min(parseFloat(req.query.radiusMiles) || 50, 50);
  // ~0.05° (3-4 miles) buckets, so nearby users share one cache entry.
  const bucket = n => (Math.round(n * 20) / 20).toFixed(2);
  const cacheKey = `nearby:${bucket(lat)}:${bucket(lng)}:${radiusMiles}`;
  const cached = getCachedOsm(cacheKey);
  if (cached) return res.json({ courses: await enrichCoursesWithRatings(cached), source: 'cache' });

  try {
    const result = await sharedLookup(cacheKey, async () => {
      const r = await nearbyWithFallbacks(lat, lng, radiusMiles, cacheKey);
      setCachedOsm(cacheKey, r.courses);
      return r;
    });
    res.json({ courses: await enrichCoursesWithRatings(result.courses), source: result.source });
  } catch (err) {
    console.error('Nearby course lookup failed on every source:', err.message);
    const stale = getCachedOsm(cacheKey, OSM_CACHE_STALE_MS);
    if (stale) return res.json({ courses: await enrichCoursesWithRatings(stale), source: 'stale-cache' });
    res.status(503).json({ error: COURSE_SEARCH_UNAVAILABLE });
  }
}));

app.get('/api/golf-courses/search', ah(async (req, res) => {
  const term = (req.query.q || '').trim().replace(/\s+/g, ' ');
  if (term.length < 3) {
    return res.status(400).json({ error: 'Search term must be at least 3 characters' });
  }
  const cacheKey = `search:${term.toLowerCase()}`;
  const cached = getCachedOsm(cacheKey);
  if (cached) return res.json({ courses: await enrichCoursesWithRatings(cached), source: 'cache' });

  try {
    const courses = await sharedLookup(cacheKey, () => searchFromNominatim(term));
    setCachedOsm(cacheKey, courses);
    res.json({ courses: await enrichCoursesWithRatings(courses), source: 'nominatim' });
  } catch (err) {
    console.error('Nominatim course search failed:', err.message);
    const stale = getCachedOsm(cacheKey, OSM_CACHE_STALE_MS);
    if (stale) return res.json({ courses: await enrichCoursesWithRatings(stale), source: 'stale-cache' });
    res.status(503).json({ error: COURSE_SEARCH_UNAVAILABLE });
  }
}));

// Final error handler — catches anything ah() forwarded (e.g. a Supabase
// query error) so it becomes a normal 500 response instead of crashing
// the process via an unhandled rejection.
app.use((err, req, res, next) => {
  console.error('Unhandled request error:', err.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Foursome backend listening on port ${PORT}`);
});
