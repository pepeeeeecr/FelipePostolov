# Foursome — App Store Submission Materials

Generated for the App Store Connect submission of the Foursome iOS app.
Everything below describes only features that actually exist in the app
today, verified against the real backend and app code — nothing here is
aspirational or unsupported. No demo account credentials are stored in
this file (see the submission checklist you were given separately).

## 1. Listing text

**App name** (24 / 30 characters)
```
Foursome: Golf Tee Times
```

**Subtitle** (29 / 30 characters)
```
Find Golfers & Open Tee Times
```

**Promotional text** (161 / 170 characters)
```
Post your tee time and find golfers to join, or browse open rounds near you. Chat with your group, rate your round, and set your availability for others to find.
```

**Description**
```
Foursome helps golfers find people to play with.

Already have a tee time booked but need a few more in your group? Post
it — course, date, time, number of open spots, handicap range, and pace
— and other golfers nearby can request to join. You decide who plays.

Looking for a round to join? Browse open tee times posted by other
golfers, filter by distance, pace, or skill level, and request a spot.

FIND PLAYERS ON YOUR SCHEDULE
Set your standing availability (weekday or weekend, morning, afternoon,
or evening) so other golfers can find you even when you haven't posted a
specific round.

STAY IN TOUCH WITH YOUR GROUP
Once you're confirmed for a round, chat with your host and the other
approved players right in the app.

RATE YOUR ROUNDS
After playing, rate the people you played with and the course itself —
ratings build up on profiles over time so you know who you're playing
with.

SAFETY FIRST
Block or report anyone, any time. Foursome doesn't run background
checks on users — like any app that connects you with people you
haven't met, use the same judgment you would anywhere else: consider
meeting for the first time at the course, and tell someone your plans.

WHAT FOURSOME ISN'T
Foursome is not a tee time booking service and isn't affiliated with any
golf course or booking platform. Posting or joining a round doesn't
reserve anything with the course — you're responsible for actually
having a tee time to share. The "Book a Tee Time" feature is a waitlist
that tells us which courses golfers want supported; it doesn't book
anything.

Sign up with email, or jump in as a guest with no account at all.
```

**Keywords** (97 / 100 characters)
```
golf,golfer,tee time,golf buddy,foursome,playing partner,handicap,golf course,pace of play,rating
```

**Suggested category**
- Primary: **Sports**
- Secondary (optional): **Social Networking**

---

## 2. App Privacy questionnaire (App Store Connect → App Privacy)

Based on a direct read of `server.js`, the Supabase schema, and both
client apps — not a guess. Overall answer to *"Does this app use data to
track you?"*: **No** — nothing here is shared with data brokers or used
to track users across other companies' apps or websites for advertising.
There are no analytics, ad, or tracking SDKs anywhere in the codebase.

| Data type | Collected? | Used for | Linked to identity? | Used for tracking? |
|---|---|---|---|---|
| **Contact Info — Name** | Yes | App Functionality | Yes | No |
| **Contact Info — Email Address** | Yes (only for full accounts; guest mode needs no email) | App Functionality | Yes | No |
| **Location — Precise Location** | Yes (only when the user taps "Use my location") | App Functionality | No — sent for one on-demand nearby-course search, not stored tied to the account | No |
| **User Content — Other User Content** (bio, round details/notes, chat messages, ratings & comments, reports you file) | Yes | App Functionality | Yes | No |
| **Identifiers — User ID** | Yes | App Functionality | Yes | No |
| **Identifiers — Device ID** (push notification token, only if notifications are enabled) | Yes, opt-in only | App Functionality | Yes | No |
| Health & Fitness | No | — | — | — |
| Financial Info | No | — | — | — |
| Contacts | No | — | — | — |
| Photos or Videos | No | — | — | — |
| Audio Data | No | — | — | — |
| Browsing/Search History | No | — | — | — |
| Usage Data (analytics) | No | — | — | — |
| Diagnostics | No | — | — | — |

**One honest caveat, not verifiable from this app's own code:** Expo/EAS
and Supabase are third-party SDKs/infrastructure this app depends on.
I've checked that this codebase adds no analytics or tracking of its
own, but I can't fully audit what baseline operational telemetry Expo's
own SDKs (e.g. expo-updates checking in) or Supabase's infrastructure
collect on their own — that's governed by their own privacy
documentation, not this app's code. Worth a quick look at Expo's and
Supabase's own privacy disclosures before finalizing the questionnaire.

---

## 4. App Review notes

Paste this into App Store Connect's **App Review Information → Notes**
field. Enter the demo account's email and password into the dedicated
**Sign-In Required → Username / Password** fields on that same page —
those credentials were provided separately and are not written here.

```
Foursome lets golfers post open tee times and find others to join. Two
test accounts are provided so you can exercise both sides of the core
flow (hosting and joining a round, including chat):

- "Foursome Demo" — the account whose login is in the Sign-In Required
  fields above. Use this to sign in and review the app as a normal user.
- "Foursome Demo Host" — a second account that has already posted an
  open round and already approved "Foursome Demo" to join it, so you can
  see a confirmed round and existing chat history immediately without
  needing the second account's credentials.

HOW TO TEST

1. Launch the app and sign in as "Foursome Demo" (use the credentials in
   the Sign-In Required fields above — tap "Log in" on the welcome
   screen, not "Sign up" or "Continue as guest").
2. You'll land on the Discover tab. A round at "Bethpage Black Golf
   Course" on 2026-10-27, hosted by "Foursome Demo Host," is already
   visible — this demonstrates browsing open rounds.
3. Go to the "My Rounds" tab. Under rounds you've joined, you'll see
   that round with status "Approved" — this demonstrates the join
   request/approval flow already completed by the two seeded accounts.
4. Tap into that round's chat. You'll see two existing messages between
   the host and this account — send a new message to confirm chat works
   in both directions.
5. To see the raw "Request to join" button itself (separate from the
   already-approved outcome in steps 2-4): back on Discover, tap
   "Request to join" on any other open round — this sends a pending
   request from "Foursome Demo" without needing the host's own
   credentials to demonstrate.
6. Other reviewable features from this same account: Profile tab (edit
   profile, set standing availability, see past rounds), Settings
   (Privacy Policy, Terms of Service, Cookie Policy, Refund Policy, Help
   & FAQ, Contact Us, Delete Account — all reachable without needing to
   actually delete the test account).
7. Google/Apple social sign-in buttons are intentionally hidden in this
   build — email/password and guest mode are the supported sign-in
   paths for this review.
8. Location permission: tapping "Use my location" on the Discover or
   Book tabs triggers the standard iOS location prompt, used only to
   sort rounds by distance and search nearby courses — no location is
   stored tied to the account.

The backend is a public web app in its own right at
https://felipepostolov.onrender.com, which the app talks to for
everything above. Privacy Policy, Terms of Service, and Support
(contact: foursomeapp.golf@gmail.com) are also reachable directly at
https://felipepostolov.onrender.com/privacy,
https://felipepostolov.onrender.com/terms, and
https://felipepostolov.onrender.com/support.
```
