'use strict';
/**
 * Couche de persistance pour Empire des Spatiates.
 *
 * Deux moteurs, une seule API :
 *
 *  1. SQLite (node:sqlite, Node >= 22.5) — moteur par defaut.
 *     La protection anti-double-reservation est un INDEX UNIQUE PARTIEL :
 *     deux reservations actives ne peuvent PAS partager (date, time).
 *     Ce n'est pas une verification applicative, c'est une contrainte que
 *     le moteur de base refuse de violer, meme sous ecriture concurrente.
 *
 *  2. JSON + verrou de fichier atomique (Node 18/20, ou STORE=json).
 *     La section critique lecture->verification->ecriture est protegee par
 *     un verrou cree avec fs.mkdirSync, operation atomique du systeme de
 *     fichiers, donc sure entre plusieurs processus sur le meme disque.
 *
 * Dans les deux cas, la collision remonte sous la forme d'une erreur
 * portant le code 'slot_taken', jamais sous la forme d'un doublon.
 */

const fs = require('fs');
const path = require('path');

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

const LEAD_FIELDS = [
  'id', 'createdAt', 'status', 'notes', 'name', 'age', 'email', 'phone', 'countryCode', 'countryName', 'dialCode', 'language',
  'score', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'
];

/* ------------------------------------------------------------------ */
/* Score — MIROIR EXACT de la logique deja presente dans index.html.   */
/* Ne pas modifier : toute evolution doit etre faite des deux cotes.   */
/* ------------------------------------------------------------------ */
function computeScore(lead) {
  let score = 0;
  if (lead.q1 !== 'beginner') score++;
  if (lead.q3 === 'strategy' || lead.q3 === 'risk') score++;
  if (lead.q5 === '8–15 èdtan' || lead.q5 === '15+ èdtan') score++;
  return score;
}

/** Reessaie une operation bloquee par un verrou SQLite transitoire. */
function retry(fn, attempts, delayMs) {
  for (let i = 0; ; i++) {
    try { return fn(); }
    catch (e) {
      const transient = /locked|busy/i.test(String(e && e.message));
      if (!transient || i >= attempts) throw e;
      const sab = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sab), 0, 0, delayMs);
    }
  }
}

/* ================================================================== */
/* Moteur SQLite                                                       */
/* ================================================================== */
function sqliteStore() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(DATA, 'empire.db'));

  // busy_timeout EN PREMIER : sans lui, plusieurs processus qui demarrent
  // ensemble echouent sur "database is locked" des le PRAGMA suivant.
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA foreign_keys = ON');

  // journal_mode = WAL exige un verrou exclusif bref. Avec N processus qui
  // demarrent simultanement, il faut reessayer.
  retry(() => db.exec('PRAGMA journal_mode = WAL'), 40, 50);

  retry(() => db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id        TEXT PRIMARY KEY,
      createdAt TEXT NOT NULL,
      status    TEXT NOT NULL DEFAULT 'new',
      notes     TEXT NOT NULL DEFAULT '',
      name      TEXT NOT NULL,
      age       TEXT NOT NULL DEFAULT '',
      email     TEXT NOT NULL,
      phone     TEXT NOT NULL,
      countryCode TEXT NOT NULL DEFAULT '',
      countryName TEXT NOT NULL DEFAULT '',
      dialCode TEXT NOT NULL DEFAULT '',
      language  TEXT NOT NULL DEFAULT '',
      score     INTEGER NOT NULL DEFAULT 0,
      q1 TEXT, q2 TEXT, q3 TEXT, q4 TEXT,
      q5 TEXT, q6 TEXT, q7 TEXT, q8 TEXT
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id        TEXT PRIMARY KEY,
      leadId    TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      date      TEXT NOT NULL,
      time      TEXT NOT NULL,
      status    TEXT NOT NULL DEFAULT 'pending',
      createdAt TEXT NOT NULL,
      updatedAt TEXT
    );

    CREATE INDEX IF NOT EXISTS bookings_lead ON bookings(leadId);
    CREATE INDEX IF NOT EXISTS bookings_date ON bookings(date);
  `), 40, 50);

  // Migration: conserver les anciennes candidatures et ajouter les informations de pays.
  const leadCols = db.prepare('PRAGMA table_info(leads)').all().map(c => c.name);
  const addLeadCol = (name, definition) => { if (!leadCols.includes(name)) retry(() => db.exec(`ALTER TABLE leads ADD COLUMN ${definition}`), 40, 50); };
  addLeadCol('age', "age TEXT NOT NULL DEFAULT ''");
  addLeadCol('countryCode', "countryCode TEXT NOT NULL DEFAULT ''");
  addLeadCol('countryName', "countryName TEXT NOT NULL DEFAULT ''");
  addLeadCol('dialCode', "dialCode TEXT NOT NULL DEFAULT ''");

  // ---- LA contrainte qui rend le double booking impossible -----------
  retry(() => db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS bookings_creneau_unique
      ON bookings(date, time)
      WHERE status <> 'cancelled';
  `), 40, 50);

  // Garde-fou : si l'index n'existe pas, la garantie anti-double-reservation
  // n'existe pas non plus. Mieux vaut refuser de demarrer.
  const idx = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND name='bookings_creneau_unique'`
  ).get();
  if (!idx) throw new Error('index unique bookings_creneau_unique absent');

  const isUnique = (e) =>
    /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(String(e && e.message));

  const taken = (e) => Object.assign(new Error('slot_taken'), { code: 'slot_taken', cause: e });

  return {
    engine: 'sqlite',

    createLead(lead) {
      const cols = LEAD_FIELDS.join(',');
      const ph = LEAD_FIELDS.map(() => '?').join(',');
      db.prepare(`INSERT INTO leads (${cols}) VALUES (${ph})`)
        .run(...LEAD_FIELDS.map((k) => lead[k] ?? (k === 'score' ? 0 : '')));
      return lead;
    },

    listLeads() {
      return db.prepare('SELECT * FROM leads ORDER BY createdAt DESC').all();
    },

    getLead(id) {
      return db.prepare('SELECT * FROM leads WHERE id = ?').get(id) || null;
    },

    updateLead(id, patch) {
      const lead = this.getLead(id);
      if (!lead) return null;
      if (patch.status !== undefined) {
        db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(patch.status, id);
      }
      if (patch.notes !== undefined) {
        db.prepare('UPDATE leads SET notes = ? WHERE id = ?').run(patch.notes, id);
      }
      return this.getLead(id);
    },

    listBookings() {
      return db.prepare('SELECT * FROM bookings ORDER BY date ASC, createdAt ASC').all();
    },

    getBooking(id) {
      return db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) || null;
    },

    activeBookingForLead(leadId) {
      return db.prepare(
        `SELECT * FROM bookings WHERE leadId = ? AND status <> 'cancelled' LIMIT 1`
      ).get(leadId) || null;
    },

    takenTimes(date) {
      return db.prepare(
        `SELECT time FROM bookings WHERE date = ? AND status <> 'cancelled'`
      ).all(date).map((r) => r.time);
    },

    createBooking(b) {
      try {
        db.prepare(
          `INSERT INTO bookings (id, leadId, date, time, status, createdAt)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(b.id, b.leadId, b.date, b.time, b.status || 'pending', b.createdAt);
      } catch (e) {
        if (isUnique(e)) throw taken(e);
        throw e;
      }
      return this.getBooking(b.id);
    },

    rescheduleBooking(id, date, time) {
      const cur = this.getBooking(id);
      if (!cur) return null;
      try {
        db.prepare(
          `UPDATE bookings SET date = ?, time = ?, updatedAt = ? WHERE id = ?`
        ).run(date, time, new Date().toISOString(), id);
      } catch (e) {
        if (isUnique(e)) throw taken(e);
        throw e;
      }
      return this.getBooking(id);
    },

    setBookingStatus(id, status) {
      const cur = this.getBooking(id);
      if (!cur) return null;
      try {
        db.prepare('UPDATE bookings SET status = ?, updatedAt = ? WHERE id = ?')
          .run(status, new Date().toISOString(), id);
      } catch (e) {
        // Reactiver un rendez-vous annule vers un creneau entre-temps repris.
        if (isUnique(e)) throw taken(e);
        throw e;
      }
      return this.getBooking(id);
    }
  };
}

/* ================================================================== */
/* Moteur JSON + verrou atomique                                       */
/* ================================================================== */
function jsonStore() {
  const leadsFile = path.join(DATA, 'leads.json');
  const bookingsFile = path.join(DATA, 'bookings.json');
  const lockDir = path.join(DATA, '.lock');
  for (const f of [leadsFile, bookingsFile]) {
    if (!fs.existsSync(f)) fs.writeFileSync(f, '[]');
  }

  const sleep = (ms) => {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  };

  /** Section critique serialisee entre processus (mkdir est atomique). */
  function withLock(fn) {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        fs.mkdirSync(lockDir);
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // Verrou orphelin laisse par un processus tue.
        try {
          if (Date.now() - fs.statSync(lockDir).mtimeMs > 10000) fs.rmdirSync(lockDir);
        } catch { /* course benigne, on retente */ }
        if (Date.now() > deadline) throw Object.assign(new Error('busy'), { code: 'busy' });
        sleep(15);
      }
    }
    try {
      return fn();
    } finally {
      try { fs.rmdirSync(lockDir); } catch { /* deja libere */ }
    }
  }

  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; } };

  /** Ecriture atomique : on ecrit a cote puis on renomme. */
  const write = (f, d) => {
    const tmp = f + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
    fs.renameSync(tmp, f);
  };

  const taken = () => Object.assign(new Error('slot_taken'), { code: 'slot_taken' });
  const clash = (list, date, time, exceptId) =>
    list.some((b) => b.date === date && b.time === time && b.status !== 'cancelled' && b.id !== exceptId);

  return {
    engine: 'json',

    createLead(lead) {
      return withLock(() => {
        const leads = read(leadsFile);
        leads.unshift(lead);
        write(leadsFile, leads);
        return lead;
      });
    },

    listLeads() {
      return read(leadsFile).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },

    getLead(id) {
      return read(leadsFile).find((l) => l.id === id) || null;
    },

    updateLead(id, patch) {
      return withLock(() => {
        const leads = read(leadsFile);
        const l = leads.find((v) => v.id === id);
        if (!l) return null;
        if (patch.status !== undefined) l.status = patch.status;
        if (patch.notes !== undefined) l.notes = patch.notes;
        write(leadsFile, leads);
        return l;
      });
    },

    listBookings() {
      return read(bookingsFile).slice()
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    },

    getBooking(id) {
      return read(bookingsFile).find((b) => b.id === id) || null;
    },

    activeBookingForLead(leadId) {
      return read(bookingsFile).find((b) => b.leadId === leadId && b.status !== 'cancelled') || null;
    },

    takenTimes(date) {
      return read(bookingsFile)
        .filter((b) => b.date === date && b.status !== 'cancelled')
        .map((b) => b.time);
    },

    createBooking(b) {
      return withLock(() => {
        const bookings = read(bookingsFile);
        if (clash(bookings, b.date, b.time, null)) throw taken();
        const row = { ...b, status: b.status || 'pending', updatedAt: null };
        bookings.unshift(row);
        write(bookingsFile, bookings);
        return row;
      });
    },

    rescheduleBooking(id, date, time) {
      return withLock(() => {
        const bookings = read(bookingsFile);
        const b = bookings.find((v) => v.id === id);
        if (!b) return null;
        if (clash(bookings, date, time, id)) throw taken();
        b.date = date; b.time = time; b.updatedAt = new Date().toISOString();
        write(bookingsFile, bookings);
        return b;
      });
    },

    setBookingStatus(id, status) {
      return withLock(() => {
        const bookings = read(bookingsFile);
        const b = bookings.find((v) => v.id === id);
        if (!b) return null;
        if (status !== 'cancelled' && b.status === 'cancelled' && clash(bookings, b.date, b.time, id)) {
          throw taken();
        }
        b.status = status;
        b.updatedAt = new Date().toISOString();
        write(bookingsFile, bookings);
        return b;
      });
    }
  };
}

/* ================================================================== */
/* Selection du moteur + reprise des donnees existantes                */
/* ================================================================== */
function createStore() {
  const forced = (process.env.STORE || '').toLowerCase();

  if (forced === 'json') {
    // Refuser de repartir sur JSON si une base SQLite contient deja des donnees :
    // les deux moteurs ne se voient pas, et on perdrait les rendez-vous existants.
    if (fs.existsSync(path.join(DATA, 'empire.db'))) {
      throw new Error(
        'STORE=json demande, mais data/empire.db existe deja. ' +
        'Deplacez ou supprimez ce fichier si vous voulez vraiment revenir au stockage JSON.'
      );
    }
    console.log('[store] Moteur JSON avec verrou de fichier.');
    return jsonStore();
  }

  // node:sqlite absent => Node < 22.5 : repli legitime et attendu.
  let sqliteAvailable = true;
  try { require('node:sqlite'); }
  catch { sqliteAvailable = false; }

  if (!sqliteAvailable) {
    if (forced === 'sqlite') {
      throw new Error('STORE=sqlite demande, mais node:sqlite est indisponible (Node >= 22.5 requis).');
    }
    console.log('[store] node:sqlite indisponible (Node < 22.5) — moteur JSON avec verrou de fichier.');
    return jsonStore();
  }

  /*
   * A partir d'ici SQLite EST disponible : toute erreur est un vrai probleme.
   * Surtout pas de repli silencieux vers JSON — plusieurs processus se
   * retrouveraient sur des stockages differents, ne verraient pas les
   * reservations des autres, et la garantie anti-double-reservation sauterait.
   */
  const s = sqliteStore();
  migrateJsonIntoSqlite(s);
  return s;
}

/** Reprend une seule fois les leads/bookings deja presents dans les .json. */
function migrateJsonIntoSqlite(store) {
  const flag = path.join(DATA, '.migrated');
  if (fs.existsSync(flag)) return;

  const readFile = (f) => {
    try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return []; }
  };
  const leads = readFile('leads.json');
  const bookings = readFile('bookings.json');
  let nl = 0, nb = 0;

  for (const l of leads) {
    if (!l || !l.id || store.getLead(l.id)) continue;
    try {
      store.createLead({ ...l, score: l.score ?? computeScore(l), notes: l.notes ?? '', status: l.status ?? 'new' });
      nl++;
    } catch (e) { console.warn('[store] lead ignore', l.id, e.message); }
  }
  for (const b of bookings) {
    if (!b || !b.id || store.getBooking(b.id)) continue;
    try { store.createBooking(b); nb++; }
    catch (e) { console.warn('[store] rendez-vous ignore (creneau en conflit)', b.id); }
  }

  fs.writeFileSync(flag, new Date().toISOString());
  if (nl || nb) console.log(`[store] Reprise JSON -> SQLite : ${nl} candidat(s), ${nb} rendez-vous.`);
}

module.exports = { createStore, computeScore, LEAD_FIELDS };
