# laundry

A booking queue for one shared washing machine: 45-minute turns, one turn per person per day,
swaps between neighbours, and an admin panel. Hebrew and English. The whole app is `index.html`,
using Firebase (sign-in and the Firestore database).

## Email reminders

Members can turn on email reminders (at sign-up, or with the on/off button under their details).
They get two emails per turn:

- about 10 minutes before the turn starts
- when the wash finishes, with the time the clothes need to be out by (skipped if they already tapped "My laundry is out")

Emails go to the address the member signed up with, in the language they last used in the app.
A scheduled Firebase function (`functions/`) checks every 5 minutes and sends them from a Gmail account.

### One-time setup

1. **Switch Firebase to the Blaze plan.** Firebase console → the project → bottom-left "Upgrade".
   Scheduled functions need it. At this size it should stay inside the free allowance.
   To be safe, set a budget alert (for example $1) in Google Cloud Billing.

2. **Make a Gmail app password** for the Gmail account the emails will come from.
   That account needs 2-Step Verification turned on. Then go to
   https://myaccount.google.com/apppasswords, create a password named "laundry", and copy the 16 characters.
   (A separate Gmail account just for the building works well.)

3. **Update the Firestore rules.** Firebase console → Firestore Database → Rules. Replace everything with
   `tests/multiuser/firestore.test.rules`, change `admin@example.com` to your own Gmail, then Publish.
   (They include the `prefs` and `reminders` rules this needs.)

   Until this is done, the reminder checkbox and button stay hidden in the app.

4. **Deploy the function.** No installs needed if you use Google Cloud Shell
   (https://shell.cloud.google.com, signed in with the Google account that owns the Firebase project):

   ```
   git clone https://github.com/yaronlasko/laundry.git && cd laundry
   npm --prefix functions install
   npx firebase-tools login --no-localhost
   npx firebase-tools functions:secrets:set SMTP_USER   # paste the Gmail address
   npx firebase-tools functions:secrets:set SMTP_PASS   # paste the 16-character app password
   npx firebase-tools deploy --only functions
   ```

   If the deploy asks for `APP_URL` (the link inside the emails) or `TIME_ZONE`, press Enter to keep the
   defaults (`https://yaronlasko.github.io/laundry/` and `Asia/Jerusalem`), or type the right value.

5. **Test it:** turn on reminders in the app, book a turn that starts in 15–20 minutes, and wait for the email.
   Logs are in Firebase console → Functions → `sendReminders` → Logs.

### Tests

```
cd functions && npm install && npm test          # reminder timing and email text
cd tests/multiuser && npm install && npm test    # several users at once, against the Firebase emulators
```

The multi-user test runs the real app in separate browsers (sign-up, booking, two people grabbing the same slot,
swaps, cancelling, finishing early, admin tools, reminder emails, Hebrew view). It uses the security
rules (`tests/multiuser/firestore.test.rules`): a copy of the published rules with a test admin email.
