'use strict';
/**
 * Course multi-processus.
 *
 * Trois serveurs independants partagent le meme dossier data/.
 * 30 candidats tentent le MEME creneau, repartis sur les trois processus.
 * Attendu : 1 seule reservation, 29 refus 'slot_taken'.
 *
 * C'est le scenario que la version en fichier JSON sans verrou ne survit pas :
 * chaque processus lisait, voyait le creneau libre, et ecrivait par-dessus.
 */
const PORTS = [4101, 4102, 4103];

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

const post = (port, p, b) => fetch(`http://127.0.0.1:${port}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b)
});

(async () => {
  const date = addDays(7);
  const time = '11:00 AM';
  const N = 30;

  // Chaque candidat est cree via un processus different.
  const leads = [];
  for (let i = 0; i < N; i++) {
    const port = PORTS[i % PORTS.length];
    const r = await post(port, '/api/lead', {
      name: 'Cluster ' + i, email: 'cluster' + i + '@test.ht', phone: '5091000' + i,
      language: 'Kreyòl', q1: 'beginner', q2: 'Forex', q3: 'risk',
      q4: 'learn', q5: '4–7 èdtan', q6: '$100–$300', q7: 'no', q8: 'Fòmasyon sèlman'
    });
    leads.push(Object.assign(await r.json(), { port }));
  }

  // Tir simultane sur les trois processus.
  const results = await Promise.all(leads.map(l =>
    post(l.port, '/api/booking', { date, time, leadId: l.id })
      .then(r => r.json().then(j => ({ status: r.status, code: j.code, port: l.port })))
  ));

  const won  = results.filter(r => r.status === 201);
  const lost = results.filter(r => r.code === 'slot_taken');
  const odd  = results.filter(r => r.status !== 201 && r.code !== 'slot_taken');

  console.log(`\n  Processus         : ${PORTS.length}`);
  console.log(`  Tentatives        : ${N}`);
  console.log(`  Reservations      : ${won.length}`);
  console.log(`  Refus slot_taken  : ${lost.length}`);
  if (odd.length) console.log(`  Autres reponses   : ${JSON.stringify(odd)}`);

  // Verification independante : lire l etat depuis chaque processus.
  for (const port of PORTS) {
    const r = await fetch(`http://127.0.0.1:${port}/api/slots?date=${date}`);
    const x = await r.json();
    const s = x.times.find(t => t.time === time);
    console.log(`  Port ${port} voit le creneau : ${s.taken ? 'PRIS' : 'LIBRE'}`);
  }

  const ok = won.length === 1 && lost.length === N - 1;
  console.log(ok
    ? '\n  \x1b[32mRESULTAT : aucune double reservation.\x1b[0m\n'
    : '\n  \x1b[31mRESULTAT : incoherence detectee.\x1b[0m\n');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
