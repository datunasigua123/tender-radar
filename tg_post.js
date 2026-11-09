/* Tender Radar: daily Telegram channel post. Run in the portal tab AFTER pipeline.js finished (window._OUT exists).
   Token and channel are read from this browser's localStorage (tr_tg_token, tr_tg_chat); set once by the owner.
   Set window.TR_PAGE_URL before running to add the page link. Mode: window.TR_DRY = true builds the text without sending.
   Result: window._TG = {stage, total, picked, status, msg, text} */
(async function () {
  const G = window._TG = {stage: 'start'};
  try {
    const data = typeof window._OUT === 'string' ? JSON.parse(window._OUT) : window._OUT;
    if (!data || !data.t) throw new Error('no _OUT: run pipeline.js first');
    const VALID = {'45200000': 'სამშენებლო სამუშაოები', '45400000': 'რემონტი და მოპირკეთება', '45100000': 'მიწის და მოსამზადებელი სამუშაოები'};
    const M = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი', 'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი'];
    const TBS = 4 * 3600e3; // Asia/Tbilisi UTC+4, no DST
    const pdt = s => { // "dd.mm.yyyy hh:mm" Tbilisi time -> ms
      const m = (s || '').match(/(\d\d)\.(\d\d)\.(\d{4})(?:\s+(\d\d):(\d\d))?/); if (!m) return null;
      return Date.UTC(+m[3], +m[2] - 1, +m[1], m[4] ? +m[4] : 23, m[5] ? +m[5] : 59) - TBS;
    };
    const tb = ms => new Date(ms + TBS); // read with getUTC*
    const dstr = ms => { const d = tb(ms); return `${d.getUTCDate()} ${M[d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
    const money = x => Math.round(x).toLocaleString('en-US').replace(/,/g, ' ') + ' ₾';
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const clean = t => {
      let d = (t.desc || '').trim();
      if (d.includes('მცხოვრებ') && d.includes('საცხოვრებელ')) { // drop resident's name and street address
        const i = d.indexOf('საცხოვრებელ');
        d = d.slice(0, i).split(',')[0].split('მცხოვრებ')[0].trim() + ' ' + d.slice(i);
      }
      d = d.replace(/\s+/g, ' ').replace(/^[ .,]+|[ .,]+$/g, '');
      if (!d) d = (VALID[t.c] || 'სამუშაოები') + ' (აღწერა ოფიციალურ საიტზეა)';
      return d.length <= 110 ? d : d.slice(0, 108).trim() + '…';
    };
    const now = Date.now();
    let rows = data.t.filter(t => VALID[t.c] && (t.sc || 0) >= 0.55)
      .map(t => [t, pdt(t.end || t.dl)]).filter(([t, e]) => e && e >= now + 6 * 3600e3);
    rows.sort((a, b) => (b[0].sc - a[0].sc) || (a[1] - b[1]));
    const per = {}, picked = [];
    for (const r of rows) { const o = r[0].org; if ((per[o] || 0) >= 2) continue; per[o] = (per[o] || 0) + 1; picked.push(r); if (picked.length === 7) break; }
    const today = tb(now), head = `დღის ტენდერები ნაკლები კონკურენციით - ${today.getUTCDate()} ${M[today.getUTCMonth()]}`;
    const L = [`<b>${esc(head)}</b>`, `მწვანე (სავარაუდოდ ცოტა კონკურენტი): ${rows.length}. აქ ტოპ ${picked.length}.`, ''];
    picked.forEach(([t, e], i) => {
      const comp = t.h >= 3 ? `ამ შემსყიდველის ${t.h} ტენდერიდან ${t.hs}-ზე (${Math.round(100 * t.hs / t.h)}%) მხოლოდ 1 კომპანია მოვიდა`
        : 'პატარა ტენდერია, ასეთზე ხშირად 1-2 კომპანია მოდის';
      L.push(`${i + 1}. <b>${esc(clean(t))}</b>`, `${esc(data.o[t.org])} | ${money(t.est)} | ვადა: ${dstr(e)}`, esc(comp),
        `<a href="https://tenders.procurement.gov.ge/public/?go=${t.app}&amp;lang=ge">ტენდერის გახსნა</a> (${esc(t.reg)})`, '');
    });
    L.push('<i>ეს პროგნოზია წარსული ტენდერების მიხედვით, გარანტია არ არის. პირობები ყოველთვის ოფიციალურ საიტზე გადაამოწმე.</i>');
    if (window.TR_PAGE_URL) L.push('', `ყველა ტენდერი, ფილტრები და ფასის რჩევა: <a href="${window.TR_PAGE_URL}">ტენდერ რადარი</a>`);
    L.push(`მონაცემები: tenders.procurement.gov.ge, განახლდა ${dstr(Date.parse(data.updated))}`);
    const text = L.join('\n');
    Object.assign(G, {total: rows.length, picked: picked.length, text});
    if (!picked.length) { G.stage = 'skipped'; G.msg = 'no green tenders today'; return; }
    if (window.TR_DRY) { G.stage = 'dry'; return; }
    const T = localStorage.getItem('tr_tg_token'), C = localStorage.getItem('tr_tg_chat');
    if (!T || !C) { G.stage = 'no_token'; G.msg = 'token or channel not set in this browser'; return; }
    G.stage = 'sending';
    // form-encoded POST = simple CORS request (no preflight)
    const r = await fetch(`https://api.telegram.org/bot${T}/sendMessage`, {method: 'POST',
      body: new URLSearchParams({chat_id: C, text, parse_mode: 'HTML', disable_web_page_preview: 'true'})});
    const j = await r.json().catch(() => ({}));
    G.status = r.status; G.stage = j.ok ? 'sent' : 'error'; G.msg = j.ok ? 'message_id ' + j.result.message_id : (j.description || 'HTTP ' + r.status);
  } catch (e) { G.stage = 'error'; G.msg = String(e && e.message || e); }
})();
