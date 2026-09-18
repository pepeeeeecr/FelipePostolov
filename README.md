# Foursome backend

This is a small real server whose only job is to verify Stripe payments
honestly. Before this, the app just trusted a button click. Now, only
Stripe's own signed webhook can mark someone Pro.

## Deploy it (Render, free tier)

1. Push this folder to a GitHub repo (can be private).
2. Go to render.com, sign up, click **New > Web Service**, connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Under **Environment**, add these variables (leave STRIPE_WEBHOOK_SECRET
   and STRIPE_PRICE_ID blank for now — you'll fill them in after steps 5 and 6):
   - `STRIPE_SECRET_KEY` — from Stripe Dashboard > Developers > API keys
5. Deploy. Render gives you a URL like `https://foursome-backend.onrender.com`.
6. In Stripe Dashboard > Product catalog, create your "Foursome Pro"
   product with a recurring $10/month price if you haven't already. Copy
   its Price ID (starts with `price_`) into the `STRIPE_PRICE_ID` env var
   on Render.
7. In Stripe Dashboard > Developers > Webhooks, click **Add endpoint**.
   Endpoint URL: `https://your-render-url.onrender.com/api/stripe/webhook`.
   Select events: `checkout.session.completed` and
   `customer.subscription.deleted`. After creating it, Stripe shows a
   **Signing secret** (starts with `whsec_`) — copy that into the
   `STRIPE_WEBHOOK_SECRET` env var on Render.
8. Redeploy (Render auto-restarts when you change env vars, but trigger a
   manual redeploy if it doesn't).
9. Send me your Render URL. I'll wire the app's Upgrade button to actually
   call this server instead of just flipping a local flag.

## Testing before real money

Stripe gives you test-mode API keys and test card numbers
(4242 4242 4242 4242, any future date, any CVC) so you can run the whole
flow without charging anyone real money. Use test keys everywhere until
you've confirmed the webhook actually flips `is_pro` in the database, then
switch to live keys.

## Known limitations, on purpose

- SQLite file storage. Fine for testing; resets on redeploy on most free
  hosts unless you attach a persistent volume. Swap for a hosted
  Postgres (Render/Railway both offer a free one) before a real launch.
- No login system yet. `userId` here is still the browser-generated ID
  from the app, not a real account. This backend solves payment
  verification specifically — real accounts are a separate, bigger step.
- CORS is wide open (`cors()`) for ease of testing. Lock it to your
  actual frontend's domain before this is public.
