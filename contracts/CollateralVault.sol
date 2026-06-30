// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title CollateralVault
 * @notice Hyperliquid 式链上抵押 + 金库托管合约（LSM 链上稳定币结算平台 Phase A）。
 *
 * 职责：① 托管 USDC（用户抵押 + LP 金库 bankroll）；② 链上金库份额/NAV 记账，复刻
 * 后端 `lsm.vault-math.ts`；③ 偿付不变量 `bankroll >= reserved` 链上强校验；④ 由授权
 * relayer 提交「已由链下引擎算好金额」的结算批量（balance deltas）；⑤ 信任最小化提现
 * （relayer 签名授权，代发或用户自发皆可）。
 *
 * 设计原则（见 design.md）：合约不做赔率/杠杆/撮合，只做托管记账 + 偿付/守恒/幂等校验。
 * 金额以「内部最小整数单位」记账（与引擎整数口径一致）；与链上 USDC base unit 经 `unitScale`
 * 换算（dust 余数留尾在合约，不入用户可用余额）。token 无关：主网把 usdc 指向 Circle 原生 USDC。
 *
 * 不变量（property 测试 + 链上强校验）：
 *   I1 偿付：每个 vault `bankroll >= reserved`。
 *   I2 守恒：`usdc.balanceOf(this) >= (totalCollateral + totalVaultBankroll) * unitScale`。
 *   I3 幂等：相同 idemKey / withdraw nonce 不重复生效。
 */
contract CollateralVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── 常量 ────────────────────────────────────────────────────
    uint256 public constant NAV_SCALE = 1e9; // 定点 NAV（与 lsm.vault-math 一致）

    // ── 不可变配置 ──────────────────────────────────────────────
    IERC20 public immutable usdc;       // 结算代币（testnet=MockUSDC, mainnet=Circle USDC）
    uint256 public immutable unitScale; // 1 内部单位 = unitScale 个 USDC base unit（如 0.01 USDC@6dec = 1e4）

    // ── 角色 / 开关 ─────────────────────────────────────────────
    address public relayer;             // 结算 + 提现签名授权者（Phase E 升级多签）
    bool public paused;

    // ── 用户抵押（内部单位）─────────────────────────────────────
    mapping(address => uint256) public collateral; // 可用抵押
    uint256 public totalCollateral;                 // Σcollateral（聚合，用于 I2）

    // ── 金库（复刻 lsm.vault-math）──────────────────────────────
    struct Vault {
        uint256 bankroll;       // 本金（内部单位）
        uint256 reserved;       // 未结算持仓预留（内部单位）
        uint256 totalShares;    // 总份额
        uint256 highWaterNav;   // 高水位 NAV（定点）
        uint16 profitShareBps;  // 主理人利润分成（基点）
        bool exists;
    }
    mapping(bytes32 => Vault) public vaults;
    mapping(bytes32 => mapping(address => uint256)) public lpShares; // vaultId → lp → shares
    uint256 public totalVaultBankroll; // Σvault.bankroll（聚合，用于 I2）

    // ── 幂等 ────────────────────────────────────────────────────
    mapping(bytes32 => bool) public usedIdem;        // 结算批量幂等
    mapping(uint256 => bool) public usedWithdrawNonce; // 提现签名防重放
    uint256 public depositSeq;                        // 充值事件序号

    // ── 事件 ────────────────────────────────────────────────────
    event Deposited(address indexed user, uint256 baseAmount, uint256 internalAmount, uint256 seq);
    event Withdrawn(address indexed user, address indexed to, uint256 internalAmount, uint256 baseAmount, uint256 nonce);
    event LiquidityDeposited(bytes32 indexed vaultId, address indexed lp, uint256 amount, uint256 sharesMinted);
    event LiquidityRedeemed(bytes32 indexed vaultId, address indexed lp, uint256 sharesBurned, uint256 payout);
    event SettlementApplied(bytes32 indexed idemKey, uint256 userCount, uint256 vaultCount);
    event VaultCreated(bytes32 indexed vaultId, uint16 profitShareBps);
    event ProfitFeeAccrued(bytes32 indexed vaultId, address indexed leader, uint256 sharesMinted, uint256 newHighWaterNav);
    event RelayerChanged(address indexed relayer);
    event PausedChanged(bool paused);

    modifier whenNotPaused() {
        require(!paused, "CV: paused");
        _;
    }
    modifier onlyRelayer() {
        require(msg.sender == relayer, "CV: not relayer");
        _;
    }

    constructor(address _usdc, uint256 _unitScale, address _relayer) {
        require(_usdc != address(0), "CV: usdc zero");
        require(_unitScale > 0, "CV: scale zero");
        require(_relayer != address(0), "CV: relayer zero");
        usdc = IERC20(_usdc);
        unitScale = _unitScale;
        relayer = _relayer;
    }

    // ── NAV 数学（与 backend lsm.vault-math.ts 逐项一致）──────────

    /// @dev 净权益 E = bankroll - reserved（偿付不变量保证 >= 0）。
    function _equity(Vault storage v) internal view returns (uint256) {
        return v.bankroll - v.reserved; // 调用点已保证 bankroll >= reserved
    }

    /// @dev NAV 定点（E/shares × 1e9）；shares=0 → 1.0。
    function navFixed(bytes32 vaultId) public view returns (uint256) {
        Vault storage v = vaults[vaultId];
        if (v.totalShares == 0) return NAV_SCALE;
        return (_equity(v) * NAV_SCALE) / v.totalShares;
    }

    /// @dev 存入铸份额：首笔或 E<=0 → 1:1；否则 floor(d*totalShares/E)，余数归金库。
    function _sharesForDeposit(Vault storage v, uint256 d) internal view returns (uint256) {
        uint256 e = _equity(v);
        if (v.totalShares == 0 || e == 0) return d;
        return (d * v.totalShares) / e;
    }

    /// @dev 赎回派彩：floor(s*E/totalShares)，余数归金库（利好剩余 LP）。
    function _payoutForRedeem(Vault storage v, uint256 s) internal view returns (uint256) {
        if (v.totalShares == 0) return 0;
        return (s * _equity(v)) / v.totalShares;
    }

    // ── 精度换算 ────────────────────────────────────────────────
    function _toInternal(uint256 baseAmount) internal view returns (uint256) {
        return baseAmount / unitScale; // floor；dust 余数留尾在合约
    }
    function _toBase(uint256 internalAmount) internal view returns (uint256) {
        return internalAmount * unitScale;
    }

    /// @dev 把带符号增量安全地应用到无符号余额（下溢 revert）。
    function _applyDelta(uint256 cur, int256 d) internal pure returns (uint256) {
        if (d >= 0) return cur + uint256(d);
        uint256 sub = uint256(-d);
        require(cur >= sub, "CV: underflow");
        return cur - sub;
    }

    // ── 充值 / 提现 ─────────────────────────────────────────────

    /// @notice 用户充值 USDC → 内部可用抵押。dust（不足 1 内部单位的余额）留尾在合约。
    function deposit(uint256 baseAmount) external nonReentrant whenNotPaused {
        uint256 internalAmount = _toInternal(baseAmount);
        require(internalAmount > 0, "CV: dust only");
        usdc.safeTransferFrom(msg.sender, address(this), baseAmount);
        collateral[msg.sender] += internalAmount;
        totalCollateral += internalAmount;
        emit Deposited(msg.sender, baseAmount, internalAmount, ++depositSeq);
    }

    /// @notice 信任最小化提现：凭 relayer 对 (this,chainId,user,to,amount,nonce) 的签名授权放款。
    /// 任何人（relayer 代发或用户自发）均可提交；授权由签名保证。
    function requestWithdraw(
        address user,
        uint256 internalAmount,
        address to,
        uint256 nonce,
        bytes calldata sig
    ) external nonReentrant whenNotPaused {
        require(to != address(0), "CV: to zero");
        require(!usedWithdrawNonce[nonce], "CV: nonce used");
        bytes32 h = keccak256(
            abi.encodePacked(address(this), block.chainid, user, to, internalAmount, nonce)
        );
        require(ECDSA.recover(ECDSA.toEthSignedMessageHash(h), sig) == relayer, "CV: bad sig");
        require(collateral[user] >= internalAmount, "CV: insufficient");
        usedWithdrawNonce[nonce] = true;
        collateral[user] -= internalAmount;
        totalCollateral -= internalAmount;
        uint256 baseAmount = _toBase(internalAmount);
        usdc.safeTransfer(to, baseAmount);
        emit Withdrawn(user, to, internalAmount, baseAmount, nonce);
    }

    // ── LP 金库存赎（NAV，复刻 lsm.vault-math）──────────────────

    function createVault(bytes32 vaultId, uint16 profitShareBps) external onlyOwner {
        require(!vaults[vaultId].exists, "CV: vault exists");
        require(profitShareBps <= 10000, "CV: bps");
        vaults[vaultId] = Vault({
            bankroll: 0, reserved: 0, totalShares: 0,
            highWaterNav: NAV_SCALE, profitShareBps: profitShareBps, exists: true
        });
        emit VaultCreated(vaultId, profitShareBps);
    }

    /// @notice LP 用其可用抵押注入金库本金，按 NAV 铸份额（USDC 不离开合约，仅重分类）。
    function depositLiquidity(bytes32 vaultId, uint256 amount) external nonReentrant whenNotPaused {
        Vault storage v = vaults[vaultId];
        require(v.exists, "CV: no vault");
        require(amount > 0, "CV: zero");
        require(collateral[msg.sender] >= amount, "CV: insufficient");
        uint256 shares = _sharesForDeposit(v, amount);
        collateral[msg.sender] -= amount;
        totalCollateral -= amount;
        v.bankroll += amount;
        totalVaultBankroll += amount;
        v.totalShares += shares;
        lpShares[vaultId][msg.sender] += shares;
        emit LiquidityDeposited(vaultId, msg.sender, amount, shares);
    }

    /// @notice LP 销份额赎回；payout ≤ E 保证不挪用预留（偿付不变量恒满足）。
    function redeemLiquidity(bytes32 vaultId, uint256 shares) external nonReentrant whenNotPaused {
        Vault storage v = vaults[vaultId];
        require(v.exists, "CV: no vault");
        require(shares > 0 && lpShares[vaultId][msg.sender] >= shares, "CV: shares");
        uint256 payout = _payoutForRedeem(v, shares);
        require(v.bankroll - payout >= v.reserved, "CV: I1 solvency"); // I1
        v.totalShares -= shares;
        lpShares[vaultId][msg.sender] -= shares;
        v.bankroll -= payout;
        totalVaultBankroll -= payout;
        collateral[msg.sender] += payout;
        totalCollateral += payout;
        emit LiquidityRedeemed(vaultId, msg.sender, shares, payout);
    }

    // ── 结算（relayer 提交已由链下引擎算好的 balance deltas）──────

    struct UserDelta { address user; int256 collateralDelta; }
    struct VaultDelta { bytes32 vaultId; int256 bankrollDelta; int256 reservedDelta; }

    /// @notice 应用一批结算 delta（开仓预留/派彩/退款/平仓的净额）。
    /// 守恒：ΣcollateralDelta + ΣbankrollDelta == 0（reserved 仅是 bankroll 内的标记，不动 USDC）。
    /// 偿付：每个受影响 vault `bankroll >= reserved`。幂等：idemKey 不重复。
    function applySettlement(
        bytes32 idemKey,
        UserDelta[] calldata users,
        VaultDelta[] calldata vlts
    ) external onlyRelayer whenNotPaused {
        require(!usedIdem[idemKey], "CV: idem used"); // I3
        usedIdem[idemKey] = true;

        int256 net = 0;
        for (uint256 i = 0; i < users.length; i++) {
            address u = users[i].user;
            int256 d = users[i].collateralDelta;
            collateral[u] = _applyDelta(collateral[u], d);
            totalCollateral = _applyDelta(totalCollateral, d);
            net += d;
        }
        for (uint256 i = 0; i < vlts.length; i++) {
            Vault storage v = vaults[vlts[i].vaultId];
            require(v.exists, "CV: no vault");
            v.bankroll = _applyDelta(v.bankroll, vlts[i].bankrollDelta);
            totalVaultBankroll = _applyDelta(totalVaultBankroll, vlts[i].bankrollDelta);
            v.reserved = _applyDelta(v.reserved, vlts[i].reservedDelta);
            require(v.bankroll >= v.reserved, "CV: I1 solvency"); // I1
            net += vlts[i].bankrollDelta;
        }
        require(net == 0, "CV: not conservative"); // I2 守恒
        emit SettlementApplied(idemKey, users.length, vlts.length);
    }

    /// @notice 高水位利润分成：向主理人铸等值份额（复刻 computeProfitFee）。relayer 触发。
    function accrueProfitFee(bytes32 vaultId, address leader) external onlyRelayer whenNotPaused {
        Vault storage v = vaults[vaultId];
        require(v.exists, "CV: no vault");
        uint256 navNow = navFixed(vaultId);
        if (v.totalShares == 0 || v.profitShareBps == 0 || navNow <= v.highWaterNav) {
            if (navNow > v.highWaterNav) v.highWaterNav = navNow;
            return;
        }
        uint256 e = _equity(v);
        uint256 gainAboveHwm = ((navNow - v.highWaterNav) * v.totalShares) / NAV_SCALE;
        uint256 feeEquity = (gainAboveHwm * v.profitShareBps) / 10000;
        uint256 leaderShares = 0;
        if (feeEquity > 0 && e > feeEquity) {
            leaderShares = (feeEquity * v.totalShares) / (e - feeEquity);
            v.totalShares += leaderShares;
            lpShares[vaultId][leader] += leaderShares;
        }
        v.highWaterNav = navFixed(vaultId); // 扣费后新高水位
        emit ProfitFeeAccrued(vaultId, leader, leaderShares, v.highWaterNav);
    }

    // ── 管理 ────────────────────────────────────────────────────
    function setRelayer(address _relayer) external onlyOwner {
        require(_relayer != address(0), "CV: relayer zero");
        relayer = _relayer;
        emit RelayerChanged(_relayer);
    }
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedChanged(_paused);
    }

    // ── 偿付视图（I2）──────────────────────────────────────────
    function totalLiabilities() public view returns (uint256) {
        return totalCollateral + totalVaultBankroll; // reserved 是 bankroll 子集，不另计
    }
    /// @notice 链上余额是否覆盖内部负债（允许 dust surplus ≥ 0）。
    function isSolvent() external view returns (bool) {
        return usdc.balanceOf(address(this)) >= _toBase(totalLiabilities());
    }
}

