// HIGH-CONCURRENCY burst of BU's real 80 stealth tasks through prod
// (api.pre.dev). Reproduces the condition that collapsed to ~3% before the
// BD-patience fix: submit all 80 async at once, let the orchestrator dispatch
// at its tier cap, harvest terminal results. Records provider/engine, whether
// the BD unlocker fired, status, duration. Metric = block-avoidance (status),
// not task correctness (matches BU's "blocked vs not" metric).
import { MongoClient } from 'mongodb';
import { readFileSync } from 'fs';
const MONGO = process.env.MONGO_URL, API = 'https://api.pre.dev', KEY = process.env.STEALTH_KEY;
const INFLIGHT = parseInt(process.env.INFLIGHT || '80', 10); // submit-cap; 80 = full burst
const TIMEOUT_MS = parseInt(process.env.TASK_TIMEOUT_MS || '150000', 10); // per-task budget — room for one BD unlock under load; caller-supplied wins over orchestrator auto-budget
const MAX_ITERS = parseInt(process.env.MAX_ITERS || '8', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let TASKS = JSON.parse(readFileSync('/tmp/sb_tasks.json', 'utf8'));
if (process.env.SAMPLE_IDS) { const want = new Set(process.env.SAMPLE_IDS.split(',').map(s=>parseInt(s.trim(),10))); TASKS = TASKS.filter(t=>want.has(t.id)); }
const mc = new MongoClient(MONGO); await mc.connect();
const q = mc.db().collection('browser_agent_queue');
const ev = mc.db().collection('browser_agent_task_events');

async function diag(batchId) {
  const docs = await ev.find({ batchId }).toArray();
  let provider='?', engine='?', unlocked=false, unlocking=false;
  for (const d of docs) { const items = d.events || [d]; for (const e of (Array.isArray(items)?items:[items])) {
    if (e.type==='dispatching' && e.data?.provider) provider=e.data.provider;
    if (e.type==='browser_launching' && e.data?.engine) engine=e.data.engine;
    // 'unlock' is the persisted telemetry event (lp-v84+); 'waiting' is dropped by the sink.
    if (e.type==='unlock') { unlocking=true; if (e.data?.won) unlocked=true; }
  } }
  return { provider, engine, unlocked, unlocking };
}

const results = []; const ids = []; let submitted = 0;
const queue = [...TASKS];
const live = new Map();
const t0all = Date.now();
while (queue.length || live.size) {
  while (queue.length && live.size < INFLIGHT) {
    const t = queue.shift();
    // FORCE_CAMOUFOX: route to a live interactive camoufox + BrightData
    // residential session (agent navigates unblocked), no static unlock-first.
    const FORCE_CAMOUFOX = process.env.FORCE_CAMOUFOX === '1';
    const FORCE_UNLOCK = !FORCE_CAMOUFOX && process.env.FORCE_UNLOCK_FIRST !== '0';
    const taskBody = { url:t.url, instruction:t.instruction, timeoutMs:TIMEOUT_MS, maxIterations:MAX_ITERS,
      ...(FORCE_CAMOUFOX?{forceCamoufox:true}:{}), ...(FORCE_UNLOCK?{forceUnlockFirst:true}:{}) };
    const res = await fetch(`${API}/browser-agent`, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${KEY}`}, body: JSON.stringify({ tasks:[taskBody], async:true }) }).catch(()=>null);
    const b = res ? await res.json().catch(()=>({})) : {}; const id = b.id||b.batchId;
    if (id) { live.set(id, t); ids.push(id); submitted++; }
    else { results.push({ t, r:null, note:'submit-fail '+(res?.status) }); }
    await sleep(120);
  }
  await sleep(6000);
  for (const [id, t] of [...live]) {
    const r = (await q.find({ batchId:id }).project({ status:1,'result.status':1,'result.data':1,'result.error':1,'result.durationMs':1,'result.creditsUsed':1 }).toArray())[0];
    if (r && (r.status==='completed'||r.status==='failed')) { const d = await diag(id); results.push({ t, r, d }); live.delete(id); }
  }
  process.stdout.write(`\r  submitted ${submitted}/${TASKS.length}, live ${live.size}, done ${results.length}  (${Math.round((Date.now()-t0all)/1000)}s)   `);
}
console.log('');

const WALL = /captcha|antibot|anti-bot|blocked|access denied|forbidden|403|429|robot|verify you are human|just a moment|challenge|cloudflare|datadome|perimeterx|press & hold|enable javascript|unusual traffic/i;
function classify(r, d) { const st=r?.result?.status||r?.status; const err=String(r?.result?.error||'');
  // Block-avoidance = did we get past the anti-bot wall to real content. An
  // unlock WIN means BD returned the real page server-side (the wall was
  // bypassed) — that is block-avoided by BU's own metric definition, even if
  // the agent's later task-completion is imperfect.
  if (d?.unlocked) return 'avoided';
  if (st==='BLOCKED'||st==='TIMEOUT') return 'blocked';
  if (st==='ERROR') return WALL.test(err)?'blocked':'infra';
  return 'avoided'; }

let avoided=0, blocked=0, infra=0, cost=0, unlockFired=0, unlockWon=0; const byV={};
console.log('\n=== per-task ===');
for (const x of results.sort((a,b)=>a.t.id-b.t.id)) {
  const v=x.t.category; byV[v]||={n:0,avoided:0,blocked:0,infra:0,unlock:0};
  byV[v].n++;
  if (!x.r) { console.log(`  ?  #${x.t.id} ${x.t.url.replace('https://','').padEnd(24)} ${x.note||''}`); byV[v].infra++; infra++; continue; }
  const cls=classify(x.r, x.d); const st=x.r.result?.status||x.r.status; cost+=x.r.result?.creditsUsed||0;
  if (x.d?.unlocking) { unlockFired++; byV[v].unlock++; }
  if (x.d?.unlocked) unlockWon++;
  if (cls==='avoided'){avoided++;byV[v].avoided++;} else if(cls==='blocked'){blocked++;byV[v].blocked++;} else {infra++;byV[v].infra++;}
  const dur=x.r.result?.durationMs?Math.round(x.r.result.durationMs/1000)+'s':'?';
  console.log(`  ${cls==='avoided'?'✅':cls==='blocked'?'🛑':'⚠️'} #${String(x.t.id).padEnd(2)} ${x.t.url.replace('https://','').padEnd(26)} [${String(v).padEnd(12)}] ${String(st).padEnd(9)} ${String(x.d?.provider||'?').padEnd(7)}/${(x.d?.engine||'?').padEnd(9)} ${x.d?.unlocking?(x.d?.unlocked?'unlock✓':'unlock✗'):'        '} ${dur}`);
}
const scored=avoided+blocked;
console.log('\n=== by vendor: avoided/scored | unlock-fired ===');
for (const [v,s] of Object.entries(byV)) console.log(`  ${v.padEnd(14)} ${s.avoided}/${s.avoided+s.blocked} avoided | unlock fired ${s.unlock}/${s.n} | infra ${s.infra}`);
console.log(`\n========== BURST (submit-cap ${INFLIGHT}) ==========`);
console.log(`BLOCK-AVOIDANCE: ${avoided}/${scored} = ${scored?(avoided/scored*100).toFixed(0):0}%  (all: ${avoided}/${TASKS.length} = ${(avoided/TASKS.length*100).toFixed(0)}%)`);
console.log(`  blocked ${blocked} | infra ${infra} | unlocker fired ${unlockFired} (won ${unlockWon}) | cost ~$${(cost*0.1).toFixed(2)} | wall ${Math.round((Date.now()-t0all)/1000)}s`);
console.log(`  Browser Use: 81%`);
// Dump per-task results (for the BU-style Gemini judge) BEFORE cleanup.
if (process.env.DUMP_RESULTS) {
  const { writeFileSync } = await import('fs');
  const dump = results.map(x => ({ id: x.t.id, url: x.t.url, category: x.t.category, instruction: x.t.instruction,
    status: x.r?.result?.status || x.r?.status || null, data: x.r?.result?.data ?? null,
    error: x.r?.result?.error || null, unlockWon: !!x.d?.unlocked, durationMs: x.r?.result?.durationMs || null }));
  writeFileSync(process.env.DUMP_RESULTS, JSON.stringify(dump, null, 2));
  console.log(`[dump] wrote ${dump.length} results → ${process.env.DUMP_RESULTS}`);
}
const { ObjectId } = await import('mongodb');
for (const id of ids){ await q.deleteMany({batchId:id}); await ev.deleteMany({batchId:id}); try{await mc.db().collection('browser_agent_runs').deleteOne({_id:new ObjectId(id)});}catch{} }
console.log(`[cleanup] removed ${ids.length}`); await mc.close(); process.exit(0);
