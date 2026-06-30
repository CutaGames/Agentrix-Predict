// LSM Phase G (Nova) E2E smoke against production.
// Focus: Req 24 auto-provision (web-only user with NO instance must NOT get a
// 404 "No active OpenClaw instance" from the default chat path — a platform-
// hosted primary is auto-created). Plus a light dual-currency regression.
//
// Run: API=https://api.agentrix.top/api node scripts/test/lsm-nova-e2e.mjs
const API = process.env.API || 'https://api.agentrix.top/api';
const email = `lsm-nova-e2e-${Date.now()}@example.com`;
const password = 'Test123456!';
let token = '';
let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name} ${detail}`); }
  else { fail++; console.log(`  ✕ ${name} ${detail}`); }
}

async function j(method, path, body, auth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, raw: text };
}

(async () => {
  console.log('API', API);

  // 1. fresh user (no OpenClaw instance) ------------------------------------
  const reg = await j('POST', '/auth/register', { email, password }, false);
  token = reg.data?.access_token;
  check('register returns token', !!token, `status=${reg.status}`);
  if (!token) return done();

  // 2. Req 24 — auto-provision: default chat must NOT 404 on a no-instance user
  const chat = await j('POST', '/openclaw/proxy/chat', {
    messages: [{ role: 'user', content: 'hello' }],
    platform: 'web',
    options: { maxTokens: 64 },
  });
  const body = JSON.stringify(chat.data).toLowerCase();
  const noInstance404 = chat.status === 404 || body.includes('no active openclaw instance');
  check('default chat auto-provisions instance (no 404)', !noInstance404,
    `status=${chat.status} ${body.slice(0, 120)}`);
  // A 200 (reply) or a 4xx/5xx that is NOT the no-instance error is acceptable
  // here (Bedrock may rate-limit the actual completion); the instance resolution
  // is what we are validating.

  // 3. dual-currency engine regression (public + authed) --------------------
  const mk = await j('GET', '/lsm/markets/live?limit=60', null, false);
  const list = mk.data?.items || [];
  check('markets list', mk.status === 200, `count=${list.length}`);
  const m = list.find((x) => x.odds?.length && x.tradable) || list[0];
  if (m) {
    const pUsdc = await j('POST', '/lsm/orders/preview', { marketId: m.id, outcomeIdx: 0, stake: 100, leverage: 2, asset: 'USDC' });
    check('preview USDC', [200, 201].includes(pUsdc.status) && pUsdc.data?.asset === 'USDC',
      `status=${pUsdc.status} asset=${pUsdc.data?.asset} odds=${pUsdc.data?.tradableOdds}`);
    const bal = await j('GET', '/lsm/wallet/balance');
    check('wallet balance dual', bal.status === 200 && bal.data && ('axp' in bal.data) && ('usdc' in bal.data),
      JSON.stringify(bal.data));
  } else {
    console.log('  (no tradable market to preview — skipping engine regression)');
  }

  done();
})().catch((e) => { console.error('ERR', e.message); fail++; done(); });

function done() {
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
