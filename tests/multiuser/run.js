// Multi-user end-to-end test: the real index.html in several separate browsers
// (each its own anonymous Firebase user), all talking to the Firebase emulators.
// Run with: npm test   (starts the emulators, runs this file, stops them)
// Uses firestore.test.rules: the production rules with a test admin email.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const PROJECT = 'demo-laundry';
const ROOT = path.resolve(__dirname, '../..');
const PORT = 5055;
const APP = `http://127.0.0.1:${PORT}/`;
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'screenshots');
const MIN = 60000, TICK = 15 * MIN;
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
if (process.env.TZ !== 'Asia/Jerusalem') { console.error('Run with TZ=Asia/Jerusalem (npm test does this).'); process.exit(2); }

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

// ---------- serve the app, and the Firebase SDK from npm instead of gstatic ----------
const fbDir = path.dirname(require.resolve('firebase/package.json'));
const PATCH = `
;(function(){ const init = firebase.initializeApp;
  firebase.initializeApp = function(c){ const app = init.call(this, Object.assign({}, c, { projectId: '${PROJECT}' }));
    firebase.auth().useEmulator('http://127.0.0.1:9099', { disableWarnings: true });
    firebase.firestore().useEmulator('127.0.0.1', 8080);
    return app; }; })();`;
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
  }
  res.writeHead(404); res.end();
});

// ---------- helpers ----------
const pad = n => String(n).padStart(2, '0');
const dayKey = ms => { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const at = (daysAhead, h, m = 0) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + daysAhead, h, m).getTime(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function eventually(fn, msg, timeout = 8000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { if (await fn()) return; } catch (e) { last = e; } await sleep(150); }
  throw new Error(msg + (last ? ` (${last.message})` : ''));
}
const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ ok: true, name }); console.log('  PASS ', name); }
  catch (e) { results.push({ ok: false, name, err: e.message }); console.log('  FAIL ', name, '\n         ', e.message); }
}
const getDoc = async p => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };

let browser;
const pageErrors = [];
async function openUser(label, opts = {}) {
  const ctx = opts.ctx || await browser.newContext({ locale: opts.locale || 'en-US', timezoneId: 'Asia/Jerusalem', viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  if (opts.fakeNow) await page.clock.setFixedTime(new Date(opts.fakeNow));
  page.on('pageerror', e => pageErrors.push(`${label}: ${e.message}`));
  await page.route(/gstatic\.com\/firebasejs\/[^/]+\/([\w-]+\.js)/, route => {
    const file = route.request().url().split('/').pop();
    let body = fs.readFileSync(path.join(fbDir, file), 'utf8');
    if (file === 'firebase-firestore-compat.js') body += PATCH;
    route.fulfill({ contentType: 'text/javascript', body });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(APP);
  await page.waitForFunction(() => window.firebase && firebase.auth().currentUser, null, { timeout: 15000 });
  const uid = await page.evaluate(() => firebase.auth().currentUser.uid);
  return { label, ctx, page, uid };
}
async function register(u, name, phone, email) {
  await u.page.waitForSelector('#reg-form');
  await u.page.fill('#reg-name', name); await u.page.fill('#reg-email', email); await u.page.fill('#reg-phone', phone);
  await u.page.click('#reg-form button[type=submit]');
  await u.page.waitForSelector('.reg-card', { timeout: 8000 });
  u.name = name; u.email = email;
}
async function toastAfter(page, action) {
  await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
  await action();
  await page.waitForFunction(() => document.getElementById('toast').textContent.trim() !== '', null, { timeout: 8000 });
  return (await page.textContent('#toast')).trim();
}
async function showDay(u, ms) { await u.page.click(`[data-act=day][data-day="${dayKey(ms)}"]`); }
async function startOptions(u) { return u.page.$$eval('#start-time option', os => os.map(o => o.value)); }
async function selectStart(u, ms) {
  await showDay(u, ms);
  await eventually(async () => (await startOptions(u)).includes(String(ms)), `${u.label}: ${new Date(ms).toTimeString().slice(0, 5)} not offered`);
  await u.page.selectOption('#start-time', String(ms));
}
async function book(u, ms) { await selectStart(u, ms); return toastAfter(u.page, () => u.page.click('#book-btn')); }
// Writes straight to Firestore from the user's browser, skipping the app's own checks: only the rules decide.
async function rawBook(u, startMs, dayOverride) {
  return u.page.evaluate(async ({ startMs, day }) => {
    const db = firebase.firestore(), uid = firebase.auth().currentUser.uid, id = String(startMs), b = db.batch();
    b.set(db.doc('bookings/' + id), { uid, startMs, endMs: startMs + 2700000, day, createdAt: Date.now() });
    for (const k of [0, 1, 2]) b.set(db.doc('ticks/' + (startMs + k * 900000)), { booking: id });
    b.set(db.doc('daily/' + uid + '_' + day), { uid, day, booking: id });
    try { await b.commit(); return 'ok'; } catch (e) { return e.code; }
  }, { startMs, day: dayOverride || dayKey(startMs) });
}
async function raw(u, fnSrc, arg) {
  return u.page.evaluate(async ({ fnSrc, arg }) => {
    const db = firebase.firestore(), uid = firebase.auth().currentUser.uid;
    try { await (new Function('db', 'uid', 'arg', 'return (async()=>{' + fnSrc + '})()'))(db, uid, arg); return 'ok'; } catch (e) { return e.code || e.message; }
  }, { fnSrc, arg });
}
async function shot(u, name) { fs.mkdirSync(SHOTS, { recursive: true }); await u.page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); }
// Undo a booking a test managed to sneak in, so later steps start from a clean state.
async function wipeBooking(ms) {
  const b = await getDoc('bookings/' + ms); if (!b) return;
  const batch = db.batch();
  batch.delete(db.doc('bookings/' + ms));
  for (const k of [0, 1, 2]) batch.delete(db.doc('ticks/' + (ms + k * TICK)));
  batch.delete(db.doc(`daily/${b.uid}_${b.day}`));
  await batch.commit();
}
async function bookingState(ms) {
  const id = String(ms), b = await getDoc('bookings/' + id);
  const ticks = await Promise.all([0, 1, 2].map(k => getDoc('ticks/' + (ms + k * TICK))));
  return { b, ticks: ticks.map(t => t && t.booking), daily: b ? await getDoc(`daily/${b.uid}_${b.day}`) : null };
}

// ---------- the scenario ----------
async function main() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  browser = await chromium.launch();
  const D1 = 1, D2 = 2, D3 = 3; // days ahead

  console.log('\nSign-up');
  const A = await openUser('Dana'), B = await openUser('Avi'), C = await openUser('Noa');
  await check('three separate browsers get three different users', async () => {
    assert(new Set([A.uid, B.uid, C.uid]).size === 3, 'uids not distinct');
  });
  await check('each user can sign up', async () => {
    await register(A, 'Dana', '050-111-1111', 'dana@example.com');
    await register(B, 'Avi', '050-222-2222', 'avi@example.com');
    await register(C, 'Noa', '050-333-3333', 'noa@example.com');
    assert(await getDoc('members/' + A.uid), 'Dana member doc missing');
  });

  console.log('\nBooking and live updates');
  const a10 = at(D1, 10);
  await check('Dana books tomorrow 10:00', async () => {
    const msg = await book(A, a10);
    assert(/Booked/.test(msg), 'toast: ' + msg);
    const s = await bookingState(a10);
    assert(s.b && s.b.uid === A.uid, 'booking not stored for Dana');
    assert(s.ticks.every(t => t === String(a10)), 'ticks not written: ' + s.ticks);
    assert(s.daily && s.daily.booking === String(a10), 'daily doc missing');
  });
  await check("Avi sees Dana's turn appear without reloading (name + phone)", async () => {
    await showDay(B, a10);
    await eventually(async () => (await B.page.textContent('#daylist')).includes('Dana'), "Dana's row never appeared for Avi");
    assert((await B.page.textContent('#daylist')).includes('050-111-1111'), "Dana's phone not shown to Avi");
  });
  await check('times overlapping 10:00–10:45 are not offered to Avi; 09:15 and 10:45 are', async () => {
    const o = await startOptions(B);
    for (const [h, m] of [[9, 30], [9, 45], [10, 0], [10, 15], [10, 30]]) assert(!o.includes(String(at(D1, h, m))), `${h}:${m} offered`);
    assert(o.includes(String(at(D1, 9, 15))) && o.includes(String(at(D1, 10, 45))), 'free neighbours missing');
  });

  console.log('\nTwo people grab the same slot at the same moment');
  const r12 = at(D1, 12);
  let W, L;
  await check('Avi and Noa both press Book for 12:00 at once: exactly one wins', async () => {
    await selectStart(B, r12); await selectStart(C, r12);
    const [mb, mc] = await Promise.all([toastAfter(B.page, () => B.page.click('#book-btn')), toastAfter(C.page, () => C.page.click('#book-btn'))]);
    const won = [/Booked/.test(mb), /Booked/.test(mc)];
    assert(won.filter(Boolean).length === 1, `toasts: Avi="${mb}" Noa="${mc}"`);
    W = won[0] ? B : C; L = won[0] ? C : B;
    assert(/just took that time/.test(won[0] ? mc : mb), 'loser message: ' + (won[0] ? mc : mb));
    const s = await bookingState(r12);
    assert(s.b.uid === W.uid && s.ticks.every(t => t === String(r12)), 'stored state inconsistent');
    assert(!(await getDoc(`daily/${L.uid}_${dayKey(r12)}`)), 'loser got a daily doc');
    console.log(`         (${W.label} won, ${L.label} lost)`);
  });

  console.log('\nRules refuse cheating writes (sent straight to the database)');
  await check('overlapping booking 12:15 while 12:00 is taken → refused', async () => {
    assert((await rawBook(L, at(D1, 12, 15))) === 'permission-denied', 'was accepted');
    assert(!(await getDoc('bookings/' + at(D1, 12, 15))), 'booking doc exists');
  });
  await check('Dana booking a second turn tomorrow: app blocks it, and the rules do too', async () => {
    const msg = await book(A, at(D1, 14));
    assert(/already have a turn/.test(msg), 'app message: ' + msg);
    assert((await rawBook(A, at(D1, 14))) === 'permission-denied', 'rules accepted a 2nd turn');
  });
  await check("Avi can't delete Dana's booking or her daily doc", async () => {
    assert((await raw(B, `await db.doc('bookings/'+arg).delete()`, String(a10))) === 'permission-denied', 'booking delete allowed');
    assert((await raw(B, `await db.doc('daily/'+arg).delete()`, `${A.uid}_${dayKey(a10)}`)) === 'permission-denied', 'daily delete allowed');
  });
  await check('a second turn on the same day, labelled as a different date, is refused', async () => {
    const ms = at(D1, 16), r = await rawBook(A, ms, '2099-01-01');
    if (r === 'ok') { await wipeBooking(ms); throw new Error('accepted: Dana got a 2nd turn tomorrow by writing day "2099-01-01"'); }
    assert(r === 'permission-denied', 'result: ' + r);
  });
  await check("Avi can't edit Dana's details or read her reminder setting", async () => {
    assert((await raw(B, `await db.doc('members/'+arg).set({name:'x',email:'x@x.x',phone:'050-0000000',joinedAt:1})`, A.uid)) === 'permission-denied', 'member edit allowed');
    assert((await raw(B, `await db.doc('prefs/'+arg).get()`, A.uid)) === 'permission-denied', 'prefs read allowed');
  });
  await check("Avi can't read swap requests between other people", async () => {
    const r = await raw(B, `await db.collection('swaps').where('fromUid','==',arg).get()`, A.uid);
    assert(r === 'permission-denied', 'all swap requests are readable by anyone signed in');
  });
  await check("a normal user can't mark the machine broken or pass the admin check", async () => {
    assert((await raw(B, `await db.doc('config/machine').set({broken:true})`)) === 'permission-denied', 'machine write allowed');
    assert((await raw(B, `await db.doc('adminCheck/me').get()`)) === 'permission-denied', 'admin check passed');
  });
  await check('someone who never signed up cannot book', async () => {
    const X = await openUser('Stranger');
    assert((await rawBook(X, at(D1, 18))) === 'permission-denied', 'accepted');
    await X.ctx.close();
  });

  console.log('\nSwaps');
  const l15 = at(D1, 15);
  await check('the loser of the race books tomorrow 15:00', async () => { assert(/Booked/.test(await book(L, l15)), 'not booked'); });
  await check("same-day swap: Dana offers her 10:00 for the loser's 15:00, they accept", async () => {
    await showDay(A, l15);
    await A.page.waitForSelector(`[data-act=swap-open][data-id="${l15}"]`);
    await A.page.click(`[data-act=swap-open][data-id="${l15}"]`);
    await A.page.selectOption('#swap-select', String(a10));
    assert(/Request sent/.test(await toastAfter(A.page, () => A.page.click('[data-act=swap-send]'))), 'request not sent');
    await L.page.waitForSelector('[data-act=swap-accept]', { timeout: 8000 });
    assert((await L.page.textContent('#mine')).includes('Dana wants to swap'), 'incoming request text missing');
    await shot(L, '1-swap-request');
    assert(/Turns swapped/.test(await toastAfter(L.page, () => L.page.click('[data-act=swap-accept]'))), 'swap failed');
    const x = await bookingState(a10), y = await bookingState(l15);
    assert(x.b.uid === L.uid && y.b.uid === A.uid, 'owners not swapped');
    assert(x.daily.booking === String(a10) && y.daily.booking === String(l15), 'daily docs wrong');
    await eventually(async () => (await A.page.textContent('#mine')).includes('15:00'), "Dana's 'My turns' didn't update");
  });
  const w9 = at(D2, 9);
  await check('winner books the day after tomorrow 09:00', async () => { assert(/Booked/.test(await book(W, w9)), 'not booked'); });
  await check('cross-day swap that would give someone 2 turns in a day is refused', async () => {
    await showDay(A, w9);
    await A.page.click(`[data-act=swap-open][data-id="${w9}"]`);
    await A.page.selectOption('#swap-select', String(l15));
    await toastAfter(A.page, () => A.page.click('[data-act=swap-send]'));
    await W.page.waitForSelector('[data-act=swap-accept]', { timeout: 8000 });
    const msg = await toastAfter(W.page, () => W.page.click('[data-act=swap-accept]'));
    assert(/two turns on one day/.test(msg), 'message: ' + msg);
    assert((await getDoc('bookings/' + l15)).uid === A.uid, 'booking changed anyway');
  });
  await check('the rules also refuse that swap when the app check is skipped', async () => {
    const sw = (await db.collection('swaps').where('toUid', '==', W.uid).where('status', '==', 'pending').get()).docs[0];
    const r = await raw(W, `
      const s=arg, b=db.batch();
      b.update(db.doc('bookings/'+s.fromBooking),{uid:s.toUid,swap:s.id}); b.update(db.doc('bookings/'+s.toBooking),{uid:s.fromUid,swap:s.id});
      b.set(db.doc('daily/'+s.toUid+'_'+s.aDay),{uid:s.toUid,day:s.aDay,booking:s.fromBooking});
      b.set(db.doc('daily/'+s.fromUid+'_'+s.bDay),{uid:s.fromUid,day:s.bDay,booking:s.toBooking});
      b.delete(db.doc('daily/'+s.fromUid+'_'+s.aDay)); b.delete(db.doc('daily/'+s.toUid+'_'+s.bDay));
      b.update(db.doc('swaps/'+s.id),{status:'accepted',answeredAt:Date.now()}); await b.commit();`,
      Object.assign({ id: sw.id, aDay: dayKey(l15), bDay: dayKey(w9) }, sw.data()));
    assert(r === 'permission-denied', 'result: ' + r);
  });
  await check('winner cancels their 12:00 (two-step) and it frees up for others', async () => {
    await W.page.click(`#mine [data-act=cancel][data-id="${r12}"]`);
    assert(/Turn cancelled/.test(await toastAfter(W.page, () => W.page.click(`#mine [data-act=cancel-yes][data-id="${r12}"]`))), 'not cancelled');
    const s = await bookingState(r12);
    assert(!s.b && s.ticks.every(t => !t), 'booking or ticks left behind');
    assert(!(await getDoc(`daily/${W.uid}_${dayKey(r12)}`)), 'daily doc left behind');
    await showDay(L, r12);
    await eventually(async () => (await startOptions(L)).includes(String(r12)), '12:00 not free for the other user');
  });
  await check("the person asked to swap can't take the offered turn without giving theirs", async () => {
    const d = (await db.collection('swaps').where('toUid', '==', W.uid).where('status', '==', 'pending').get()).docs[0];
    const arg = Object.assign({ id: d.id, aDay: dayKey(l15) }, d.data());
    const steal = `const s=arg, b=db.batch();
      b.update(db.doc('bookings/'+s.fromBooking),{uid:s.toUid,swap:s.id});
      b.set(db.doc('daily/'+s.toUid+'_'+s.aDay),{uid:s.toUid,day:s.aDay,booking:s.fromBooking});
      if (s.markAccepted) b.update(db.doc('swaps/'+s.id),{status:'accepted',answeredAt:Date.now()});
      await b.commit();`;
    for (const markAccepted of [false, true]) {
      const r = await raw(W, steal, Object.assign({ markAccepted }, arg));
      if (r === 'ok') {
        const FV = admin.firestore.FieldValue, b = db.batch();
        b.update(db.doc('bookings/' + l15), { uid: A.uid, swap: FV.delete() });
        b.delete(db.doc(`daily/${W.uid}_${arg.aDay}`));
        b.update(db.doc('swaps/' + d.id), { status: 'pending', answeredAt: FV.delete() });
        await b.commit();
        throw new Error(`accepted${markAccepted ? ' (marking the request accepted)' : ''}: the winner took Dana's 15:00 and kept their own turn`);
      }
      assert(r === 'permission-denied', 'result: ' + r);
    }
  });
  await check('now the same cross-day swap is accepted, and the daily docs move', async () => {
    assert(/Turns swapped/.test(await toastAfter(W.page, () => W.page.click('[data-act=swap-accept]'))), 'swap failed');
    assert((await getDoc('bookings/' + l15)).uid === W.uid && (await getDoc('bookings/' + w9)).uid === A.uid, 'owners not swapped');
    assert((await getDoc(`daily/${W.uid}_${dayKey(l15)}`)).booking === String(l15), 'winner daily D1');
    assert((await getDoc(`daily/${A.uid}_${dayKey(w9)}`)).booking === String(w9), 'Dana daily D2');
    assert(!(await getDoc(`daily/${A.uid}_${dayKey(l15)}`)) && !(await getDoc(`daily/${W.uid}_${dayKey(w9)}`)), 'old daily docs left');
  });

  console.log('\nFinishing early (browser clock set to tomorrow 10:20)');
  const fakeNow = at(D1, 10, 20);
  await check('the 10:00 owner sees the live dial and taps "My laundry is out"', async () => {
    const L2 = await openUser(L.label + ' (10:20)', { ctx: L.ctx, fakeNow });
    await L2.page.waitForSelector('[data-act=done]', { timeout: 8000 });
    const st = await L2.page.textContent('#status');
    assert(st.includes('Washing') && st.includes('Your turn'), 'dial: ' + st);
    await shot(L2, '2-washing');
    assert(/machine is free/.test(await toastAfter(L2.page, () => L2.page.click('[data-act=done]'))), 'done failed');
    const s = await bookingState(a10);
    assert(s.b.doneAt === fakeNow, 'doneAt not saved');
    assert(s.ticks[0] && s.ticks[1] && !s.ticks[2], 'expected only the 10:30 tick freed: ' + s.ticks);
    await L2.page.close();
  });
  await check('at 10:20 the machine stays held until the 10:30 mark, but 10:30 is already bookable', async () => {
    const A2 = await openUser('Dana (10:20)', { ctx: A.ctx, fakeNow });
    try {
      await showDay(A2, a10);
      await eventually(async () => (await startOptions(A2)).includes(String(at(D1, 10, 30))), '10:30 not offered');
      assert(!(await A2.page.textContent('#status')).includes('Machine is free'), 'shown free before 10:30');
    } finally { await A2.page.close(); }
  });
  await check('at 10:31 Dana sees the machine free ("ended 10:30") and books 10:30', async () => {
    const A3 = await openUser('Dana (10:31)', { ctx: A.ctx, fakeNow: at(D1, 10, 31) });
    try {
      await eventually(async () => (await A3.page.textContent('#status')).includes('Machine is free'), 'status not free');
      assert((await A3.page.textContent('#status')).includes('ended 10:30'), 'last-turn line missing');
      assert(/Booked/.test(await book(A3, at(D1, 10, 30))), 'could not book 10:30');
    } finally { await A3.page.close(); }
  });

  console.log('\nAdmin');
  const Adm = await openUser('Admin');
  await check('Google admin sees the admin panel; another Google user does not', async () => {
    const E = await openUser('Eve');
    await E.page.evaluate(() => firebase.auth().signInWithCredential(firebase.auth.GoogleAuthProvider.credential(JSON.stringify({ sub: 'eve', email: 'eve@example.com', email_verified: true }))));
    await E.page.waitForSelector('[data-act=signout]');
    await sleep(800);
    assert(!(await E.page.$('#admin .admin')), 'Eve got the admin panel');
    await E.ctx.close();
    await Adm.page.evaluate(() => firebase.auth().signInWithCredential(firebase.auth.GoogleAuthProvider.credential(JSON.stringify({ sub: 'boss', email: 'admin@example.com', email_verified: true }))));
    await Adm.page.waitForSelector('#admin .admin', { timeout: 8000 });
    const t = await Adm.page.textContent('#admin');
    assert(t.includes('Members (3)') && t.includes('dana@example.com'), 'members list wrong: ' + t.slice(0, 200));
    await shot(Adm, '3-admin');
  });
  await check('admin marks the machine broken: everyone sees it and booking stops', async () => {
    await Adm.page.click('[data-act=machine]');
    await eventually(async () => (await A.page.textContent('#notice')).includes('out of order'), 'Dana never saw the notice');
    assert(await A.page.$eval('#book-btn', b => b.disabled), 'book button still enabled');
    assert((await rawBook(A, at(D3, 9))) === 'permission-denied', 'rules allowed booking while broken');
    await shot(A, '4-out-of-order');
    await Adm.page.click('[data-act=machine]');
    await eventually(async () => !(await A.page.textContent('#notice')).includes('out of order'), 'notice did not clear');
  });
  await check("admin cancels Dana's turn the day after tomorrow", async () => {
    await showDay(Adm, w9);
    await Adm.page.click(`[data-act=admin-cancel][data-id="${w9}"]`);
    assert(/Turn cancelled/.test(await toastAfter(Adm.page, () => Adm.page.click(`[data-act=admin-cancel-yes][data-id="${w9}"]`))), 'not cancelled');
    const s = await bookingState(w9);
    assert(!s.b && s.ticks.every(t => !t) && !(await getDoc(`daily/${A.uid}_${dayKey(w9)}`)), 'left behind');
    await eventually(async () => !(await A.page.textContent('#mine')).includes(new Date(w9).toTimeString().slice(0, 5) + '–'), "still in Dana's list");
  });

  console.log('\nEmail reminders (function run against the same database)');
  const a8 = at(D3, 8);
  await check('reminders are on after sign-up (ticked by default), and the button turns them off and on', async () => {
    assert((await getDoc('prefs/' + A.uid)).email === true, 'not on after sign-up');
    await A.page.waitForSelector('[data-act=remind]', { timeout: 8000 });
    assert(/reminders off/i.test(await toastAfter(A.page, () => A.page.click('[data-act=remind]'))), 'did not turn off');
    assert((await getDoc('prefs/' + A.uid)).email === false, 'off not saved');
    await A.page.waitForSelector('[data-act=remind]:not([disabled])');
    assert(/reminders on/i.test(await toastAfter(A.page, () => A.page.click('[data-act=remind]'))), 'did not turn on');
    assert((await getDoc('prefs/' + A.uid)).email === true, 'on not saved');
  });
  await check('the 15:00 owner turns reminders off; Dana books in 3 days at 08:00', async () => {
    const o = (await getDoc('bookings/' + l15)).uid === W.uid ? W : L;
    assert(/reminders off/i.test(await toastAfter(o.page, () => o.page.click('[data-act=remind]'))), 'did not turn off');
    assert(/Booked/.test(await book(A, a8)), 'not booked');
  });
  await check('function sends one "starts soon" and one "take clothes out" email, no duplicates', async () => {
    const sent = [];
    const { processReminders } = require(path.join(ROOT, 'functions', 'send.js'));
    const runAt = now => processReminders({ db, now, timeZone: 'Asia/Jerusalem', appUrl: 'https://example.org/', send: async m => { sent.push(m); } });
    await runAt(a8 - 10 * MIN); await runAt(a8 - 5 * MIN);
    assert(sent.length === 1, `expected 1 start email, got ${sent.length}`);
    assert(sent[0].to === 'dana@example.com' && /08:00/.test(sent[0].subject), `wrong email: ${sent[0].to} / ${sent[0].subject}`);
    await runAt(a8 + 40 * MIN); await runAt(a8 + 45 * MIN);
    assert(sent.length === 2 && /08:45/.test(sent[1].subject), `pickup email: ${sent.map(m => m.subject).join(' | ')}`);
    await runAt(at(D1, 15) - 10 * MIN);
    assert(sent.length === 2, 'emailed someone who has reminders off');
    console.log('         emails: ' + sent.map(m => `"${m.subject}"`).join(', '));
  });

  console.log('\nAdmin removes a member');
  await check('admin removes the race winner: details and future turns go, they see the sign-up form again', async () => {
    await Adm.page.click(`[data-act=rm][data-uid="${W.uid}"]`);
    assert(/removed/.test(await toastAfter(Adm.page, () => Adm.page.click(`[data-act=rm-yes][data-uid="${W.uid}"]`))), 'not removed');
    assert(!(await getDoc('members/' + W.uid)), 'member doc still there');
    const left = (await db.collection('bookings').where('uid', '==', W.uid).get()).docs.filter(d => d.data().startMs > Date.now());
    assert(left.length === 0, 'future bookings left: ' + left.length);
    await W.page.waitForSelector('#reg-form', { timeout: 8000 });
  });

  console.log('\nHebrew view');
  await check('a Hebrew-language user sees everyone else live, right-to-left', async () => {
    const H = await openUser('Hebrew', { locale: 'he-IL' });
    await showDay(H, a10);
    await eventually(async () => { const t = await H.page.textContent('#daylist'); return t.includes('Dana') && t.includes(L.name); }, 'bookings not shown');
    assert((await H.page.getAttribute('html', 'dir')) === 'rtl', 'not RTL');
    await shot(H, '5-hebrew-guest');
  });

  await check('no JavaScript errors in any browser', async () => { assert(pageErrors.length === 0, pageErrors.join(' | ')); });

  await browser.close(); server.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed` + (failed.length ? `, ${failed.length} failed` : ''));
  process.exit(failed.length ? 1 : 0);
}

main().catch(async e => { console.error(e); try { await browser.close(); } catch (_) {} process.exit(1); });
