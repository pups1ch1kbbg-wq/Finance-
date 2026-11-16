Educational project for the course Introduction to Finance. Not a real product, service or investment offer. Do not use with real funds.

# HealthyChain — Cold-Chain Pharmaceutical Escrow Prototype

**Course:** Introduction to Finance (2026–2027)  
**Group:** SE-2526  
**Team Members:** Zhangir Kairov, Azat Zholdygali  
**Supervisor:** Raskaliyev Timur  
**Demo Video:** [Insert Google Drive Demo Video Link Here]

## Overview
This repository contains the local Hardhat smart contract prototype for **HealthyChain**, a permissioned blockchain platform designed to prevent cold-chain spoilage and invoice settlement delays in Kazakhstan's pharmaceutical distribution sector.

The core smart contract (`contracts/MedBatchEscrow.sol`) uses OpenZeppelin's `AccessControl`, `ReentrancyGuard`, and `Pausable` libraries to enforce role-based permissions across four participants:
1. **Manufacturer (`MANUFACTURER_ROLE`):** Creates a pharmaceutical batch with $+2^\circ\text{C}$ to $+8^\circ\text{C}$ thresholds and locks escrow funds (`createBatch`).
2. **IoT Gateway (`IOT_GATEWAY_ROLE`):** Submits temperature readings (`logTelemetry`). Any reading outside the allowed range automatically transitions the batch to `Disputed`.
3. **Carrier (`CARRIER_ROLE`):** Submits the off-chain proof-of-delivery hash upon arrival (`confirmDelivery`).
4. **Pharmacy / Hospital (`PHARMACY_ROLE`):** Confirms physical inspection to release funds (`releasePayment`) or claims a refund if the batch was disputed or delayed (`claimRefund`).

## How to Run Locally
1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Compile the smart contract:**
   ```bash
   npx hardhat compile
   ```
3. **Run the 6 unit tests:**
   ```bash
   npx hardhat test
   ```
4. **Run the end-to-end deployment and simulation script:**
   ```bash
   npx hardhat run scripts/deploy_and_demo.js
   ```
