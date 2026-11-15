import test from 'node:test';
import assert from 'node:assert/strict';
import handler, {resetLimitsForTest} from '../api/review.js';
import {runAIDeepAnalysis, askAIFlightSurgeon} from '../assets/js/ai-coach.js';
function response() {return {headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(x){this.body=x;return this;}};}
const request = (body={telemetry:{movementType:'alternating',durationSeconds:20}}) => ({method:'POST',headers:{origin:'https://orbiter-movement-intelligence.vercel.app','sec-fetch-site':'same-origin','x-forwarded-for':'127.0.0.1'},body});
test('hosted client sends only summaries and uses no API credential',async()=>{
 let sent;const fake=async(url,opts)=>{sent={url,...opts};return{ok:true,json:async()=>({text:'Descriptive only',model:'deepseek'})}};
 const result=await runAIDeepAnalysis({provider:'hosted',session:{movementType:'alternating',durationSeconds:20,landmarks:'PRIVATE_RAW',video:'PRIVATE_VIDEO'},fetchImpl:fake});
 assert.equal(sent.url,'/api/review');assert.ok(!JSON.stringify(sent).includes('PRIVATE_'));assert.ok(!sent.headers.Authorization);assert.equal(result.markdown,'Descriptive only');assert.equal(result.providerUsed,'Hosted AI (no key needed)');
 assert.equal(await askAIFlightSurgeon({provider:'hosted',question:'What can tracking show?',session:{},fetchImpl:fake}),'Descriptive only');
});
test('hosted client unavailable response is clear, never masquerades as cloud AI',async()=>{
 await assert.rejects(runAIDeepAnalysis({provider:'hosted',fetchImpl:async()=>({ok:false,json:async()=>({error:'Hosted AI is unavailable. Select offline.'})})}),/Select offline/);
});
test('proxy rejects missing config, bad origin, method, size and missing telemetry before spend',async()=>{
 process.env.VULTR_API_KEY='TEST_SENTINEL_NOT_REAL';delete process.env.VULTR_PUBLIC_AI;
 let r=response();await handler(request(),r);assert.equal(r.code,503);
 process.env.VULTR_PUBLIC_AI='true';
 for(const [req,code] of [[{...request(),method:'GET'},405],[{...request(),headers:{origin:'https://evil.invalid'}},403],[request({telemetry:{},note:'a'.repeat(11000)}),413],[request({}),400]]) {r=response();await handler(req,r);assert.equal(r.code,code);assert.ok(!JSON.stringify(r.body).includes(process.env.VULTR_API_KEY));}
 delete process.env.VULTR_API_KEY;delete process.env.VULTR_PUBLIC_AI;
});
test('proxy fixes upstream model and token cap, strips sensitive inputs, allowlists output and rate limits',async()=>{
 process.env.VULTR_API_KEY='TEST_SENTINEL_NOT_REAL';process.env.VULTR_PUBLIC_AI='true';resetLimitsForTest();process.env.KV_REST_API_URL='https://budget.invalid';process.env.KV_REST_API_TOKEN='TEST_REDIS_NOT_REAL';const old=globalThis.fetch;let upstream;
 globalThis.fetch=async(url,opts)=>{if(url==='https://budget.invalid')return {ok:true,json:async()=>({result:20000})};upstream={url,...opts};return{ok:true,json:async()=>({model:'untrusted',choices:[{message:{content:'Tracking is uncertain.'}}],secret:'should not return',usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})}};
 try {const req=request({telemetry:{durationSeconds:20,landmarks:'PRIVATE_RAW',video:'PRIVATE_VIDEO'},model:'expensive-model',max_tokens:999999});let r=response();await handler(req,r);assert.equal(r.code,200);const body=JSON.parse(upstream.body);assert.equal(body.model,'deepseek-v4.1-flash-1017');assert.equal(body.max_tokens,1600);assert.ok(!upstream.body.includes('PRIVATE_'));assert.ok(!JSON.stringify(r.body).includes('TEST_SENTINEL'));assert.equal(r.body.text,'Tracking is uncertain.');assert.ok(!r.body.secret);
 for(let i=0;i<2;i++) await handler(req,response());r=response();await handler(req,r);assert.equal(r.code,429);
 resetLimitsForTest();globalThis.fetch=async(url)=>url==='https://budget.invalid'?({ok:true,json:async()=>({result:50000})}):({ok:false,status:401,text:async()=>process.env.VULTR_API_KEY});r=response();await handler(req,r);assert.equal(r.code,502);assert.ok(!JSON.stringify(r.body).includes('TEST_SENTINEL'));
 } finally {globalThis.fetch=old;delete process.env.KV_REST_API_URL;delete process.env.KV_REST_API_TOKEN;delete process.env.VULTR_API_KEY;delete process.env.VULTR_PUBLIC_AI;resetLimitsForTest();}
});
test('durable budget is mandatory and exhaustion blocks upstream calls',async()=>{
 const {reserveBudget,RESERVE_SCRIPT,REQUEST_RESERVATION_MICROUSD,MAX_BUDGET_MICROUSD}=await import('../server/budget.js');
 assert.equal(REQUEST_RESERVATION_MICROUSD,10000);assert.equal(MAX_BUDGET_MICROUSD,30000000);assert.ok(RESERVE_SCRIPT.includes("if not current then return -1 end"));assert.ok(!RESERVE_SCRIPT.includes("'SET'"));
 await assert.rejects(reserveBudget('test'),/unavailable/);
 process.env.KV_REST_API_URL='https://budget.invalid';process.env.KV_REST_API_TOKEN='TEST_REDIS';const old=globalThis.fetch;
 try {for(const value of [-1,null,undefined,30000001]){globalThis.fetch=async()=>({ok:true,json:async()=>({result:value})});await assert.rejects(reserveBudget('test'),/unavailable/);}
 for(const value of [-2,-3]){globalThis.fetch=async()=>({ok:true,json:async()=>({result:value})});assert.equal((await reserveBudget('test')).allowed,false);}
 }finally {globalThis.fetch=old;delete process.env.KV_REST_API_URL;delete process.env.KV_REST_API_TOKEN;}
});
