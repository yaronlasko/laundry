// Scheduled job: every 5 minutes, email people whose laundry turn starts soon
// or whose wash just finished. Only members who turned reminders on in the app
// (prefs/{uid}.email === true) get emails, at the address in members/{uid}.email.
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret, defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const nodemailer = require('nodemailer');
const { dueReminders, buildEmail, validEmail, SLOT, START_LEAD } = require('./reminders');

initializeApp();

// Gmail address the emails are sent from, and its 16-character app password.
const SMTP_USER = defineSecret('SMTP_USER');
const SMTP_PASS = defineSecret('SMTP_PASS');
const APP_URL = defineString('APP_URL', { default: 'https://yaronlasko.github.io/laundry/' });
const TIME_ZONE = defineString('TIME_ZONE', { default: 'Asia/Jerusalem' });

const DAY = 24 * 3600000;

exports.sendReminders = onSchedule(
  { schedule: 'every 5 minutes', timeZone: 'Asia/Jerusalem', secrets: [SMTP_USER, SMTP_PASS], retryCount: 0, timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const db = getFirestore();
    const now = Date.now();

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

      const mail = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 465, secure: true,
        auth: { user: SMTP_USER.value(), pass: SMTP_PASS.value() }
      });

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
        const msg = buildEmail(r, { name: m.name, lang: p.lang, now, timeZone: TIME_ZONE.value(), appUrl: APP_URL.value() });
        try {
          await mail.sendMail({ from: { name: p.lang === 'en' ? 'Laundry Queue' : 'תור כביסה', address: SMTP_USER.value() }, to: m.email, subject: msg.subject, text: msg.text, html: msg.html });
          logger.info('reminder sent', { type: r.type, booking: r.booking.id });
        } catch (e) {
          logger.error('email failed, will retry next run', { type: r.type, booking: r.booking.id, error: String(e && e.message || e) });
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
  }
);
