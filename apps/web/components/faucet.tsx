"use client";

import { useEffect, useState } from "react";
import { useReadContracts } from "wagmi";
import { useAddresses, contractFor } from "../lib/contracts";
import { useViewer } from "./connect";
import { useTx, TxStatus, TxButton } from "./tx";
import { Panel, Row } from "./ui";
import { hesoyam, timeUntil } from "../lib/format";

/**
 * The testnet HESOYAM faucet.
 *
 * A fresh deployment mints the whole supply to the deployer, so a tester who
 * connects a wallet and gets testnet ETH from a public faucet still cannot do
 * anything in the game that costs HESOYAM, which is everything past looking at
 * the room. This closes that gap.
 *
 * Two independent gates keep it from ever appearing anywhere real:
 *   1. `contractFor` returns undefined unless a faucet address exists for the
 *      connected chain, which is only ever written by the standalone
 *      `faucet-deploy` script, never by the main deploy.
 *   2. The chain id is checked explicitly against testnet, not just "some
 *      testnet flag", so a future chain added to the app does not
 *      accidentally inherit this panel by having `testnet: true` set on it.
 */
const ROBINHOOD_TESTNET_CHAIN_ID = 46630;

export function Faucet() {
  const { address } = useViewer();
  const { addresses, chainId } = useAddresses();
  const faucetC = contractFor(addresses, "Faucet");

  if (chainId !== ROBINHOOD_TESTNET_CHAIN_ID || !faucetC || !address) return null;

  return <FaucetBody address={address} faucetC={faucetC} />;
}

function FaucetBody({
  address,
  faucetC,
}: {
  address: `0x${string}`;
  faucetC: { address: `0x${string}`; abi: readonly unknown[] };
}) {
  const tx = useTx();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const { data, refetch } = useReadContracts({
    contracts: [
      { ...faucetC, functionName: "amountPerClaim" },
      { ...faucetC, functionName: "canClaim", args: [address] },
      { ...faucetC, functionName: "nextClaimAt", args: [address] },
    ],
  });

  const amount = data?.[0]?.result as bigint | undefined;
  const canClaim = Boolean(data?.[1]?.result);
  const nextAt = Number((data?.[2]?.result as bigint | undefined) ?? 0n);

  return (
    <Panel
      title="Testnet faucet"
      subtitle="Free test HESOYAM, worth nothing, so you can actually try the game."
    >
      <Row label="Per claim" value={`${hesoyam(amount, 0)} HESOYAM`} />
      <Row
        label="Status"
        value={canClaim ? "ready" : `next claim in ${timeUntil(nextAt, now)}`}
        tone={canClaim ? "cash" : undefined}
      />
      <TxButton
        tx={tx}
        disabled={!canClaim}
        title={canClaim ? undefined : "Come back once your cooldown ends"}
        onClick={() =>
          void tx
            .run({ address: faucetC.address, abi: faucetC.abi as never, functionName: "claim" })
            .then(() => refetch())
        }
      >
        {canClaim ? "Claim test HESOYAM" : "Claimed already"}
      </TxButton>
      <TxStatus tx={tx} />
    </Panel>
  );
}
