// One persistent counter shared across every deployment and instance.
// It must be initialized once by the owner to 10000, with NO TTL/eviction.
// Missing/deleted state fails closed rather than silently resetting the budget.
export const BUDGET_KEY = '{orbiter-ai}:reserved-microusd:v1';
export const MAX_BUDGET_MICROUSD = 30_000_000;
export const REQUEST_RESERVATION_MICROUSD = 10_000;
export const RESERVE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return -1 end
local amount = tonumber(current)
if not amount or amount < 0 then return -1 end
if amount + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return -2 end
local hits = redis.call('INCR', KEYS[2])
if hits == 1 then redis.call('EXPIRE', KEYS[2], 3600) end
if hits > 3 then return -3 end
return redis.call('INCRBY', KEYS[1], ARGV[1])
`;
export async function reserveBudget(ipHash) {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Budget protection unavailable.');
  const r = await fetch(url, {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(['EVAL',RESERVE_SCRIPT,2,BUDGET_KEY,`{orbiter-ai}:ip:${ipHash}`,REQUEST_RESERVATION_MICROUSD,MAX_BUDGET_MICROUSD]),signal:AbortSignal.timeout(5000)});
  if (!r.ok) throw new Error('Budget protection unavailable.');
  const data = await r.json();
  if (data.error || !Number.isSafeInteger(data.result) || data.result === -1) throw new Error('Budget protection unavailable.');
  if (data.result === -2) return {allowed:false,reason:'Hosted AI budget reached. Use the offline coach or your own key.'};
  if (data.result === -3) return {allowed:false,reason:'Hosted AI limit reached (3 per hour). Use the offline coach or your own key.'};
  if (data.result < 0 || data.result > MAX_BUDGET_MICROUSD) throw new Error('Budget protection unavailable.');
  return {allowed:true};
}
