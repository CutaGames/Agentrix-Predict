// LSM Phase G — conversational Copilot E2E (Req 24/25): verify the LLM actually
// invokes the lsm_* tools through the unified chat path on production.
// Was previously blocked by Bedrock 429 (daily token cap); runnable now.
//
// Flow: register -> POST /openclaw/proxy/chat (auto-provisions platform-hosted
// agent) with an explicit market-search instruction -> assert the reply / tool
// calls reference LSM markets.
const API = process.env.API || 'https://api.agentrix.top/api';
const email = `lsm-copilot-${Date.now()}@example.com`;
const password = 'Test123456!';
let token = '';

async function j(method, path, body, auth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, text };
}

(async () => {
  console.log('API', API);
  const reg = await j('POST', '/auth/register', { email, password }, false);
  token = reg.data?.access_token;
  console.log('register', reg.status, token ? 'token ok' : 'NO TOKEN');
  if (!token) return;

  // Explicitly steer the model to use the prediction tool (non-streaming for easy assertion).
  const msg = '请用 lsm_search_markets 工具列出当前可下注的滚球预测盘口（最多5个），并解释第一个盘口的赔率。';
  console.log('\n>>> chat:', msg);
  const t0 = Date.now();
  const chat = await j('POST', '/openclaw/proxy/chat', {
    messages: [{ role: 'user', content: msg }],
    platform: 'web',
    options: { maxTokens: 1024 },
  });
  console.log('chat status', chat.status, `(${Date.now() - t0}ms)`);

  const blob = JSON.stringify(chat.data);
  const replyText = chat.data?.reply?.content || chat.data?.text || chat.data?.content || '';
  const toolCalls = chat.data?.toolCalls || chat.data?.reply?.toolCalls || [];
  const calledLsm = blob.includes('lsm_search_markets') || blob.includes('lsm_market_list');
  const hasMarketData = /vs |odds|赔率|盘口|market/i.test(replyText) || blob.includes('"cardType":"lsm_market_list"');

  console.log('--- toolCalls ---', JSON.stringify(toolCalls).slice(0, 400));
  console.log('--- reply (first 500) ---', String(replyText).slice(0, 500));
  console.log('\nRESULT:');
  console.log('  chat ok:', [200, 201].includes(chat.status) ? 'PASS' : `FAIL(${chat.status})`);
  console.log('  lsm tool invoked:', calledLsm ? 'PASS' : 'not detected');
  console.log('  market data in reply:', hasMarketData ? 'PASS' : 'not detected');
})().catch((e) => console.error('ERR', e.message));
