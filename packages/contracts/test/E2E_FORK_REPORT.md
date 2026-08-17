# Base Sepolia real-Circle-USDC E2E run

| Field | Value |
| --- | --- |
| Executed test revision | `d5e8129f604611b64fd25f405db79f995ea11560` |
| Contract source pin | `4799a6f29e3919634afc1d1ff14ec8c0111014d7` |
| Fork network | Base Sepolia (`84532`) |
| Fork block | `45552959` |
| RPC | `https://sepolia.base.org` |
| Mode | local read-only Foundry fork; no broadcast, transaction, funds, or external key used |

The shell recorded `git rev-parse HEAD` both before and after the command. Both values were `d5e8129f604611b64fd25f405db79f995ea11560`.

```text
No files changed, compilation skipped

Ran 13 tests for packages/contracts/test/EscrowTreeE2E.t.sol:EscrowTreeE2ETest
[PASS] test_abandonRefundExcludesLiveChildFromLedger() (gas: 5462391)
[PASS] test_claimAcceptTimeoutIsPermissionlessAndReleasesWorker() (gas: 5348155)
[PASS] test_claimNonDeliveryIsPermissionlessAndRefundsBuyer() (gas: 5279793)
[PASS] test_feePassUsesCeilingReserveAndReturnsGrossOnRefund() (gas: 11144600)
[PASS] test_happyPathConservesAndWithdrawsRealUsdc() (gas: 5746829)
[PASS] test_m107CurrentUnallocatedRoutesOnRefundedTerminal() (gas: 5793565)
[PASS] test_m107CurrentUnallocatedRoutesOnReleasedTerminal() (gas: 5849894)
[PASS] test_noAdministrativeSelectorMovesFunds() (gas: 5236701)
[PASS] test_realAllowanceFundingUsesSameInitialLedger() (gas: 5297031)
[PASS] test_realEip3009FundingIsRelayableAndSingleUse() (gas: 10754221)
[PASS] test_rejectRefundRestoresBuyerAndFreezesTree() (gas: 5564966)
[PASS] test_releasedAncestorRefundRoutesToPending() (gas: 5713643)
[PASS] test_surplusIsStuckOnBothTerminalPaths() (gas: 10576592)
Suite result: ok. 13 passed; 0 failed; 0 skipped; finished in 427.83ms (873.44ms CPU time)

Ran 1 test suite in 438.80ms (427.83ms CPU time): 13 tests passed, 0 failed, 0 skipped (13 total tests)
```
