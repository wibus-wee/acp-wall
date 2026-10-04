import { COLUMNS, STATUS, METHODOLOGY_VERSION, reasonLabel, uncertaintyReasons } from '../probe/src/evidence.js';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeUrl = value => {
  try { const u = new URL(value, location.href); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; }
};
const data = window.__ACP_WALL__ ?? { harnesses: [] };
const current = h => h.reportVersion === 2 && h.methodologyVersion === METHODOLOGY_VERSION;
const rows = data.harnesses.map(h => current(h) ? h : { ...h, state: 'legacy', summary: null, historicalNotes: h.historicalNotes ?? h.notes, cells: COLUMNS.map(([key,,scope]) => ({ key, scope, status:'legacy', items:[] })) });
const names = { measured:'Measured', blocked:'Prerequisite blocked', issues:'Issues observed', 'probe-error':'Probe / setup error', inconclusive:'Inconclusive', legacy:'Needs re-probe' };
const colors = { measured:'pass', blocked:'blocked', issues:'fail', 'probe-error':'error', inconclusive:'na', legacy:'legacy' };
const selected = new Set();
const fmtDate = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().replace('T',' ').slice(0,16) + ' UTC' : 'Not recorded';
const stale = h => Date.now() - Date.parse(h.probedAt) > 7 * 86400000;
const stateBadge = h => `<span class="badge ${colors[h.state] ?? 'na'}">${esc(names[h.state] ?? 'Inconclusive')}</span>`;
const statusBadge = s => `<span class="badge ${esc(s)}">${esc(STATUS[s]?.label ?? s)}</span>`;
const link = (url, text) => safeUrl(url) ? `<a href="${esc(safeUrl(url))}" target="_blank" rel="noopener">${esc(text)} ↗</a>` : '';
$('edition').textContent = `DATA ASSEMBLED ${fmtDate(data.generatedAt)} · ${rows.length} AGENTS`;
$('stats').innerHTML = [[rows.length,'CATALOG RECORDS'],[rows.filter(current).length,'CURRENT METHOD'],[rows.filter(h=>current(h)&&h.summary?.blocked>0).length,'WITH BLOCKERS'],[rows.filter(h=>!current(h)).length,'NEED RE-PROBE']].map(([n,label])=>`<div class="stat"><strong>${n}</strong><small>${label}</small></div>`).join('');
const legendKeys = ['pass','observed','blocked','unsupported','fail','error','na','mixed','legacy'];
$('legend').innerHTML = legendKeys.map(s=>`<span title="${esc(STATUS[s].description)}"><b class="symbol ${s}">${STATUS[s].mark}</b> ${STATUS[s].label}</span>`).join('');
$('status-guide').innerHTML = legendKeys.filter(s=>s!=='mixed').map(s=>`<div class="guide-row"><b class="symbol ${s}">${STATUS[s].mark}</b><span>${STATUS[s].label}</span><p>${esc(STATUS[s].description)}</p></div>`).join('');

function render() {
  const query = $('search').value.trim().toLowerCase();
  const columns = COLUMNS.filter(([, ,scope]) => $('scope').value === 'all' || $('scope').value === scope);
  let visible = rows.filter(h => (!$('compare-only').checked || selected.has(h.id)) && ($('state').value === 'all' || h.state === $('state').value) && (!query || [h.n,h.v,h.id,h.desc,h.version,JSON.stringify(h.methods ?? h.historicalNotes ?? {})].join(' ').toLowerCase().includes(query)));
  visible.sort((a,b)=> $('sort').value === 'recent' ? (Date.parse(b.probedAt)||0)-(Date.parse(a.probedAt)||0) : $('sort').value === 'verified' ? (b.summary?.pass ?? -1)-(a.summary?.pass ?? -1)||a.n.localeCompare(b.n) : a.n.localeCompare(b.n));
  $('matrix-head').innerHTML = `<tr><th scope="col">AGENT / VERSION</th><th scope="col">RUN OUTCOME</th>${columns.map(([key,,scope])=>`<th scope="col" title="${esc(scope)} surface">${esc(key)}${scope==='experimental'?'<br>experimental':''}</th>`).join('')}<th scope="col">LAST PROBED</th></tr>`;
  $('matrix-body').innerHTML = visible.map(h=>`<tr><th scope="row"><div><input type="checkbox" data-select="${esc(h.id)}" aria-label="Compare ${esc(h.n)}" ${selected.has(h.id)?'checked':''} ${selected.size>=4&&!selected.has(h.id)?'disabled':''}><button class="agent-button" data-open="${esc(h.id)}"><strong>${esc(h.n)}</strong><small>${esc(h.v)}${h.version?` · v${esc(h.version)}`:''}</small></button></div></th><td class="outcome-cell">${stateBadge(h)}${current(h)?`<small class="stale na">${h.summary?.pass??0} verified observations</small>`:''}</td>${columns.map(([key])=>{const c=h.cells?.find(c=>c.key===key)??{status:'na',items:[]};const s=STATUS[c.status]??STATUS.na;const title=[`${h.n} · ${key}: ${s.label}`,...(!current(h)&&h.historicalNotes?.[key]?[`Historical note: ${h.historicalNotes[key]}`]:[]),...(c.items??[]).map(i=>`${i.method}: ${STATUS[i.status]?.label??i.status}${i.note?' — '+i.note:''}`)].join('\n');return `<td><button class="symbol ${esc(c.status)}" data-open="${esc(h.id)}" data-column="${esc(key)}" title="${esc(title)}" aria-label="${esc(`${h.n}, ${key}, ${s.label}. Open evidence`)}">${s.mark}</button></td>`;}).join('')}<td class="mono">${esc(fmtDate(h.probedAt))}${stale(h)?'<span class="stale">STALE · over 7 days</span>':''}</td></tr>`).join('');
  $('result-count').textContent = `${visible.length} of ${rows.length} records · ${columns.length} surfaces`;
  $('selected-count').textContent = `(${selected.size}/4)`;
  $('empty').hidden = !!visible.length;
  syncUrl();
}
function syncUrl() {
  const u = new URL(location.href);
  for (const [id,key] of [['search','q'],['state','state'],['scope','surface'],['sort','sort']]) {
    const v=$(id).value;
    if (v !== ({search:'',state:'all',scope:'all',sort:'recent'})[id]) u.searchParams.set(key,v); else u.searchParams.delete(key);
  }
  if(selected.size)u.searchParams.set('compare',[...selected].join(','));else u.searchParams.delete('compare');
  if($('compare-only').checked)u.searchParams.set('selected','1');else u.searchParams.delete('selected');
  history.replaceState(null,'',u);
}
function methodTable(h, column) {
  const targeted = new Set(COLUMNS.find(([key])=>key===column)?.[1]??[]);
  return `<table class="detail-table"><thead><tr><th>Method / observation</th><th>Evidence</th><th>Declared</th><th>What happened</th></tr></thead><tbody>${COLUMNS.flatMap(([,keys])=>keys).map(key=>{
    const r=h.methods?.[key]??{status:'na',note:'Not exercised in this run'};
    return `<tr ${targeted.has(key)?'class="target"':''}><td><code>${esc(key)}</code></td><td>${statusBadge(r.status)}</td><td>${r.advertised===true?'Yes':r.advertised===false?'No':'—'}</td><td>${r.reason?`<b class="reason">${esc(reasonLabel(r.reason))}</b><br>`:''}${esc(r.note??'Successful schema-checked response')}${r.blockedBy?`<br><span class="blocked">Depends on ${esc(r.blockedBy)}</span>`:''}${typeof r.errorCode==='number'?`<br><code>JSON-RPC ${r.errorCode}</code>`:''}${typeof r.latencyMs==='number'?`<br><span class="na">${r.latencyMs} ms</span>`:''}</td></tr>`;
  }).join('')}</tbody></table>`;
}
function missingEvidence(h) {
  const reasons=Object.entries(h.uncertaintyReasons??uncertaintyReasons(h.methods));
  if(!reasons.length)return '';
  return `<div class="notice"><b>Why evidence is missing</b><p>Unobserved checks have different causes. No scenario run and no client callback are not evidence of unsupported capabilities.</p><ul>${reasons.map(([reason,count])=>`<li>${esc(reasonLabel(reason))}: <strong>${count}</strong></li>`).join('')}</ul></div>`;
}
function scenarioEvidence(h) {
  if(!h.scenarios?.length)return '';
  return `<details open><summary>Scenario evidence · ${h.scenarios.length} controlled scenarios</summary><p class="record-description">Each scenario retains its configuration, tool outcomes and client callbacks. A successful prompt response alone does not establish that its tools succeeded. MCP results describe fixture interactions. File and terminal replies are simulated.</p><label class="scenario-filter">Scenario profile <select id="scenario-profile"><option value="all">All profiles</option>${[...new Set(h.scenarios.map(s=>s.profile))].map(p=>`<option value="${esc(p)}">${esc(p)}</option>`).join('')}</select></label>${h.scenarios.map(s=>`<details class="scenario" data-profile="${esc(s.profile)}"><summary><code>${esc(s.id)}</code> · ${esc(s.result.status==='pass'&&!s.id.startsWith('mcp:')?'Prompt answered':STATUS[s.result.status]?.label??s.result.status)}${s.tools?.some(t=>t.status==='failed')?' · <span class="fail">tool rejected / failed</span>':''}</summary><p>${s.result.reason?`<b>${esc(reasonLabel(s.result.reason))}.</b> `:''}${esc(s.result.note)}</p><dl class="record-meta"><div><dt>Profile</dt><dd>${esc(s.profile)}</dd></div><div><dt>Session</dt><dd>${esc(s.sessionId??'Not created')}</dd></div><div><dt>Configuration</dt><dd>${esc(JSON.stringify(s.configuration??{}))}</dd></div><div><dt>Client callbacks</dt><dd>${esc(Object.entries(s.callbacks??{}).filter(([,n])=>n).map(([k,n])=>`${k} ×${n}`).join(', ')||'None observed')}</dd></div><div><dt>Notifications</dt><dd>${esc((s.notifications??[]).join(', ')||'None observed')}</dd></div></dl>${s.tools?.length?`<table class="detail-table"><thead><tr><th>Tool</th><th>Outcome</th><th>Agent detail</th></tr></thead><tbody>${s.tools.map(t=>`<tr><td>${esc(t.name??t.id)}</td><td class="${t.status==='failed'?'fail':''}">${esc(t.status??'Unrecorded')}</td><td>${esc(t.detail??'—')}</td></tr>`).join('')}</tbody></table>`:''}${s.model?`<p>Model issued: ${esc(s.model.issuedTools.join(', ')||'No tool calls')}<br>Skipped stimuli: ${esc(s.model.skippedCalls.join('; ')||'None')}</p>`:''}${s.mcpEvents?.length?`<pre>${esc(JSON.stringify(s.mcpEvents,null,2))}</pre>`:''}${s.diagnostics?.length?`<details><summary>Agent stderr diagnostics · separate from protocol results</summary><pre>${esc(s.diagnostics.join('\n'))}</pre></details>`:''}</details>`).join('')}</details>`;
}
function showRecord(id, column, updateHash = true) {
  const h=rows.find(h=>h.id===id); if(!h)return;
  $('record-title').textContent=h.n;
  const env=h.environment??{};
  const profile=env.profile==='mock'?`Mock provider · ${env.mockRequests??'unrecorded'} model requests`:env.profile==='external-provider'?'External provider · credentials not inferred':env.profile==='not-started'?'No completed run':'Not recorded';
  const meta=[['Agent version',h.version??'Not recorded'],['Probed at',fmtDate(h.probedAt)],['Environment',profile],['Client services',env.client==='simulated'?'Simulated file, terminal and permission replies':'Not recorded'],['Discovery mode',typeof env.discovery==='boolean'?(env.discovery?'Explicit diagnostic discovery':'Capability-negotiated'):'Not recorded'],['Recipe SHA-256',env.recipeSha256??'Not recorded'],['Runtime',env.platform?`${env.platform} · ${env.node}`:'Not recorded'],['Methodology',h.methodologyVersion??'Historical v1'],['Schema SHA-256',h.schemaSha256??'Not recorded'],['Probe revision',env.revision?`${env.revision}${env.sourceDirty?' · local modifications':''}`:'Not recorded'],['Probe source SHA-256',env.sourceHash??'Not recorded'],['Dependencies SHA-256',env.dependencySha256??'Not recorded'],['MCP fixture SDK',env.mcpSdkVersion??'Not recorded']];
  const counts=h.summary?['pass','observed','blocked','unsupported','fail','partial','error','na'].filter(s=>h.summary[s]>0).map(s=>`<span class="${s}">${h.summary[s]} ${STATUS[s].label.toLowerCase()}</span>`).join(''):'';
  $('record-body').innerHTML = `${stateBadge(h)}<p class="record-description">${esc(h.desc??'')}</p>${!current(h)?'<div class="notice">This historical run used the previous scoring method. Its old grades have not been converted into verified evidence. A new probe is required; original notes are retained below.</div>':''}${stale(h)?'<div class="notice">This run is more than seven days old. It describes the recorded version and environment, not necessarily the latest release.</div>':''}${h.setup?.status==='error'?`<div class="notice issue"><b>Test setup failed.</b> ${esc(h.setup.note)} ${h.setup.phase==='execution'?'The measurement did not finish.':'ACP was not launched.'}</div>`:''}${current(h)&&h.summary?.blocked?'<div class="notice">Some observations are blocked by prerequisites. Follow the “Depends on” entries to the cause; these are not evidence that the agent lacks those capabilities.</div>':''}<div class="summary-counts">${counts}</div><div class="record-links">${h.reportUrl?link(h.reportUrl,'Download evidence JSON'):''}${env.ciUrl?link(env.ciUrl,'CI run & full transcript'):''}${link(h.url,'Agent documentation')}${link('https://github.com/wibus-wee/acp-wall/issues/new','Appeal this result')}</div><dl class="record-meta">${meta.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>${env.command?`<details><summary>Recorded launch command</summary><pre>${esc(env.command)}</pre><p class="record-description">Run through the registry entry to reproduce preparation and environment settings.</p></details>`:''}${current(h)?missingEvidence(h)+methodTable(h,column)+scenarioEvidence(h):`<details open><summary>Historical observations · unvalidated by current method</summary><pre>${esc(JSON.stringify(h.historicalNotes??{},null,2))}</pre></details>`}${h.attempts?.length?`<details><summary>Request attempts · scenario, timestamp and outcome</summary><pre>${esc(JSON.stringify(h.attempts,null,2))}</pre></details>`:''}${h.transport?`<details><summary>Transport observations · interception disclosure</summary><pre>${esc(JSON.stringify(h.transport,null,2))}</pre></details>`:''}${env.modelEvidence?`<details><summary>Model-side scenario evidence</summary><pre>${esc(JSON.stringify(env.modelEvidence,null,2))}</pre></details>`:''}${h.violations?.length?`<details open><summary>Schema diagnostics (${h.violations.length})</summary><pre>${esc(h.violations.map(v=>`${v.where} · ${v.method} · ${v.path||'(root)'}\n${v.msg}`).join('\n\n'))}</pre></details>`:''}${h.claimMismatches?.length?`<details open><summary>Capability declaration mismatches</summary><pre>${esc(JSON.stringify(h.claimMismatches,null,2))}</pre></details>`:''}<details><summary>Advertised capabilities and authentication methods</summary><pre>${esc(JSON.stringify(h.advertised??{note:'Not preserved in this historical row'},null,2))}</pre></details><details><summary>Extension evidence${h.lodyAdapter?' · Lody adapter available':''}</summary><p class="record-description">Advertised features do not establish successful execution. Endpoint replies may be errors. Extension observations are separate from the matrix.</p><pre>${esc(JSON.stringify({namespaces:h.ext??null,lody:h.lody??null,adapterAvailable:h.lodyAdapter??null},null,2))}</pre></details>`;
  if(!$('record').open)$('record').showModal();
  $('record').scrollTop=0;
  if(column)requestAnimationFrame(()=>$('record-body').querySelector('.target')?.scrollIntoView({block:'center'}));
  if(updateHash){const u=new URL(location.href);u.hash=`agent=${encodeURIComponent(id)}${column?'&column='+encodeURIComponent(column):''}`;history.replaceState(null,'',u);}
}
function fromHash(){const q=new URLSearchParams(location.hash.slice(1));if(q.has('agent'))showRecord(q.get('agent'),q.get('column'),false);}
$('record-body').addEventListener('change',e=>{if(e.target.id==='scenario-profile')for(const row of $('record-body').querySelectorAll('.scenario'))row.hidden=e.target.value!=='all'&&row.dataset.profile!==e.target.value;});
$('matrix-body').addEventListener('click',e=>{const b=e.target.closest('[data-open]');if(b)showRecord(b.dataset.open,b.dataset.column);});
$('matrix-body').addEventListener('change',e=>{const id=e.target.dataset.select;if(!id)return;if(e.target.checked&&selected.size<4)selected.add(id);else selected.delete(id);render();$('matrix-body').querySelector(`input[data-select="${CSS.escape(id)}"]`)?.focus();});
for(const id of ['state','scope','sort','compare-only'])$(id).addEventListener('change',render);
$('search').addEventListener('input',render);
$('clear').addEventListener('click',()=>{for(const id of ['state','scope'])$(id).value='all';$('sort').value='recent';$('search').value='';$('compare-only').checked=false;selected.clear();render();});
$('close-record').addEventListener('click',()=>$('record').close());
$('record').addEventListener('click',e=>{if(e.target===$('record')){const r=$('record').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('record').close();}});
$('record').addEventListener('close',()=>{const u=new URL(location.href);if(u.hash.startsWith('#agent=')){u.hash='';history.replaceState(null,'',u);}});
window.addEventListener('hashchange',fromHash);
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();if($('record').open)$('record').close();$('search').focus();}});
const params=new URLSearchParams(location.search);
for(const [id,key]of [['search','q'],['state','state'],['scope','surface'],['sort','sort']])if(params.has(key))$(id).value=params.get(key);
for(const id of (params.get('compare')??'').split(',').slice(0,4))if(rows.some(h=>h.id===id))selected.add(id);
$('compare-only').checked=params.get('selected')==='1';
for(const id of ['state','scope'])if(!$(id).value)$(id).value='all';if(!$('sort').value)$('sort').value='recent';
render();fromHash();
