// Scheduled job: every 5 minutes, email people whose laundry turn starts soon
// or whose wash just finished. Only members who turned reminders on in the app
// (prefs/{uid}.email === true) get emails, at the address in members/{uid}.email.
// The work itself is in send.js.
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret, defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const nodemailer = require('nodemailer');
const { processReminders } = require('./send');

initializeApp();

// Gmail address the emails are sent from, and its 16-character app password.
const SMTP_USER = defineSecret('SMTP_USER');
const SMTP_PASS = defineSecret('SMTP_PASS');
const APP_URL = defineString('APP_URL', { default: 'https://yaronlasko.github.io/laundry/' });
const TIME_ZONE = defineString('TIME_ZONE', { default: 'Asia/Jerusalem' });

exports.sendReminders = onSchedule(
  { schedule: 'every 5 minutes', timeZone: 'Asia/Jerusalem', secrets: [SMTP_USER, SMTP_PASS], retryCount: 0, timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const mail = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: SMTP_USER.value(), pass: SMTP_PASS.value() }
    });
    await processReminders({
      db: getFirestore(),
      now: Date.now(),
      timeZone: TIME_ZONE.value(),
      appUrl: APP_URL.value(),
      send: (msg, lang) => mail.sendMail(Object.assign({ from: { name: lang === 'en' ? 'Laundry Queue' : 'תור כביסה', address: SMTP_USER.value() } }, msg)),
      log: (level, message, data) => logger[level](message, data)
    });
  }
);
