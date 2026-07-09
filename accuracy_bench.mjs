// Accuracy/speed/cost battery on REAL-WORLD tasks (tasks.json) through the
// DEFAULT fast prod path (no forceCamoufox/forceUnlock). Grades each result with
// its programmatic successCheckSrc — so it catches FALSE SUCCESSES (status=SUCCESS
// but wrong/empty data), the accuracy bug class. Reports accuracy %, false-success
// count, median speed, total cost, and unlock-fired (cost signal).
import { MongoClient } from 'mongodb';
import { readFileSync } from 'fs';
const MONGO = process.env.MONGO_URL, API = 'https://api.pre.dev', KEY = process.env.STEALTH_KEY;
const INFLIGHT = parseInt(process.env.INFLIGHT || '6', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let TASKS = JSON.parse(readFileSync(process.env.TASKS_FILE || 'tasks.json', 'utf8'));
TASKS = (Array.isArray(TASKS) ? TASKS : TASKS.tasks).map((t, i) => ({ id: i + 1, ...t }));
if (process.env.SAMPLE) { const n = parseInt(process.env.SAMPLE, 10); const step = Math.max(1, Math.floor(TASKS.length / n)); TASKS = TASKS.filter((_, i) => i % step === 0).slice(0, n); }
if (process.env.IDS) { const w = new Set(process.env.IDS.split(',').map(s => parseInt(s, 10))); TASKS = TASKS.filter(t => w.has(t.id)); }

const HELPERS = `
function findArray(obj){if(Array.isArray(obj))return obj;if(obj&&typeof obj==="object"){for(const v of Object.values(obj)){const f=findArray(v);if(f)return f;}}return null;}
function findValue(obj,p){if(p(obj))return obj;if(obj&&typeof obj==="object"){for(const v of Object.values(obj)){const f=findValue(v,p);if(f!==undefined)return f;}}return undefined;}
function findStr(obj,sub){return findValue(obj,(v)=>typeof v==="string"&&v.toLowerCase().includes(sub.toLowerCase()));}
`;
function grade(t, data) {
  if (!t.successCheckSrc) return { success: data != null, reason: 'no-check' };
  try { const fn = new Function('result', `${HELPERS}\nreturn (${t.successCheckSrc})(result);`); return fn({ data, success: true }); }
  catch (e) { return { success: false, reason: 'check-threw: ' + e.message }; }
}

const mc = new MongoClient(MONGO); await mc.connect();
const q = mc.db().collection('browser_agent_queue'), ev = mc.db().collection('browser_agent_task_events');
async function unlockFired(batchId) { const docs = await ev.find({ batchId }).toArray(); for (const d of docs) { const items = d.events || [d]; for (const e of (Array.isArray(items) ? items : [items])) if (e.type === 'unlock') return true; } return false; }

const results = [], ids = []; let submitted = 0;
const queue = [...TASKS], live = new Map();
while (queue.length || live.size) {
  while (queue.length && live.size < INFLIGHT) {
    const t = queue.shift();
    const res = await fetch(`${API}/browser-agent`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, body: JSON.stringify({ tasks: [{ url: t.url, instruction: t.instruction, output: t.output }], async: true }) }).catch(() => null);
    const b = res ? await res.json().catch(() => ({})) : {}; const id = b.id || b.batchId;
    if (id) { live.set(id, t); ids.push(id); submitted++; } else results.push({ t, r: null });
    await sleep(40);
  }
  await sleep(1500);
  for (const [id, t] of [...live]) {
    const r = (await q.find({ batchId: id }).project({ status: 1, 'result.status': 1, 'result.data': 1, 'result.error': 1, 'result.durationMs': 1, 'result.creditsUsed': 1 }).toArray())[0];
    if (r && (r.status === 'completed' || r.status === 'failed')) { results.push({ t, r, unlock: await unlockFired(id) }); live.delete(id); }
  }
  process.stdout.write(`\r  submitted ${submitted}/${TASKS.length}, live ${live.size}, done ${results.length}   `);
}
console.log('');

let pass = 0, falseSucc = 0, hardFail = 0, cost = 0, unlocks = 0; const durs = [];
console.log('\n=== per-task (accuracy graded by programmatic verifier) ===');
for (const x of results.sort((a, b) => a.t.id - b.t.id)) {
  if (!x.r) { console.log(`  ?? #${x.t.id} ${x.t.url.replace(/https?:\/\//, '').slice(0, 30)} submit-fail`); hardFail++; continue; }
  const st = x.r.result?.status || x.r.status; const g = grade(x.t, x.r.result?.data);
  cost += x.r.result?.creditsUsed || 0; if (x.unlock) unlocks++; if (x.r.result?.durationMs) durs.push(x.r.result.durationMs);
  if (g.success) pass++; else if (st === 'SUCCESS') falseSucc++; else hardFail++;
  const mark = g.success ? '✅' : (st === 'SUCCESS' ? '❌FALSE-SUCC' : '🛑fail');
  const errTxt = !g.success ? ` ERR="${String(x.r.result?.error || '').slice(0, 60)}"` : '';
  console.log(`  ${mark} #${String(x.t.id).padEnd(3)} ${x.t.url.replace(/https?:\/\//, '').slice(0, 30).padEnd(30)} ${String(st).padEnd(9)} ${x.r.result?.durationMs ? Math.round(x.r.result.durationMs / 1000) + 's' : '?'} ${x.unlock ? 'unlock' : ''} ${g.reason || ''}${errTxt}`);
}
durs.sort((a, b) => a - b);
const n = results.length;
console.log(`\n========== ACCURACY / SPEED / COST (default fast path, n=${n}) ==========`);
console.log(`  ACCURATE (verifier pass): ${pass}/${n} = ${(pass / n * 100).toFixed(0)}%`);
console.log(`  FALSE-SUCCESS (said SUCCESS, wrong/empty): ${falseSucc}`);
console.log(`  hard fail (BLOCKED/TIMEOUT/ERROR/null): ${hardFail}`);
console.log(`  speed: median ${durs.length ? Math.round(durs[Math.floor(durs.length / 2)] / 1000) : '?'}s | p90 ${durs.length ? Math.round(durs[Math.floor(durs.length * 0.9)] / 1000) : '?'}s`);
console.log(`  cost: ${cost.toFixed(2)} credits total (~$${(cost * 0.1).toFixed(3)}) | unlock fired on ${unlocks}/${n}`);
if (process.env.DUMP) { const { writeFileSync } = await import('fs'); writeFileSync(process.env.DUMP, JSON.stringify(results.map(x => ({ id: x.t.id, url: x.t.url, instruction: x.t.instruction, status: x.r?.result?.status, data: x.r?.result?.data, grade: x.r ? grade(x.t, x.r.result?.data) : null, durationMs: x.r?.result?.durationMs, creditsUsed: x.r?.result?.creditsUsed ?? 0, unlock: x.unlock })), null, 2)); console.log(`[dump] ${process.env.DUMP}`); }
const { ObjectId } = await import('mongodb');
for (const id of ids) { await q.deleteMany({ batchId: id }); await ev.deleteMany({ batchId: id }); try { await mc.db().collection('browser_agent_runs').deleteOne({ _id: new ObjectId(id) }); } catch {} }
console.log(`[cleanup] removed ${ids.length}`); await mc.close(); process.exit(0);
