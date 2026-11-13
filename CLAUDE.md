# CLAUDE.md

Laundry Queue: a booking app for one shared washing machine in a building. Hebrew first (RTL), with an English toggle, built mainly for phones.

## Working with the owner
- The owner mostly works from a phone and isn't a developer. For anything done in Firebase, Google Cloud or GitHub, give short step-by-step instructions (which page, which button). Screenshots are a normal way for them to show where they are.
- `main` is production. Work on a branch, then open a PR and merge it only when the owner asks.

## Layout
| Path | What it is |
|---|---|
| `index.html` | The entire app: HTML, CSS and JS in one file. No build step, no npm. Firebase compat SDK 10.12.2 is loaded from gstatic. The Firebase web config is inline (that's public by design). |
| `functions/` | Firebase Cloud Functions (Node 20, v2): `sendReminders` (`index.js`) runs every 5 min and sends reminder emails via Gmail SMTP. The run itself is `processReminders` in `send.js` (takes db, clock and mail sender, so tests can drive it). Timing and email text are pure logic in `reminders.js`, unit tests in `test.js`. |
| `tests/multiuser/` | End-to-end test: the real app in several browsers at once against the Firebase emulators, with `firestore.test.rules`. |
| `firebase.json`, `.firebaserc` | Functions deploy config. Project id: `laundry-schedule-fa89a`. |
| `README.md` | User-facing docs, including the one-time setup for reminders. |

The page is served statically, presumably via GitHub Pages at `https://yaronlasko.github.io/laundry/`. That's also the default `APP_URL` used in the emails.

## Booking rules (constants at the top of the app script)
- `SLOT` 45 min per turn = `WASH` 40 min + 5 min to take clothes out. Starts snap to `TICK` 15-minute marks. Bookings open `DAYS` = 14 days ahead.
- One turn per person per day. A start up to 10 minutes in the past is still bookable.
- `doneAt` ("My laundry is out") frees the machine early. `effEnd(b)` is the time a turn really occupies: rounded up to the next 15-minute mark after `doneAt`, otherwise `endMs`. Always use `effEnd`, not `endMs`, when checking overlaps or whether the machine is free.
- All times are the browser's local time. Day keys are `YYYY-MM-DD` local. The function formats times in `Asia/Jerusalem`.

## Firestore data model
| Collection | Contents |
|---|---|
| `members/{uid}` | `{name, email, phone, joinedAt}`. Every signed-in user can read all of these, including emails. |
| `bookings/{startMs}` | `{uid, startMs, endMs, day, createdAt, doneAt?, swap?}`. The doc id is the start time, so two bookings can't share a start. |
| `ticks/{ms}` | `{booking}`. One per 15-minute block a booking covers (3 per turn). Exists so the rules can block overlapping bookings. |
| `daily/{uid}_{day}` | `{uid, day, booking}`. Exists so the rules can enforce one turn per day. |
| `swaps/{id}` | `{fromUid, toUid, fromBooking, toBooking, status: pending/accepted/declined, createdAt, answeredAt?}` |
| `config/machine` | `{broken, updatedAt}`. When `broken` is true, booking is paused. |
| `adminCheck/me` | Admin probe: the client tries to read it, and success means admin. The client only checks this for Google-signed-in users. |
| `prefs/{uid}` | `{email: bool, lang, updatedAt}`. Reminder opt-in, private to the user. |
| `reminders/{bookingId}_{uid}_{start or pickup}` | "Already sent" markers, written only by the function (Admin SDK). Cleared after 3 days. |

Booking, cancelling, finishing ("done") and accepting swaps each write the booking, its `ticks` and its `daily` doc together in one batch (`book`, `addDeleteBooking`, `markDone`, `acceptSwap`). Keep those three in sync whenever you touch booking writes.

## Security rules are not in this repo
The real protection is the Firestore security rules in the Firebase console. They block double-booking and a second turn per day, decide who is admin, and control who can edit whose data. The app's own checks only shape the UI and anyone can bypass them.
- Before adding or changing any write (new fields, new collections, admin acting on other users' data), ask the owner to paste the current rules from Firebase console → Firestore Database → Rules. Don't guess them.
- When a change needs new rules, give the exact rule text and say where to paste it. Make the UI degrade gracefully until the rules are published. Example: the reminder UI stays hidden while reading `prefs` is denied.
- Prefer new collections over new fields on existing docs, because existing rules may whitelist fields.

## Code conventions in index.html
- Global state lives in `S`. Each area has a `renderX()`, and `renderAll()` redraws everything. Snapshots call `renderAll()`, and a 30-second interval refreshes the time-based views.
- `setHTML(el, html)` skips identical HTML and keeps input/select values (and checkbox state) and focus across re-renders. Give form controls stable `id`s so this works.
- Clicks go through one delegated listener on `[data-act]`. Add new actions as `case`s there. Thrown `{code}` errors are mapped to messages in `errMsg`.
- **i18n:** every user-facing string goes in both `T.en` and `T.he`. Use `t(key, vars)` with `{placeholders}`. Hebrew is the default.
- **Escaping:** pass any user-provided value through `esc()` before putting it in HTML.
- **RTL:** use logical CSS properties (`inset-inline-start`, `margin-inline-end`, `border-inline-start`). Wrap times, phone numbers and emails in `dir="ltr"`.
- **Styling:** colors come from CSS custom properties on `:root`, with a dark-mode override block. Use the existing tokens (`--accent`, `--mine`, `--ok`, `--warn`, …) and components (`.card`, `.pill`, `.row`, `button.primary`, `button.danger`, `.mini`).
- **Confirmations:** destructive actions use a two-step confirm via `S.confirm = '<kind>:<id>'`, not `confirm()`.

## Testing
- Functions: `cd functions && npm install && npm test`.
- Multi-user: `cd tests/multiuser && npm install && npm test` (also needs `functions/node_modules`; set `SHOTS_DIR` to choose where screenshots go). It starts the Auth and Firestore emulators (project `demo-laundry`), serves `index.html`, swaps the gstatic Firebase SDK for the npm copy pointed at the emulators, and drives 3+ users in separate browser contexts: booking and live sync, a same-moment race for one slot, swaps, cancel, finishing early (via `page.clock`), admin (Google sign-in with a fake emulator token for `admin@example.com`), the reminder run, and Hebrew/RTL. It also sends rule-bypassing writes straight to Firestore to check they're refused. Run it after any change to booking, swap, admin or reminder code.
- `tests/multiuser/firestore.test.rules` is a **stand-in** written from what the app writes, not the production rules. A pass shows the app and those rules agree; it says nothing about the real rules until the owner shares them.
- The app has no test suite. To check UI changes: extract the inline `<script>` and run `node --check` on it, then render with Playwright. Intercept `gstatic.com/firebasejs` requests and serve a small fake `window.firebase` (auth that calls back with a user, and Firestore `collection/doc/where/orderBy/onSnapshot/set/batch` over in-memory data). Screenshot both languages at phone width (around 420px).
- Real Firebase or email behaviour can't be tested from a cloud session. Say so rather than claiming it works.

## Deploying
- App: merging to `main` updates the live site (assuming Pages serves `main`).
- Functions: need the Blaze plan, plus secrets `SMTP_USER` and `SMTP_PASS` (a Gmail address and app password). Optional params are `APP_URL` and `TIME_ZONE`. Deploy with `npx firebase-tools deploy --only functions`. The owner runs this, for example from Google Cloud Shell; see README.

## Known issues
- The setup notice text mentions `firebase-config.js`, which doesn't exist. The config is inline.
- `members` is readable by everyone, including emails.
- If an anonymous user signs in to a Google account that's already in use, their anonymous registration and bookings are left orphaned.
- Removing a member deletes their future bookings but leaves their swaps.
- Any sign-up email address is accepted without verification, so reminders can be sent to an address that isn't the member's.
