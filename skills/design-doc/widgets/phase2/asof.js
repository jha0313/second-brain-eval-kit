const root = $('#w-asof'); if (!root) return;
const RUNS = [null, '1a2b3c4d', '5e6f7a8b', '9c0d1e2f', '3a4b5c6d', '7e8f9a0b', 'c1d2e3f4'];
const DATES = [null, '10-01', '10-03', '10-08', '10-15', '10-22', '10-29'];
const LATEST = 6;
// each row: versions [from, to) in run ids, to = null means current. label = what the version holds
const ROWS = [
  { key: 'doc:docs/billing.md', kind: '기억 revision', vers: [[1, 2, 'r1 초안'], [2, 5, 'r2 수정'], [5, 6, 'r3 수정']], note: 'run 6에서 문서 삭제 → 현재 행 없음' },
  { key: 'pr:120', kind: '기억 revision', vers: [[1, 3, 'r1 open'], [3, null, 'r2 merged']] },
  { key: 'lib/charge.ts#settle@function', kind: '노드 revision', vers: [[1, 4, 'r1 줄 40'], [4, null, 'r2 줄 52']] },
  { key: 'run.ts → settle (calls, 줄 12)', kind: '간선 사실', vers: [[1, 4, '사실']] },
  { key: 'run.ts → settle (calls, 줄 14)', kind: '간선 사실', vers: [[4, null, '사실']] },
  { key: 'billing.md 청크 → settle', kind: '링크 사실', vers: [[2, 6, '사실']] },
];
const el = { grid: $('.asof-grid', root), latest: $('#asofLatest', root), run: $('#asofRun', root), out: $('#asofRunOut', root),
  mirror: $('#asofMirror', root), res: $('#asofRes', root), sql: $('#asofSql', root) };
const visible = (v, R) => v[0] <= R && (v[1] == null || v[1] > R);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
function render() {
  const R = el.latest.checked ? LATEST : +el.run.value;
  el.run.disabled = el.latest.checked; el.out.textContent = R;
  let h = '<div></div>' + [1, 2, 3, 4, 5, 6].map((r) => `<div class="h${r === R ? ' on' : ''}">r${r}</div>`).join('');
  for (const row of ROWS) {
    h += `<div class="lab" title="${esc(row.kind)}">${esc(row.key)}</div>`;
    for (let r = 1; r <= 6; r++) {
      const k = row.vers.findIndex((v) => visible(v, r));
      if (k < 0) { h += '<div class="gap"></div>'; continue; }
      const v = row.vers[k], start = v[0] === r;
      h += `<div class="seg v${k % 3}${r === R ? ' hit' : ''}" title="${esc(v[2])} · valid_from ${v[0]}, valid_to ${v[1] ?? 'null'}">${start ? esc(v[2]) : ''}</div>`;
    }
  }
  el.grid.innerHTML = h;
  const vis = ROWS.map((row) => ({ row, v: row.vers.find((v) => visible(v, R)) }));
  const ptr = (row, v) => (/^(doc|pr):/.test(row.key) ? `${row.key}@${v[2].split(' ')[0]}` : row.key);
  el.res.innerHTML = `<div class="big">${el.latest.checked ? '<span class="pill ok">최신</span>' : `<span class="pill info">as-of run ${R}</span>`} 보이는 행 ${vis.filter((x) => x.v).length}개 / ${ROWS.length}</div>
    <dl>${vis.map(({ row, v }) => `<dt>${esc(row.kind)}</dt><dd>${v ? esc(ptr(row, v)) + ' · ' + esc(v[2]) : '<span style="color:var(--muted)">안 보임' + (row.note && R === 6 ? ' (' + esc(row.note) + ')' : '') + '</span>'}</dd>`).join('')}</dl>
    <p style="margin:8px 0 0;color:var(--muted)">옛 행은 지우지 않는다. 바뀌는 것은 <code>valid_to</code>를 한 번 닫는 것뿐이다. <code>@r2</code> 포인터는 언제 읽어도 같은 글이다.</p>`;
  const A = +el.mirror.value, B = LATEST;
  const ins = [], del = [];
  if (A === 0) ROWS.forEach((row) => row.vers.forEach((v) => { if (visible(v, B)) ins.push(row.key + ' ' + v[2]); }));
  const skip = [];
  if (A !== 0) ROWS.forEach((row) => row.vers.forEach((v) => {
    const born = v[0] > A && v[0] <= B, closed = v[1] != null && v[1] > A && v[1] <= B;
    if (born && closed) skip.push(row.key + ' ' + v[2]);          // appeared and closed between A and B: nothing to do
    else if (born) ins.push(row.key + ' ' + v[2]);
    else if (closed) del.push(row.key + ' ' + v[2]);
  }));
  el.sql.innerHTML = `<span class="d">-- 이 run에서 보이는 행 (모든 revision · 사실 표에 같은 식)</span>
<span class="h">WHERE</span> valid_from &lt;= <span class="q">${R}</span>
  <span class="h">AND</span> (valid_to <span class="h">IS NULL OR</span> valid_to &gt; <span class="q">${R}</span>)

<span class="d">-- mirror를 run ${A || '없음'}에서 run ${B}로: ${A === 0 ? '처음이라 전부 받는다' : `valid_from ∈ (${A}, ${B}] 넣기, valid_to ∈ (${A}, ${B}] 지우기`}</span>
${A === B ? '<span class="f">이미 최신. 받을 행 없음</span>' : `<span class="f">넣기 ${ins.length}</span>  ${ins.map(esc).join(' · ') || '—'}
<span class="x">지우기 ${del.length}</span>  ${del.map(esc).join(' · ') || '—'}${skip.length ? `
<span class="d">건너뜀 ${skip.length}  ${skip.map(esc).join(' · ')} (그 사이에 생겼다 닫힘)</span>` : ''}`}
<span class="d">  footer: brain data as of run ${R} @${RUNS[R]} (2026-${DATES[R]}${el.latest.checked ? '' : ', as-of'}) · latest run ${LATEST}</span>`;
}
[el.latest, el.mirror].forEach((e) => (e.onchange = render));
el.run.oninput = render;
render();
