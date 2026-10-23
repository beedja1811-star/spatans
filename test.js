'use strict';
/**
 * Tests de bout en bout.
 * Lancer les tests en local uniquement : demarrer le serveur avec ADMIN_PASS=test1234 et RATE_LIMIT=off, puis lancer ADMIN_PASS=test1234 node test.js.
 * RATE_LIMIT=off doit rester reserve aux tests locaux et ne jamais etre defini sur Railway.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const PASS = process.env.ADMIN_PASS || 'test1234';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  \x1b[32mOK\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mKO\x1b[0m  ' + name + (detail ? '  -> ' + detail : '')); }
}

const post = (p, b, h) => fetch(BASE + p, {
  method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h || {}),
  body: JSON.stringify(b)
});
const get = (p, h) => fetch(BASE + p, { headers: h || {} });

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function makeLead(name) {
  const r = await post('/api/lead', {
    name, email: name.toLowerCase().replace(/\s/g, '') + '@test.ht', phone: '509' + Math.floor(10000000 + Math.random() * 89999999),
    language: 'Français', q1: 'intermediate', q2: 'Forex', q3: 'strategy',
    q4: 'learn', q5: '8–15 èdtan', q6: '$100–$300', q7: 'no', q8: 'Fòmasyon + coaching'
  });
  return r.json();
}

(async () => {
  console.log('\n=== 1. Candidature et score ===');
  const lead = await makeLead('Candidat Alpha');
  check('lead cree', !!lead.id, JSON.stringify(lead));
  check('score calcule cote serveur = 3', lead.score === 3, 'recu ' + lead.score);

  const bad = await (await post('/api/lead', { name: '', email: '', phone: '' })).json();
  check('champs obligatoires refuses', bad.code === 'missing_fields', JSON.stringify(bad));

  console.log('\n=== 2. Fenetre de reservation ===');
  const far = await (await get('/api/slots?date=' + addDays(40))).json();
  check('au-dela de 14 jours refuse', far.code === 'invalid_range');
  const past = await (await get('/api/slots?date=' + addDays(-3))).json();
  check('date passee refusee', past.code === 'invalid_range');
  const ok = await (await get('/api/slots?date=' + addDays(3))).json();
  check('17 creneaux de 30 minutes entre 10h et 18h', ok.times.length === 17, 'recu ' + ok.times.length);

  console.log('\n=== 3. COURSE : 25 reservations simultanees sur le MEME creneau ===');
  const date = addDays(5), time = '2:00 PM';
  const leads = await Promise.all(
    Array.from({ length: 25 }, (_, i) => makeLead('Concurrent ' + i))
  );
  const results = await Promise.all(
    leads.map(l => post('/api/booking', { date, time, leadId: l.id })
      .then(r => r.json().then(j => ({ status: r.status, j }))))
  );
  const won = results.filter(r => r.status === 201);
  const lost = results.filter(r => r.status === 409 && r.j.code === 'slot_taken');
  check('exactement 1 gagnant', won.length === 1, won.length + ' gagnant(s)');
  check('24 refus avec code slot_taken', lost.length === 24, lost.length + ' refus');

  const after = await (await get('/api/slots?date=' + date)).json();
  const slot = after.times.find(t => t.time === time);
  check('le creneau est marque pris', slot && slot.taken === true && slot.available === false);

  console.log('\n=== 4. Regles candidat ===');
  // Le seul candidat qui a un rendez-vous actif est le gagnant de la course.
  const winnerId = won[0].j.booking.leadId;
  const dbl = await (await post('/api/booking', { date, time: '3:00 PM', leadId: winnerId })).json();
  check('un candidat ne peut pas reserver deux fois', dbl.code === 'already_booked', JSON.stringify(dbl));

  const ghost = await (await post('/api/booking', { date, time: '4:00 PM', leadId: 'inexistant' })).json();
  check('leadId inconnu refuse', ghost.code === 'lead_not_found');

  const badTime = await (await post('/api/booking', { date, time: '9:00 PM', leadId: (await makeLead('Hors Horaire')).id })).json();
  check('creneau hors 10h-18h refuse', badTime.code === 'invalid_time');

  console.log('\n=== 5. Administration ===');
  const noAuth = await get('/api/admin/data');
  check('acces admin sans token refuse', noAuth.status === 401);

  const badLogin = await (await post('/api/admin/login', { username: 'admin', password: 'faux' })).json();
  check('mauvais mot de passe refuse', badLogin.code === 'unauthorized');

  const li = await (await post('/api/admin/login', { username: 'admin', password: PASS })).json();
  check('connexion admin reussie', !!li.token, JSON.stringify(li));
  const H = { Authorization: 'Bearer ' + li.token };

  const d = await (await get('/api/admin/data', H)).json();
  check('candidats visibles', d.leads.length >= 26, d.leads.length + ' candidats');
  check('reponses du questionnaire presentes', d.leads[0].q1 !== undefined);
  check('score present', typeof d.leads[0].score === 'number');
  check('calendrier de 15 jours', d.calendar.length === 15, d.calendar.length + ' jours');

  const winner = won[0].j.booking;
  const detail = await (await get('/api/admin/lead?id=' + winner.leadId, H)).json();
  check('fiche candidat accessible', detail.lead && detail.bookings.length === 1);

  // Deplacer vers un creneau libre
  const mv = await (await post('/api/admin/booking-reschedule', { id: winner.id, date, time: '5:00 PM' }, H)).json();
  check('rendez-vous deplace', mv.ok && mv.booking.time === '5:00 PM', JSON.stringify(mv));

  // L ancien creneau redevient libre
  const s2 = await (await get('/api/slots?date=' + date)).json();
  check('ancien creneau libere', s2.times.find(t => t.time === time).available === true);

  // Occuper 5:00 PM est desormais impossible pour un autre
  const other = await makeLead('Second Candidat');
  const clash = await (await post('/api/booking', { date, time: '5:00 PM', leadId: other.id })).json();
  check('nouveau creneau protege apres deplacement', clash.code === 'slot_taken', JSON.stringify(clash));

  // Annulation
  const cx = await (await post('/api/admin/booking-status', { id: winner.id, status: 'cancelled' }, H)).json();
  check('rendez-vous annule', cx.ok && cx.booking.status === 'cancelled');
  const s3 = await (await get('/api/slots?date=' + date)).json();
  check('creneau libere apres annulation', s3.times.find(t => t.time === '5:00 PM').available === true);

  // Reservable a nouveau
  const re = await (await post('/api/booking', { date, time: '5:00 PM', leadId: other.id })).json();
  check('creneau libere est reservable', !!re.ok, JSON.stringify(re));

  const csv = await get('/api/admin/export.csv', H);
  check('export CSV candidats', csv.status === 200 && (await csv.text()).includes('score'));
  const csv2 = await get('/api/admin/export-bookings.csv', H);
  check('export CSV rendez-vous', csv2.status === 200);

  await post('/api/admin/logout', {}, H);
  const afterLogout = await get('/api/admin/data', H);
  check('token invalide apres deconnexion', afterLogout.status === 401);

  console.log('\n──────────────────────────────');
  console.log(`  ${pass} reussis, ${fail} echoues`);
  console.log('──────────────────────────────\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nErreur de test:', e); process.exit(1); });
