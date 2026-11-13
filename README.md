# Foursome backend

This is the real server and database behind Foursome. It serves the app
itself as a website (`/public/index.html`), stores everything in Supabase
(Postgres + Auth), looks up golf courses via OpenStreetMap, and sends
push notifications (web and Expo/mobile). Stripe is set up for paid
events, which aren't built yet.

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
- **Payments**: not in use yet. The Stripe client and a signed webhook
  route (`/api/stripe/webhook`) are in place for paid events; the webhook
  verifies the signature and logs the event, but doesn't act on anything
  yet.
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
   notifications. The Stripe variables are only needed for paid events.
5. Deploy. Render gives you a URL like `https://foursome-backend.onrender.com`.
6. (Optional, Stripe) In Stripe Dashboard > Developers > Webhooks, click
   **Add endpoint**. Endpoint URL:
   `https://your-render-url.onrender.com/api/stripe/webhook`. Pick the
   payment events paid events will need once they're built. Copy the
   **Signing secret** (starts with `whsec_`) into the
   `STRIPE_WEBHOOK_SECRET` env var on Render.
7. Redeploy (Render auto-restarts when you change env vars, but trigger a
   manual redeploy if it doesn't).

## Testing before real money

Stripe gives you test-mode API keys and test card numbers
(4242 4242 4242 4242, any future date, any CVC) so you can run the whole
flow without charging anyone real money. Use test keys everywhere until
you've confirmed payments and the webhook work end to end, then switch to
live keys.

## Known limitations, on purpose

- CORS is wide open (`cors()`) for ease of testing. Lock it to your
  actual frontend's domain before this is public.
- No analytics or tracking of any kind is wired in — see the Privacy
  Policy in the app for exactly what is and isn't collected.
