import test from 'node:test';
import assert from 'node:assert/strict';
import {runAIDeepAnalysis,askAIFlightSurgeon,AI_PROVIDERS} from '../assets/js/ai-coach.js';
const session={durationSeconds:17,quality:.94,reps:{squat:{count:1,reps:[]}},landmarks:['PRIVATE_RAW'],video:'PRIVATE_VIDEO'};
test('Vultr uses documented endpoint/model and only summary telemetry',async()=>{
 let request;
 const result=await runAIDeepAnalysis({session,synthesis:{overallScore:48},provider:AI_PROVIDERS.VULTR,apiKey:'TEST_ONLY',fetchImpl:async(url,opts)=>{request={url,...opts};return{ok:true,json:async()=>({model:'deepseek-v4.1-flash-1017',choices:[{message:{content:'Experimental review'}}]})}}});
 assert.equal(request.url,'https://api.vultrinference.com/v1/chat/completions');
 const body=JSON.parse(request.body);assert.equal(body.model,'deepseek-v4.1-flash-1017');assert.equal(body.reasoning_effort,'minimal');assert.equal(request.headers.Authorization,'Bearer TEST_ONLY');
 assert.ok(!request.body.includes('PRIVATE_'));assert.ok(!request.body.includes('TEST_ONLY'));assert.ok(result.providerUsed.includes('Vultr DeepSeek'));assert.equal(result.markdown,'Experimental review');
});
test('Vultr rejects missing keys before network calls',async()=>{await assert.rejects(runAIDeepAnalysis({provider:AI_PROVIDERS.VULTR,fetchImpl:()=>{throw Error('must not call')}}),/Missing API key/)});
test('Vultr surfaces cloud errors without silent template fallback',async()=>{await assert.rejects(runAIDeepAnalysis({provider:AI_PROVIDERS.VULTR,apiKey:'TEST_ONLY',fetchImpl:async()=>({ok:false,status:401,text:async()=> 'Unauthorized'})}),/API error 401/)});
test('Vultr follow-up uses cloud endpoint and question',async()=>{let body;const answer=await askAIFlightSurgeon({provider:AI_PROVIDERS.VULTR,apiKey:'TEST_ONLY',question:'Is camera angle reliable?',session,synthesis:{},fetchImpl:async(url,opts)=>{assert.equal(url,'https://api.vultrinference.com/v1/chat/completions');body=JSON.parse(opts.body);return{ok:true,json:async()=>({choices:[{message:{content:'Check camera angle first.'}}]})}}});assert.equal(body.messages.at(-1).content,'Is camera angle reliable?');assert.equal(answer,'Check camera angle first.')});
