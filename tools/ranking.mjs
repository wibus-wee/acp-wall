import { COLUMNS, STATUS } from '../probe/src/evidence.js';

// Preserve the original 24-column league table. Additional probe scenarios
// remain in the evidence report instead of changing the ranking denominator.
export const RANK_COLUMNS = COLUMNS.filter(([key]) => key !== 'prompt:content');
export const CAPS = RANK_COLUMNS.map(([key]) => key);
export function rankingFromMethods(methods = {}, mismatches = []) {
  const notes = {};
  const cells = RANK_COLUMNS.map(([column, keys]) => {
    const results = keys.map(key => ({ method: key, ...(methods[key] ?? { status: 'na', note: 'Not exercised' }) }));
    notes[column] = results.map(r => `${r.method}: ${STATUS[r.status]?.label ?? r.status}${r.reason ? ` (${r.reason})` : ''}${r.note ? ` — ${r.note}` : ''}`).join(' · ');
    if (results.every(r => r.status === 'pass')) return 1;
    // A successful submethod remains visible when its peers are unobserved,
    // rejected or unavailable. Full details stay in the report and case file.
    if (results.some(r => r.status === 'pass' || r.status === 'partial')) return 2;
    if (results.some(r => r.status === 'fail' || r.status === 'unsupported')) return 0;
    return -1;
  });
  const score = Math.round(cells.reduce((sum, cell) => sum + (cell === 1 ? 1 : cell === 2 ? 0.5 : 0), 0) / CAPS.length * 100);
  let tier = score >= 60 ? 'verified' : score >= 25 ? 'partial' : 'limited';
  if (mismatches.length && tier === 'verified') tier = 'partial';
  if (mismatches.length && score < 70) tier = 'limited';
  return { cells, notes, score, tier, star: tier === 'verified' && score === 100 ? 1 : 0 };
}

export function wallRow(row, registry = {}) {
  const ranking = row.methods ? rankingFromMethods(row.methods, row.claimMismatches ?? row.dishonesty) : {
    cells: CAPS.map((_, i) => typeof row.cells?.[i] === 'number' ? row.cells[i] : -1),
    notes: row.notes ?? row.historicalNotes ?? {}, score: row.score ?? 0,
    tier: row.tier ?? 'limited', star: row.star ?? 0,
  };
  return { ...row, ...ranking, run: registry.run ?? row.run ?? null,
    dishonesty: row.claimMismatches ?? row.dishonesty ?? [],
    mitm: row.transport?.mitm?.impersonated ?? row.mitm ?? null,
  };
}
