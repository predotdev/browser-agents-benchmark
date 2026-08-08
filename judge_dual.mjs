// Dual-metric judge on the BU 80. Per task, Gemini 2.5-flash returns:
//  - blocked_by_antibot: was the agent stopped by anti-bot protection (captcha,
//    challenge, access-denied, "unusual activity", IP block, bot wall)? This is
//    Browser Use's block-avoidance metric (their 81%). NOT-blocked counts even
//    if the task wasn't fully completed, as long as no anti-bot wall stopped it.
//  - delivered_real_data: did the result contain real, useful site data for the
//    task (strict task-delivery)?
import { readFileSync } from 'fs';
const GK = process.env.GEMINI_KEY;
const rows = JSON.parse(readFileSync(process.argv[2] || '/tmp/bu80_lpv88_results.json', 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SYS = `You are scoring an anti-bot STEALTH benchmark on hard websites. For the given task and the agent's result, output strict JSON with TWO booleans:
{"blocked_by_antibot": <true|false>, "delivered_real_data": <true|false>}
- blocked_by_antibot = true ONLY if the result shows the agent was stopped by ANTI-BOT protection: a CAPTCHA, "verify you are human", Cloudflare "just a moment", "access denied/restricted", "unusual activity/traffic", press-and-hold, bot wall, or an empty/error result whose error clearly indicates an anti-bot block. A plain timeout, a slow site, or "reached the page but couldn't find the specific item" is NOT an anti-bot block (blocked_by_antibot=false).
- delivered_real_data = true if the extracted data contains real, specific information from the site relevant to the task (names, prices, titles, listings, etc.). Block-page text, nulls, empty arrays, or generic error messages = false.
Be precise. Output ONLY the JSON.`;
async function judge(r) {
  const dataStr = r.data == null ? '(none)' : JSON.stringify(r.data).slice(0, 1500);
  const user = `URL: ${r.url}\nAnti-bot vendor: ${r.category||'?'}\nTask: ${(r.instruction||'').slice(0,400)}\nAgent status: ${r.status}\nAgent error: ${r.error||'(none)'}\nExtracted data: ${dataStr}`;
  const body = { systemInstruction:{parts:[{text:SYS}]}, contents:[{parts:[{text:user}]}], generationConfig:{temperature:0,responseMimeType:'application/json'} };
  for (let a=0;a<4;a++){ try{
    const res=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GK}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(res.status===429||res.status>=500){await sleep(2000*(a+1));continue;}
    const j=await res.json(); const p=JSON.parse(j?.candidates?.[0]?.content?.parts?.[0]?.text||'{}');
    return { blocked: !!p.blocked_by_antibot, delivered: !!p.delivered_real_data };
  }catch{await sleep(1500*(a+1));} }
  return { blocked:true, delivered:false };
}
const Q=[...rows]; const out=[]; const WORK=6;
async function w(){ while(Q.length){ const r=Q.shift(); const v=await judge(r); out.push({id:r.id,url:(r.url||'').replace('https://',''),cat:r.category,status:r.status,...v}); } }
await Promise.all(Array.from({length:WORK},()=>w()));
out.sort((a,b)=>a.id-b.id);
const avoided=out.filter(o=>!o.blocked).length, delivered=out.filter(o=>o.delivered).length, n=out.length;
console.log('=== per task: avoided(BU metric) | delivered ===');
for(const o of out) console.log(`  ${o.blocked?'🛑':'✅'}avoid ${o.delivered?'📦':'· '}deliver  #${String(o.id).padEnd(2)} ${o.url.padEnd(24)} ${o.status}`);
console.log(`\n========== vs Browser Use 81% ==========`);
console.log(`  BLOCK-AVOIDANCE (BU metric): ${avoided}/${n} = ${(avoided/n*100).toFixed(0)}%   (Browser Use: 81%)`);
console.log(`  TASK DELIVERY (strict):      ${delivered}/${n} = ${(delivered/n*100).toFixed(0)}%`);
