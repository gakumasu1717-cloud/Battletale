// Rhythm-style timing minigame. A cursor sweeps back and forth; tap / Space / Enter
// when it is inside the zone. Inner zone = perfect, outer = good, outside = miss.
// steps: [{ key, label, beats, zone, perfect, speed }] → resolves { key: grade | [grades] } or null if cancelled.
const GRADE_TXT = { perfect: 'PERFECT!', good: 'GOOD', miss: 'MISS' };

export function runTiming(steps) {
  return new Promise(resolve => {
    if (!steps?.length) { resolve({}); return; }
    const root = document.createElement('div');
    root.id = 'bt-timing';
    root.innerHTML = `<div class="bt-t-box">
      <div class="bt-t-label"></div><div class="bt-t-beats"></div>
      <div class="bt-t-track"><div class="bt-t-zone"><div class="bt-t-perfect"></div></div><div class="bt-t-cursor"></div></div>
      <div class="bt-t-grade"></div>
      <div class="bt-t-hint">화면을 탭하거나 Space / Enter</div>
      <button class="menu_button bt-t-cancel">취소</button></div>`;
    document.body.appendChild(root);
    const $ = sel => root.querySelector(sel);
    const results = {};
    let si = 0, beat = 0, t0 = 0, raf = 0, waiting = false, center = 0.5, done = false;
    const step = () => steps[si];

    const finish = (value) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey, true);
      root.remove();
      resolve(value);
    };

    const place = () => {
      const s = step();
      center = s.zone / 2 + 0.06 + Math.random() * (1 - s.zone - 0.12);
      const zone = $('.bt-t-zone');
      zone.style.left = `${(center - s.zone / 2) * 100}%`;
      zone.style.width = `${s.zone * 100}%`;
      const p = $('.bt-t-perfect');
      p.style.width = `${(s.perfect / s.zone) * 100}%`;
      p.style.left = `${(0.5 - s.perfect / s.zone / 2) * 100}%`;
      $('.bt-t-label').textContent = s.label;
      $('.bt-t-beats').textContent = s.beats > 1 ? `${beat + 1} / ${s.beats}` : '';
      $('.bt-t-grade').textContent = '';
      $('.bt-t-grade').className = 'bt-t-grade';
      t0 = performance.now();
      waiting = false;
    };

    const pos = (now) => {
      const s = step();
      const x = ((now - t0) / 1000) / s.speed;     // sweeps elapsed
      const phase = x % 2;
      return { p: phase < 1 ? phase : 2 - phase, sweeps: x };
    };

    const record = (grade) => {
      const s = step();
      if (s.beats > 1) (results[s.key] ??= []).push(grade);
      else results[s.key] = grade;
      waiting = true;
      const g = $('.bt-t-grade');
      g.textContent = GRADE_TXT[grade];
      g.className = `bt-t-grade ${grade}`;
      setTimeout(() => {
        beat += 1;
        if (beat >= s.beats) { si += 1; beat = 0; }
        if (si >= steps.length) finish(results); else place();
      }, 420);
    };

    const hit = () => {
      if (waiting || done) return;
      const { p } = pos(performance.now());
      const s = step();
      const d = Math.abs(p - center);
      record(d <= s.perfect / 2 ? 'perfect' : d <= s.zone / 2 ? 'good' : 'miss');
    };

    const loop = (now) => {
      if (done) return;
      const { p, sweeps } = pos(now);
      $('.bt-t-cursor').style.left = `${p * 100}%`;
      if (!waiting && sweeps > 3) record('miss');
      raf = requestAnimationFrame(loop);
    };

    const onKey = (e) => {
      if (e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); hit(); }
      else if (e.key === 'Escape') finish(null);
    };
    root.addEventListener('pointerdown', e => { if (e.target.closest('.bt-t-cancel')) return; e.preventDefault(); hit(); });
    $('.bt-t-cancel').addEventListener('click', () => finish(null));
    document.addEventListener('keydown', onKey, true);
    place();
    raf = requestAnimationFrame(loop);
  });
}
