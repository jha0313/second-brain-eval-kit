const root = $('#w-run'); if (!root) return;
const STAGES = [
  { id: 'S0', name: '대기', sec: 40 }, { id: 'S1', name: '준비', sec: 60 }, { id: 'S2', name: 'attempt · mirror', sec: 20 },
  { id: 'S3', name: 'build', sec: 120 }, { id: 'S4', name: 'sync', sec: 60 }, { id: 'S5', name: 'publish', sec: 10 }, { id: 'S6', name: '확인', sec: 20 } ];
const SLO = 600;
const init = () => ({ run: 42, commit: '9f3c2e1a', cursor: '어제 19:20', attempt: '—', show: 'fresh 아님 · 3 commits behind' });
let db = init();
const el = { bar: $('.runbar', root), state: $('.runstate', root), log: $('.reqlog', root), res: $('#runRes', root),
  fault: $('#runFault', root), cold: $('#runCold', root), nocache: $('#runNoCache', root), go: $('#runGo', root), reset: $('#runReset', root) };
const secs = () => STAGES.map((s) => s.sec + (s.id === 'S2' && el.nocache.checked ? 25 : 0) + ((s.id === 'S2' || s.id === 'S5') && el.cold.checked ? 3 : 0));
function drawBar(status = {}) {
  const t = secs(), total = Math.max(SLO * 1.08, t.reduce((a, b) => a + b, 0));
  el.bar.innerHTML = STAGES.map((s, k) => `<div class="st ${status[s.id] || 'todo'}" style="width:${(t[k] / total) * 100}%" title="${s.id} ${s.name} · 보통 ${t[k]}초">${s.id} ${s.name}</div>`).join('')
    + `<div class="slo" style="left:${(SLO / total) * 100}%"><span>10분</span></div>`;
}
function drawState() {
  el.state.innerHTML = `<div>서버 최신 run<b>run ${db.run} @${db.commit}</b></div><div>GitHub cursor T<b>${db.cursor}</b></div>
    <div>이번 attempt<b>${db.attempt}</b></div><div>footer<b style="font-weight:500">${db.show}</b></div>`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
const line = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; el.log.append(d); el.log.scrollTop = el.log.scrollHeight; };
async function go() {
  el.go.disabled = true; el.log.innerHTML = '';
  const f = el.fault.value, st = {}, t = secs();
  let elapsed = 0, published = null;
  const before = { ...db };
  const stage = async (k, ok = true) => { const s = STAGES[k]; st[s.id] = 'run'; drawBar(st); await sleep(260); elapsed += t[k]; st[s.id] = ok ? 'done' : 'fail'; drawBar(st); };
  const end = (kind, msg) => { finish(kind, msg, before, elapsed, published); };
  line('dim', '# trigger: workflow_dispatch (입력 없음) · concurrency 그룹 brain-publish'); await stage(0);
  line('', 'checkout 운영 repo · 소스 repo main (fetch-depth 0) · npm ci · cache 복원'); await stage(1);
  line('db', 'BEGIN; INSERT attempt (running, gha 8812/1, src 4be2d07c); SELECT 최신 run → B = 42; COMMIT');
  if (f === 'dup') { Object.assign(db, { run: 43, commit: '4be2d07c', cursor: '4분 전' }); line('dim', '# 상황: 이 run은 6분 전에 만들어져 줄을 섰고, 그사이 앞선 run 43이 같은 커밋을 publish함'); line('', '최신 run 43: 커밋 = 소스 커밋 4be2d07c · GitHub T(4분 전) ≥ 이 run created_at(6분 전) · 도구 버전 같음 · 첫 attempt → 건너뜀'); st.S2 = 'skip'; for (const s of STAGES.slice(3)) st[s.id] = 'skip'; drawBar(st); db.attempt = 'skipped'; return end('skip'); }
  line('', el.nocache.checked ? 'mirror cache 없음 → 서버에서 run 42 전부 받기 (약 25 MB)' : 'mirror cache run 41 → delta로 run 42 (0.4 MB) · checksum 일치');
  if (el.cold.checked) line('dim', '  compute 잠듦: 연결 재시도 1초 · 2초 → 성공');
  await stage(2);
  line('', '자식 프로세스: brain build (상한 3분)');
  if (f === 'build') { await stage(3, false); line('err', '  3분 초과 → SIGTERM, 10초 뒤 SIGKILL'); return fail('build timeout'); }
  await stage(3); line('dim', '  노드 28,3xx · 간선 16만 · 청크 5천');
  line('', '자식 프로세스: brain sync (cursor T − 1시간부터, 첫 응답 Date → 새 T 후보)');
  if (f === 'gh500') { await stage(4, false); line('err', '  GET /pulls → 500, 3회 재시도 실패'); return fail('sync'); }
  await stage(4); line('dim', '  요청 78개 · 바뀐 PR 4개');
  line('', 'snapshot · delta = 새 상태 − run 42 · 업로드 전 검사');
  if (f === 'outbound') { st.S5 = 'fail'; drawBar(st); line('err', '  edges.site 경로에 비밀 모양 문자열 → 쓰기 연결을 열지 않음'); return fail('outbound'); }
  line('db', '새 연결 (direct, transaction_timeout=60s) · BEGIN · pg_advisory_xact_lock');
  if (f === 'stale') { await stage(5, false); line('err', '  최신 run = 43 ≠ B 42 → ROLLBACK, 다시 돌지 않음'); db.run = 43; db.commit = '77aa01bc'; return fail('stale-base'); }
  line('db', '  확인 셋 OK (최신 run = 42, 자손, attempt running) · INSERT run 43');
  line('db', '  노드 · 간선 delta 2,140행');
  if (f === 'mid') { await stage(5, false); line('err', '  항목 쓰기에서 오류 → ROLLBACK (서버가 전부 버림)'); return fail('publish'); }
  if (f === 'kill') { await stage(5, false); line('err', '  kill -9 → 연결 끊김 → 서버가 트랜잭션을 버림. 실패 기록 못 함'); db.attempt = 'running → 표시 abandoned'; return end('abandoned'); }
  line('db', '  항목 revision 9 · sync_state · 행 수 검사 · attempt ok');
  line('db', 'COMMIT');
  if (f === 'lostok') { line('err', '  응답 유실'); line('db', '새 연결 · 같은 잠금 (원래 트랜잭션이 끝날 때까지 기다림) · run에 내 attempt? → 있음'); }
  await stage(5); published = elapsed;
  db.run = 43; db.commit = '4be2d07c'; db.cursor = '방금'; db.attempt = 'ok';
  if (f === 'after') { st.S6 = 'fail'; drawBar(st); line('err', 'S6 전에 프로세스 죽음 → job은 실패 표시, 데이터는 이미 커밋됨'); return end('after'); }
  line('', 'S6: 새 연결로 최신 run = 43 확인 · mirror를 43으로 · cache 저장'); await stage(6);
  end('ok');
  function fail(stageName) { db.attempt = `failed (${stageName})`; end('fail', stageName); }
}
function finish(kind, msg, before, elapsed, published) {
  const same = before.run === db.run && before.cursor === db.cursor;
  const label = { ok: '<span class="pill ok">published</span>', fail: '<span class="pill bad">rollback</span>', abandoned: '<span class="pill bad">rollback · abandoned</span>',
    skip: '<span class="pill warn">skipped</span>', after: '<span class="pill warn">published · 확인 실패</span>' }[kind];
  if (kind === 'ok' || kind === 'after' || kind === 'skip') db.show = kind === 'skip' ? 'up to date (다른 실행이 이미 publish)' : 'up to date with main · github as of 0m';
  else db.show = `last attempt FAILED (${msg || 'killed'}) · data = run ${db.run}`;
  const mm = (s) => `${Math.floor(s / 60)}분 ${s % 60}초`;
  el.res.innerHTML = `<div class="big">${label}</div><dl>
    <dt>지도 · 기억 · cursor</dt><dd>${kind === 'fail' && msg === 'stale-base' ? '내 쓰기 없음 (다른 run 43이 먼저 커밋)' : same ? '그대로 (run ' + db.run + ', T ' + db.cursor + ')' : '함께 새로: run ' + db.run + ', T ' + db.cursor}</dd>
    <dt>trigger → published</dt><dd>${published != null ? mm(published) + (published <= 600 ? ' · SLO 안' : ' · SLO 넘음') : '—'}</dd>
    <dt>attempt</dt><dd>${db.attempt}</dd></dl>
    <p style="margin:8px 0 0;color:var(--muted)">${kind === 'after' ? 'COMMIT 뒤의 실패는 롤백이 아니다. 다음 refresh가 서버 상태로 성공을 확인한다.' : kind === 'skip' ? '몰린 dispatch는 job 시작에서 걸러져 publish가 한 번이 된다.' : kind === 'ok' ? '쓰기는 트랜잭션 하나. 기다림 대부분은 트랜잭션 밖이다.' : '실패 지점과 상관없이 서버 상태는 run ' + before.run + ' 그대로다. 다음 run이 같은 창부터 다시 한다.'}</p>`;
  drawState(); el.go.disabled = false;
}
el.go.onclick = go;
el.reset.onclick = () => { db = init(); el.log.innerHTML = '<div class="dim"># 처음 상태: run 42</div>'; el.res.textContent = '실패 지점을 고르고 실행해 보세요.'; drawBar(); drawState(); };
[el.cold, el.nocache].forEach((e) => (e.onchange = () => drawBar()));
drawBar(); drawState();
