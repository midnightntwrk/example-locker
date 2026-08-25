// This file is part of example-locker.
// Copyright (C) 2026 Midnight Foundation
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { type ContractAddress } from '@midnight-ntwrk/compact-runtime';
import * as LockerContract from '../../contract/src/managed/locker/contract/index.js';
import { witnesses, createLockerPrivateState, setCombination, type LockerPrivateState } from '../../contract/src/witnesses.js';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { type MidnightProvider, type WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles, generateRandomSeed } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
  type UnshieldedKeystore,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { assertIsContractAddress, toHex } from '@midnight-ntwrk/midnight-js-utils';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { Buffer } from 'buffer';
import {
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from '@midnight-ntwrk/wallet-sdk-address-format';
import * as Rx from 'rxjs';
import { WebSocket } from 'ws';
import {
  type LockerCircuits,
  LockerPrivateStateId,
  type LockerProviders,
  type DeployedLockerContract,
} from './common-types.js';
import { type Config, zkConfigPath, privateStateStoreName } from './config.js';

// @ts-expect-error: WebSocket polyfill required for Node.js GraphQL subscriptions
globalThis.WebSocket = WebSocket;

const lockerCompiledContract = CompiledContract.make<LockerContract.Contract<LockerPrivateState>>(
  'locker',
  LockerContract.Contract,
).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);

export interface WalletContext {
  wallet: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

// ── Ledger state ─────────────────────────────────────────────────────────────

export const getLedgerState = async (providers: LockerProviders, contractAddress: ContractAddress) => {
  assertIsContractAddress(contractAddress);
  const state = await providers.publicDataProvider.queryContractState(contractAddress);
  return state ? LockerContract.ledger(state.data) : null;
};

// ── Deploy & join ─────────────────────────────────────────────────────────────

export const deploy = async (providers: LockerProviders): Promise<DeployedLockerContract> =>
  deployContract(providers, {
    compiledContract: lockerCompiledContract,
    privateStateId: LockerPrivateStateId,
    initialPrivateState: createLockerPrivateState(),
  });

export const joinContract = async (
  providers: LockerProviders,
  contractAddress: string,
): Promise<DeployedLockerContract> =>
  findDeployedContract(providers, {
    contractAddress,
    compiledContract: lockerCompiledContract,
    privateStateId: LockerPrivateStateId,
    initialPrivateState: createLockerPrivateState(),
  });

// ── Circuit calls ─────────────────────────────────────────────────────────────

// Rents a locker and commits the combination hash in one transaction.
// Returns the assigned locker ID by reading totalLockers after the call
// (new lockers) or the queue state (reused lockers). Since the contract handles
// both cases internally, the CLI just needs the combination.
export const rent = async (
  c: DeployedLockerContract,
  providers: LockerProviders,
  combination: number,
): Promise<bigint> => {
  setCombination(combination);
  await c.callTx.rent();
  // The assigned ID is the current totalLockers value if a new locker was created,
  // but for reused lockers it could be lower. Read ledger state to find it.
  const state = await getLedgerState(providers, c.deployTxData.public.contractAddress);
  return state?.totalLockers ?? 0n;
};

export const vacate = async (c: DeployedLockerContract, id: bigint, combination: number) => {
  setCombination(combination);
  await c.callTx.vacate(id);
};

// Returns the list of locker IDs currently in the bank, available for reuse.
export const getAvailableLockers = async (
  providers: LockerProviders,
  contractAddress: ContractAddress,
): Promise<bigint[]> => {
  assertIsContractAddress(contractAddress);
  const state = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!state) return [];
  const ledgerState = LockerContract.ledger(state.data);
  return [...ledgerState.lockerBank];
};

// ── Wallet ────────────────────────────────────────────────────────────────────

export const withStatus = async <T>(message: string, fn: () => Promise<T>): Promise<T> => {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const interval = setInterval(() => process.stdout.write(`\r  ${frames[i++ % frames.length]} ${message}`), 80);
  try {
    const result = await fn();
    clearInterval(interval);
    process.stdout.write(`\r  ✓ ${message}\n`);
    return result;
  } catch (e) {
    clearInterval(interval);
    process.stdout.write(`\r  ✗ ${message}\n`);
    throw e;
  }
};

const deriveKeys = (seed: string) => {
  const hd = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hd.type !== 'seedOk') throw new Error('Invalid seed');
  const r = hd.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  if (r.type !== 'keysDerived') throw new Error('Key derivation failed');
  hd.hdWallet.clear();
  return r.keys;
};

const shieldedCfg = ({ indexer, indexerWS, node, proofServer }: Config) => ({
  networkId: getNetworkId(),
  indexerClientConnection: { indexerHttpUrl: indexer, indexerWsUrl: indexerWS },
  provingServerUrl: new URL(proofServer),
  relayURL: new URL(node.replace(/^http/, 'ws')),
});

const unshieldedCfg = ({ indexer, indexerWS }: Config) => ({
  networkId: getNetworkId(),
  indexerClientConnection: { indexerHttpUrl: indexer, indexerWsUrl: indexerWS },
  txHistoryStorage: new InMemoryTransactionHistoryStorage(),
});

const dustCfg = (c: Config) => ({
  ...shieldedCfg(c),
  costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
});

export const waitForSync = (wallet: WalletFacade) =>
  Rx.firstValueFrom(wallet.state().pipe(Rx.throttleTime(5_000), Rx.filter((s) => s.isSynced)));

export const waitForFunds = (wallet: WalletFacade): Promise<bigint> =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(10_000),
      Rx.filter((s) => s.isSynced),
      Rx.map((s) => s.unshielded.balances[unshieldedToken().raw] ?? 0n),
      Rx.filter((b) => b > 0n),
    ),
  );

const registerForDust = async (wallet: WalletFacade, ks: UnshieldedKeystore) => {
  const state = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  if (state.dust.availableCoins.length > 0) {
    console.log(`  ✓ Dust available (${state.dust.balance(new Date()).toLocaleString()})`);
    return;
  }
  const unregistered = state.unshielded.availableCoins.filter((c: any) => !c.meta?.registeredForDustGeneration);
  if (unregistered.length > 0) {
    await withStatus(`Registering ${unregistered.length} NIGHT UTXO(s) for DUST`, async () => {
      const recipe = await wallet.registerNightUtxosForDustGeneration(
        unregistered, ks.getPublicKey(), (p) => ks.signData(p),
      );
      await wallet.submitTransaction(await wallet.finalizeRecipe(recipe));
    });
  }
  await withStatus('Waiting for DUST', () =>
    Rx.firstValueFrom(wallet.state().pipe(
      Rx.throttleTime(5_000), Rx.filter((s) => s.isSynced), Rx.filter((s) => s.dust.balance(new Date()) > 0n),
    )),
  );
};

const signIntents = (tx: { intents?: Map<number, any> }, sign: (p: Uint8Array) => ledger.Signature, marker: 'proof' | 'pre-proof') => {
  if (!tx.intents?.size) return;
  for (const seg of tx.intents.keys()) {
    const intent = tx.intents.get(seg);
    if (!intent) continue;
    const cloned = ledger.Intent.deserialize<ledger.SignatureEnabled, ledger.Proofish, ledger.PreBinding>(
      'signature', marker, 'pre-binding', intent.serialize(),
    );
    const sig = sign(cloned.signatureData(seg));
    if (cloned.fallibleUnshieldedOffer) {
      cloned.fallibleUnshieldedOffer = cloned.fallibleUnshieldedOffer.addSignatures(
        cloned.fallibleUnshieldedOffer.inputs.map((_: any, i: number) => cloned.fallibleUnshieldedOffer!.signatures.at(i) ?? sig),
      );
    }
    if (cloned.guaranteedUnshieldedOffer) {
      cloned.guaranteedUnshieldedOffer = cloned.guaranteedUnshieldedOffer.addSignatures(
        cloned.guaranteedUnshieldedOffer.inputs.map((_: any, i: number) => cloned.guaranteedUnshieldedOffer!.signatures.at(i) ?? sig),
      );
    }
    tx.intents.set(seg, cloned);
  }
};

export const createWalletProvider = async (ctx: WalletContext): Promise<WalletProvider & MidnightProvider> => {
  const state = await Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  return {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx, ttl?) {
      const recipe = await ctx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      const sign = (p: Uint8Array) => ctx.unshieldedKeystore.signData(p);
      signIntents(recipe.baseTransaction, sign, 'proof');
      if (recipe.balancingTransaction) signIntents(recipe.balancingTransaction, sign, 'pre-proof');
      return ctx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx) => ctx.wallet.submitTransaction(tx) as any,
  };
};

export const buildWallet = async (config: Config, seed: string): Promise<WalletContext> => {
  const { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore } = await withStatus('Building wallet', async () => {
    const keys = deriveKeys(seed);
    const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
    const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
    const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], getNetworkId());
    const cfg = { ...shieldedCfg(config), ...unshieldedCfg(config), ...dustCfg(config) };
    const wallet = await WalletFacade.init({
      configuration: cfg,
      shielded: (c) => ShieldedWallet(c).startWithSecretKeys(shieldedSecretKeys),
      unshielded: (c) => UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
      dust: (c) => DustWallet(c).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
    });
    await wallet.start(shieldedSecretKeys, dustSecretKey);
    return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
  });

  const DIV = '──────────────────────────────────────────────────────────────';
  const networkId = getNetworkId();
  console.log(`\n${DIV}\n  Address: ${unshieldedKeystore.getBech32Address()}\n  Faucet:  https://faucet.preprod.midnight.network/\n${DIV}\n`);

  const synced = await withStatus('Syncing with network', () => waitForSync(wallet));
  const ck = ShieldedCoinPublicKey.fromHexString(synced.shielded.coinPublicKey.toHexString());
  const ek = ShieldedEncryptionPublicKey.fromHexString(synced.shielded.encryptionPublicKey.toHexString());
  console.log(`  Shielded: ${MidnightBech32m.encode(networkId, new ShieldedAddress(ck, ek))}`);
  console.log(`  Balance:  ${(synced.unshielded.balances[unshieldedToken().raw] ?? 0n).toLocaleString()} tNight\n`);

  if ((synced.unshielded.balances[unshieldedToken().raw] ?? 0n) === 0n) {
    await withStatus('Waiting for tNight', () => waitForFunds(wallet));
  }
  await registerForDust(wallet, unshieldedKeystore);
  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
};

export const buildFreshWallet = async (config: Config): Promise<WalletContext> => {
  const seed = toHex(Buffer.from(generateRandomSeed()));
  const DIV = '──────────────────────────────────────────────────────────────';
  console.log(`\n${DIV}\n  New wallet — save your seed phrase:\n\n  ${seed}\n${DIV}\n`);
  return buildWallet(config, seed);
};

export const getDustBalance = async (wallet: WalletFacade): Promise<bigint> => {
  const state = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  return state.dust.balance(new Date());
};

export const configureProviders = async (ctx: WalletContext, config: Config): Promise<LockerProviders> => {
  const walletProvider = await createWalletProvider(ctx);
  const zkProvider = new NodeZkConfigProvider<LockerCircuits>(zkConfigPath);
  const accountId = walletProvider.getCoinPublicKey();
  const sanitized = accountId.replace(/(.)\1{3,}/g, '$1$1$1');
  const storagePassword = `L0ck!${sanitized.slice(0, 12)}Aa1`;
  return {
    privateStateProvider: levelPrivateStateProvider<typeof LockerPrivateStateId>({
      privateStateStoreName,
      accountId,
      privateStoragePasswordProvider: () => storagePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWS),
    zkConfigProvider: zkProvider,
    proofProvider: httpClientProofProvider(config.proofServer, zkProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
};
