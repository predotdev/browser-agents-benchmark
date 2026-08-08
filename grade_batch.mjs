// Grade two batch-probe result files (ON vs OFF) against tasks.json verifiers.
// Usage: node grade_batch.mjs /tmp/batch_on.json /tmp/batch_off.json
import { readFileSync } from 'fs';
const HELPERS = `
function findArray(obj){if(Array.isArray(obj))return obj;if(obj&&typeof obj==="object"){for(const v of Object.values(obj)){const f=findArray(v);if(f)return f;}}return null;}
function findValue(obj,p){if(p(obj))return obj;if(obj&&typeof obj==="object"){for(const v of Object.values(obj)){const f=findValue(v,p);if(f!==undefined)return f;}}return undefined;}
function findStr(obj,sub){return findValue(obj,(v)=>typeof v==="string"&&v.toLowerCase().includes(sub.toLowerCase()));}
`;
const tasksRaw = JSON.parse(readFileSync('tasks.json', 'utf8'));
const T = Array.isArray(tasksRaw) ? tasksRaw : tasksRaw.tasks;
function grade(t, data) {
	if (!t?.successCheckSrc) return { success: data != null, reason: 'no-check' };
	try { const fn = new Function('result', `${HELPERS}\nreturn (${t.successCheckSrc})(result);`); return fn({ data, success: true }); }
	catch (e) { return { success: false, reason: 'check-threw: ' + e.message }; }
}
const on = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const off = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const byId = (arr) => Object.fromEntries(arr.map((r) => [r.id, r]));
const O = byId(on), F = byId(off);
const ids = [...new Set([...on.map((r) => r.id), ...off.map((r) => r.id)])].sort((a, b) => a - b);
let onPass = 0, offPass = 0, onT = 0, offT = 0, regress = [];
console.log('id   url                          ON         OFF        verdict');
for (const id of ids) {
	const t = T[id - 1];
	const o = O[id], f = F[id];
	const og = o ? grade(t, o.data) : { success: false, reason: 'no-result' };
	const fg = f ? grade(t, f.data) : { success: false, reason: 'no-result' };
	if (og.success) onPass++; if (fg.success) offPass++;
	const os = o?.durationMs ? o.durationMs / 1000 : 0, fs = f?.durationMs ? f.durationMs / 1000 : 0;
	onT += os; offT += fs;
	const verdict = og.success && fg.success ? 'both ok' : og.success ? 'ON-only ok' : fg.success ? 'OFF-only (REGRESS)' : 'both fail';
	if (!og.success && fg.success) regress.push(id);
	const url = (t?.url || '').replace(/https?:\/\//, '').slice(0, 28);
	console.log(`#${String(id).padEnd(3)} ${url.padEnd(28)} ${(og.success ? 'PASS' : 'fail').padEnd(4)} ${(os ? os.toFixed(1) + 's' : '?').padStart(5)} ${(fg.success ? 'PASS' : 'fail').padEnd(4)} ${(fs ? fs.toFixed(1) + 's' : '?').padStart(5)}  ${verdict}${og.success ? '' : '  [' + (og.reason || '') + ']'}`);
}
const n = ids.length;
console.log(`\nON : ${onPass}/${n} pass, avg ${(onT / n).toFixed(1)}s`);
console.log(`OFF: ${offPass}/${n} pass, avg ${(offT / n).toFixed(1)}s`);
console.log(`speed: DOM-only is ${((offT - onT) / offT * 100).toFixed(0)}% faster on this sample (${(onT / n).toFixed(1)}s vs ${(offT / n).toFixed(1)}s avg)`);
if (regress.length) console.log(`\n*** CORRECTNESS REGRESSIONS (ON fails, OFF passes): ${regress.join(', ')} ***`);
else console.log(`\nNo correctness regressions from DOM-only planning on this sample.`);
