// Pure reminder logic (no Firebase), so it can be tested on its own.
const MIN = 60000;
const SLOT = 45 * MIN, WASH = 40 * MIN;
// "Your turn starts soon" goes out when the turn is at most this far away.
// The job runs every 5 minutes, so this lands about 10 minutes before the turn.
const START_LEAD = 12 * MIN;
// "Take your clothes out" goes out from (wash end - 1 min) until this long after the turn ends,
// so a late scheduler run still catches it.
const PICKUP_GRACE = 10 * MIN;

// Which reminders are due right now. Each has a stable key, so it is sent at most once per owner.
function dueReminders(bookings, now) {
  const out = [];
  for (const b of bookings) {
    if (!b || !b.uid || typeof b.startMs !== 'number') continue;
    const endMs = typeof b.endMs === 'number' ? b.endMs : b.startMs + SLOT;
    const untilStart = b.startMs - now;
    // Skip turns booked inside the reminder window: the person just booked it and knows.
    const bookedLate = typeof b.createdAt === 'number' && b.createdAt > b.startMs - START_LEAD;
    if (untilStart > 0 && untilStart <= START_LEAD && !bookedLate) {
      out.push({ key: `${b.id}_${b.uid}_start`, type: 'start', uid: b.uid, booking: b });
    }
    const done = typeof b.doneAt === 'number';
    if (!done && now >= b.startMs + WASH - MIN && now < endMs + PICKUP_GRACE) {
      out.push({ key: `${b.id}_${b.uid}_pickup`, type: 'pickup', uid: b.uid, booking: b });
    }
  }
  return out;
}

const TEXT = {
  en: {
    startSubject: 'Reminder: your laundry turn starts at {t}',
    startBody: 'Hi {name}, your laundry turn starts at {t} (in about {m} minutes). The wash ends at {w}, and your clothes need to be out by {e}.',
    pickupSubject: 'Wash done: take your clothes out by {e}',
    pickupBody: 'Hi {name}, your wash should be finished now. Please take your clothes out by {e} so the next person can start. When you\'re done, tap "My laundry is out" in the app.',
    open: 'Open the laundry queue',
    footer: 'You get these emails because reminders are on in the laundry queue. You can turn them off in the app.'
  },
  he: {
    startSubject: 'תזכורת: תור הכביסה שלך מתחיל ב-{t}',
    startBody: 'שלום {name}, תור הכביסה שלך מתחיל ב-{t} (בעוד כ-{m} דקות). הכביסה מסתיימת ב-{w}, ויש להוציא את הבגדים עד {e}.',
    pickupSubject: 'הכביסה הסתיימה: להוציא את הבגדים עד {e}',
    pickupBody: 'שלום {name}, הכביסה שלך אמורה להסתיים עכשיו. נא להוציא את הבגדים עד {e} כדי שהבא בתור יוכל להתחיל. בסיום, אפשר ללחוץ על ״הוצאתי את הכביסה״ באפליקציה.',
    open: 'לפתיחת תור הכביסה',
    footer: 'המייל הזה נשלח כי תזכורות במייל פעילות בתור הכביסה. אפשר לכבות אותן באפליקציה.'
  }
};

function fill(s, v) { for (const k in v) s = s.split('{' + k + '}').join(v[k]); return s; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildEmail(r, { name, lang, now, timeZone, appUrl }) {
  const L = lang === 'en' ? 'en' : 'he';
  const T = TEXT[L];
  const fmt = ms => new Intl.DateTimeFormat(L === 'he' ? 'he-IL' : 'en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(ms);
  const b = r.booking;
  const endMs = typeof b.endMs === 'number' ? b.endMs : b.startMs + SLOT;
  const vals = {
    name: name || (L === 'he' ? 'שכן/ה' : 'neighbour'),
    t: fmt(b.startMs), w: fmt(b.startMs + WASH), e: fmt(endMs),
    m: String(Math.max(1, Math.round((b.startMs - now) / MIN)))
  };
  const subject = fill(r.type === 'start' ? T.startSubject : T.pickupSubject, vals);
  const body = fill(r.type === 'start' ? T.startBody : T.pickupBody, vals);
  const htmlBody = fill(r.type === 'start' ? T.startBody : T.pickupBody, Object.assign({}, vals, { name: esc(vals.name) }));
  const dir = L === 'he' ? 'rtl' : 'ltr';
  const text = `${body}\n\n${T.open}: ${appUrl}\n\n${T.footer}\n`;
  const html = `<div dir="${dir}" style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#13242b;max-width:520px">
<p>${htmlBody}</p>
<p><a href="${esc(appUrl)}" style="display:inline-block;background:#16708a;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:bold">${T.open}</a></p>
<p style="color:#56696f;font-size:13px">${T.footer}</p>
</div>`;
  return { subject, text, html };
}

function validEmail(s) { return typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s); }

module.exports = { dueReminders, buildEmail, validEmail, SLOT, WASH, START_LEAD, PICKUP_GRACE };
