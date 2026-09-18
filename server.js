// Foursome backend — now the single source of truth for everything:
// profiles, tee times, and real Stripe payment verification. Also serves
// the app itself as a real website (see /public/index.html), which is
// what makes the payment button actually work — no more sandboxed
// artifact blocking outbound requests.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;

const stripeConfigured = !!process.env.STRIPE_SECRET_KEY;
const stripe = stripeConfigured ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (!stripeConfigured) {
  console.warn('STRIPE_SECRET_KEY not set — payment routes are disabled until STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_ID are configured.');
}

const pushConfigured = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (pushConfigured) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn('VAPID keys not set — push notifications are disabled until VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are configured.');
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

async function buildTeetimeResponse(row) {
  const json = teetimeRowToJson(row);
  json.ratings = await getRatingsForTeetime(row.id);
  const hostSummary = await getRatingSummary(row.host_id);
  json.hostAvgRating = hostSummary.avgRating;
  json.hostRatingCount = hostSummary.ratingCount;
  return json;
}

async function toProfileJson(row) {
  const summary = await getRatingSummary(row.user_id);
  return {
    id: row.user_id,
    name: row.name,
    homeCourse: row.home_course,
    handicap: row.handicap,
    bio: row.bio || '',
    isPro: !!row.is_pro,
    avgRating: summary.avgRating,
    ratingCount: summary.ratingCount
  };
}

async function notifyUser(userId, title, body) {
  if (!pushConfigured) return;
  const { data: subs, error } = await supabase.from('push_subscriptions').select('*').eq('user_id', userId);
  if (error) {
    console.error('Failed to load push subscriptions for', userId, error.message);
    return;
  }
  for (const row of subs || []) {
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

function isParticipant(teetimeRow, userId) {
  if (teetimeRow.host_id === userId) return true;
  const requests = teetimeRow.requests || [];
  return requests.some(r => r.userId === userId && r.status === 'approved');
}

// Free geocoding via OpenStreetMap's Nominatim — no API key needed.
// Their usage policy asks for a real identifying User-Agent and to keep
// requests light (this app only geocodes once per posted round, not on
// every page load, so it stays well within fair use).
async function geocodeCourse(courseName) {
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
      encodeURIComponent(courseName + ' golf course');
    const res = await fetch(url, {
      headers: { 'User-Agent': 'FoursomeApp/1.0 (golf tee-time matching prototype)' }
    });
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
// null and routes fall back to trusting a client-supplied id, same as
// before — that's what keeps guest mode working untouched.
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
  next();
}

// The effective identity for a request: the verified session's user id when
// one exists, otherwise whatever id the client sent (guest mode). A signed-in
// client can't spoof a different userId in the body/query once this is used
// consistently — the session always wins.
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
  const userId = resolveUserId(req, req.body.userId);
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
  const userId = resolveUserId(req, req.query.userId);
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  const user = await getUser(userId);
  res.json({ isPro: !!(user && user.is_pro) });
}));

app.post('/api/portal', ah(async (req, res) => {
  if (!stripeConfigured) {
    return res.status(503).json({ error: 'Stripe is not configured on this server yet' });
  }
  const { returnUrl } = req.body;
  const userId = resolveUserId(req, req.body.userId);
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
app.post('/api/auth/migrate-guest', ah(async (req, res) => {
  if (!req.authUser) return res.status(401).json({ error: 'Sign in required' });
  const { guestId } = req.body;
  if (!guestId) return res.status(400).json({ error: 'guestId is required' });
  if (guestId === req.authUser.id) return res.json({ migrated: false, profile: null });

  const { error } = await supabase.rpc('migrate_guest_to_user', {
    p_guest_id: guestId,
    p_auth_id: req.authUser.id,
  });
  if (error) {
    console.error('Guest migration failed:', error.message);
    return res.status(500).json({ error: 'Could not migrate guest data' });
  }

  const user = await getUser(req.authUser.id);
  res.json({ migrated: true, profile: user ? await toProfileJson(user) : null });
}));

// Permanently deletes a user's data — profile, rounds they hosted (and
// those rounds' chat history), their ratings, push subscriptions, and their
// entries inside other people's teetimes.requests/viewedBy. Works the same
// way for a signed-in user (resolveUserId forces this to their own id) and
// a guest (trusts the client-supplied id, same trust model as everywhere
// else in guest mode). When signed in, also deletes the actual Supabase
// Auth account — from that point the access token they were using is dead.
app.delete('/api/account', ah(async (req, res) => {
  const userId = resolveUserId(req, req.body.userId);
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const { error: rpcError } = await supabase.rpc('delete_user_account', { p_user_id: userId });
  if (rpcError) {
    console.error('Failed to delete account data:', rpcError.message);
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
  const { name, homeCourse, handicap, bio } = req.body;
  const userId = resolveUserId(req, req.body.userId);
  if (!userId || !name || !homeCourse || handicap == null) {
    return res.status(400).json({ error: 'userId, name, homeCourse and handicap are required' });
  }
  const existing = await getUser(userId);
  if (existing) {
    const { error } = await supabase.from('users').update({
      name, home_course: homeCourse, handicap: parseFloat(handicap), bio: bio || '', updated_at: Date.now()
    }).eq('user_id', userId);
    if (error) return res.status(500).json({ error: 'Could not save profile' });
  } else {
    const { error } = await supabase.from('users').insert({
      user_id: userId, name, home_course: homeCourse, handicap: parseFloat(handicap), bio: bio || '', updated_at: Date.now()
    });
    if (error) return res.status(500).json({ error: 'Could not save profile' });
  }
  res.json(await toProfileJson(await getUser(userId)));
}));

app.get('/api/profiles/:userId', ah(async (req, res) => {
  const user = await getUser(req.params.userId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(await toProfileJson(user));
}));

// --- Tee times -------------------------------------------------------------
app.get('/api/teetimes', ah(async (req, res) => {
  const { data: rows, error } = await supabase.from('teetimes').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Could not load tee times' });
  res.json(await Promise.all(rows.map(buildTeetimeResponse)));
}));

app.post('/api/teetimes', ah(async (req, res) => {
  const { hostName, hostHandicap, course, date, time, totalSpots, hcpRange, pace, notes } = req.body;
  const hostId = resolveUserId(req, req.body.hostId);
  if (!hostId || !hostName || !course || !date || !time || !totalSpots) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

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
  res.json(await buildTeetimeResponse(row));
}));

app.post('/api/teetimes/:id/request', ah(async (req, res) => {
  const { name, handicap } = req.body;
  const userId = resolveUserId(req, req.body.userId);
  const { data: row, error } = await supabase.from('teetimes').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not load tee time' });
  if (!row) return res.status(404).json({ error: 'Not found' });
  const requests = row.requests || [];
  if (requests.some(r => r.userId === userId)) {
    return res.json(await buildTeetimeResponse(row)); // already requested, no-op
  }
  requests.push({ userId, name, handicap, status: 'pending' });
  await supabase.from('teetimes').update({ requests }).eq('id', req.params.id);
  notifyUser(row.host_id, 'New join request', `${name} wants to join your round at ${row.course}`).catch(() => {});
  const { data: updated } = await supabase.from('teetimes').select('*').eq('id', req.params.id).single();
  res.json(await buildTeetimeResponse(updated));
}));

app.post('/api/teetimes/:id/respond', ah(async (req, res) => {
  const { userId, decision } = req.body;
  const { data: row, error } = await supabase.from('teetimes').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not load tee time' });
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (req.authUser && req.authUser.id !== row.host_id) {
    return res.status(403).json({ error: 'Only the host can respond to requests' });
  }
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
  res.json(await buildTeetimeResponse(updated));
}));

app.post('/api/teetimes/:id/rate', ah(async (req, res) => {
  const { rateeId, rating, comment } = req.body;
  const raterId = resolveUserId(req, req.body.raterId);
  if (!raterId || !rateeId || !rating) {
    return res.status(400).json({ error: 'raterId, rateeId and rating are required' });
  }
  const r = parseInt(rating);
  if (r < 1 || r > 5) return res.status(400).json({ error: 'rating must be between 1 and 5' });
  const { data: row, error } = await supabase.from('teetimes').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not load tee time' });
  if (!row) return res.status(404).json({ error: 'Not found' });
  // Upsert: remove any existing rating from this rater to this ratee for this round, then insert fresh
  await supabase.from('ratings').delete().match({ teetime_id: req.params.id, rater_id: raterId, ratee_id: rateeId });
  await supabase.from('ratings').insert({
    teetime_id: req.params.id, rater_id: raterId, ratee_id: rateeId, rating: r, comment: comment || '', created_at: Date.now()
  });
  res.json(await buildTeetimeResponse(row));
}));

app.post('/api/teetimes/:id/view', ah(async (req, res) => {
  const userId = resolveUserId(req, req.body.userId);
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
  const userId = resolveUserId(req, req.body.userId);
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

app.get('/api/teetimes/:id/messages', ah(async (req, res) => {
  const { userId } = req.query;
  const { data: row, error } = await supabase.from('teetimes').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not load tee time' });
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!userId || !isParticipant(row, userId)) {
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
  const userId = resolveUserId(req, req.body.userId);
  if (!userId || !name || !text || !text.trim()) {
    return res.status(400).json({ error: 'userId, name and text are required' });
  }
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

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: pushConfigured ? process.env.VAPID_PUBLIC_KEY : '' });
});

app.post('/api/push/subscribe', async (req, res) => {
  const { subscription } = req.body;
  const userId = resolveUserId(req, req.body.userId);
  if (!userId || !subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'userId and subscription are required' });
  }
  try {
    const { data: existing } = await supabase.from('push_subscriptions').select('id').eq('endpoint', subscription.endpoint).maybeSingle();
    if (existing) {
      const { error } = await supabase.from('push_subscriptions')
        .update({ user_id: userId, subscription })
        .eq('endpoint', subscription.endpoint);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('push_subscriptions')
        .insert({ user_id: userId, endpoint: subscription.endpoint, subscription, created_at: Date.now() });
      if (error) throw error;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to save push subscription:', err.message);
    res.status(500).json({ error: 'Could not save subscription' });
  }
});

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
  const userId = resolveUserId(req, req.query.userId);
  if (!userId) return res.status(400).json({ error: 'userId is required' });
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
  const userId = resolveUserId(req, req.body.userId);
  if (!userId || !courseName || !courseName.trim()) {
    return res.status(400).json({ error: 'userId and courseName are required' });
  }
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
  const userId = resolveUserId(req, req.body.userId);
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

// --- Book a Tee Time: live course search (OpenStreetMap) -------------------
// Nearby search uses Overpass's `around:` spatial filter — direct testing
// showed this is fast and reliable on the public instance. Global name
// search uses Nominatim (OSM's purpose-built search index, already used by
// geocodeCourse above) instead of Overpass — testing showed Overpass's `~`
// regex tag search reliably times out on the public instance regardless of
// query shape or spatial bound size (even an 800km-bounded regex query
// timed out), while Nominatim answers the same "find this named place"
// query in well under a second. Both share one small in-memory cache so
// repeated lookups (retyped searches, re-opening the tab) don't re-hit
// either service every time — this is shared across all users, which is
// what actually matters for being a good citizen of free public infra.
const OSM_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const osmCache = new Map();

function getCachedOsm(key) {
  const hit = osmCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > OSM_CACHE_TTL_MS) { osmCache.delete(key); return null; }
  return hit.data;
}
function setCachedOsm(key, data) {
  osmCache.set(key, { at: Date.now(), data });
  if (osmCache.size > 200) osmCache.delete(osmCache.keys().next().value);
}

function overpassElementToCourse(el) {
  const tags = el.tags || {};
  const lat = el.lat != null ? el.lat : (el.center ? el.center.lat : null);
  const lng = el.lon != null ? el.lon : (el.center ? el.center.lon : null);
  if (lat == null || lng == null || !tags.name) return null;
  return { name: tags.name, lat, lng };
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

app.get('/api/golf-courses/nearby', ah(async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }
  const radiusMiles = Math.min(parseFloat(req.query.radiusMiles) || 50, 50);
  const radiusMeters = Math.round(radiusMiles * 1609.34);
  const cacheKey = `nearby:${lat.toFixed(2)}:${lng.toFixed(2)}:${radiusMiles}`;
  const cached = getCachedOsm(cacheKey);
  if (cached) return res.json({ courses: cached });

  const query = `[out:json][timeout:20];(node["leisure"="golf_course"](around:${radiusMeters},${lat},${lng});way["leisure"="golf_course"](around:${radiusMeters},${lat},${lng});relation["leisure"="golf_course"](around:${radiusMeters},${lat},${lng}););out center 60;`;
  try {
    const r = await fetchWithTimeout('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'User-Agent': 'FoursomeApp/1.0 (golf tee-time matching prototype; contact: foursomeapp.golf@gmail.com)' },
      body: query
    }, 15000);
    if (!r.ok) throw new Error('Overpass returned ' + r.status);
    const data = await r.json();
    if (data.remark) throw new Error(data.remark);
    const seen = new Set();
    const courses = [];
    for (const el of (data.elements || [])) {
      const c = overpassElementToCourse(el);
      if (c && !seen.has(c.name)) { seen.add(c.name); courses.push(c); }
    }
    setCachedOsm(cacheKey, courses);
    res.json({ courses });
  } catch (err) {
    console.error('Overpass nearby lookup failed:', err.message);
    res.status(503).json({ error: 'Course search is temporarily unavailable — try again shortly' });
  }
}));

app.get('/api/golf-courses/search', ah(async (req, res) => {
  const term = (req.query.q || '').trim();
  if (term.length < 3) {
    return res.status(400).json({ error: 'Search term must be at least 3 characters' });
  }
  const cacheKey = `search:${term.toLowerCase()}`;
  const cached = getCachedOsm(cacheKey);
  if (cached) return res.json({ courses: cached });

  try {
    // Biasing toward "<term> golf course" matters: a bare distinctive name
    // (e.g. "Cariari") often matches a village/neighborhood in Nominatim's
    // general ranking before it matches the golf venue at that same name —
    // adding the qualifier consistently surfaces the actual course instead,
    // without breaking searches that already include the full venue name.
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=10&q=' + encodeURIComponent(term + ' golf course');
    const r = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'FoursomeApp/1.0 (golf tee-time matching prototype; contact: foursomeapp.golf@gmail.com)' }
    }, 10000);
    if (!r.ok) throw new Error('Nominatim returned ' + r.status);
    const results = await r.json();
    const courses = results
      .filter(p => p.class === 'leisure' && p.type === 'golf_course')
      .map(p => ({ name: p.name || p.display_name.split(',')[0], lat: parseFloat(p.lat), lng: parseFloat(p.lon) }));
    setCachedOsm(cacheKey, courses);
    res.json({ courses });
  } catch (err) {
    console.error('Nominatim course search failed:', err.message);
    res.status(503).json({ error: 'Course search is temporarily unavailable — try again shortly' });
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
