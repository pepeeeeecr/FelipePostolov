# Foursome backend

This is the real server and database behind Foursome. It serves the app
itself as a website (`/public/index.html`), stores everything in Supabase
(Postgres + Auth), verifies real Stripe payments via signed webhook (Pro
gating is currently disabled app-wide, so this path is dormant), looks up
golf courses via OpenStreetMap, and sends push notifications (web and
Expo/mobile).

## What's actually in here

- **Accounts**: Supabase Auth (email/password, plus Google/Apple
  sign-in). A visitor can also use the app as a guest — a locally
  generated id with no email or password — and upgrade to a real account
  later, which migrates their guest data over.
- **Database**: Supabase/Postgres. Schema lives in the `supabase-*.sql`
  files at the repo root — run them in the Supabase SQL Editor, in the
  order they were added (`supabase-migration.sql` first, the rest are
  additive). Row Level Security is enabled on every table
  (`supabase-enable-rls.sql`); the server only ever talks to Supabase with
  the `service_role` key, which bypasses RLS, so RLS exists to protect the
  tables if the anon key were ever used directly.
- **Payments**: Stripe, verified only through its signed webhook — a
  client-side button click alone can never mark someone Pro. The Pro
  plan UI is currently hidden/disabled in the app, so this code path
  isn't reachable from the live app right now.
- **Course lookup**: OpenStreetMap (Nominatim/Overpass), queried by name
  or coordinates — no user identity is sent with these requests.
- **Push notifications**: Web Push (VAPID) for the website, Expo push
  tokens for the mobile app, both through the same `push_subscriptions`
  table.

## Deploy it (Render, free tier)

1. Push this folder to a GitHub repo (can be private).
2. Go to render.com, sign up, click **New > Web Service**, connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Under **Environment**, add the variables listed in `.env.example`:
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (required), and
   `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` if you want push
   notifications. Leave the Stripe variables blank unless you're actually
   enabling the Pro plan.
5. Deploy. Render gives you a URL like `https://foursome-backend.onrender.com`.
6. (Optional, Stripe) In Stripe Dashboard > Product catalog, create your
   "Foursome Pro" product with a recurring price. Copy its Price ID
   (starts with `price_`) into the `STRIPE_PRICE_ID` env var on Render.
7. (Optional, Stripe) In Stripe Dashboard > Developers > Webhooks, click
   **Add endpoint**. Endpoint URL:
   `https://your-render-url.onrender.com/api/stripe/webhook`. Select
   events: `checkout.session.completed` and `customer.subscription.deleted`.
   Copy the **Signing secret** (starts with `whsec_`) into the
   `STRIPE_WEBHOOK_SECRET` env var on Render.
8. Redeploy (Render auto-restarts when you change env vars, but trigger a
   manual redeploy if it doesn't).

## Testing before real money

Stripe gives you test-mode API keys and test card numbers
(4242 4242 4242 4242, any future date, any CVC) so you can run the whole
flow without charging anyone real money. Use test keys everywhere until
you've confirmed the webhook actually flips `is_pro` in the database, then
switch to live keys.

## Known limitations, on purpose

- CORS is wide open (`cors()`) for ease of testing. Lock it to your
  actual frontend's domain before this is public.
- No analytics or tracking of any kind is wired in — see the Privacy
  Policy in the app for exactly what is and isn't collected.
