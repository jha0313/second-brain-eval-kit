  const root = $('#w-footer'); if (!root) return;
  const code = $('#fCode', root), gh = $('#fGh', root), cut = $('#fCut', root), outEl = $('.foot-out pre', root);
  const C = { up: 'code @a1b2c3d4 = HEAD (up to date)', behind: 'code @a1b2c3d4 · HEAD @9f3c2e1a · 14 commits behind · 37 files changed', div: 'code @a1b2c3d4 · HEAD @c0ffee12 · diverged' };
  const G = { ok: ['github data as of 11-15 09:58Z (synced 12m ago, ok · full sync never)', null], stale: ['github data as of 11-12 10:02Z (3d old, stale · full sync never)', null], never: ['github never synced', 'github not synced'],
    failed: ['last github sync FAILED 40m ago (rate limit) · data as of 11-15 08:58Z', 'last github sync failed'] };
  const render = () => { const g = G[gh.value]; const cov = cut.checked ? 'truncated · 10 of 37 hits · --cursor 10' : g[1] ? `partial · ${g[1]}` : 'complete · 3 hits';
    const covCls = cut.checked ? 'q' : g[1] ? 'x' : 'f';
    outEl.innerHTML = `<span class="d">  coverage: </span><span class="${covCls}">${cov}</span>\n<span class="d">  freshness: </span><span class="${code.value === 'up' ? 'f' : 'q'}">${C[code.value]}</span><span class="d"> · </span><span class="${gh.value === 'ok' ? 'f' : 'q'}">${g[0]}</span>`; };
  [code, gh, cut].forEach((e) => e.onchange = render); render();
