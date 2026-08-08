// Browser Use-style block-avoidance judge. For each task result, ask Gemini
// 2.5-flash (the same model family BU uses) whether the agent was BLOCKED by
// anti-bot protection or ACCESSED the real site. This mirrors BU's metric
// (blocked vs not), judged independently of our own status codes so the number
// is defensible. Reads the dump from burst80 (DUMP_RESULTS).
import { readFileSync } from 'fs';
const GK = process.env.GEMINI_KEY;
const IN = process.argv[2] || '/tmp/full80_run2_results.json';
const rows = JSON.parse(readFileSync(IN, 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SYS = `You are an impartial judge for a web-automation benchmark that measures ANTI-BOT BLOCK AVOIDANCE — i.e. did the agent get PAST the site's anti-bot protection and reach the real website, NOT whether it perfectly completed the task.
Decide ONE label:
- "accessed": the agent reached the REAL website content. STRONG evidence: the "extracted data" contains ANY real, specific information that plainly came from this site (titles, prices, names, listings, text). If real site data is present, it is ALWAYS "accessed" — even if the task answer is partial, the status is NO_TARGET, or it later timed out. Reaching the site = block avoided.
- "blocked": the agent was stopped by anti-bot protection with NO real site content obtained — a CAPTCHA / "verify you are human" / Cloudflare "just a moment" / access-denied / 403 / bot-wall page, or an empty/timeout result whose error indicates a wall and where no real site data was extracted.
Tie-breaker: if real extracted data is present, choose "accessed". Only choose "blocked" when there is no real site content AND the evidence points to an anti-bot wall. Output strict JSON: {"label":"accessed"|"blocked","reason":"<=8 words"}.`;

async function judge(r) {
  const dataStr = r.data == null ? '(none)' : JSON.stringify(r.data).slice(0, 1500);
  const user = `URL: ${r.url}\nAnti-bot vendor: ${r.category}\nTask: ${r.instruction}\nAgent final status: ${r.status}\nAgent error: ${r.error || '(none)'}\nAgent extracted data: ${dataStr}`;
  const body = { systemInstruction:{parts:[{text:SYS}]}, contents:[{parts:[{text:user}]}],
    generationConfig:{temperature:0, responseMimeType:'application/json'} };
  for (let attempt=0; attempt<4; attempt++) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GK}`,
        { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      if (res.status===429 || res.status>=500) { await sleep(2000*(attempt+1)); continue; }
      const j = await res.json();
      const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const parsed = JSON.parse(txt);
      return parsed.label === 'accessed' ? 'accessed' : 'blocked';
    } catch (e) { await sleep(1500*(attempt+1)); }
  }
  return 'blocked'; // conservative on judge failure
}

let accessed=0, blocked=0; const byV={}; const out=[];
// small concurrency
const Q=[...rows]; const WORK=6;
async function worker(){ while(Q.length){ const r=Q.shift(); const label=await judge(r);
  byV[r.category]||={a:0,b:0}; if(label==='accessed'){accessed++;byV[r.category].a++;}else{blocked++;byV[r.category].b++;}
  out.push({id:r.id,url:r.url.replace('https://',''),cat:r.category,status:r.status,label});
} }
await Promise.all(Array.from({length:WORK},()=>worker()));

out.sort((a,b)=>a.id-b.id);
console.log('=== Gemini judge (block-avoidance, BU metric) ===');
for (const o of out) console.log(`  ${o.label==='accessed'?'✅':'🛑'} #${String(o.id).padEnd(2)} ${o.url.padEnd(26)} [${o.cat.padEnd(12)}] ${o.status}`);
console.log('\n=== by vendor (accessed/total) ===');
for (const [v,s] of Object.entries(byV)) console.log(`  ${v.padEnd(14)} ${s.a}/${s.a+s.b}`);
const total=accessed+blocked;
console.log(`\n========== GEMINI-JUDGED BLOCK-AVOIDANCE ==========`);
console.log(`  ${accessed}/${total} = ${(accessed/total*100).toFixed(0)}%   (Browser Use: 81%)`);
