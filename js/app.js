/*
 * app.js — wiring: one render loop, one active simulation at a time, a
 * quality governor that steps resolution down before the machine struggles,
 * and the page's controls, calculator and form.
 */
(function (ES) {
  'use strict';
  const BUILD = '2026.09.24-1';
  ES.build = BUILD;
  const P = ES.physics;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const out = (key) => $(`[data-out="${key}"]`);
  const set = (key, text) => { const el = out(key); if (el && el.textContent !== text) el.textContent = text; };
  const nf = (v, d = 1) => v.toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const minus = (s) => s.replace('-', '−');
  const deg = (v, d = 1) => `${minus(nf(v, d))} °C`;

  const params = new URLSearchParams(location.search);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const weak = (navigator.hardwareConcurrency || 4) <= 4 || matchMedia('(pointer: coarse)').matches;
  const Q_CAP = params.get('q') === 'low' ? 0 : 2;
  const Q_START = Math.min(Q_CAP, weak ? 0 : 1);
  const Q_NAMES = ['düşük', 'orta', 'yüksek'];

  ES.sims = {};
  ES.caps = {};
  const entries = [];

  // ---------------------------------------------------------------- scheduler

  function register(name, Ctor, onStats, sync) {
    const stage = $(`.sim-stage[data-sim="${name}"]`);
    const e = { name, stage, canvas: $('canvas', stage), Ctor, onStats, sync, sim: null, ratio: 0, failed: false, paused: false, played: !reducedMotion };
    entries.push(e);
    return e;
  }

  function fail(e, err) {
    e.failed = true;
    e.sim = null;
    e.stage.classList.remove('compiling');
    e.stage.classList.add('no-gl');
    $('.sim-fallback', e.stage).hidden = false;
    const msg = `[${e.name}] simülasyon başlatılamadı: ${err.message.split('\n')[0]}`;
    if (/shader|program/.test(err.message)) console.error(msg, err.message); else console.warn(msg);
  }

  /** Phase 1: build the context and queue shader compilation (returns at once). */
  function create(e) {
    if (e.sim || e.pending || e.failed) return;
    try {
      e.pending = new e.Ctor(e.canvas);
      e.stage.classList.add('compiling');
      ES.caps.webgl2 = true;
      ES.caps.floatRead = e.pending.ctx.floatRead;
      ES.caps.parallelCompile = !!e.pending.ctx.parallel;
    } catch (err) { fail(e, err); }
  }

  /** Phase 2: once the driver reports the shaders compiled, size, sync and warm up. */
  function promote(e) {
    if (!e.pending || !e.pending.ctx.ready()) return;
    const sim = e.pending;
    e.pending = null;
    try {
      sim.setQuality(Q_START);
      if (e.sync) e.sync(sim);
      sim.warmup(e.name === 'fire' ? 1.2 : 0.6);
      e.sim = sim;
      ES.sims[e.name] = sim;
      e.stage.classList.remove('compiling');
    } catch (err) { fail(e, err); }
  }

  const io = new IntersectionObserver((list) => {
    for (const it of list) {
      const e = entries.find(x => x.stage === it.target);
      e.ratio = it.isIntersecting ? it.intersectionRatio : 0;
      if (it.isIntersecting) create(e);
    }
  }, { rootMargin: '250px 0px', threshold: [0, 0.05, 0.15, 0.3, 0.5, 0.7, 0.9, 1] });

  function activeEntry() {
    let best = null;
    for (const e of entries) if (e.sim && !e.failed && e.ratio > 0.04 && (!best || e.ratio > best.ratio)) best = e;
    return best;
  }

  const gov = { ema: 16, slow: 0, fast: 0, downgraded: new Set() };
  function govern(e, dtMs) {
    gov.ema += (dtMs - gov.ema) * 0.08;
    const q = e.sim.qi;
    if (gov.ema > 26) { gov.slow++; gov.fast = 0; } else if (gov.ema < 14) { gov.fast++; gov.slow = 0; } else { gov.slow = 0; gov.fast = 0; }
    if (gov.slow > 40 && q > 0) {
      e.sim.setQuality(q - 1);
      gov.downgraded.add(e.name);
      gov.slow = 0; gov.ema = 16;
    } else if (gov.fast > 300 && q < Q_CAP && !gov.downgraded.has(e.name)) {
      e.sim.setQuality(q + 1);
      gov.fast = 0;
    }
  }

  let last = performance.now(), current = null, uiAt = 0;
  function tick(now) {
    requestAnimationFrame(tick);
    const dtMs = now - last;
    if (dtMs < 1000 / 64) return;                 // cap at ~60 fps on high-refresh screens
    last = now;
    if (document.hidden) return;
    for (const x of entries) if (x.pending) promote(x);
    const e = activeEntry();
    if (e !== current) { current = e; gov.ema = 16; gov.slow = gov.fast = 0; }
    if (!e || e.paused || !e.played) return;
    try {
      e.sim.frame(Math.min(dtMs / 1000, 0.1), now);
    } catch (err) {
      fail(e, err);
      return;
    }
    const s = e.sim.stats;
    s.fps += (1000 / dtMs - s.fps) * 0.1;
    govern(e, dtMs);
    if (now - uiAt > 200) { uiAt = now; e.onStats(s, e.sim); set(`${e.name}-q`, `kalite ${Q_NAMES[s.quality]} · ${Math.round(s.fps)} fps`); }
  }

  // ---------------------------------------------------------------- air

  const air = register('air', ES.AirSim, (s) => {
    set('air-mean', deg(s.meanT));
    set('air-supply', `${deg(s.supplyT)} · ${nf(s.speed, 1)} m/s`);
    set('air-comp', s.compressor ? 'Çalışıyor' : 'Durdu (hedefte)');
    set('air-re', `${Math.round(s.reynolds).toLocaleString('tr-TR')} · türbülanslı`);
    set('air-buoy', `${nf(s.buoyancy, 2)} m/s²`);
    const probe = out('air-probe');
    probe.hidden = s.probeT == null;
    if (s.probeT != null) probe.textContent = `sonda ${deg(s.probeT)}`;
  }, (sim) => {
    sim.view = VIEWS[$('[data-air-view][aria-pressed="true"]').dataset.airView];
    sim.setpoint = +$('#air-set').value;
    sim.fan = $('input[name="air-fan"]:checked').value;
    sim.swing = $('#air-swing').checked;
    sim.humid = $('#air-humid').checked;
  });

  const VIEWS = { visible: 0, thermal: 1, schlieren: 2 };
  for (const b of $$('[data-air-view]')) {
    b.addEventListener('click', () => {
      for (const x of $$('[data-air-view]')) x.setAttribute('aria-pressed', String(x === b));
      if (air.sim) air.sim.view = VIEWS[b.dataset.airView];
      $('[data-legend]').hidden = b.dataset.airView !== 'thermal';
    });
  }
  const airSet = $('#air-set');
  airSet.addEventListener('input', () => {
    const v = +airSet.value;
    set('air-set', `${v} °C`);
    set('air-quip', v <= 17 ? `${v} °C mi? Penguen misiniz?` : v >= 28 ? 'Bunun için klima değil, pencere yeterdi.' : '');
    if (air.sim) air.sim.setpoint = v;
  });
  for (const r of $$('input[name="air-fan"]')) r.addEventListener('change', () => { if (air.sim) air.sim.fan = r.value; });
  $('#air-swing').addEventListener('change', (ev) => { if (air.sim) air.sim.swing = ev.target.checked; });
  $('#air-humid').addEventListener('change', (ev) => { if (air.sim) air.sim.humid = ev.target.checked; });

  // ---------------------------------------------------------------- fire

  const FLAME_TEXT = { lit: 'Alev var', out: 'Alev yok · gaz açık', igniting: 'Ateşleniyor', lockout: 'Kilitlendi · servisi arayın (bizi)' };
  const fire = register('fire', ES.FireSim, (s) => {
    set('fire-state', FLAME_TEXT[s.state] || s.state);
    set('fire-current', `${nf(s.current, 1)} µA`);
    set('fire-tmax', `${Math.round(s.maxT).toLocaleString('tr-TR')} K · ${Math.round(s.maxT - 273.15).toLocaleString('tr-TR')} °C`);
  }, (sim) => { sim.phi = +$('#fire-phi').value; sim.flow = +$('#fire-flow').value / 100; });
  const phiEl = $('#fire-phi'), flowEl = $('#fire-flow');
  function fireControls() {
    const phi = +phiEl.value;
    set('fire-phi', nf(phi, 2));
    set('fire-lambda', nf(1 / phi, 2));
    const co = out('fire-co');
    const level = phi < 1.05 ? ['Düşük', 'good'] : phi < 1.4 ? ['Orta', 'warn'] : ['Yüksek', 'crit'];
    co.textContent = level[0];
    co.dataset.level = level[1];
    set('fire-colour', phi < 1.05 ? 'Mavi, kısa, sessiz alev: yakıt tam yanıyor. Sıkıcı ama doğru.'
      : phi < 1.5 ? 'Mavi taban, sarı uç: is oluşmaya başladı. Kombi değil, kamp ateşi estetiği.'
        : 'Sarı-turuncu alev: is parçacıkları 1500 K civarında akkor. Güzel görünüyor, CO dedektörünüz öyle düşünmüyor.');
    set('fire-flow', `%${flowEl.value}`);
    if (fire.sim) { fire.sim.phi = phi; fire.sim.flow = +flowEl.value / 100; }
  }
  phiEl.addEventListener('input', fireControls);
  flowEl.addEventListener('input', fireControls);
  $('#fire-ignite').addEventListener('click', () => { if (fire.sim) fire.sim.ignite(); });

  // ---------------------------------------------------------------- water

  const env = { tin: 22, rh: 75, tout: -2, glazing: 'single' };
  const GLAZING_QUIP = {
    single: 'Tek cam: 1987\'den selamlar. İç yüzey neredeyse dışarısı kadar soğuk.',
    double: 'Çift cam: makul. Hâlâ nemi abartırsanız ağlar.',
    triple: 'Üçlü cam: iç yüzey odaya yakın sıcaklıkta. Camınız artık duygusal olarak stabil.',
  };
  function waterReadouts() {
    const ts = P.glassSurfaceTemp(env.tin, env.tout, P.GLAZING[env.glazing].u);
    const td = P.dewPoint(env.tin, env.rh);
    const S = P.supersaturation(env.tin, env.rh, ts);
    set('w-tin', deg(env.tin, env.tin % 1 ? 1 : 0));
    set('w-rh', `%${Math.round(env.rh)}`);
    set('w-tout', deg(env.tout, 0));
    set('dewpoint', deg(td));
    set('surface', deg(ts));
    set('super', `${S >= 0 ? '+' : '−'}%${Math.round(Math.abs(S) * 100)}`);
    const st = out('state');
    st.dataset.state = S > 0 ? 'condensing' : 'drying';
    st.textContent = S > 0 ? 'Yoğuşma' : 'Kuruma';
    set('glazing-quip', GLAZING_QUIP[env.glazing]);
    if (water.sim) water.sim.setEnv(env);
  }
  const water = register('water', ES.WaterSim, (s, sim) => {
    set('drops', s.drops.toLocaleString('tr-TR'));
    set('water', `${nf(s.water, 1)} g/m²`);
    if (sim.dehumidify && Math.round(sim.env.rh) !== Math.round(env.rh)) {
      env.rh = sim.env.rh;
      $('#w-rh').value = String(Math.round(env.rh));
      waterReadouts();
    }
  }, (sim) => { sim.setEnv(env); sim.dehumidify = $('#w-dehum').getAttribute('aria-pressed') === 'true'; });
  for (const [id, key] of [['#w-tin', 'tin'], ['#w-rh', 'rh'], ['#w-tout', 'tout']]) {
    $(id).addEventListener('input', (ev) => { env[key] = +ev.target.value; waterReadouts(); });
  }
  for (const r of $$('input[name="w-glazing"]')) r.addEventListener('change', () => { if (r.checked) { env.glazing = r.value; waterReadouts(); } });
  $('#w-dehum').addEventListener('click', (ev) => {
    const on = ev.currentTarget.getAttribute('aria-pressed') !== 'true';
    ev.currentTarget.setAttribute('aria-pressed', String(on));
    ev.currentTarget.textContent = on ? 'Nem alma: açık' : 'Nem alma modu';
    if (water.sim) water.sim.dehumidify = on;
  });

  // ---------------------------------------------------------------- pause / reduced motion

  for (const b of $$('[data-pause]')) {
    const e = entries.find(x => x.name === b.dataset.pause);
    if (!e.played) { b.textContent = 'Oynat'; b.setAttribute('aria-pressed', 'true'); }
    b.addEventListener('click', () => {
      if (!e.played) { e.played = true; e.paused = false; }
      else e.paused = !e.paused;
      b.setAttribute('aria-pressed', String(e.paused));
      b.textContent = e.paused ? 'Oynat' : 'Duraklat';
    });
  }

  // ---------------------------------------------------------------- calculator

  const CALC = {
    area: '#c-area', height: '#c-height', windowArea: '#c-window', orientation: '#c-orient', insulation: '#c-insul',
    glazing: '#c-glazing', people: '#c-people', devicesW: '#c-devices', tOut: '#c-tout', tIn: '#c-tin',
  };
  const PARTS = [
    ['transmission', 'İletim (duvar + cam)'], ['solar', 'Güneş'], ['people', 'İnsanlar'],
    ['devices', 'Cihaz + aydınlatma'], ['infiltration', 'Hava sızıntısı'],
  ];
  function calc() {
    const room = {};
    for (const [k, sel] of Object.entries(CALC)) {
      const el = $(sel);
      room[k] = el.tagName === 'SELECT' ? el.value : Math.max(0, Number(el.value) || 0);
    }
    const load = P.coolingLoad(room);
    const btu = P.wattsToBtuPerHour(load.total);
    set('btu', `${Math.round(btu).toLocaleString('tr-TR')} BTU/sa`);
    set('watts', `${nf(load.total / 1000, 2)} kW`);
    const unit = P.recommendUnit(btu * 1.1);
    set('unit', unit ? `${unit.toLocaleString('tr-TR')} BTU/sa` : 'çoklu sistem / VRF');
    const stack = out('stack'), legend = out('legend');
    stack.replaceChildren();
    legend.replaceChildren();
    PARTS.forEach(([k, label], i) => {
      const w = load.parts[k], pct = load.total ? w / load.total * 100 : 0;
      const seg = document.createElement('span');
      seg.className = `seg-${i + 1}`;
      seg.style.flexGrow = String(Math.max(pct, 0.0001));
      seg.title = `${label}: ${Math.round(w).toLocaleString('tr-TR')} W (%${nf(pct, 0)})`;
      if (pct > 0.5) stack.append(seg);
      const li = document.createElement('li');
      li.innerHTML = `<i class="sw seg-${i + 1}" aria-hidden="true"></i><span></span><b></b>`;
      li.children[1].textContent = label;
      li.children[2].textContent = `${Math.round(w).toLocaleString('tr-TR')} W · %${nf(pct, 0)}`;
      legend.append(li);
    });
    const carnot = P.carnotCopCooling(room.tIn, room.tOut);
    const real = P.realisticCopCooling(room.tIn, room.tOut);
    set('cop-carnot', Number.isFinite(carnot) ? nf(carnot, 1) : '∞');
    set('cop-real', nf(real, 1));
    set('elec', `${nf(load.total / real / 1000, 2)} kW`);
    set('cop-quip', `Carnot en fazla ${Number.isFinite(carnot) ? nf(carnot, 1) : '∞'} diyor. Biz ${nf(real, 1)} diyoruz, çünkü evaporatör ve kondenser havadan 12 K farklı çalışmak zorunda. Katalogda 25 yazan rakibimiz ya yalan söylüyor ya da termodinamiği yeniden yazdı.`);
  }
  for (const sel of Object.values(CALC)) {
    $(sel).addEventListener('input', calc);
    $(sel).addEventListener('change', calc);
  }

  // ---------------------------------------------------------------- form

  const form = $('#contact-form');
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const reply = out('form-reply');
    const name = $('#f-name').value.trim(), phone = $('#f-phone').value.replace(/\D/g, ''), msg = $('#f-msg').value.trim();
    const miss = !name ? ['#f-name', 'Adınızı yazın; faturayı kime keseceğimizi bilmemiz lazım.']
      : phone.length < 7 ? ['#f-phone', 'Telefon numarası eksik ya da kısa. Sizi arayamazsak kime söylenecek?']
        : msg.length < 5 ? ['#f-msg', 'Birkaç kelime yazın. "Klima bozuk" bile olur, biz gerisini tahmin ederiz.'] : null;
    for (const el of $$('.field input, .field textarea', form)) el.removeAttribute('aria-invalid');
    if (miss) {
      reply.dataset.state = 'error';
      reply.textContent = miss[1];
      $(miss[0]).setAttribute('aria-invalid', 'true');
      $(miss[0]).focus();
      return;
    }
    reply.dataset.state = 'ok';
    reply.textContent = `Teşekkürler ${name.split(' ')[0]}. Talebiniz alındı. Aslında alınmadı: bu bir demo site, form hiçbir yere gönderilmez. Gerçek bir firma olsaydık şimdi sizi arıyor olurduk.`;
  });

  // ---------------------------------------------------------------- nav

  const links = $$('.nav a');
  const navIo = new IntersectionObserver((list) => {
    for (const it of list) if (it.isIntersecting) {
      for (const a of links) a.toggleAttribute('aria-current', a.getAttribute('href') === `#${it.target.id}`);
    }
  }, { rootMargin: '-45% 0px -50% 0px' });
  for (const s of $$('main > section')) navIo.observe(s);

  // ---------------------------------------------------------------- start

  set('build', BUILD);
  fireControls();
  waterReadouts();
  calc();
  for (const e of entries) io.observe(e.stage);
  requestAnimationFrame(tick);
  ES.ready = true;
})(window.ES = window.ES || {});
