  const root = $('#w-read'); if (!root) return;
  const tabs = $$('.tab', root), panes = $$('.pane', root), bar = $('.expo i', root), lab = $('.expo b', root);
  const EXPO = { search: [6, '한 줄 요약 × 3 ≈ 480자'], get: [14, '첫 줄 × 3 + 메타 ≈ 1,100자'], source: [100, '원문 한 항목 전체 (쪽 단위)'] };
  const show = (k) => { tabs.forEach((t) => t.setAttribute('aria-selected', t.dataset.k === k)); panes.forEach((p) => p.hidden = p.dataset.k !== k);
    bar.style.width = EXPO[k][0] + '%'; lab.textContent = EXPO[k][1]; };
  tabs.forEach((t) => t.onclick = () => show(t.dataset.k));
  const raw = $('#readRaw', root);
  if (raw) raw.onchange = () => { $('#srcEnv', root).hidden = raw.checked; $('#srcRaw', root).hidden = !raw.checked; };
  show('search');
