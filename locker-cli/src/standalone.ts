// This file is part of example-locker.
// Copyright (C) 2026 Midnight Foundation
// SPDX-License-Identifier: Apache-2.0

import { run } from './cli.js';
import { StandaloneConfig } from './config.js';

// Suppress noisy wallet SDK / polkadot.js messages written directly to stderr.
const _stderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk: any, ...args: any[]) => {
  const s = chunk.toString();
  if (s.includes('API-WS:') || s.includes('Wallet.Sync') || s.includes('RPC-CORE:')) return true;
  return _stderr(chunk, ...args);
};

await run(new StandaloneConfig());
