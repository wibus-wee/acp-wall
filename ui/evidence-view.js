// Plain browser/Node shared projection. No report mutation and no inferred support.
(function (scope) {
  function assessment(h) {
    const m = h.methods;
    if (!m) return { rankable: false, label: 'Historical / needs re-probe', coverage: h.score ?? 0, checked: 0, passed: 0, issues: 0, passRate: null };
    const values = Object.values(m);
    const checked = values.filter(r => ['pass', 'partial', 'fail'].includes(r.status));
    const passed = checked.filter(r => r.status === 'pass').length;
    const issues = (h.violations?.length ?? 0) + values.filter(r => r.status === 'fail').length;
    const rankable = h.state !== 'legacy' && h.setup?.status !== 'error' && !values.some(r => r.status === 'error') &&
      ['initialize', 'session/new', 'session/prompt'].every(k => m[k]?.status === 'pass');
    const label = rankable ? 'Measured coverage' : h.state === 'legacy' ? 'Historical / needs re-probe' : h.setup?.status === 'error' ? 'Environment / preparation blocked' :
      ['initialize', 'session/new', 'session/prompt'].some(k => m[k]?.reason === 'authentication') ? 'Authentication blocked' : 'Measurement incomplete';
    return { rankable, label, coverage: h.score ?? 0, checked: checked.length, passed, issues, passRate: checked.length ? Math.round(passed / checked.length * 100) : null };
  }
  function extensionMark(h) {
    const l = h.lody;
    if (!l) return { cls: 'un', txt: '·', tip: 'Extension not probed' };
    const declared = Object.keys(l.advertised ?? {});
    const observed = l.observed ?? [];
    if (declared.length) return { cls: 'ok', txt: `+${declared.length}`, tip: 'Advertised Lody extension features; excluded from the ACP score' };
    if (observed.length) return { cls: 'pr', txt: '±', tip: 'Extension wire keys observed without advertised features' };
    return { cls: 'un', txt: '·', tip: 'No declared or observed extension features; endpoint replies alone are not evidence of support' };
  }
  scope.AcpEvidenceView = { assessment, extensionMark };
})(globalThis);
