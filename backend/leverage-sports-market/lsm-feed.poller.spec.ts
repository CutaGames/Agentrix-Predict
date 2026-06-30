import { LsmFeedPoller } from './lsm-feed.poller';
import { LsmFeedService } from './lsm-feed.service';
import { FeedMarketSnapshot } from './lsm-feed.types';

/**
 * task 1 验证：LSM feed poller 行为。
 *  - 未配 env / disabled → 静默跳过，不发请求、不 ingest。
 *  - 成功拉取 → 解析 ApiResponse 包裹的 markets → ingest。
 *  - HTTP 非 2xx / 抛错 → 仅告警，不抛、不阻塞（返回 null）。
 *  - 0 盘口 → 不调用 ingest。
 *  - 带 X-Internal-Token 头与 limit 查询参数。
 */

const sampleMarket = (id: string): FeedMarketSnapshot => ({
  externalMarketId: id,
  sport: 'soccer',
  league: null,
  homeTeam: 'A',
  awayTeam: 'B',
  outcomeCount: 2,
  status: 'live',
  kickoffAt: new Date().toISOString(),
  odds: [
    { outcomeIdx: 0, fairOdds: 1.85 },
    { outcomeIdx: 1, fairOdds: 2.05 },
  ],
  oddsTs: new Date().toISOString(),
  winningOutcomeIdx: null,
});

function makeFeed(): { feed: LsmFeedService; ingest: jest.Mock } {
  const ingest = jest.fn(async () => ({ upserted: 1, snapshots: 2 }));
  const feed = { ingest } as unknown as LsmFeedService;
  return { feed, ingest };
}

describe('LsmFeedPoller (task 1 赔率轮询)', () => {
  const ORIG = { ...process.env };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    process.env = { ...ORIG };
    jest.restoreAllMocks();
    delete (global as any).fetch;
  });

  it('未配 KMARKET_INTERNAL_BASE_URL → 静默跳过（不请求、不 ingest）', async () => {
    delete process.env.KMARKET_INTERNAL_BASE_URL;
    const { feed, ingest } = makeFeed();
    const poller = new LsmFeedPoller(feed);

    const r = await poller.poll(200, 'live');

    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it('LSM_FEED_POLL_DISABLED=1 → 整体停用', async () => {
    process.env.KMARKET_INTERNAL_BASE_URL = 'http://kmarket-internal:8080';
    process.env.LSM_FEED_POLL_DISABLED = '1';
    const { feed, ingest } = makeFeed();
    const poller = new LsmFeedPoller(feed);

    const r = await poller.poll(200, 'live');

    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it('成功拉取 ApiResponse 包裹的 markets → ingest，并带令牌头与 limit', async () => {
    process.env.KMARKET_INTERNAL_BASE_URL = 'http://kmarket-internal:8080/';
    process.env.KMARKET_INTERNAL_TOKEN = 'secret-token';
    delete process.env.LSM_FEED_POLL_DISABLED;
    const { feed, ingest } = makeFeed();
    const poller = new LsmFeedPoller(feed);

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { markets: [sampleMarket('1'), sampleMarket('2')], count: 2 },
      }),
    });

    const r = await poller.poll(1000, 'all');

    expect(r).toEqual({ upserted: 1, snapshots: 2 });
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0][0].markets).toHaveLength(2);

    // URL 去重尾斜杠 + path + limit
    const [calledUrl, opts] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(
      'http://kmarket-internal:8080/api/v1/internal/lsm/snapshots?limit=1000',
    );
    expect(opts.headers['X-Internal-Token']).toBe('secret-token');
  });

  it('裸 payload（无 ApiResponse 包裹）也能解析 markets', async () => {
    process.env.KMARKET_INTERNAL_BASE_URL = 'http://kmarket-internal:8080';
    const { feed, ingest } = makeFeed();
    const poller = new LsmFeedPoller(feed);

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ markets: [sampleMarket('9')] }),
    });

    await poller.poll(200, 'live');
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0][0].markets).toHaveLength(1);
  });

  it('未配令牌 → 不带 X-Internal-Token 头', async () => {
    process.env.KMARKET_INTERNAL_BASE_URL = 'http://kmarket-internal:8080';
    delete process.env.KMARKET_INTERNAL_TOKEN;
    const { feed } = makeFeed();
    const poller = new LsmFeedPoller(feed);

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { markets: [] } }),
    });

    await poller.poll(200, 'live');
    const opts = fetchMock.mock.calls[0][1];
    expect(opts.headers['X-Internal-Token']).toBeUndefined();
  });

  it('0 盘口 → 不调用 ingest，返回零计数', async () => {
    process.env.KMARKET_INTERNAL_BASE_URL = 'http://kmarket-internal:8080';
    const { feed, ingest } = makeFeed();
    const poller = new LsmFeedPoller(feed);

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { markets: [] } }),
    });

    const r = await poller.poll(200, 'live');
    expect(r).toEqual({ upserted: 0, snapshots: 0 });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('HTTP 非 2xx → 仅告警不抛，返回 null', async () => {
    process.env.KMARKET_INTERNAL_BASE_URL = 'http://kmarket-internal:8080';
    const { feed, ingest } = makeFeed();
    const poller = new LsmFeedPoller(feed);

    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    const r = await poller.poll(200, 'live');
    expect(r).toBeNull();
    expect(ingest).not.toHaveBeenCalled();
  });

  it('fetch 抛错（超时/网络）→ 仅告警不抛，返回 null', async () => {
    process.env.KMARKET_INTERNAL_BASE_URL = 'http://kmarket-internal:8080';
    const { feed, ingest } = makeFeed();
    const poller = new LsmFeedPoller(feed);

    fetchMock.mockRejectedValue(new Error('aborted'));

    const r = await poller.poll(200, 'live');
    expect(r).toBeNull();
    expect(ingest).not.toHaveBeenCalled();
  });

  it('pollLive/pollAll 使用不同 limit（200 / 1000）', async () => {
    process.env.KMARKET_INTERNAL_BASE_URL = 'http://kmarket-internal:8080';
    const { feed } = makeFeed();
    const poller = new LsmFeedPoller(feed);

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { markets: [] } }),
    });

    await poller.pollLive();
    await poller.pollAll();

    expect(fetchMock.mock.calls[0][0]).toContain('limit=200');
    expect(fetchMock.mock.calls[1][0]).toContain('limit=1000');
  });
});
