import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
const root=resolve(import.meta.dirname,'../..');
function page() {
 const html=readFileSync(resolve(root,'index.html'),'utf8');
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'http://localhost/'});
 dom.window.HTMLElement.prototype.scrollIntoView=function(){};
 const caps=['initialize','session/new','session/prompt'];
 dom.window.__ACP_WALL__={generatedAt:'2026-10-25T00:00:00Z',caps,harnesses:[
   {n:'Blocked Agent',v:'Fixture',score:4,tier:'limited',cells:[1,-1,-1],methods:{initialize:{status:'pass'},'session/new':{status:'blocked',reason:'authentication'}},lody:{advertised:{},answered:['_lody/rate_limits/get'],observed:[]}},
   {n:'Measured Agent',v:'Fixture',score:2,tier:'limited',cells:[1,1,1],methods:Object.fromEntries(caps.map(k=>[k,{status:'pass'}]))},
 ]};
 dom.window.eval(readFileSync(resolve(root,'ui/evidence-view.js'),'utf8'));
 const code=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
 dom.window.eval(code);return dom;
}
test('actual page ranks all rows by score, retains blocked scores, and supports expansion',()=>{
 const dom=page();try {
  const d=dom.window.document;
  assert.equal(d.querySelector('#list-unmeasured'),null);
  assert.match(d.querySelector('#list-limited').textContent,/Blocked Agent/);
  assert.match(d.querySelector('#lg-body tr.rowhead').textContent,/Blocked Agent/);
  const row=[...d.querySelectorAll('#lg-body tr.rowhead')].find(r=>r.textContent.includes('Blocked Agent'));
  assert.equal(row.querySelector('.lody-col').textContent,'·');assert.equal(row.querySelector('.lg-sc').textContent,'4');
  assert.doesNotMatch(row.textContent,/Authentication blocked/);
  row.click();assert.equal(row.nextElementSibling.querySelector('.xp').hasAttribute('hidden'),false);
  assert.match(row.nextElementSibling.textContent,/Endpoint replies are diagnostic only/);
  const input=d.querySelector('#pal-in');input.value='tier:limited';input.dispatchEvent(new dom.window.Event('input'));
  assert.match(d.querySelector('#pal-list').textContent,/Blocked Agent/);
  const toggle=d.querySelector('#lody-tog');toggle.checked=false;toggle.dispatchEvent(new dom.window.Event('change'));assert.equal(d.body.classList.contains('no-lody'),true);
 }finally{dom.window.close();}
});
