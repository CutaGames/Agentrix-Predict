// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockUSDC
 * @notice TESTNET-ONLY 6-decimal USDC stand-in for the LSM on-chain settlement platform.
 *
 * Rationale (see spec lsm-onchain-stablecoin-platform, Requirement 1): Circle's
 * testnet faucet only dispenses ~20 USDC per address per 2h, which cannot seed the
 * official vault bankroll nor fund batches of test accounts. Testnet tokens have no
 * real value, so a self-issued mintable USDC is economically identical to the official
 * testnet USDC while letting the owner mint arbitrary amounts for vault seeding + QA.
 *
 * The production `CollateralVault` is token-agnostic (takes the USDC address as a
 * constructor arg), so mainnet simply points it at Circle's native USDC on Injective —
 * this contract is NEVER deployed to mainnet.
 */
contract MockUSDC is ERC20, Ownable {
    uint8 private constant DECIMALS = 6;

    constructor() ERC20("Mock USD Coin", "USDC") {}

    /// @dev USDC uses 6 decimals (not the ERC20 default 18).
    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }

    /// @notice Owner mints test USDC (e.g. to the treasury for vault seeding, or to QA wallets).
    function mint(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "MockUSDC: mint to zero");
        _mint(to, amount);
    }
}
