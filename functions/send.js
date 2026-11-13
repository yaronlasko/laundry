// The reminder run itself, separate from Firebase Functions so tests can call it
// with their own database, clock and mail sender.
const { dueReminders, buildEmail, validEmail, SLOT, START_LEAD } = require('./reminders');

const DAY = 24 * 3600000;

// send(message, lang) delivers one email: message has {to, subject, text, html}.
// Returns the number of emails sent.
async function processReminders({ db, now, send, timeZone, appUrl, log = () => {} }) {
  let count = 0;
  const snap = await db.collection('bookings')
    .where('startMs', '>=', now - SLOT)
    .where('startMs', '<=', now + START_LEAD)
    .get();
  const due = dueReminders(snap.docs.map(d => Object.assign({ id: d.id }, d.data())), now);

  if (due.length) {
    const uids = [...new Set(due.map(r => r.uid))];
    const [memberDocs, prefDocs] = await Promise.all([
      db.getAll(...uids.map(u => db.doc('members/' + u))),
      db.getAll(...uids.map(u => db.doc('prefs/' + u)))
    ]);
    const members = {}, prefs = {};
    memberDocs.forEach(d => { if (d.exists) members[d.id] = d.data(); });
    prefDocs.forEach(d => { if (d.exists) prefs[d.id] = d.data(); });

    for (const r of due) {
      const m = members[r.uid], p = prefs[r.uid];
      if (!p || p.email !== true || !m || !validEmail(m.email)) continue;
      // Claim the reminder first; create() fails if it was already sent, so nobody gets duplicates.
      const ref = db.doc('reminders/' + r.key);
      try {
        await ref.create({ uid: r.uid, booking: r.booking.id, type: r.type, sentAt: now });
      } catch (e) {
        if (e && e.code === 6) continue; // ALREADY_EXISTS
        throw e;
      }
      const msg = buildEmail(r, { name: m.name, lang: p.lang, now, timeZone, appUrl });
      try {
        await send({ to: m.email, subject: msg.subject, text: msg.text, html: msg.html }, p.lang);
        count++;
        log('info', 'reminder sent', { type: r.type, booking: r.booking.id });
      } catch (e) {
        log('error', 'email failed, will retry next run', { type: r.type, booking: r.booking.id, error: String((e && e.message) || e) });
        await ref.delete().catch(() => {});
      }
    }
  }

  // Once an hour, clear "already sent" markers older than 3 days.
  if (new Date(now).getUTCMinutes() < 5) {
    const old = await db.collection('reminders').where('sentAt', '<', now - 3 * DAY).limit(300).get();
    if (!old.empty) {
      const batch = db.batch();
      old.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  }
  return count;
}

module.exports = { processReminders };
