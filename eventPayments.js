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

const HOLD_MINUTES = 20; // enough for card + 3DS, or a SINPE Móvil transfer
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://felipepostolov.onrender.com').replace(/\/$/, '');
// Where the "Back to Foursome" button on the return page may point: the
// app's own scheme, or Expo Go while developing.
const APP_RETURN_PATTERN = /^(foursomemobile|exp|exps):\/\/[^\s"'<>]*$/;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function makePayments(deps) {
  const { supabase } = deps;

  async function loadRegistration(match) {
    const [col, val] = Object.entries(match)[0];
    const { data, error } = await supabase.from('event_registrations').select('*').eq(col, val).maybeSingle();
    if (error) throw error;
    return data;
  }

  // Full refund of one paid registration. Claims the row first so two
  // callers (say a webhook retry and the owner cancelling) can't both
  // refund it. The final result arrives by refund.* webhook.
  async function refundRegistration(regId) {
    const { data: claimed, error: claimError } = await supabase.from('event_registrations')
      .update({ refund_id: 'requesting', refund_error: null, status: 'refund_pending', updated_at: new Date().toISOString() })
      .eq('id', regId).is('refund_id', null).in('status', ['confirmed', 'refund_pending'])
      .select('*').maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) return { skipped: true };
    if (!claimed.payment_intent_id) {
      await supabase.from('event_registrations').update({ refund_id: null, refund_error: 'No ONVO payment to refund' }).eq('id', regId);
      return { error: 'No ONVO payment to refund' };
    }
    try {
      const refund = await onvo.createRefund({ paymentIntentId: claimed.payment_intent_id, amountColones: claimed.amount_colones });
      await supabase.from('event_registrations').update({ refund_id: refund.id, updated_at: new Date().toISOString() }).eq('id', regId);
      return { refundId: refund.id };
    } catch (e) {
      console.error(`Refund for registration ${regId} failed:`, e.message);
      await supabase.from('event_registrations').update({ refund_id: null, refund_error: e.message.slice(0, 300), updated_at: new Date().toISOString() }).eq('id', regId);
      return { error: e.message };
    }
  }

  // ONVO says this registration's payment succeeded.
  async function markPaid(reg, paymentIntentId) {
    const { data: outcome, error } = await supabase.rpc('confirm_event_payment', {
      p_registration_id: reg.id, p_payment_intent_id: paymentIntentId || null,
    });
    if (error) throw error;
    if (outcome === 'needs_refund') {
      console.warn(`Registration ${reg.id} was paid but the event is full or cancelled — refunding.`);
      await refundRegistration(reg.id);
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

      const { data: rows, error: rpcError } = await supabase.rpc('reserve_event_spot', {
        p_event_id: Number(req.params.id), p_user_id: userId, p_user_name: userName, p_hold_minutes: HOLD_MINUTES,
      });
      if (rpcError) {
        console.error('reserve_event_spot failed:', rpcError.message);
        return res.status(500).json({ error: 'Could not hold a spot — try again' });
      }
      const { registration_id: regId, result } = (rows && rows[0]) || {};
      if (result === 'not_found') return res.status(404).json({ error: 'Event not found' });
      if (result === 'closed') return res.status(409).json({ error: 'This event is no longer open' });
      if (result === 'full') return res.status(409).json({ error: 'Sorry — this event just filled up', code: 'full' });
      if (result === 'confirmed') return res.json({ status: 'confirmed' });
      if (result === 'refund_pending') return res.json({ status: 'refund_pending' });

      const reg = await loadRegistration({ id: regId });
      if (reg.checkout_url && reg.checkout_session_id) {
        return res.json({ status: 'held', checkoutUrl: reg.checkout_url, holdExpiresAt: reg.hold_expires_at });
      }

      const { data: ev } = await supabase.from('events').select('*').eq('id', reg.event_id).single();
      const back = `${PUBLIC_BASE_URL}/pay/return?r=${reg.id}&app=${encodeURIComponent(appReturn)}`;
      let session;
      try {
        session = await onvo.createCheckoutSession({
          amountColones: reg.amount_colones,
          description: `${ev.title} — ${ev.course}, ${whenLabel(new Date(ev.starts_at), ev.time_zone)}`.slice(0, 250),
          customerEmail: req.authUser.email,
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
      const app = APP_RETURN_PATTERN.test(String(req.query.app || '')) ? String(req.query.app) : 'foursomemobile://payment-return';
      const link = app + (app.includes('?') ? '&' : '?') + 'r=' + encodeURIComponent(String(req.query.r || '')) + (cancelled ? '&cancelled=1' : '');
      res.set('Cache-Control', 'no-store').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Foursome</title></head><body style="font-family:-apple-system,system-ui,sans-serif;background:#F6F3EC;color:#1C2A1F;text-align:center;padding:64px 24px;">
<h2 style="margin:0 0 10px;">${cancelled ? 'Payment cancelled' : 'Payment sent'}</h2>
<p style="opacity:.75;max-width:360px;margin:0 auto 28px;line-height:1.45;">${cancelled ? 'No charge was made. Your spot is held for a few more minutes if you change your mind.' : 'Your spot is confirmed as soon as ONVO confirms the payment — usually within seconds.'}</p>
<a href="${escapeHtml(link)}" style="display:inline-block;background:#2E5E3A;color:#fff;text-decoration:none;padding:14px 26px;border-radius:12px;font-weight:600;">Back to Foursome</a>
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
      const result = await refundRegistration(reg.id);
      if (result.error) return res.status(502).json({ error: 'We couldn’t start your refund — try again, or contact us' });
      res.json({ ok: true, refunding: true });
    }));

    // The owner's list of paid attendees (and anyone mid-refund) for an event.
    app.get('/api/admin/events/:id/attendees', ah(async (req, res) => {
      if (!deps.isEventAdmin(req)) return res.status(req.authUser ? 403 : 401).json({ error: 'Only the Foursome owner can do that' });
      const { data, error } = await supabase.from('event_registrations')
        .select('id, user_id, user_name, status, amount_colones, paid_at, refund_error, refunded_at, created_at')
        .eq('event_id', req.params.id).in('status', ['confirmed', 'refund_pending', 'refunded'])
        .order('paid_at', { ascending: true });
      if (error) return res.status(500).json({ error: 'Could not load attendees' });
      res.json({
        attendees: (data || []).map(r => ({
          id: r.id, userId: r.user_id, name: r.user_name, status: r.status, amountColones: r.amount_colones,
          paidAt: r.paid_at, refundError: r.refund_error, refundedAt: r.refunded_at,
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
    let refunding = 0; let failed = 0;
    for (const reg of regs || []) {
      if (reg.status === 'held') { await releaseHold(reg); continue; }
      const result = await refundRegistration(reg.id);
      if (result.error) failed++; else if (!result.skipped) refunding++;
      if (deps.notifyUser) {
        deps.notifyUser(reg.user_id, 'Event cancelled', 'An event you paid for was cancelled. Your payment is being refunded in full.').catch(() => {});
      }
    }
    return { refunding, failed };
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
    await supabase.from('event_requests').delete().eq('user_id', userId);
  }

  return { registerWebhook, registerRoutes, sweepExpiredHolds, refundRegistration, cancelEventWithRefunds, handleAccountDeletion, HOLD_MINUTES };
}

module.exports = { makePayments, HOLD_MINUTES };
