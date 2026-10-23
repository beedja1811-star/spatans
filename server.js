'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStore, computeScore, LEAD_FIELDS } = require('./store');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const store = createStore();

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'ChangeMe123!';
const TZ = process.env.TZ_NAME || 'America/Port-au-Prince';
const BOOKING_WINDOW_DAYS = 14;
const LANGUAGES = ['Kreyòl', 'Français', 'English'];
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost'];
const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled'];

// Creneaux 10:00 -> 18:00 (identiques a la version actuelle du site).
const BOOKING_TIMES = [
  '10:00 AM','10:30 AM','11:00 AM','11:30 AM','12:00 PM','12:30 PM',
  '1:00 PM','1:30 PM','2:00 PM','2:30 PM','3:00 PM','3:30 PM',
  '4:00 PM','4:30 PM','5:00 PM','5:30 PM','6:00 PM'
];

if (ADMIN_PASS === 'ChangeMe123!') {
  if (process.env.NODE_ENV === 'production') {
    console.error('\n[FATAL] ADMIN_PASS est encore le mot de passe par defaut.');
    console.error('        Definissez ADMIN_PASS avant de demarrer en production.\n');
    process.exit(1);
  }
  console.warn('\n[ATTENTION] Mot de passe admin par defaut. Definissez ADMIN_PASS avant la mise en ligne.\n');
}

/* ------------------------------------------------------------------ */
/* Dates et heures, dans le fuseau reel du coach                       */
/* ------------------------------------------------------------------ */
function todayLocal() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()); // YYYY-MM-DD
}

function nowMinutesLocal() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** '1:00 PM' -> 780 */
function timeToMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3] === 'PM') h += 12;
  return h * 60 + Number(m[2]);
}

function isValidDate(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));
}

/** Un creneau deja passe aujourd'hui n'est plus reservable. */
function isPast(date, time) {
  return date === todayLocal() && timeToMinutes(time) <= nowMinutesLocal();
}

function bookingWindow() {
  const today = todayLocal();
  return { today, max: addDays(today, BOOKING_WINDOW_DAYS) };
}

/* ------------------------------------------------------------------ */
/* Utilitaires HTTP                                                    */
/* ------------------------------------------------------------------ */
function json(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(obj));
}

const FALLBACK_MESSAGES = {
  missing_fields: 'Champs obligatoires manquants.',
  invalid_range: 'Date hors de la periode de reservation.',
  invalid_time: 'Creneau horaire invalide.',
  past_time: 'Ce creneau est deja passe.',
  slot_taken: 'Ce creneau vient d etre reserve.',
  already_booked: 'Un rendez-vous existe deja pour cette candidature.',
  lead_not_found: 'Candidature introuvable.',
  booking_not_found: 'Rendez-vous introuvable.',
  unauthorized: 'Non autorise.',
  rate_limited: 'Trop de tentatives. Reessayez dans une minute.',
  busy: 'Serveur occupe, reessayez.',
  server_error: 'Erreur serveur.'
};

/** Le client traduit a partir de `code`; `error` reste un repli lisible. */
function fail(res, status, code, extra) {
  return json(res, status, { code, error: FALLBACK_MESSAGES[code] || code, ...extra });
}

function body(req, limit = 100000) {
  return new Promise((resolve, reject) => {
    let d = '', size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('payload_too_large')); return; }
      d += c;
    });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function safeText(v, max = 500) { return String(v ?? '').trim().slice(0, max); }

/**
 * X-Forwarded-For n'est croyable que derriere un proxy de confiance.
 * Sans TRUST_PROXY=1, n'importe qui pourrait falsifier l'en-tete pour
 * contourner la limitation de debit.
 */
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/* ------------------------------------------------------------------ */
/* Limitation de debit (fenetre glissante en memoire)                  */
/* ------------------------------------------------------------------ */
const buckets = new Map();
const RATE_LIMIT_OFF = process.env.RATE_LIMIT === 'off'; // tests de charge uniquement
function rateLimit(key, max, windowMs) {
  if (RATE_LIMIT_OFF) return true;
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) { buckets.set(key, hits); return false; }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) {
    const keep = v.filter((t) => now - t < 3600000);
    if (keep.length) buckets.set(k, keep); else buckets.delete(k);
  }
}, 600000).unref();

/* ------------------------------------------------------------------ */
/* Sessions admin                                                      */
/* ------------------------------------------------------------------ */
const SESSION_TTL = 8 * 60 * 60 * 1000;
const sessions = new Map();

function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
  return crypto.timingSafeEqual(ba, bb);
}

function auth(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return false;
  const token = h.slice(7);
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(token); return false; }  // expiration reellement appliquee
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (now > exp) sessions.delete(t);
}, 600000).unref();

/* ------------------------------------------------------------------ */
/* Fichiers statiques                                                  */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon'
};

function serve(res, file, type) {
  fs.readFile(file, (e, d) => {
    if (e) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
    res.end(d);
  });
}

/* ------------------------------------------------------------------ */
/* Vue des creneaux d'une journee                                      */
/* ------------------------------------------------------------------ */
function slotsForDate(date) {
  const taken = new Set(store.takenTimes(date));
  return BOOKING_TIMES.map((time) => ({
    time,
    available: !taken.has(time) && !isPast(date, time),
    taken: taken.has(time),
    past: isPast(date, time)
  }));
}

/* ================================================================== */
/* Routage                                                            */
/* ================================================================== */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = clientIp(req);

  try {
    /* ---------------- Candidature ---------------------------------- */
    if (req.method === 'POST' && url.pathname === '/api/lead') {
      if (!rateLimit('lead:' + ip, 10, 60000)) return fail(res, 429, 'rate_limited');
      const x = await body(req);

      const lead = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        status: 'new',
        notes: '',
        name: safeText(x.name, 120),
        age: safeText(x.age, 20),
        email: safeText(x.email, 180),
        phone: safeText(x.phone, 80),
        countryCode: safeText(x.countryCode, 8),
        countryName: safeText(x.countryName, 100),
        dialCode: safeText(x.dialCode, 12),
        language: LANGUAGES.includes(x.language) ? x.language : '',
        q1: safeText(x.q1), q2: safeText(x.q2), q3: safeText(x.q3), q4: safeText(x.q4),
        q5: safeText(x.q5), q6: safeText(x.q6), q7: safeText(x.q7), q8: safeText(x.q8)
      };
      const validAgeRanges = ['18-25 ans', '25-30 ans', '30-45 ans', '45 ans+'];
      const legacyNumericAge = /^\d{2,3}$/.test(lead.age) && Number(lead.age) >= 18 && Number(lead.age) <= 100;
      if (!lead.name || !lead.email || !lead.phone || !(validAgeRanges.includes(lead.age) || legacyNumericAge)) return fail(res, 400, 'missing_fields');

      // Score recalcule cote serveur avec exactement la meme regle que le front.
      lead.score = computeScore(lead);

      store.createLead(lead);
      return json(res, 201, { ok: true, id: lead.id, score: lead.score });
    }

    /* ---------------- Creneaux disponibles ------------------------- */
    if (req.method === 'GET' && url.pathname === '/api/slots') {
      const date = safeText(url.searchParams.get('date'), 20);
      const w = bookingWindow();
      if (!isValidDate(date) || date < w.today || date > w.max) {
        return json(res, 200, { date, times: [], code: 'invalid_range', window: w });
      }
      return json(res, 200, { date, times: slotsForDate(date), window: w });
    }

    /* ---------------- Reservation ---------------------------------- */
    if (req.method === 'POST' && url.pathname === '/api/booking') {
      if (!rateLimit('book:' + ip, 15, 60000)) return fail(res, 429, 'rate_limited');
      const x = await body(req);
      const date = safeText(x.date, 20);
      const time = safeText(x.time, 30);
      const leadId = safeText(x.leadId, 80);
      const w = bookingWindow();

      if (!date || !time || !leadId) return fail(res, 400, 'missing_fields');
      if (!isValidDate(date) || date < w.today || date > w.max) return fail(res, 400, 'invalid_range');
      if (!BOOKING_TIMES.includes(time)) return fail(res, 400, 'invalid_time');
      if (isPast(date, time)) return fail(res, 409, 'past_time');
      if (!store.getLead(leadId)) return fail(res, 404, 'lead_not_found');

      const existing = store.activeBookingForLead(leadId);
      if (existing) return fail(res, 409, 'already_booked', { booking: existing });

      // Derniere verification applicative, puis la base tranche definitivement.
      if (store.takenTimes(date).includes(time)) return fail(res, 409, 'slot_taken');

      let booking;
      try {
        booking = store.createBooking({
          id: crypto.randomUUID(), leadId, date, time,
          status: 'pending', createdAt: new Date().toISOString()
        });
      } catch (e) {
        if (e.code === 'slot_taken') return fail(res, 409, 'slot_taken');
        if (e.code === 'busy') return fail(res, 503, 'busy');
        throw e;
      }

      const lead = store.getLead(leadId);
      return json(res, 201, { ok: true, booking, name: lead ? lead.name : '' });
    }

    /* ---------------- Connexion admin ------------------------------ */
    if (req.method === 'POST' && url.pathname === '/api/admin/login') {
      if (!rateLimit('login:' + ip, 8, 300000)) return fail(res, 429, 'rate_limited');
      const x = await body(req);
      const okUser = constantTimeEqual(safeText(x.username, 120), ADMIN_USER);
      const okPass = constantTimeEqual(safeText(x.password, 200), ADMIN_PASS);
      if (!okUser || !okPass) return fail(res, 401, 'unauthorized');
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + SESSION_TTL);
      return json(res, 200, { token, expiresIn: SESSION_TTL });
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
      const h = req.headers.authorization || '';
      if (h.startsWith('Bearer ')) sessions.delete(h.slice(7));
      return json(res, 200, { ok: true });
    }

    /* ---------------- Zone protegee -------------------------------- */
    if (url.pathname.startsWith('/api/admin/') && !auth(req)) {
      return fail(res, 401, 'unauthorized');
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/data') {
      const w = bookingWindow();
      const calendar = [];
      for (let i = 0; i <= BOOKING_WINDOW_DAYS; i++) {
        const d = addDays(w.today, i);
        calendar.push({ date: d, slots: slotsForDate(d) });
      }
      return json(res, 200, {
        leads: store.listLeads(),
        bookings: store.listBookings(),
        calendar,
        times: BOOKING_TIMES,
        window: { today: w.today, max: w.max, days: BOOKING_WINDOW_DAYS },
        timezone: TZ,
        engine: store.engine
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/lead') {
      const lead = store.getLead(safeText(url.searchParams.get('id'), 80));
      if (!lead) return fail(res, 404, 'lead_not_found');
      return json(res, 200, {
        lead,
        bookings: store.listBookings().filter((b) => b.leadId === lead.id)
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/export.csv') {
      const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const rows = [LEAD_FIELDS, ...store.listLeads().map((l) => LEAD_FIELDS.map((k) => l[k]))]
        .map((r) => r.map(esc).join(','));
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="prospects.csv"'
      });
      return res.end('\ufeff' + rows.join('\r\n'));
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/export-bookings.csv') {
      const leads = new Map(store.listLeads().map((l) => [l.id, l]));
      const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const header = ['date', 'time', 'status', 'name', 'age', 'email', 'phone', 'language', 'score', 'createdAt'];
      const rows = [header, ...store.listBookings().map((b) => {
        const l = leads.get(b.leadId) || {};
        return [b.date, b.time, b.status, l.name, l.age, l.email, l.phone, l.language, l.score, b.createdAt];
      })].map((r) => r.map(esc).join(','));
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="rendez-vous.csv"'
      });
      return res.end('\ufeff' + rows.join('\r\n'));
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/lead-status') {
      const x = await body(req);
      const patch = {};
      if (LEAD_STATUSES.includes(x.status)) patch.status = x.status;
      if (x.notes !== undefined) patch.notes = safeText(x.notes, 2000);
      const lead = store.updateLead(safeText(x.id, 80), patch);
      if (!lead) return fail(res, 404, 'lead_not_found');
      return json(res, 200, { ok: true, lead });
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/booking-status') {
      const x = await body(req);
      if (!BOOKING_STATUSES.includes(x.status)) return fail(res, 400, 'missing_fields');
      let booking;
      try {
        booking = store.setBookingStatus(safeText(x.id, 80), x.status);
      } catch (e) {
        if (e.code === 'slot_taken') return fail(res, 409, 'slot_taken');
        throw e;
      }
      if (!booking) return fail(res, 404, 'booking_not_found');
      return json(res, 200, { ok: true, booking });
    }

    /* Deplacer un rendez-vous : meme contrainte d'unicite que cote candidat. */
    if (req.method === 'POST' && url.pathname === '/api/admin/booking-reschedule') {
      const x = await body(req);
      const id = safeText(x.id, 80);
      const date = safeText(x.date, 20);
      const time = safeText(x.time, 30);
      if (!id || !date || !time) return fail(res, 400, 'missing_fields');
      if (!isValidDate(date)) return fail(res, 400, 'invalid_range');
      if (!BOOKING_TIMES.includes(time)) return fail(res, 400, 'invalid_time');

      let booking;
      try {
        booking = store.rescheduleBooking(id, date, time);
      } catch (e) {
        if (e.code === 'slot_taken') return fail(res, 409, 'slot_taken');
        if (e.code === 'busy') return fail(res, 503, 'busy');
        throw e;
      }
      if (!booking) return fail(res, 404, 'booking_not_found');
      return json(res, 200, { ok: true, booking });
    }

    /* ---------------- Healthcheck ---------------------------------- */
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, { ok: true, engine: store.engine });
    }

    /* ---------------- Pages ---------------------------------------- */
    if (req.method === 'GET' && url.pathname === '/') {
      return serve(res, path.join(PUBLIC, 'index.html'), MIME['.html']);
    }
    if (req.method === 'GET' && url.pathname === '/admin') {
      return serve(res, path.join(PUBLIC, 'login.html'), MIME['.html']);
    }
    if (req.method === 'GET' && url.pathname === '/dashboard') {
      return serve(res, path.join(PUBLIC, 'dashboard.html'), MIME['.html']);
    }
    if (req.method === 'GET') {
      const f = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
      if (f.startsWith(PUBLIC + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        return serve(res, f, MIME[path.extname(f)] || 'application/octet-stream');
      }
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      json(res, 500, { code: 'server_error', error: FALLBACK_MESSAGES.server_error });
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Empire des Spatiates — http://localhost:${PORT}`);
  console.log(`Dashboard             — http://localhost:${PORT}/admin`);
  console.log(`Stockage: ${store.engine}   Fuseau: ${TZ}`);
});
