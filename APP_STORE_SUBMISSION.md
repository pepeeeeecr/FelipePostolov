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
Post your tee time and find golfers to join, or browse open rounds near you. Chat with your group and find golf courses nearby.
```

**Description**
```
Foursome helps golfers find people to play with.

Already have a tee time booked but need a few more in your group? Post
it — course, date, time, number of open spots, handicap range, and pace
— and other golfers nearby can request to join. You decide who plays.

Looking for a round to join? Browse open tee times posted by other
golfers, filter by distance, and request a spot.

STAY IN TOUCH WITH YOUR GROUP
Once you're confirmed for a round, chat with your host and the other
approved players right in the app.

SAFETY FIRST
Block or report anyone, or report a single chat message, any time. Foursome doesn't run background
checks on users — like any app that connects you with people you
haven't met, use the same judgment you would anywhere else: consider
meeting for the first time at the course, and tell someone your plans.

FOURSOME EVENTS
Join organized golf events near you from the Events tab. Pay securely by
card or SINPE Móvil, see who's going, and cancel for a full refund up to
the cutoff. Want one somewhere else? Request an event.

WHAT FOURSOME ISN'T
Foursome is not a tee time booking service and isn't affiliated with any
golf course or booking platform. Posting or joining a round doesn't
reserve anything with the course — you're responsible for actually
having a tee time to share. The "Courses" tab lets you search for golf
courses or see what's nearby; it doesn't book anything.

Sign in with Apple, Google or email, or jump in as a guest with no account at all.
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
| **Contact Info — Email Address** | Yes (only for full accounts — email, Apple or Google sign-in; with Apple's Hide My Email it's a private relay address; guest mode needs no email) | App Functionality | Yes | No |
| **Contact Info — Phone Number** | Yes, only if a player paid by SINPE Móvil and cancels: the number the organizer sends the refund to | App Functionality | Yes | No |
| **Location — Precise Location** | Yes, once the user grants permission (checked when the app is opened or brought to the foreground, only while in use) | App Functionality | No — sent with nearby-course searches, never stored | No |
| **User Content — Other User Content** (bio, round details/notes, round and group chat messages, groups, friends, guests' names on group payments, ratings & comments, reports you file) | Yes | App Functionality | Yes | No |
| **User Content — Photos or Videos** (optional profile photo; event photos the organizer posts) | Yes | App Functionality | Yes | No |
| **Identifiers — User ID** | Yes | App Functionality | Yes | No |
| **Purchases — Purchase History** (paid event spots: amount, date, refund status) | Yes, only if the user pays for an event | App Functionality | Yes | No |
| **Identifiers — Device ID** (push notification token, only if notifications are enabled) | Yes, opt-in only | App Functionality | Yes | No |
| Health & Fitness | No | — | — | — |
| Financial Info | No | — | — | — |
| Contacts | No | — | — | — |
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
- "Foursome Demo Host" — a second account that has posted two open
  rounds and already approved "Foursome Demo" to join one of them, so you
  can see a confirmed round and existing chat history immediately without
  needing the second account's credentials.

HOW TO TEST

1. Launch the app and sign in as "Foursome Demo" (use the credentials in
   the Sign-In Required fields above — tap "Log in" on the welcome
   screen, not "Sign up" or "Continue as guest").
2. You'll land on the Discover tab. Two upcoming rounds hosted by
   "Foursome Demo Host" are visible — "Bethpage Black Golf Course" and
   "Marine Park Golf Course" — this demonstrates browsing open rounds.
   (Both dates are always about a week out, so neither will have
   expired by the time you review.)
3. Go to the "My Rounds" tab. Under rounds you've joined, you'll see
   the Bethpage Black round with status "Approved" — this demonstrates the join
   request/approval flow already completed by the two seeded accounts.
4. Tap into that round's chat. You'll see two existing messages between
   the host and this account — send a new message to confirm chat works
   in both directions. To report a message, tap "Report" next to the
   sender's name (or long-press the message) and pick a reason.
5. To see the "Request to join" button itself (separate from the
   already-approved outcome in steps 2-4): back on Discover, tap
   "Request to join" on the "Marine Park Golf Course" round. It then
   appears under "Requested to join" on My Rounds with status
   "Pending", and you can tap "Withdraw request" to undo it. The demo
   accounts only see each other's rounds, so this never sends a request
   to a real user.
6. Other reviewable features from this same account: Profile tab (edit
   profile, see past rounds), Settings (Privacy Policy, Terms of Service,
   Help — a short FAQ with a Contact us button —, Blocked users, Delete
   Account — all reachable without needing to actually delete the test
   account).
7. Sign-in options: Sign in with Apple, Sign in with Google, email and
   password, or guest mode (no account). Sign in with Apple is offered
   alongside Google, as Guideline 4.8 requires, and is shown first. You
   can use the demo account above (email and password) or your own Apple
   ID or Google account; a new account goes through a short setup (name,
   home course and handicap, then notifications). A new email account
   is confirmed with a 6-digit code sent by email, and "Forgot
   password?" on the login screen resets a password the same way.
   Deleting an account that signed in with Apple asks Apple to confirm
   once more and revokes the app's Sign in with Apple access.
8. Location permission: tapping "Use my location" on the Discover or
   Courses tabs triggers the standard iOS "While Using the App"
   prompt. Once allowed, the app checks location each time it's opened
   or brought back to the foreground — never in the background — to
   sort rounds by distance and find nearby courses. Coordinates are
   not stored.
9. Paid events (Events tab): these are in-person golf events at a real
   course. Payment is for attending the event in person, so per App
   Store Review Guideline 3.1.3(e) it uses an outside payment provider
   (ONVO Pay, Costa Rica, cards and SINPE Móvil) on ONVO's hosted page,
   not In-App Purchase. No digital content or app features are sold.
   Refunds: full refund if the player cancels before the event's
   cutoff, or if we cancel the event. Card payments are refunded
   automatically through ONVO; SINPE Móvil payments can't be refunded
   through ONVO, so the organizer sends them by hand to the number the
   player confirms in the app, within 3 business days.

Foursome is an app only; https://foursomecr.com is its landing page
and the server the app talks to for everything above. Privacy Policy,
Terms of Service, Refund Policy, Support (contact:
foursomeapp.golf@gmail.com) and how to delete an account are at
https://foursomecr.com/privacy, https://foursomecr.com/terms,
https://foursomecr.com/refund, https://foursomecr.com/support and
https://foursomecr.com/delete-account.
```
