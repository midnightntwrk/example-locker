// This file is part of example-locker.
// Copyright (C) 2026 Midnight Foundation
// SPDX-License-Identifier: Apache-2.0

import { stdin as input, stdout as output } from 'node:process';
import { createInterface, type Interface } from 'node:readline/promises';
import { type Config, StandaloneConfig } from './config.js';
import * as api from './api.js';
import { type LockerProviders, type DeployedLockerContract } from './common-types.js';

const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';
const D = '──────────────────────────────────────────────────────────────';

const BANNER = `
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║              Midnight Locker Example                         ║
║              ─────────────────────────                       ║
║              ZK-protected combinations on-chain              ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

const dustLabel = async (wallet: api.WalletContext['wallet']): Promise<string> => {
  try { return (await api.getDustBalance(wallet)).toLocaleString(); } catch { return ''; }
};

const askCombination = async (rli: Interface, prompt: string): Promise<number> => {
  while (true) {
    const val = await rli.question(`  ${prompt} (0–9999): `);
    const n = parseInt(val.trim(), 10);
    if (!isNaN(n) && n >= 0 && n <= 9999) return n;
    console.log('  Please enter a number between 0 and 9999.\n');
  }
};

const askId = async (rli: Interface): Promise<bigint> => {
  const val = await rli.question('  Locker ID: ');
  return BigInt(val.trim());
};

// ── Wallet setup ──────────────────────────────────────────────────────────────

const setupWallet = async (config: Config, rli: Interface): Promise<api.WalletContext | null> => {
  if (config instanceof StandaloneConfig) return api.buildWallet(config, GENESIS_SEED);

  const choice = await rli.question(
    `\n${D}\n  Wallet Setup\n${D}\n  [1] Create a new wallet\n  [2] Restore wallet from seed\n  [3] Exit\n${D}\n> `,
  );

  if (choice.trim() === '1') return api.buildFreshWallet(config);
  if (choice.trim() === '2') {
    const seed = await rli.question('  Enter your wallet seed: ');
    return api.buildWallet(config, seed.trim());
  }
  return null;
};

// ── Contract setup ────────────────────────────────────────────────────────────

const setupContract = async (
  providers: LockerProviders,
  walletCtx: api.WalletContext,
  rli: Interface,
): Promise<DeployedLockerContract | null> => {
  while (true) {
    const dust = await dustLabel(walletCtx.wallet);
    const choice = await rli.question(
      `\n${D}\n  Contract Actions${dust ? `                    DUST: ${dust}` : ''}\n${D}\n` +
      `  [1] Deploy a new locker contract\n  [2] Join an existing locker contract\n  [3] Exit\n${D}\n> `,
    );

    if (choice.trim() === '1') {
      try {
        const contract = await api.withStatus('Deploying locker contract', () => api.deploy(providers));
        console.log(`\n  Contract address: ${contract.deployTxData.public.contractAddress}\n`);
        return contract;
      } catch (e) {
        console.log(`\n  ✗ ${e instanceof Error ? e.message : e}\n`);
      }
    } else if (choice.trim() === '2') {
      const addr = await rli.question('  Enter the contract address (hex): ');
      try {
        return await api.withStatus('Joining contract', () => api.joinContract(providers, addr.trim()));
      } catch (e) {
        console.log(`\n  ✗ ${e instanceof Error ? e.message : e}\n`);
      }
    } else {
      return null;
    }
  }
};

// ── Main loop ─────────────────────────────────────────────────────────────────

const mainLoop = async (
  providers: LockerProviders,
  walletCtx: api.WalletContext,
  contract: DeployedLockerContract,
  rli: Interface,
): Promise<void> => {
  const address = contract.deployTxData.public.contractAddress;

  while (true) {
    const dust = await dustLabel(walletCtx.wallet);
    const choice = await rli.question(
      `\n${D}\n  Locker Actions${dust ? `                     DUST: ${dust}` : ''}\n${D}\n` +
      `  [1] Rent a locker\n  [2] Vacate a locker\n  [3] Show locker status\n  [4] Exit\n${D}\n> `,
    );

    switch (choice.trim()) {

      case '1': // Rent
        try {
          // Show available (vacated) lockers before asking for a combination so the
          // user knows whether they are getting a fresh slot or a reused one.
          const vacated = await api.getAvailableLockers(providers, address);
          if (vacated.length > 0) {
            console.log(`\n  Available lockers for reuse: ${vacated.join(', ')}`);
            console.log('  One of these slots will be reused.\n');
          } else {
            console.log('\n  No vacated lockers - a new slot will be created.\n');
          }
          const combo = await askCombination(rli, 'Set a combination for this locker');
          const id = await api.withStatus('Renting locker', () => api.rent(contract, providers, combo));
          console.log(`\n  Locker ${id} rented. Combination hash committed on-chain.\n  The digits never appeared in any transaction transcript.\n`);
        } catch (e) { console.log(`\n  ✗ ${e instanceof Error ? e.message : e}\n`); }
        break;

      case '2': // Vacate
        try {
          const id = await askId(rli);
          const combo = await askCombination(rli, 'Enter combination');
          await api.withStatus(`Vacating locker ${id}`, () => api.vacate(contract, id, combo));
          console.log(`\n  Locker ${id} is now available and queued for reuse.\n  ZK proof verified your combination without revealing it.\n`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('locker is not rented')) {
            console.log(`\n  ✗ Locker is already available — it has not been rented.\n`);
          } else if (msg.includes('wrong combination')) {
            console.log(`\n  ✗ Wrong combination — the proof failed.\n`);
          } else {
            console.log(`\n  ✗ ${msg}\n`);
          }
        }
        break;

      case '3': // Show status
        try {
          const state = await api.getLedgerState(providers, address);
          const total = state ? Number(state.totalLockers) : 0;
          const available = await api.getAvailableLockers(providers, address);
          console.log(`\n  Total lockers: ${total}${total > 0 ? `  (IDs 1 - ${total})` : ''}`);
          if (available.length > 0) {
            console.log(`  Available for reuse: ${available.join(', ')}`);
          } else {
            console.log('  No available lockers.');
          }
          console.log('');
        } catch (e) { console.log(`\n  x ${e instanceof Error ? e.message : e}\n`); }
        break;

      case '4': return;
      default: console.log(`\n  Invalid option.\n`);
    }
  }
};

// ── Entry point ───────────────────────────────────────────────────────────────

export const run = async (config: Config): Promise<void> => {
  console.log(BANNER);
  const rli = createInterface({ input, output, terminal: true });

  try {
    const walletCtx = await setupWallet(config, rli);
    if (!walletCtx) return;

    try {
      const providers = await api.withStatus('Configuring providers', () => api.configureProviders(walletCtx, config));
      console.log('');

      const contract = await setupContract(providers, walletCtx, rli);
      if (!contract) return;

      await mainLoop(providers, walletCtx, contract, rli);
    } catch (e) {
      if (e instanceof Error) console.error(e.message);
      else throw e;
    } finally {
      try { await walletCtx.wallet.stop(); } catch {}
    }
  } finally {
    rli.close();
    rli.removeAllListeners();
    console.log('\nGoodbye.');
  }
};
