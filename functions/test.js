// Run with: node test.js
const assert = require('assert');
const { dueReminders, buildEmail } = require('./reminders');
const MIN = 60000;
const start = Date.UTC(2026, 10, 13, 8, 0); // 10:00 in Israel
const b = { id: String(start), uid: 'u1', startMs: start, endMs: start + 45 * MIN, createdAt: start - 3 * 3600000 };
const keys = now => dueReminders([b], now).map(r => r.type);

// The job runs every 5 minutes: exactly one start reminder window opens before the turn.
assert.deepStrictEqual(keys(start - 15 * MIN), []);
assert.deepStrictEqual(keys(start - 10 * MIN), ['start']);
assert.deepStrictEqual(keys(start - 5 * MIN), ['start']); // same key, deduplicated by the reminders doc
assert.deepStrictEqual(keys(start), []);
assert.deepStrictEqual(keys(start + 20 * MIN), []);
// Pickup reminder around wash end (start + 40), still caught if the run is a bit late.
assert.deepStrictEqual(keys(start + 40 * MIN), ['pickup']);
assert.deepStrictEqual(keys(start + 50 * MIN), ['pickup']);
assert.deepStrictEqual(keys(start + 56 * MIN), []);
// No pickup reminder once "my laundry is out" was pressed.
assert.deepStrictEqual(dueReminders([Object.assign({}, b, { doneAt: start + 30 * MIN })], start + 40 * MIN), []);
// No start reminder for a turn booked 5 minutes before it starts.
assert.deepStrictEqual(dueReminders([Object.assign({}, b, { createdAt: start - 5 * MIN })], start - 4 * MIN), []);
// A swapped turn gets a new key, so the new owner is reminded too.
const [r1] = dueReminders([b], start - 10 * MIN), [r2] = dueReminders([Object.assign({}, b, { uid: 'u2' })], start - 10 * MIN);
assert.notStrictEqual(r1.key, r2.key);

const he = buildEmail(r1, { name: 'דנה <b>', lang: 'he', now: start - 10 * MIN, timeZone: 'Asia/Jerusalem', appUrl: 'https://example.org/' });
assert.ok(he.subject.includes('10:00'), he.subject);
assert.ok(he.text.includes('10:40') && he.text.includes('10:45'), he.text);
assert.ok(he.html.includes('dir="rtl"') && he.html.includes('&lt;b&gt;'));
const en = buildEmail(dueReminders([b], start + 40 * MIN)[0], { name: 'Dana', lang: 'en', now: start + 40 * MIN, timeZone: 'Asia/Jerusalem', appUrl: 'https://example.org/' });
assert.strictEqual(en.subject, 'Wash done: take your clothes out by 10:45');
console.log('all reminder tests passed');
console.log('\n' + he.subject + '\n' + he.text + '\n' + en.subject + '\n' + en.text);
