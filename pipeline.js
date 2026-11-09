/* Tender Radar pipeline. Run in the page https://tenders.procurement.gov.ge/public/?lang=ge
   Modes: window.TR_MODE = 'full'  -> also downloads 1 year of history (slow, ~1 h), result stats in window._STATS_OUT
          window.TR_MODE = 'daily' -> uses window._STATS or localStorage 'tr_stats' (saved by the last full run); only open tenders (fast)
   Progress: window._R ; result (JSON string): window._OUT  */
(function () {
  const CATS = ['45200000', '45400000', '45100000', '45300000', '71300000', '71200000'];
  // median winning price / estimate by number of bidders (1, 2, 3+), measured 06.11.2026 on 150 recent contracts per category
  const WR = {
    '45100000': {1: .975, 2: .877, 3: .8}, '45200000': {1: .979, 2: .894, 3: .858},
    '45300000': {1: .949, 2: .875, 3: .8}, '45400000': {1: .969, 2: .85, 3: .8},
    '71200000': {1: .971, 2: .9, 3: .991}, '71300000': {1: .96, 2: .773, 3: .666}
  };
  const T0 = Date.now();
  if (!window._STATS) { try { const x = localStorage.getItem('tr_stats'); if (x) window._STATS = JSON.parse(x); } catch (e) {} }
  const MODE = window.TR_MODE || (window._STATS ? 'daily' : 'full');
  if (MODE === 'daily' && !(window._STATS && window._STATS.org)) { window._R = {stage: 'error', msg: 'daily mode needs window._STATS'}; return; }
  const R = window._R = {stage: 'start', mode: MODE, cat: '', p: 0, pages: 0, det: 0, detTotal: 0, msg: ''};
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear();
  const now = new Date(), from = new Date(now.getTime() - 365 * 864e5);
  const form = document.querySelector('form');
  const opts = [...form.app_basecode.options];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function get(url) {
    for (let k = 0; k < 4; k++) { try { const r = await fetch(url); if (r.ok) return await r.text(); } catch (e) {} await sleep(800 * (k + 1)); }
    throw new Error('fetch failed: ' + url);
  }
  function rowsOf(x) {
    const d = document.createElement('div'); d.innerHTML = x;
    return [...d.querySelectorAll('#list_apps_by_subject tbody tr')].map(tr => {
      const m = tr.outerHTML.match(/ShowApp\((\d+),'[^']*',\d+,'([0-9a-f]+)'\)/);
      const t = tr.innerText.replace(/\s+/g, ' ');
      const g = re => (t.match(re) || ['', ''])[1].trim();
      return {id: m && m[1], key: m && m[2], reg: g(/განცხადების ნომერი:\s*(\S+)/), ann: g(/გამოცხადების თარიღი:\s*([\d.]+)/),
        dl: g(/მიღების ვადა:\s*([\d.]+)/), org: g(/შემსყიდველი:\s*(.+?) შესყიდვის კატეგორია/),
        est: parseFloat(g(/სავარაუდო ღირებულება:\s*([\d`.,]+)/).replace(/`/g, '')) || 0, n: +g(/მონაწილეთა რაოდენობა - (\d+)/) || 0};
    });
  }
  // the portal keeps search paging in the session: one search at a time, strictly sequential
  async function list(v, status, a, b) {
    form.reset(); form.app_basecode.value = v; form.app_status.value = status;
    form.app_date_from.value = a || ''; form.app_date_tlll.value = b || '';
    const h = await get('library/controller.php?' + new URLSearchParams(new FormData(form)));
    if (!/ჩანაწერი/.test(h)) return [];
    const pages = +((h.match(/plastpage = eval\('(\d+)'\)/) || [0, 1])[1]); R.pages = pages;
    let L = rowsOf(h), miss = 0;
    for (let p = 2; p <= pages; p++) {
      R.p = p; let x = '', ok = false;
      // the portal sometimes answers with an empty or wrong page: accept only "page p/pages" that has rows
      for (let k = 0; k < 5 && !ok; k++) {
        x = await get('library/controller.php?action=search_app&page=' + p);
        ok = x.includes('გვერდი: ' + p + '/') && rowsOf(x).length > 0;
        if (!ok) await sleep(1500 * (k + 1));
      }
      if (ok) L = L.concat(rowsOf(x)); else miss++;
    }
    R.miss = (R.miss || 0) + miss;
    if (miss > Math.max(2, pages * 0.01)) throw new Error(`missing ${miss} of ${pages} pages (${v}, status ${status})`);
    return L;
  }
  const med = v => { v = [...v].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const adj = e => e < 30000 ? 0.08 : e < 100000 ? 0.03 : e < 300000 ? -0.03 : -0.08;
  async function run() {
    const out = {updated: now.toISOString(), source: 'tenders.procurement.gov.ge', o: [], t: [], base: {}};
    const ST = {date: now.toISOString(), base: {}, org: {}, hist: {}};
    if (MODE === 'daily') out.stats = window._STATS.date;
    const oi = {};
    const orgIdx = o => (o in oi) ? oi[o] : (oi[o] = out.o.push(o) - 1);
    const todo = [];
    for (const code of CATS) {
      R.cat = code; R.stage = 'lists';
      const v = opts.find(o => o.text.trim().startsWith(code)).value;
      const open20 = await list(v, '20'), open10 = await list(v, '10');
      let base, S;
      if (MODE === 'full') {
        R.stage = 'history';
        const hist = (await list(v, '140', fmt(from), fmt(now))).filter(a => a.n > 0);
        base = hist.length ? hist.filter(a => a.n === 1).length / hist.length : 0.3;
        const by = {}; hist.forEach(a => { (by[a.org] = by[a.org] || []).push(a); });
        S = {}; for (const [org, h] of Object.entries(by)) S[org] = [h.length, h.filter(x => x.n === 1).length, med(h.map(x => x.n))];
        ST.base[code] = Math.round(base * 1000) / 1000; ST.org[code] = S; ST.hist[code] = hist.length;
      } else { base = window._STATS.base[code]; S = window._STATS.org[code] || {}; }
      out.base[code] = Math.round(base * 100);
      for (const [L, s] of [[open20, 20], [open10, 10]]) for (const o of L) {
        if (!o.id) continue;
        const [hn, hs, hm] = S[o.org] || [0, 0, null];
        const score = (hs + base * 3) / (hn + 3) + adj(o.est);
        const nb = hn >= 3 ? hm : (o.est < 30000 ? 1 : 2);
        const wr = WR[code][Math.min(nb, 3)];
        const row = {reg: o.reg, app: +o.id, key: o.key, c: code, org: orgIdx(o.org), est: Math.round(o.est), dl: o.dl, s: s,
          h: hn, hs: hs, nb: nb, wr: wr, sc: Math.round(score * 1000) / 1000};
        out.t.push(row); todo.push(row);
      }
    }
    R.stage = 'details'; R.detTotal = todo.length;
    const q = [...todo];
    async function worker() {
      while (q.length) {
        const r = q.shift();
        try {
          const h = await get(`library/controller.php?action=app_main&app_id=${r.app}&key=${r.key}`);
          const d = document.createElement('div'); d.innerHTML = h;
          const kv = {}; d.querySelectorAll('tr').forEach(tr => { const c = tr.children; if (c.length === 2) kv[c[0].innerText.trim()] = c[1].innerText.trim().replace(/\s+/g, ' '); });
          const desc = (d.querySelector('.blabla') || {innerText: ''}).innerText.trim().replace(/\s+/g, ' ');
          r.end = kv['წინადადებების მიღება მთავრდება'] || '';
          r.start = kv['წინადადებების მიღება იწყება'] || '';
          r.gar = parseFloat((kv['გარანტიის ოდენობა'] || '').replace(/`/g, '').replace(/[^\d.]/g, '')) || 0;
          r.term = (kv['მოწოდების ვადა'] || '').slice(0, 90);
          let dd = desc;
          // household repair tenders name the resident: keep only the town, drop name and street address
          if (dd.includes('მცხოვრებ') && dd.includes('საცხოვრებელ')) { const i = dd.indexOf('საცხოვრებელ'); dd = (dd.slice(0, i).split(',')[0].split('მცხოვრებ')[0].trim() + ' ' + dd.slice(i)).trim(); }
          // private person's house used as a landmark ("X Y-ის სახლის მიმდებარედ") -> "კერძო სახლის მიმდებარედ"
          dd = dd.replace(/(?:(?<=\s)|^)(?:(?!\S*(?:ში|ზე|ის,)\s)\S+\s)?\S+\s(სახლის\s(?:მიმდებარედ|მიმდებარე|უკან|წინ|გვერდით))/g, 'კერძო $1');
          r.desc = dd.length > 260 ? dd.slice(0, 257) + '…' : dd;
        } catch (e) { r.desc = r.desc || ''; }
        delete r.key; R.det++;
      }
    }
    await Promise.all([1, 2, 3, 4].map(worker));
    out.t.forEach(x => {
      if (x.desc && x.desc.length > 120) x.desc = x.desc.slice(0, 118) + '…';
      if (x.term) x.term = x.term.replace(/ხელშეკრულების გაფორმებიდან/, 'ხელშეკრულებიდან').slice(0, 50);
      if (x.s !== 10) delete x.start;
      if (x.end) delete x.dl;
    });
    if (MODE === 'full') { window._STATS_OUT = JSON.stringify(ST); try { localStorage.setItem('tr_stats', window._STATS_OUT); R.saved = true; } catch (e) { R.saved = String(e); } out.stats = ST.date; R.statsSize = window._STATS_OUT.length; }
    window._OUT = JSON.stringify(out); R.stage = 'done'; R.min = Math.round((Date.now() - T0) / 6e4); R.size = window._OUT.length; R.count = out.t.length;
  }
  run().catch(e => { R.stage = 'error'; R.msg = String(e && e.message || e); });
})();
