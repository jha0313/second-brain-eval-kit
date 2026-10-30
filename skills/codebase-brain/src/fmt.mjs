// Terminal output: aligned tables, color only on a TTY (agents get plain text).
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = { dim: paint(2), bold: paint(1), red: paint(31), green: paint(32), yellow: paint(33), blue: paint(34), cyan: paint(36) };
const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
export const width = (s) => [...visible(s)].reduce((w, ch) => w + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);

export function cut(s, n) {
  s = String(s ?? '');
  if (width(s) <= n) return s;
  let out = '';
  for (const ch of s) { if (width(out + ch) > n - 1) break; out += ch; }
  return out + '…';
}

// Output width: the terminal, else $COLUMNS, else 120; never below 100 (a 1080p recording shows ~100).
export const COLS = Math.max(100, process.stdout.columns || +process.env.COLUMNS || 120);

// "…tail" when a path is longer than n
export const cutLeft = (s, n) => (width(s) <= n ? s : '…' + [...s].slice(-(n - 1)).join(''));

// rows: array of arrays. align: 'l' | 'r' per column. max: max width per column (0 = no cap).
// Wider than `fit`: the last column shrinks first, then the widest. Key/value tables (no head) wrap at ' · '.
export function table(head, rows, { align = [], max = [], indent = '  ', fit = COLS } = {}) {
  let cells = [head, ...rows].map((r) => r.map((v, i) => (max[i] ? cut(v, max[i]) : String(v ?? ''))));
  const w = head.map((_, i) => Math.max(...cells.map((r) => width(r[i] ?? ''))));
  if (head.every((h) => !h)) {
    const room = fit - indent.length - w[0] - 2, cont = ' '.repeat(indent.length + w[0] + 2);
    const wrap = (v) => v.split(' · ').reduce((lines, part) => {
      const last = lines[lines.length - 1];
      if (last !== undefined && width(last + ' · ' + part) <= room) lines[lines.length - 1] = last + ' · ' + part; else lines.push(part);
      return lines;
    }, []).join('\n' + cont);
    const pad0 = (v) => v + ' '.repeat(Math.max(0, w[0] - width(v)));
    return cells.slice(1).map((r) => indent + c.dim(pad0(r[0])) + '  ' + wrap(r.slice(1).join('  '))).join('\n');
  }
  for (let over = indent.length + w.reduce((a, b) => a + b + 2, -2) - fit; over > 0;) {
    const last = w.length - 1;
    const i = w[last] > 12 ? last : w.indexOf(Math.max(...w));
    const to = Math.max(8, w[i] - over);
    if (to === w[i]) break;
    over -= w[i] - to; w[i] = to;
    cells = cells.map((r) => r.map((v, j) => (j === i ? cut(v, to) : v)));
  }
  const pad = (v, i) => {
    const gap = ' '.repeat(Math.max(0, w[i] - width(v)));
    return align[i] === 'r' ? gap + v : v + gap;
  };
  const line = (r) => indent + r.map(pad).join('  ').trimEnd();
  return [c.dim(line(cells[0])), indent + c.dim(w.map((n) => '─'.repeat(n)).join('  ')), ...cells.slice(1).map(line)].join('\n');
}

export const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
