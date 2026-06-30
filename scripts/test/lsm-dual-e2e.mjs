// LSM dual-currency E2E smoke against production.
// register -> markets -> preview(AXP) -> preview(USDC) -> balance -> place(AXP) -> me/orders
const API = process.env.API || 'https://api.agentrix.top/api';
const email = `lsm-e2e-${Date.now()}@example.com`;
const password = 'Test123456!';
let token = '';

async function j(method, path, body, auth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

(async () => {
  console.log('API', API);
  // 1. register
  let reg = await j('POST', '/auth/register', { email, password }, false);
  console.log('register', reg.status, reg.data?.user?.id || reg.data?.message || '');
  token = reg.data?.access_token;
  if (!token) { console.log('no token, abort'); return; }

  // 2. markets (live returns live+pre)
  const mk = await j('GET', '/lsm/markets/live?limit=60', null, false);
  const list = mk.data?.items || [];
  const m = list.find((x) => x.odds?.length && x.tradable) || list[0];
  console.log('markets', mk.status, 'count', list.length, 'pick', m && `${m.homeTeam} vs ${m.awayTeam} [${m.status}]`);
  if (!m) { console.log('no market, abort'); return; }
  const outcomeIdx = 0;
  const odds = m.odds[0].fairOdds;

  // 3. preview AXP
  const pAxp = await j('POST', '/lsm/orders/preview', { marketId: m.id, outcomeIdx, stake: 100, leverage: 2, asset: 'AXP' });
  console.log('preview AXP', pAxp.status, JSON.stringify(pAxp.data).slice(0, 220));
  // 4. preview USDC
  const pUsdc = await j('POST', '/lsm/orders/preview', { marketId: m.id, outcomeIdx, stake: 100, leverage: 2, asset: 'USDC' });
  console.log('preview USDC', pUsdc.status, JSON.stringify(pUsdc.data).slice(0, 220));

  // 5. balance
  const bal = await j('GET', '/lsm/wallet/balance');
  console.log('balance', bal.status, JSON.stringify(bal.data));

  // 5b. try to grant test AXP (testnet funding for a successful bet)
  const grant = await j('POST', '/axp/earn', { source: 'admin_grant', amount: 1000 });
  console.log('axp grant', grant.status, JSON.stringify(grant.data).slice(0, 160));
  const bal2 = await j('GET', '/lsm/wallet/balance');
  console.log('balance after grant', bal2.status, JSON.stringify(bal2.data));

  // 6. place AXP
  const quoted = pAxp.data?.tradableOdds || odds;
  const place = await j('POST', '/lsm/orders', { marketId: m.id, outcomeIdx, stake: 100, leverage: 2, quotedOdds: quoted, asset: 'AXP', idemKey: `e2e-${Date.now()}` });
  console.log('place AXP', place.status, JSON.stringify(place.data).slice(0, 260));

  // 7. me/orders
  const mine = await j('GET', '/lsm/me/orders?limit=5');
  console.log('me/orders', mine.status, 'count', (mine.data?.items || []).length, JSON.stringify((mine.data?.items || [])[0] || {}).slice(0, 200));
})().catch((e) => console.error('ERR', e.message));
