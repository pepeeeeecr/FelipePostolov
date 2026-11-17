// Paying for an event with ONVO (parts C and D).
//
// 1. Join: the server holds a spot for HOLD_MINUTES (a database function
//    locks the event, so the last spot can't go to two people) and opens
//    an ONVO Checkout page for the exact price in colones.
// 2. The spot is confirmed only when ONVO's signed webhook says the payment
//    succeeded — never because the app says so.
// 3. A hold that runs out is released and its Checkout page expired, so it
//    can't be paid late. If a payment still lands after the event filled
//    up (or was cancelled), it's refunded in full automatically.

const express = require('express');
const onvo = require('./onvo');
const { whenLabel } = require('./events');
const { push } = require('./i18n');

const HOLD_MINUTES = 20; // enough for card + 3DS, or a SINPE Móvil transfer
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://felipepostolov.onrender.com').replace(/\/$/, '');
// Where the "Back to Foursome" button on the return page may point: the
// app's own scheme, or Expo Go while developing.
const APP_RETURN_PATTERN = /^(foursomemobile|exp|exps):\/\/[^\s"'<>]*$/;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Apple's "Hide My Email" addresses (Sign in with Apple).
const isAppleRelay = email => /@privaterelay\.appleid\.com$/i.test(String(email || '').trim());

// A Costa Rica SINPE Móvil number: 8 digits (a +506 in front is dropped).
// Returns '8888-8888', or null if it isn't one.
function cleanPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('506')) d = d.slice(3);
  return /^[2-8]\d{7}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4)}` : null;
}

// What's left of a payment after guest refunds (see refundGuest).
function remainingColones(reg) {
  const taken = (Array.isArray(reg.guest_refunds) ? reg.guest_refunds : [])
    .filter(g => g.status !== 'failed').reduce((sum, g) => sum + (Number(g.amountColones) || 0), 0);
  return Math.max(0, Number(reg.amount_colones) - taken);
}

// One spot's share of a group payment: the total split evenly (the buyer's
// own spot takes any odd colón).
function guestShareColones(reg) {
  const bought = (reg.guest_names || []).length + 1;
  return Math.floor(Number(reg.amount_colones) / bought);
}

function makePayments(deps) {
  const { supabase } = deps;

  async function loadRegistration(match) {
    const [col, val] = Object.entries(match)[0];
    const { data, error } = await supabase.from('event_registrations').select('*').eq(col, val).maybeSingle();
    if (error) throw error;
    return data;
  }

  // --- SINPE Móvil refunds by hand ---------------------------------------------
  // ONVO only refunds card payments through its API. A SINPE Móvil payment is
  // refunded by the owner, by hand: a manual_refunds row is the to-do item,
  // and the player confirms the number to send it to.
  const isSinpe = reg => reg.payment_method === 'mobile_number';

  async function addManualRefund(reg, { kind, amountColones, guestIndex = null, guestName = null, phone = null }) {
    const { data, error } = await supabase.from('manual_refunds').insert({
      registration_id: reg.id, event_id: reg.event_id, user_id: reg.user_id, user_name: reg.user_name || '',
      kind, guest_index: guestIndex, guest_name: guestName, amount_colones: amountColones, phone: cleanPhone(phone), status: 'to_send', sent_at: null,
    }).select('*').maybeSingle();
    if (error) throw error;
    return data;
  }

  // Full refund of one paid registration (what's left of it after guest
  // refunds). Claims the row first so two callers (say a webhook retry and
  // the owner cancelling) can't both refund it. Cards: ONVO, and the result
  // arrives by refund.* webhook. SINPE Móvil: a refund to send by hand
  // (status refund_manual); returns { manual: true, amountColones }.
  async function refundRegistration(regId, { phone = null } = {}) {
    const { data: claimed, error: claimError } = await supabase.from('event_registrations')
      .update({ refund_id: 'requesting', refund_error: null, status: 'refund_pending', updated_at: new Date().toISOString() })
      .eq('id', regId).is('refund_id', null).in('status', ['confirmed', 'refund_pending'])
      .select('*').maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) return { skipped: true };
    const amount = remainingColones(claimed);
    const byHand = async () => {
      try {
        await addManualRefund(claimed, { kind: 'payment', amountColones: amount, phone });
      } catch (e) {
        console.error(`Could not record the SINPE Móvil refund for registration ${regId} (run supabase-sinpe-refunds.sql):`, e.message);
        await supabase.from('event_registrations').update({ refund_id: null, refund_error: 'SINPE Móvil refund: run supabase-sinpe-refunds.sql', updated_at: new Date().toISOString() }).eq('id', regId);
        return { error: 'We couldn’t start your refund — try again, or contact us' };
      }
      await supabase.from('event_registrations').update({
        status: 'refund_manual', refund_id: null, refund_error: null, payment_method: 'mobile_number', updated_at: new Date().toISOString(),
      }).eq('id', regId);
      return { manual: true, amountColones: amount };
    };
    if (isSinpe(claimed)) return byHand();
    if (!claimed.payment_intent_id) {
      await supabase.from('event_registrations').update({ refund_id: null, refund_error: 'No ONVO payment to refund' }).eq('id', regId);
      return { error: 'No ONVO payment to refund' };
    }
    try {
      const refund = await onvo.createRefund({ paymentIntentId: claimed.payment_intent_id, amountColones: amount });
      await supabase.from('event_registrations').update({ refund_id: refund.id, updated_at: new Date().toISOString() }).eq('id', regId);
      return { refundId: refund.id };
    } catch (e) {
      if (onvo.isNotRefundableByApi(e)) return byHand(); // a SINPE Móvil payment we didn't know about
      console.error(`Refund for registration ${regId} failed:`, e.message);
      await supabase.from('event_registrations').update({ refund_id: null, refund_error: e.message.slice(0, 300), updated_at: new Date().toISOString() }).eq('id', regId);
      return { error: e.message };
    }
  }

  // Remembers how a payment was made (card or SINPE Móvil), so a later
  // refund knows whether ONVO can do it.
  async function rememberPaymentMethod(regId, paymentIntentId) {
    if (!paymentIntentId) return;
    try {
      const type = await onvo.paymentMethodType(paymentIntentId);
      if (type) await supabase.from('event_registrations').update({ payment_method: type }).eq('id', regId);
    } catch (e) { /* not important: a refund finds out from ONVO's answer */ }
  }

  // ONVO says this registration's payment succeeded.
  async function markPaid(reg, paymentIntentId) {
    const { data: outcome, error } = await supabase.rpc('confirm_event_payment', {
      p_registration_id: reg.id, p_payment_intent_id: paymentIntentId || null,
    });
    if (error) throw error;
    if (outcome === 'needs_refund') {
      console.warn(`Registration ${reg.id} was paid but the event is full or cancelled — refunding.`);
      await rememberPaymentMethod(reg.id, paymentIntentId || reg.payment_intent_id);
      await refundRegistration(reg.id);
    } else if (outcome === 'confirmed') {
      rememberPaymentMethod(reg.id, paymentIntentId || reg.payment_intent_id);
    }
    return outcome;
  }

  async function handleEvent(event) {
    const obj = (event.data && event.data.object) || {};
    switch (event.type) {
      case 'checkout_session.succeeded': {
        const reg = (obj.id && await loadRegistration({ checkout_session_id: obj.id }))
          || (obj.metadata && obj.metadata.registrationId && await loadRegistration({ id: Number(obj.metadata.registrationId) }));
        if (!reg) { console.warn('ONVO checkout_session.succeeded for an unknown session:', obj.id); return; }
        const expected = Math.round(reg.amount_colones * 100);
        if (String(obj.currency || '').toUpperCase() !== 'CRC' || Number(obj.amountTotal) !== expected) {
          console.error(`ONVO session ${obj.id} paid ${obj.amountTotal} ${obj.currency}, expected ${expected} CRC — not confirming registration ${reg.id}.`);
          return;
        }
        await markPaid(reg, obj.paymentIntentId);
        return;
      }
      case 'payment_intent.succeeded': {
        if (!obj.id) return;
        const reg = await loadRegistration({ payment_intent_id: obj.id });
        if (!reg) return; // the checkout_session event handles it
        const expected = Math.round(reg.amount_colones * 100);
        if (String(obj.currency || '').toUpperCase() !== 'CRC' || Number(obj.amount) !== expected) {
          console.error(`ONVO payment ${obj.id} was ${obj.amount} ${obj.currency}, expected ${expected} CRC — not confirming registration ${reg.id}.`);
          return;
        }
        await markPaid(reg, obj.id);
        return;
      }
      case 'refund.succeeded': {
        const reg = (obj.id && await loadRegistration({ refund_id: obj.id }))
          || (obj.paymentIntentId && await loadRegistration({ payment_intent_id: obj.paymentIntentId }));
        if (!reg) return;
        // One guest's refund: mark just that guest.
        if (await settleGuestRefund(reg, obj, 'refunded')) return;
        if (reg.refund_id !== obj.id && reg.status !== 'refund_pending') return; // not a refund of the whole payment
        await supabase.from('event_registrations')
          .update({ status: 'refunded', refunded_at: new Date().toISOString(), refund_id: obj.id || reg.refund_id, refund_error: null, updated_at: new Date().toISOString() })
          .eq('id', reg.id);
        return;
      }
      case 'refund.failed': {
        const reg = (obj.id && await loadRegistration({ refund_id: obj.id }))
          || (obj.paymentIntentId && await loadRegistration({ payment_intent_id: obj.paymentIntentId }));
        if (!reg) return;
        const why = (obj.failure && obj.failure.message) || obj.failureReason || 'Refund failed';
        if (await settleGuestRefund(reg, obj, 'failed', why)) return;
        if (reg.refund_id !== obj.id && reg.status !== 'refund_pending') return;
        // refund_id cleared so the owner can retry it.
        await supabase.from('event_registrations')
          .update({ refund_id: null, refund_error: String(why).slice(0, 300), updated_at: new Date().toISOString() })
          .eq('id', reg.id);
        return;
      }
      default:
        // payment_intent.failed / .canceled: nothing to do — the hold stays
        // until it runs out, so the player can try another card.
        return;
    }
  }

  // A refund webhook about one guest's refund: updates that guest's entry.
  // A failed one gives the spot back to the buyer (they can try again).
  async function settleGuestRefund(reg, obj, outcome, why) {
    const refundId = obj.id;
    const list = Array.isArray(reg.guest_refunds) ? reg.guest_refunds : [];
    let i = refundId ? list.findIndex(g => g.refundId === refundId) : -1;
    // The webhook can beat us saving ONVO's refund id: match by amount.
    if (i < 0) i = list.findIndex(g => g.refundId === 'requesting' && Math.round(g.amountColones * 100) === Number(obj.amount));
    if (i < 0) return false;
    const next = list.map((g, j) => (j === i ? { ...g, refundId: refundId || g.refundId, status: outcome, ...(why ? { error: String(why).slice(0, 200) } : {}) } : g));
    const update = { guest_refunds: next, updated_at: new Date().toISOString() };
    if (outcome === 'failed' && list[i].status !== 'failed') {
      update.spots = (reg.spots || 1) + 1;
      update.refund_error = `Guest refund failed: ${String(why).slice(0, 200)}`;
    }
    await supabase.from('event_registrations').update(update).eq('id', reg.id);
    return true;
  }

  // Refund one guest of a group payment (before the cutoff): their spot is
  // freed and their share goes back: by ONVO for a card, by hand (SINPE
  // Móvil) otherwise. index: position in guest_names.
  async function refundGuest(reg, index, { phone = null } = {}) {
    const name = (reg.guest_names || [])[index];
    if (name == null) return { status: 404, error: 'Guest not found' };
    const done = Array.isArray(reg.guest_refunds) ? reg.guest_refunds : [];
    if (done.some(g => g.index === index && g.status !== 'failed')) return { status: 409, error: 'That guest was already refunded' };
    if ((reg.spots || 1) < 2) return { status: 409, error: 'That guest was already refunded' };
    if (!reg.payment_intent_id && !isSinpe(reg)) return { status: 409, error: 'No ONVO payment to refund' };
    const amount = guestShareColones(reg);
    const sinpe = isSinpe(reg);
    const entry = { index, name, amountColones: amount, refundId: sinpe ? null : 'requesting', status: sinpe ? 'manual' : 'pending', at: new Date().toISOString() };
    // Claim: only if nothing changed since we read it.
    const { data: claimed, error } = await supabase.from('event_registrations')
      .update({ spots: reg.spots - 1, guest_refunds: [...done.filter(g => g.index !== index), entry], updated_at: new Date().toISOString() })
      .eq('id', reg.id).eq('spots', reg.spots).eq('status', 'confirmed').select('*').maybeSingle();
    if (error) throw error;
    if (!claimed) return { status: 409, error: 'Something changed — try again' };
    const undo = () => supabase.from('event_registrations')
      .update({ spots: reg.spots, guest_refunds: done, updated_at: new Date().toISOString() }).eq('id', reg.id);
    const byHand = async () => {
      try {
        await addManualRefund(reg, { kind: 'guest', amountColones: amount, guestIndex: index, guestName: name, phone });
      } catch (e) {
        console.error(`Could not record the SINPE Móvil guest refund for registration ${reg.id}:`, e.message);
        await undo();
        return { status: 502, error: 'We couldn’t start your refund — try again, or contact us' };
      }
      const { data: now } = await supabase.from('event_registrations').select('guest_refunds').eq('id', reg.id).maybeSingle();
      const list = ((now && now.guest_refunds) || []).map(g => (g.index === index ? { ...g, refundId: null, status: 'manual' } : g));
      await supabase.from('event_registrations').update({ guest_refunds: list, payment_method: 'mobile_number' }).eq('id', reg.id);
      return { status: 200, amountColones: amount, manual: true };
    };
    if (sinpe) return byHand();
    try {
      const refund = await onvo.createRefund({ paymentIntentId: reg.payment_intent_id, amountColones: amount });
      const { data: now } = await supabase.from('event_registrations').select('guest_refunds').eq('id', reg.id).maybeSingle();
      const list = ((now && now.guest_refunds) || claimed.guest_refunds || []).map(g => (g.index === index && g.refundId === 'requesting' ? { ...g, refundId: refund.id } : g));
      await supabase.from('event_registrations').update({ guest_refunds: list }).eq('id', reg.id);
      return { status: 200, amountColones: amount };
    } catch (e) {
      if (onvo.isNotRefundableByApi(e)) return byHand();
      console.error(`Guest refund for registration ${reg.id} failed:`, e.message);
      await undo();
      return { status: 502, error: 'We couldn’t start your refund — try again, or contact us' };
    }
  }

  // Signed webhook from ONVO. Registered before the JSON body parser, since
  // the signature is over the exact raw bytes.
  function registerWebhook(app) {
    app.post('/api/onvo/webhook', express.raw({ type: '*/*', limit: '1mb' }), deps.ah(async (req, res) => {
      if (!onvo.webhookSecretSet) return res.status(503).json({ error: 'ONVO webhooks are not configured' });
      if (!onvo.verifyWebhookSignature(req.body, req.get('X-Onvo-Signature'))) {
        console.warn('ONVO webhook with a bad or missing signature — ignored.');
        return res.status(400).json({ error: 'Bad signature' });
      }
      let event;
      try { event = JSON.parse(req.body.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'Bad JSON' }); }
      if (!event || !event.id || !event.type) return res.status(400).json({ error: 'Not an event' });

      // At-least-once delivery: record the event id first; a repeat is a no-op.
      const { error: dupError } = await supabase.from('onvo_webhook_events').insert({ id: event.id, type: event.type });
      if (dupError) {
        if (dupError.code === '23505') return res.json({ received: true, duplicate: true });
        throw dupError;
      }
      try {
        await handleEvent(event);
      } catch (e) {
        // Forget the event so ONVO's retry runs it again.
        await supabase.from('onvo_webhook_events').delete().eq('id', event.id);
        throw e;
      }
      res.json({ received: true });
    }));
  }

  // Releases holds that ran out and expires their Checkout pages.
  async function sweepExpiredHolds() {
    const { data: stale, error } = await supabase.from('event_registrations')
      .select('id, checkout_session_id').eq('status', 'held').lt('hold_expires_at', new Date().toISOString()).limit(50);
    if (error) { console.error('Hold sweep failed:', error.message); return; }
    for (const reg of stale || []) {
      if (reg.checkout_session_id) {
        try { await onvo.expireCheckoutSession(reg.checkout_session_id); }
        catch (e) { if (!(e.status >= 400 && e.status < 500)) console.warn(`Could not expire ONVO session ${reg.checkout_session_id}:`, e.message); }
      }
      await supabase.from('event_registrations')
        .update({ status: 'expired', updated_at: new Date().toISOString() })
        .eq('id', reg.id).eq('status', 'held');
    }
  }

  function registerRoutes(app) {
    const { ah, getUser, isBanned, BANNED_ERROR } = deps;

    // Join an event: hold a spot and get the ONVO Checkout page to pay on.
    // Signed-in accounts only (guests can't pay), so receipts and refunds
    // reach a real person.
    app.post('/api/events/:id/join', ah(async (req, res) => {
      if (!onvo.onvoConfigured) return res.status(503).json({ error: 'Payments aren’t available right now. Try again later.' });
      // 403, not 401: the app treats 401 as "your session expired".
      if (!req.authUser) return res.status(403).json({ error: 'Create an account or log in to join paid events', code: 'account_required' });
      const userId = req.authUser.id;
      if (await isBanned(userId)) return res.status(403).json(BANNED_ERROR);
      const appReturn = APP_RETURN_PATTERN.test(String(req.body.appReturnUrl || '')) ? req.body.appReturnUrl : 'foursomemobile://payment-return';
      const user = await getUser(userId);
      const userName = (user && user.name) || (req.authUser.email || '').split('@')[0] || 'Player';

      // Paying for a group (2–4 spots, guests' names) and discount codes
      // need supabase-event-extras.sql; one spot without a code works either way.
      const spots = Math.round(Number(req.body.spots) || 1);
      const guestNames = (Array.isArray(req.body.guestNames) ? req.body.guestNames : []).map(n => String(n || '').trim().slice(0, 60));
      const code = String(req.body.code || '').trim().slice(0, 30);
      if (spots < 1 || spots > 4) return res.status(400).json({ error: 'You can pay for 1 to 4 spots' });
      if (guestNames.length !== spots - 1 || guestNames.some(n => !n)) return res.status(400).json({ error: 'Add a name for each guest' });
      if (deps.moderateFields) {
        const modError = deps.moderateFields(guestNames);
        if (modError) return res.status(400).json(modError);
      }
      let { data: rows, error: rpcError } = await supabase.rpc('reserve_event_spots', {
        p_event_id: Number(req.params.id), p_user_id: userId, p_user_name: userName, p_hold_minutes: HOLD_MINUTES,
        p_spots: spots, p_guest_names: guestNames, p_code: code || null,
      });
      if (rpcError && /reserve_event_spots|function|schema cache/i.test(rpcError.message || '')) {
        if (spots > 1 || code) return res.status(503).json({ error: 'Group payments and codes aren’t set up yet' });
        ({ data: rows, error: rpcError } = await supabase.rpc('reserve_event_spot', {
          p_event_id: Number(req.params.id), p_user_id: userId, p_user_name: userName, p_hold_minutes: HOLD_MINUTES,
        }));
      }
      if (rpcError) {
        console.error('reserve_event_spot failed:', rpcError.message);
        return res.status(500).json({ error: 'Could not hold a spot — try again' });
      }
      const { registration_id: regId, result } = (rows && rows[0]) || {};
      if (result === 'not_found') return res.status(404).json({ error: 'Event not found' });
      if (result === 'closed') return res.status(409).json({ error: 'This event is no longer open' });
      if (result === 'full') return res.status(409).json({ error: 'Sorry — this event just filled up', code: 'full' });
      if (result === 'not_enough') return res.status(409).json({ error: 'There aren’t that many spots left', code: 'not_enough' });
      if (result === 'bad_code') return res.status(400).json({ error: 'That code isn’t valid', code: 'bad_code' });
      if (result === 'code_used_up') return res.status(400).json({ error: 'That code has been used up', code: 'bad_code' });
      if (result === 'confirmed') return res.json({ status: 'confirmed' });
      if (result === 'refund_pending') return res.json({ status: 'refund_pending' });

      const reg = await loadRegistration({ id: regId });
      if (reg.checkout_url && reg.checkout_session_id) {
        return res.json({ status: 'held', checkoutUrl: reg.checkout_url, holdExpiresAt: reg.hold_expires_at });
      }

      const { data: ev } = await supabase.from('events').select('*').eq('id', reg.event_id).single();
      const back = `${PUBLIC_BASE_URL}/pay/return?r=${reg.id}&app=${encodeURIComponent(appReturn)}`;
      let session;
      const spotsText = (reg.spots || 1) > 1 ? ` (${reg.spots} ${req.lang === 'en' ? 'spots' : 'espacios'})` : '';
      try {
        session = await onvo.createCheckoutSession({
          amountColones: reg.amount_colones,
          description: `${ev.title}${spotsText} — ${ev.course}, ${whenLabel(new Date(ev.starts_at), ev.time_zone, req.lang)}`.slice(0, 250),
          // Not Apple's hidden relay addresses: ONVO mails receipts from its own
          // domain, which Apple won't forward.
          customerEmail: isAppleRelay(req.authUser.email) ? undefined : req.authUser.email,
          customerName: userName,
          redirectUrl: back,
          cancelUrl: back + '&cancelled=1',
          metadata: { registrationId: String(reg.id), eventId: String(ev.id) },
        });
      } catch (e) {
        console.error('ONVO Checkout session failed:', e.message);
        await supabase.from('event_registrations').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', reg.id).eq('status', 'held');
        return res.status(502).json({ error: 'Couldn’t open the payment page. Your spot wasn’t held — try again.' });
      }
      await supabase.from('event_registrations').update({
        checkout_session_id: session.id, checkout_url: session.url,
        payment_intent_id: session.paymentIntentId || null, updated_at: new Date().toISOString(),
      }).eq('id', reg.id);
      res.json({ status: 'held', checkoutUrl: session.url, holdExpiresAt: reg.hold_expires_at });
    }));

    // Where ONVO sends the player after paying or cancelling. Just a page
    // with a way back into the app — it confirms nothing.
    app.get('/pay/return', (req, res) => {
      const cancelled = req.query.cancelled === '1';
      const es = req.lang !== 'en';
      const copy = es
        ? { title: cancelled ? 'Pago cancelado' : 'Pago enviado', body: cancelled ? 'No se hizo ningún cobro. Tu espacio sigue reservado unos minutos más si cambiás de idea.' : 'Tu espacio se confirma en cuanto ONVO confirme el pago, normalmente en segundos.', back: 'Volver a Foursome' }
        : { title: cancelled ? 'Payment cancelled' : 'Payment sent', body: cancelled ? 'No charge was made. Your spot is held for a few more minutes if you change your mind.' : 'Your spot is confirmed as soon as ONVO confirms the payment — usually within seconds.', back: 'Back to Foursome' };
      const app = APP_RETURN_PATTERN.test(String(req.query.app || '')) ? String(req.query.app) : 'foursomemobile://payment-return';
      const link = app + (app.includes('?') ? '&' : '?') + 'r=' + encodeURIComponent(String(req.query.r || '')) + (cancelled ? '&cancelled=1' : '');
      res.set('Cache-Control', 'no-store').send(`<!doctype html><html lang="${es ? 'es' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Foursome</title></head><body style="font-family:-apple-system,system-ui,sans-serif;background:#F6F3EC;color:#1C2A1F;text-align:center;padding:64px 24px;">
<h2 style="margin:0 0 10px;">${copy.title}</h2>
<p style="opacity:.75;max-width:360px;margin:0 auto 28px;line-height:1.45;">${copy.body}</p>
<a href="${escapeHtml(link)}" style="display:inline-block;background:#2E5E3A;color:#fff;text-decoration:none;padding:14px 26px;border-radius:12px;font-weight:600;">${copy.back}</a>
</body></html>`);
    });

    const requireAdmin = (req, res) => {
      if (deps.isEventAdmin(req)) return true;
      res.status(req.authUser ? 403 : 401).json({ error: 'Only the Foursome owner can do that' });
      return false;
    };

    // The owner cancels an event: everyone who paid is refunded in full.
    app.post('/api/admin/events/:id/cancel', ah(async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const { data: ev, error } = await supabase.from('events').select('*').eq('id', req.params.id).maybeSingle();
      if (error) return res.status(500).json({ error: 'Could not load event' });
      if (!ev) return res.status(404).json({ error: 'Event not found' });
      const result = await cancelEventWithRefunds(ev.id);
      res.json({ ok: true, ...result });
    }));

    // The owner retries a refund that failed.
    app.post('/api/admin/registrations/:id/refund', ah(async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const result = await refundRegistration(Number(req.params.id));
      if (result.error) return res.status(502).json({ error: `Refund failed: ${result.error}` });
      if (result.skipped) return res.status(409).json({ error: 'That payment already has a refund under way, or isn’t paid' });
      res.json({ ok: true });
    }));

    // A player cancels their own spot. Paid, before the cutoff: full refund.
    // Only held (not paid yet): the hold is released.
    app.post('/api/events/:id/cancel-my-spot', ah(async (req, res) => {
      if (!req.authUser) return res.status(403).json({ error: 'Log in to manage your spot', code: 'account_required' });
      const { data: ev } = await supabase.from('events').select('*').eq('id', req.params.id).maybeSingle();
      if (!ev) return res.status(404).json({ error: 'Event not found' });
      const { data: reg } = await supabase.from('event_registrations').select('*')
        .eq('event_id', ev.id).eq('user_id', req.authUser.id).in('status', ['held', 'confirmed'])
        .order('id', { ascending: false }).limit(1).maybeSingle();
      if (!reg) return res.status(404).json({ error: 'You don’t have a spot in this event' });
      if (reg.status === 'held') {
        await releaseHold(reg);
        return res.json({ ok: true, released: true });
      }
      if (!beforeCutoff(ev)) return res.status(409).json({ error: 'It’s past the cancellation cutoff for this event, so it can’t be refunded' });
      const phone = cleanPhone(req.body.sinpePhone);
      const result = await refundRegistration(reg.id, { phone });
      if (result.error) return res.status(502).json({ error: 'We couldn’t start your refund — try again, or contact us' });
      // SINPE Móvil: the organizer sends it by hand; the app asks for the
      // number if it wasn't given.
      if (result.manual) return res.json({ ok: true, manual: true, amountColones: result.amountColones, needsPhone: !phone });
      res.json({ ok: true, refunding: true });
    }));

    // The buyer refunds one guest (before the cutoff).
    app.post('/api/events/:id/cancel-guest', ah(async (req, res) => {
      if (!req.authUser) return res.status(403).json({ error: 'Log in to manage your spot', code: 'account_required' });
      const { data: ev } = await supabase.from('events').select('*').eq('id', req.params.id).maybeSingle();
      if (!ev) return res.status(404).json({ error: 'Event not found' });
      const { data: reg } = await supabase.from('event_registrations').select('*')
        .eq('event_id', ev.id).eq('user_id', req.authUser.id).eq('status', 'confirmed')
        .order('id', { ascending: false }).limit(1).maybeSingle();
      if (!reg) return res.status(404).json({ error: 'You don’t have a spot in this event' });
      if (!beforeCutoff(ev)) return res.status(409).json({ error: 'It’s past the cancellation cutoff for this event, so it can’t be refunded' });
      const phone = cleanPhone(req.body.sinpePhone);
      const out = await refundGuest(reg, Math.round(Number(req.body.index)), { phone });
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json({ ok: true, amountColones: out.amountColones, manual: !!out.manual, needsPhone: !!out.manual && !phone });
    }));

    // The player confirms (or changes) the SINPE Móvil number for their
    // refunds still to send for this event.
    app.post('/api/events/:id/refund-phone', ah(async (req, res) => {
      if (!req.authUser) return res.status(403).json({ error: 'Log in to manage your spot', code: 'account_required' });
      const phone = cleanPhone(req.body.phone);
      if (!phone) return res.status(400).json({ error: 'Enter an 8-digit SINPE Móvil number' });
      const { error } = await supabase.from('manual_refunds').update({ phone })
        .eq('event_id', Number(req.params.id)).eq('user_id', req.authUser.id).eq('status', 'to_send');
      if (error) return res.status(500).json({ error: 'Could not save the number' });
      res.json({ ok: true, phone });
    }));

    // --- Owner: refunds to send by hand (SINPE Móvil) -----------------------------
    app.get('/api/admin/manual-refunds', ah(async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const { data, error } = await supabase.from('manual_refunds').select('*').order('created_at', { ascending: true });
      if (error) return res.status(503).json({ error: 'Run supabase-sinpe-refunds.sql first' });
      const eventIds = [...new Set((data || []).map(r => r.event_id))];
      const { data: evs } = eventIds.length ? await supabase.from('events').select('id, title').in('id', eventIds) : { data: [] };
      const titles = new Map((evs || []).map(e => [e.id, e.title]));
      const shape = r => ({
        id: r.id, eventId: r.event_id, eventTitle: titles.get(r.event_id) || '', name: r.user_name, kind: r.kind,
        guestName: r.guest_name, amountColones: r.amount_colones, phone: r.phone, status: r.status, createdAt: r.created_at, sentAt: r.sent_at,
      });
      const toSend = (data || []).filter(r => r.status === 'to_send');
      res.json({
        toSend: toSend.map(shape),
        totalToSendColones: toSend.reduce((n, r) => n + r.amount_colones, 0),
        recentlySent: (data || []).filter(r => r.status === 'sent').sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at)).slice(0, 20).map(shape),
      });
    }));

    app.post('/api/admin/manual-refunds/:id/sent', ah(async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const out = await markManualRefundSent(Number(req.params.id));
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json({ ok: true });
    }));

    // The owner's list of paid attendees (and anyone mid-refund) for an event.
    app.get('/api/admin/events/:id/attendees', ah(async (req, res) => {
      if (!deps.isEventAdmin(req)) return res.status(req.authUser ? 403 : 401).json({ error: 'Only the Foursome owner can do that' });
      const { data, error } = await supabase.from('event_registrations')
        .select('*')
        .eq('event_id', req.params.id).in('status', ['confirmed', 'refund_pending', 'refund_manual', 'refunded'])
        .order('paid_at', { ascending: true });
      if (error) return res.status(500).json({ error: 'Could not load attendees' });
      res.json({
        attendees: (data || []).map(r => ({
          id: r.id, userId: r.user_id, name: r.user_name, status: r.status, amountColones: r.amount_colones,
          paidAt: r.paid_at, refundError: r.refund_error, refundedAt: r.refunded_at,
          spots: r.spots || 1, guestNames: r.guest_names || [], discountColones: r.discount_colones || 0,
          guestRefunds: (r.guest_refunds || []).map(g => ({ name: g.name, amountColones: g.amountColones, status: g.status })),
          paymentMethod: r.payment_method || null,
        })),
      });
    }));
  }

  // Lets go of a hold (not paid): expires the ONVO page so it can't be paid.
  async function releaseHold(reg) {
    if (reg.checkout_session_id) {
      try { await onvo.expireCheckoutSession(reg.checkout_session_id); }
      catch (e) { if (!(e.status >= 400 && e.status < 500)) console.warn(`Could not expire ONVO session ${reg.checkout_session_id}:`, e.message); }
    }
    await supabase.from('event_registrations')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', reg.id).eq('status', 'held');
  }

  // Part E: the owner cancels an event. Everyone who paid gets a full
  // refund; open holds are released. Safe to call again — paid spots that
  // already have a refund under way are skipped.
  async function cancelEventWithRefunds(eventId) {
    const { error } = await supabase.from('events')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', eventId);
    if (error) throw error;
    const { data: regs, error: regError } = await supabase.from('event_registrations')
      .select('*').eq('event_id', eventId).in('status', ['held', 'confirmed', 'refund_pending']);
    if (regError) throw regError;
    let refunding = 0; let failed = 0; let manualCount = 0; let manualTotalColones = 0;
    for (const reg of regs || []) {
      if (reg.status === 'held') { await releaseHold(reg); continue; }
      const result = await refundRegistration(reg.id);
      if (result.error) failed++;
      else if (result.manual) { manualCount++; manualTotalColones += result.amountColones; }
      else if (!result.skipped) refunding++;
      if (deps.notifyUser) {
        deps.notifyUser(reg.user_id, result.manual
          ? (lang => lang === 'en'
            ? ['Event cancelled', 'An event you paid for was cancelled. The organizer will send your full refund by SINPE Móvil within 3 business days. Open the event to confirm your number.']
            : ['Evento cancelado', 'Se canceló un evento que pagaste. El organizador te enviará el reembolso completo por SINPE Móvil en un plazo de 3 días hábiles. Abrí el evento para confirmar tu número.'])
          : (lang => push(lang, 'eventCancelled')),
        null, { data: { url: `${PUBLIC_BASE_URL}/e/${eventId}` } }).catch(() => {});
      }
    }
    // Everything owed by SINPE Móvil for this event, including guest refunds
    // from before the cancellation.
    const { data: owed } = await supabase.from('manual_refunds').select('amount_colones, user_id').eq('event_id', eventId).eq('status', 'to_send');
    const owedTotal = (owed || []).reduce((n, r) => n + r.amount_colones, 0);
    return { refunding, failed, manualCount: new Set((owed || []).map(r => r.user_id)).size || manualCount, manualTotalColones: Math.max(owedTotal, manualTotalColones) };
  }

  // The owner sent a SINPE Móvil refund: done, and the player is told.
  async function markManualRefundSent(id) {
    const { data: row, error } = await supabase.from('manual_refunds').update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'to_send').select('*').maybeSingle();
    if (error) return { status: 503, error: 'Run supabase-sinpe-refunds.sql first' };
    if (!row) return { status: 409, error: 'That refund was already marked as sent' };
    const reg = await loadRegistration({ id: row.registration_id });
    if (reg && row.kind === 'payment') {
      await supabase.from('event_registrations').update({ status: 'refunded', refunded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', reg.id).eq('status', 'refund_manual');
    } else if (reg && row.kind === 'guest') {
      const list = (reg.guest_refunds || []).map(g => (g.index === row.guest_index && g.status === 'manual' ? { ...g, status: 'refunded' } : g));
      await supabase.from('event_registrations').update({ guest_refunds: list, updated_at: new Date().toISOString() }).eq('id', reg.id);
    }
    const amount = '₡' + String(row.amount_colones).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (deps.notifyUser) {
      deps.notifyUser(row.user_id, lang => lang === 'en'
        ? ['Refund sent', `${amount} was sent to you by SINPE Móvil${row.phone ? ` (${row.phone})` : ''}.`]
        : ['Reembolso enviado', `Te enviamos ${amount} por SINPE Móvil${row.phone ? ` (${row.phone})` : ''}.`],
      null, { data: { url: `${PUBLIC_BASE_URL}/e/${row.event_id}` } }).catch(() => {});
    }
    return { ok: true };
  }

  // Can this player still cancel their own paid spot for a refund?
  function beforeCutoff(ev) {
    const cutoff = new Date(ev.starts_at).getTime() - ev.cancel_cutoff_hours * 60 * 60 * 1000;
    return Date.now() < cutoff;
  }

  // Account deletion: refund paid spots in upcoming events, release holds,
  // and replace the name on every remaining payment record. The records
  // themselves stay, for bookkeeping.
  async function handleAccountDeletion(userId) {
    const { data: regs, error } = await supabase.from('event_registrations')
      .select('*, events!inner(starts_at, status)').eq('user_id', userId).in('status', ['held', 'confirmed']);
    if (error) throw error;
    for (const reg of regs || []) {
      if (reg.status === 'held') await releaseHold(reg);
      else if (new Date(reg.events.starts_at) > new Date() && reg.events.status === 'open') await refundRegistration(reg.id);
    }
    await supabase.from('event_registrations').update({ user_name: 'Deleted user' }).eq('user_id', userId);
    // SINPE Móvil refunds still to send keep the number, so the money still reaches them.
    await supabase.from('manual_refunds').update({ user_name: 'Deleted user' }).eq('user_id', userId).then(() => {}, () => {});
    await supabase.from('event_requests').delete().eq('user_id', userId);
  }

  return { registerWebhook, registerRoutes, sweepExpiredHolds, refundRegistration, refundGuest, cancelEventWithRefunds, handleAccountDeletion, markManualRefundSent, HOLD_MINUTES, _handleEvent: handleEvent };
}

module.exports = { makePayments, HOLD_MINUTES, remainingColones, guestShareColones, cleanPhone, isAppleRelay };
