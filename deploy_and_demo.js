const { ethers } = require("hardhat");

async function main() {
  const [admin, manufacturer, iotGateway, carrier, pharmacy] = await ethers.getSigners();

  console.log("=== Deploying HealthyChain MedBatchEscrow ===");
  const MedBatchEscrow = await ethers.getContractFactory("MedBatchEscrow");
  const escrow = await MedBatchEscrow.deploy(admin.address);
  await escrow.waitForDeployment();

  const contractAddress = await escrow.getAddress();
  console.log("MedBatchEscrow deployed to:", contractAddress);

  // Assign Roles
  await escrow.grantRole(await escrow.MANUFACTURER_ROLE(), manufacturer.address);
  await escrow.grantRole(await escrow.IOT_GATEWAY_ROLE(), iotGateway.address);
  await escrow.grantRole(await escrow.CARRIER_ROLE(), carrier.address);
  await escrow.grantRole(await escrow.PHARMACY_ROLE(), pharmacy.address);
  console.log("Roles assigned to Manufacturer, IoT Gateway, Carrier, and Pharmacy.\n");

  // Step 1: Create Batch
  const batchId = "INSULIN-ASTANA-104";
  const escrowVal = ethers.parseEther("2.0");
  console.log(`[1] Manufacturer creating batch ${batchId} (+2.0C to +8.0C) with 2.0 ETH escrow...`);
  await escrow
    .connect(manufacturer)
    .createBatch(batchId, manufacturer.address, pharmacy.address, 200, 800, 86400, {
      value: escrowVal,
    });

  // Step 2: Log Telemetry
  const timestamp = Math.floor(Date.now() / 1000);
  console.log(`[2] IoT Gateway logging valid cold-chain temperature: +4.8C...`);
  await escrow.connect(iotGateway).logTelemetry(batchId, 480, timestamp);

  // Step 3: Confirm Delivery
  const deliveryHash = ethers.keccak256(ethers.toUtf8Bytes("DELIVERY-RECEIPT-104"));
  console.log(`[3] Carrier confirming physical delivery with hash ${deliveryHash}...`);
  await escrow.connect(carrier).confirmDelivery(batchId, deliveryHash);

  // Step 4: Release Payment
  console.log(`[4] Pharmacy approving inspection and releasing escrow payout...`);
  await escrow.connect(pharmacy).releasePayment(batchId, true);

  const finalBatch = await escrow.getBatch(batchId);
  console.log(`\n=== Settlement Complete! Final Batch Status: ${finalBatch.status} (3 = Settled) ===`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
