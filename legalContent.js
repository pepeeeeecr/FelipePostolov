// Real Terms of Service / Privacy Policy / Cookie Policy / Refund Policy
// content for server-rendered /terms, /privacy pages — kept in sync
// wording-for-wording with public/index.html's inline copy and
// foursome-mobile/src/legalContent.js (same convention already used
// between those two: each platform/surface keeps its own copy with a
// comment pointing at the others, rather than a shared import across
// runtimes that don't share a module system).
//
// Each section is { h: heading, p: [paragraphs], list: [bullet items] }.
// `list` and multiple `p` entries are both optional.

const LEGAL_EFFECTIVE_DATE = 'October 12, 2026';
const ADMIN_EMAIL = 'foursomeapp.golf@gmail.com';

const TERMS_SECTIONS = [
  { h: 'The short version', p: ["Foursome helps golfers post open tee times and find groups to play with. Be honest in your profile, be respectful to other golfers, and use good judgment when meeting people in person — just like you would with any app that connects you with strangers. The rest of this page spells out the details."] },
  { h: 'Who can use Foursome', p: ["You must be at least 18 years old to create a Foursome account or use the app. By using Foursome, you're confirming that you meet this requirement and that the information in your profile is accurate."] },
  { h: 'Your account', p: ["You can use Foursome as a guest (a local profile stored only on your device, with no email or password) or with a full account (email and password, managed by our authentication provider, Supabase). Either way, you're responsible for the activity on your account and for keeping your login credentials private. If you're signed in on a device you share with others, remember to sign out when you're done."] },
  { h: "What Foursome is — and isn't", p: ['Foursome is a place for golfers to post rounds they\'ve already booked and invite others to join, or to browse rounds other golfers have posted. We are not a booking service, and posting or joining a round through Foursome does not reserve a tee time at any course. The "Book a Tee Time" feature is a waitlist: it tells us which courses golfers want to see supported, and lets us notify you if that changes — it does not book anything on your behalf.', 'Foursome is not affiliated with, endorsed by, or operated in partnership with any golf course, golf club, or booking platform. Course names and locations shown in the app come from OpenStreetMap, a public, community-run map — not from the courses themselves.'] },
  { h: 'Posting and joining rounds', p: ["When you post a round, the details you enter (course, date, time, number of spots, handicap range, pace, and any notes) are visible to other Foursome users. When someone requests to join your round, you decide whether to approve or deny them — Foursome doesn't guarantee that any request will be approved, or that a posted round will fill up. You're responsible for the accuracy of what you post, including making sure you've actually got a tee time to share."] },
  { h: 'Meeting people in person', p: ["Foursome connects you with other golfers, but the actual round happens off our platform, in person. We don't run background checks on users and can't guarantee the identity, behavior, or skill level of anyone you meet through the app. Use the same judgment you would with any app that connects you to strangers: consider meeting for the first time at the course itself, tell someone your plans, and trust your instincts. If something feels off, you can leave, block the other user, and report them to us."] },
  { h: 'Messaging and conduct', p: ["Chat within a round is only visible to that round's host and approved participants. When using Foursome — in chat, in your bio, in round notes, or anywhere else — don't:"], list: ['Harass, threaten, or discriminate against anyone', 'Post spam, scams, or unrelated advertising', 'Impersonate another person or misrepresent your handicap or identity', "Share anyone else's personal information without their consent", 'Use Foursome for anything illegal'] },
  { h: 'Ratings', p: ["After a round, participants can rate each other. Ratings should reflect your honest, good-faith experience playing with that person — not a way to settle an unrelated dispute or retaliate against someone. Don't post a rating or comment about someone you didn't actually play a round with."] },
  { h: 'Blocking and reporting', p: ["If you'd rather not interact with a specific user, you can block them — this hides your rounds from each other and prevents join requests between you, in both directions. If you believe someone has violated these terms or otherwise made you feel unsafe, you can report them, separately from blocking. We review reports and may take action, including warning, suspending, or removing an account, at our discretion."] },
  { h: 'Your content', p: ["You own what you post — your bio, round notes, messages, and ratings. By posting it on Foursome, you're giving us permission to store and display it to the other users it's meant for (for example, showing your round notes to people browsing Discover, or your bio to someone viewing your profile). You're responsible for what you post and confirm you have the right to share it."] },
  { h: 'Account termination', p: ["You can delete your account at any time from Settings — this permanently removes your profile, the rounds you've hosted (along with their chat history), your ratings, and (if you're signed in) your login itself. We may suspend or terminate your account if you violate these terms."] },
  { h: 'No warranty, limitation of liability', p: ['Foursome is provided "as is." We work to keep it running reliably, but we don\'t guarantee it will always be available, error-free, or that any particular round, course, or golfer will meet your expectations. To the fullest extent the law allows, Foursome isn\'t liable for disputes, injuries, or losses arising from interactions between users, or from a course\'s own policies, conditions, or availability.'] },
  { h: 'Changes to these terms', p: ["We may update these terms as Foursome changes. If we make a significant change, we'll do our best to let you know in the app. Continuing to use Foursome after an update means you accept the revised terms."] },
  { h: 'Contact', p: ['Questions about these terms? Email us at ' + ADMIN_EMAIL + '.'] },
];

const PRIVACY_SECTIONS = [
  { h: 'The short version', p: ["We collect what we need to run Foursome — your profile info, the rounds/messages/ratings you create, and (only when you choose to share it) your location, to help you find nearby rounds and courses. We don't sell your data, and we don't share it with advertisers."] },
  { h: 'Information we collect', p: [
    "Account info: If you sign up with email and password, that's handled by our authentication provider, Supabase — we never see or store your plaintext password. If you use Foursome as a guest, we assign a random local ID stored only on your device; there's no email or password involved.",
    'Profile info: your name, home course, handicap, and bio (if you add one) — set when you create your profile and visible to other Foursome users.',
    'Rounds, messages, ratings, and reports: the tee times you post or request to join, chat messages within a round, ratings and comments you leave for other players, and reports you file against another user.',
    'Location: when you tap "Use my location," your device\'s coordinates are used to sort and filter rounds by distance, and to search for nearby golf courses. That distance calculation happens on your device — we don\'t store your location tied to your account. If you search for nearby courses, your coordinates are sent to our server for that one search (so it can look up courses via OpenStreetMap on your behalf); we cache course results generally, not tied to your identity, and don\'t retain your coordinates afterward.',
    "Push notification data: if you turn on notifications, we store a push subscription — an anonymous endpoint provided by your browser (website) or an Expo push token (mobile app) — so we can alert you about join requests, approvals, and messages.",
  ] },
  { h: 'How we use your information', list: ['To run the core features — posting/joining rounds, matching you with other golfers, messaging within a round, and showing ratings and mutual-round history on profiles', 'To help you find nearby rounds and courses when you choose to share your location', 'To respond to reports and enforce our Terms of Service', "To send you notifications you've opted into", 'To keep Foursome secure and working reliably'], p: ["We don't use your information for advertising, and we don't sell it to third parties."] },
  { h: 'Who can see what', p: ["Your name, home course, handicap, bio, and rating are visible to other Foursome users, particularly anyone viewing a round you're hosting or joining. Round chat is only visible to that round's host and approved participants. Reports you file are visible only to us."] },
  { h: 'Third parties we work with', p: ['We use a small number of outside services to run Foursome:'], list: ["Supabase — our database, authentication, and hosting provider. Your account, profile, and app data are stored on Supabase's infrastructure.", 'OpenStreetMap (Nominatim and Overpass) — public, community-run map data we query to look up golf course names and locations. We only send a search term or coordinates for that lookup, never your identity.', 'Stripe — if and when Foursome offers a paid Pro plan, Stripe handles payment directly; we never see or store your full card details.'] },
  { h: 'How long we keep your data', p: ["We keep your data for as long as your account is active. If you delete your account from Settings, we permanently remove your profile, the rounds you've hosted (and their chat history), your ratings, your push subscription, and your blocks — and, if you were signed in, your login itself. Reports you filed against others are deleted too.", "One exception: if someone else filed a report about you, we keep that report even after you delete your account, since it's part of our safety record and not something a person should be able to erase by leaving."] },
  { h: 'Your choices', list: ["Location is entirely opt-in — the app works without it, just without distance sorting and nearby course search.", 'You can edit your profile (name, home course, handicap, bio) any time from Settings.', 'You can turn push notifications on or off from Settings.', 'You can block or report another user any time from their profile.', 'You can delete your account entirely from Settings — see above for what that removes.'] },
  { h: "Children's privacy", p: ["Foursome isn't intended for anyone under 18, and we don't knowingly collect information from anyone under that age."] },
  { h: 'Security', p: ["We take reasonable steps to protect your information, but no app or service can guarantee complete security. Please use a strong, unique password if you create a full account."] },
  { h: 'Changes to this policy', p: ["We may update this policy as Foursome changes. If we make a significant change, we'll do our best to let you know in the app."] },
  { h: 'Contact', p: ['Questions about your data or this policy? Email us at ' + ADMIN_EMAIL + '.'] },
];

const COOKIE_SECTIONS = [
  { h: 'The short version', p: ["Foursome's website doesn't use cookies, and neither the website nor the mobile app use any advertising or tracking cookies, pixels, or third-party analytics. We use a small amount of storage on your own device to keep the app working the way you'd expect — described below."] },
  { h: "What we store on your device", list: [
    "Your active profile/account id, so the app knows who you are between visits without you signing in every time.",
    "The list of local guest profiles you've used on this device, so you can switch between them.",
    "Your last shared location, so distance sorting keeps working across visits without asking again.",
    "Whether you've turned push notifications on or off.",
    "On the website only: a short-lived marker used only during the few seconds of a Google/Apple sign-in redirect, deleted immediately after it's used.",
  ] },
  { h: 'Staying signed in', p: ["If you create a full account, our authentication provider (Supabase) keeps you signed in using its own secure storage on your device. This is standard session storage, not an advertising cookie, and exists only so you don't have to log in every time you open Foursome."] },
  { h: 'Your choices', p: ["None of this storage is optional in the sense of needing your permission to function — it's what makes core features (staying signed in, remembering your location preference, keeping notifications set the way you left them) work at all. You can clear it any time through your browser's or device's own settings, which will simply sign you out and reset those preferences locally; it won't delete your account or data from our servers."] },
  { h: 'Changes to this policy', p: ["We may update this policy as Foursome changes. If we make a significant change, we'll do our best to let you know in the app."] },
  { h: 'Contact', p: ['Questions about this policy? Email us at ' + ADMIN_EMAIL + '.'] },
];

const REFUND_SECTIONS = [
  { h: 'The short version', p: ["Foursome is currently free to use, with no paid features enabled. Since there's nothing to buy, there's nothing to refund."] },
  { h: 'If that changes', p: ["If Foursome ever introduces a paid plan, we'll update this policy before charging anyone, so it accurately describes how refunds work for whatever's actually offered at that time."] },
  { h: 'Contact', p: ['Questions about this policy? Email us at ' + ADMIN_EMAIL + '.'] },
];

module.exports = { LEGAL_EFFECTIVE_DATE, ADMIN_EMAIL, TERMS_SECTIONS, PRIVACY_SECTIONS, COOKIE_SECTIONS, REFUND_SECTIONS };
