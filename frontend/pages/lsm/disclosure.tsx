/**
 * /lsm/disclosure — risk disclosure (GET /lsm/vaults/disclosure).
 * Anonymous-viewable. Falls back to a built-in notice if the API is empty.
 */
import { useEffect, useState } from 'react';
import { Loader2, ShieldAlert } from 'lucide-react';
import LsmLayout from '../../components/lsm/LsmLayout';
import { Card } from '../../components/lsm/ui';
import { lsm, type LsmDisclosure } from '../../services/lsm';

const FALLBACK: LsmDisclosure = {
  zh: {
    title: '风险披露',
    points: [
      '本平台当前运行于 Injective EVM 测试网（chainId 1439），所用 USDC 为测试代币，无真实价值。',
      '杠杆滚球预测具有高风险，可能损失全部保证金；过往表现不代表未来收益。',
      '金库（LP）份额净值随庄家盈亏波动，不保证本金与收益。',
      '请遵守所在地法律法规；本平台内容不构成任何投资或博彩建议。',
    ],
  },
  en: {
    title: 'Risk Disclosure',
    points: [
      'This platform currently runs on Injective EVM testnet (chainId 1439). USDC here is a test token with no real value.',
      'Leveraged in-play prediction is high risk; you may lose your entire margin. Past performance does not indicate future results.',
      'LP vault share NAV fluctuates with house P&L; neither principal nor returns are guaranteed.',
      'Comply with the laws of your jurisdiction. Nothing here is investment or betting advice.',
    ],
  },
};

export default function DisclosurePage() {
  const [data, setData] = useState<LsmDisclosure | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    lsm
      .disclosure()
      .then((d) => setData(d && d.zh?.points?.length ? d : FALLBACK))
      .catch(() => setData(FALLBACK))
      .finally(() => setLoading(false));
  }, []);

  return (
    <LsmLayout title="风险披露" active="/lsm/disclosure">
      <div className="mb-5 flex items-center gap-2">
        <ShieldAlert className="text-amber-400" />
        <h1 className="text-2xl font-extrabold text-white">风险披露 · Risk Disclosure</h1>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="animate-spin text-violet-400" size={32} />
        </div>
      ) : (
        <div className="space-y-6">
          {(['zh', 'en'] as const).map((lang) => {
            const block = data?.[lang] || FALLBACK[lang];
            return (
              <Card key={lang} className="p-5">
                <h2 className="mb-3 font-bold text-white">{block.title}</h2>
                <ul className="list-disc space-y-2 pl-5 text-sm text-slate-300">
                  {block.points.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
    </LsmLayout>
  );
}
