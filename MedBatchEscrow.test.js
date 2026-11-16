const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("MedBatchEscrow Smart Contract", function () {
  async function deployFixture() {
    const [admin, manufacturer, iotGateway, carrier, pharmacy, outsider] = await ethers.getSigners();

    const MedBatchEscrow = await ethers.getContractFactory("MedBatchEscrow");
    const escrow = await MedBatchEscrow.deploy(admin.address);

    await escrow.grantRole(await escrow.MANUFACTURER_ROLE(), manufacturer.address);
    await escrow.grantRole(await escrow.IOT_GATEWAY_ROLE(), iotGateway.address);
    await escrow.grantRole(await escrow.CARRIER_ROLE(), carrier.address);
    await escrow.grantRole(await escrow.PHARMACY_ROLE(), pharmacy.address);

    const batchId = "BATCH-KZ-2026-001";
    const tempMin = 200; // +2.00 C
    const tempMax = 800; // +8.00 C
    const duration = 86400; // 24 hours
    const escrowAmount = ethers.parseEther("5.0");

    return {
      escrow,
      admin,
      manufacturer,
      iotGateway,
      carrier,
      pharmacy,
      outsider,
      batchId,
      tempMin,
      tempMax,
      duration,
      escrowAmount,
    };
  }

  it("1. Completes the full cold-chain happy path and settles payment to manufacturer", async function () {
    const { escrow, manufacturer, iotGateway, carrier, pharmacy, batchId, tempMin, tempMax, duration, escrowAmount } =
      await deployFixture();

    await escrow
      .connect(manufacturer)
      .createBatch(batchId, manufacturer.address, pharmacy.address, tempMin, tempMax, duration, {
        value: escrowAmount,
      });

    let batch = await escrow.getBatch(batchId);
    expect(batch.status).to.equal(0); // Created

    // Valid temperature reading (+5.00 C)
    const now = await time.latest();
    await escrow.connect(iotGateway).logTelemetry(batchId, 500, now);
    batch = await escrow.getBatch(batchId);
    expect(batch.status).to.equal(1); // InTransit

    // Carrier confirms delivery
    const proofHash = ethers.keccak256(ethers.toUtf8Bytes("POD-SIGNED-ASTANA-01"));
    await escrow.connect(carrier).confirmDelivery(batchId, proofHash);
    batch = await escrow.getBatch(batchId);
    expect(batch.status).to.equal(2); // PendingInspection

    // Pharmacy passes inspection and releases payment
    await expect(
      escrow.connect(pharmacy).releasePayment(batchId, true)
    ).to.changeEtherBalance(manufacturer, escrowAmount);

    batch = await escrow.getBatch(batchId);
    expect(batch.status).to.equal(3); // Settled
  });

  it("2. Automatically marks batch as Disputed when temperature breaches +2C to +8C bounds", async function () {
    const { escrow, manufacturer, iotGateway, pharmacy, batchId, tempMin, tempMax, duration, escrowAmount } =
      await deployFixture();

    await escrow
      .connect(manufacturer)
      .createBatch(batchId, manufacturer.address, pharmacy.address, tempMin, tempMax, duration, {
        value: escrowAmount,
      });

    // Excursion temperature (+11.50 C = 1150)
    const now = await time.latest();
    await expect(escrow.connect(iotGateway).logTelemetry(batchId, 1150, now))
      .to.emit(escrow, "TelemetryLogged")
      .withArgs(batchId, 1150, now, true);

    const batch = await escrow.getBatch(batchId);
    expect(batch.status).to.equal(4); // Disputed
  });

  it("3. Allows pharmacy to claim full refund after temperature excursion dispute", async function () {
    const { escrow, manufacturer, iotGateway, pharmacy, batchId, tempMin, tempMax, duration, escrowAmount } =
      await deployFixture();

    await escrow
      .connect(manufacturer)
      .createBatch(batchId, manufacturer.address, pharmacy.address, tempMin, tempMax, duration, {
        value: escrowAmount,
      });

    const now = await time.latest();
    await escrow.connect(iotGateway).logTelemetry(batchId, -100, now); // -1.00 C freeze breach

    await expect(
      escrow.connect(pharmacy).claimRefund(batchId)
    ).to.changeEtherBalance(pharmacy, escrowAmount);

    const batch = await escrow.getBatch(batchId);
    expect(batch.status).to.equal(5); // Refunded
  });

  it("4. Refunds pharmacy if carrier misses the delivery deadline", async function () {
    const { escrow, manufacturer, pharmacy, batchId, tempMin, tempMax, duration, escrowAmount } =
      await deployFixture();

    await escrow
      .connect(manufacturer)
      .createBatch(batchId, manufacturer.address, pharmacy.address, tempMin, tempMax, duration, {
        value: escrowAmount,
      });

    await time.increase(duration + 10);

    await expect(
      escrow.connect(pharmacy).claimRefund(batchId)
    ).to.changeEtherBalance(pharmacy, escrowAmount);

    const batch = await escrow.getBatch(batchId);
    expect(batch.status).to.equal(5); // Refunded
  });

  it("5. Enforces Role-Based Access Control (RBAC) and blocks unauthorized callers", async function () {
    const { escrow, manufacturer, carrier, pharmacy, outsider, batchId, tempMin, tempMax, duration, escrowAmount } =
      await deployFixture();

    await expect(
      escrow
        .connect(outsider)
        .createBatch(batchId, manufacturer.address, pharmacy.address, tempMin, tempMax, duration, {
          value: escrowAmount,
        })
    ).to.be.reverted;

    await escrow
      .connect(manufacturer)
      .createBatch(batchId, manufacturer.address, pharmacy.address, tempMin, tempMax, duration, {
        value: escrowAmount,
      });

    // Carrier cannot log IoT telemetry
    const now = await time.latest();
    await expect(escrow.connect(carrier).logTelemetry(batchId, 450, now)).to.be.reverted;
  });

  it("6. Allows admin to pause contract in an emergency and blocks state-changing calls", async function () {
    const { escrow, admin, manufacturer, pharmacy, batchId, tempMin, tempMax, duration, escrowAmount } =
      await deployFixture();

    await escrow.connect(admin).pause();

    await expect(
      escrow
        .connect(manufacturer)
        .createBatch(batchId, manufacturer.address, pharmacy.address, tempMin, tempMax, duration, {
          value: escrowAmount,
        })
    ).to.be.reverted;

    await escrow.connect(admin).unpause();

    await expect(
      escrow
        .connect(manufacturer)
        .createBatch(batchId, manufacturer.address, pharmacy.address, tempMin, tempMax, duration, {
          value: escrowAmount,
        })
    ).to.not.be.reverted;
  });
});
