// CLEAN baseline on BU's real 80 tasks at LOW concurrency (<=6) + per-task
// diagnostics: which provider/engine ran, did camoufox engage, status, wall.
import { MongoClient } from 'mongodb';
import { readFileSync } from 'fs';
const MONGO = process.env.MONGO_URL, API = 'https://api.pre.dev', KEY = process.env.STEALTH_KEY;
const MAX_INFLIGHT = 6;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TASKS = JSON.parse(readFileSync('/tmp/sb_tasks.json', 'utf8'));
const mc = new MongoClient(MONGO); await mc.connect();
const q = mc.db().collection('browser_agent_queue'); const ev = mc.db().collection('browser_agent_task_events');

async function diag(batchId) {
  const docs = await ev.find({ batchId }).toArray();
  let provider='?', engine='?';
  for (const d of docs) { const items = d.events || [d]; for (const e of (Array.isArray(items)?items:[items])) {
    if (e.type==='dispatching' && e.data?.provider) provider=e.data.provider;
    if (e.type==='browser_launching' && e.data?.engine) engine=e.data.engine;
  } }
  return { provider, engine };
}

const results = []; const ids = []; let submitted = 0;
async function inflight() { return q.countDocuments({ userId: KEY, status: { $in:['pending','claimed','running'] } }); }

// submit with in-flight gate
const queue = [...TASKS];
const live = new Map(); // batchId -> task
while (queue.length || live.size) {
  // top up to MAX_INFLIGHT
  while (queue.length && live.size < MAX_INFLIGHT) {
    const t = queue.shift();
    const res = await fetch(`${API}/browser-agent`, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${KEY}`}, body: JSON.stringify({ tasks:[{ url:t.url, instruction:t.instruction }], async:true }) }).catch(()=>null);
    const b = res ? await res.json().catch(()=>({})) : {}; const id = b.id||b.batchId;
    if (id) { live.set(id, t); ids.push(id); submitted++; }
    else { results.push({ t, r:null, note:'submit-fail '+(res?.status) }); }
    await sleep(300);
  }
  await sleep(6000);
  // harvest terminal
  for (const [id, t] of [...live]) {
    const r = (await q.find({ batchId:id }).project({ status:1,'result.status':1,'result.data':1,'result.error':1,'result.durationMs':1,'result.creditsUsed':1 }).toArray())[0];
    if (r && (r.status==='completed'||r.status==='failed')) { const d = await diag(id); results.push({ t, r, d }); live.delete(id); }
  }
  process.stdout.write(`\r  submitted ${submitted}/${TASKS.length}, live ${live.size}, done ${results.length}   `);
}
console.log('');

const WALL = /captcha|antibot|anti-bot|blocked|access denied|forbidden|403|429|robot|verify you are human|just a moment|challenge|cloudflare|datadome|perimeterx|press & hold|enable javascript|unusual traffic/i;
function classify(r) { const st=r?.result?.status||r?.status; const err=String(r?.result?.error||'');
  if (st==='BLOCKED'||st==='TIMEOUT') return 'blocked';
  if (st==='ERROR') return WALL.test(err)?'blocked':'infra';
  return 'avoided'; }

let avoided=0, blocked=0, infra=0, cost=0, camoufoxFired=0; const byV={};
console.log('\n=== per-task (provider/engine shows if arsenal engaged) ===');
for (const x of results.sort((a,b)=>a.t.id-b.t.id)) {
  const v=x.t.category; byV[v]||={n:0,avoided:0,blocked:0,infra:0,camoufox:0};
  byV[v].n++;
  if (!x.r) { console.log(`  ?  #${x.t.id} ${x.t.url.replace('https://','').padEnd(24)} ${x.note||''}`); continue; }
  const cls=classify(x.r); const st=x.r.result?.status||x.r.status; cost+=x.r.result?.creditsUsed||0;
  const cf = x.d?.engine==='camoufox'; if (cf){camoufoxFired++;byV[v].camoufox++;}
  if (cls==='avoided'){avoided++;byV[v].avoided++;} else if(cls==='blocked'){blocked++;byV[v].blocked++;} else {infra++;byV[v].infra++;}
  console.log(`  ${cls==='avoided'?'✅':cls==='blocked'?'🛑':'⚠️'} #${String(x.t.id).padEnd(2)} ${x.t.url.replace('https://','').padEnd(24)} [${String(v).padEnd(13)}] ${String(st).padEnd(9)} ${String(x.d?.provider||'?').padEnd(7)}/${(x.d?.engine||'?').padEnd(9)} ${x.r.result?.durationMs||'?'}ms`);
}
const scored=avoided+blocked;
console.log('\n=== by vendor: avoided/scored | camoufox-engaged ===');
for (const [v,s] of Object.entries(byV)) console.log(`  ${v.padEnd(15)} ${s.avoided}/${s.avoided+s.blocked} avoided | camoufox fired ${s.camoufox}/${s.n} | infra ${s.infra}`);
console.log('\n========== CLEAN BASELINE (conc<=6) ==========');
console.log(`BLOCK-AVOIDANCE: ${avoided}/${scored} = ${scored?(avoided/scored*100).toFixed(0):0}%  (all: ${avoided}/${TASKS.length} = ${(avoided/TASKS.length*100).toFixed(0)}%)`);
console.log(`  blocked ${blocked} | infra ${infra} | camoufox engaged on ${camoufoxFired}/${TASKS.length} tasks | cost ~$${(cost*0.1).toFixed(2)}`);
console.log(`  Browser Use: 81%`);
const { ObjectId } = await import('mongodb');
for (const id of ids){ await q.deleteMany({batchId:id}); await ev.deleteMany({batchId:id}); try{await mc.db().collection('browser_agent_runs').deleteOne({_id:new ObjectId(id)});}catch{} }
console.log(`[cleanup] removed ${ids.length}`); await mc.close(); process.exit(0);
