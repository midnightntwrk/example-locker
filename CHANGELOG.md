# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-04-02

### Added

- Compact smart contract (`locker.compact`) with `addLocker`, `rent`, and `open` circuits.
- Zero-knowledge combination verification — 4-digit code is hashed on-chain, opening produces a ZK proof without revealing the digits.
- Interactive CLI with wallet creation, contract deployment, and locker management.
- Standalone (local devnet) and preprod network configurations.
- Wallet setup using `wallet-sdk-facade` with HD wallet, shielded, unshielded, and dust wallets.
- Docker Compose file for local proof server (`proof-server.yml`).
- Step-by-step build tutorial (`TUTORIAL.md`).

[1.0.0]: https://github.com/midnightntwrk/example-locker/releases/tag/v1.0.0
