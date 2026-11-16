// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title MedBatchEscrow
 * @notice Educational prototype for HealthyChain cold-chain pharmaceutical escrow in Kazakhstan.
 * @dev Implements RBAC, temperature excursion dispute automation, and reentrancy protection.
 */
contract MedBatchEscrow is AccessControl, ReentrancyGuard, Pausable {
    bytes32 public constant MANUFACTURER_ROLE = keccak256("MANUFACTURER_ROLE");
    bytes32 public constant IOT_GATEWAY_ROLE = keccak256("IOT_GATEWAY_ROLE");
    bytes32 public constant CARRIER_ROLE = keccak256("CARRIER_ROLE");
    bytes32 public constant PHARMACY_ROLE = keccak256("PHARMACY_ROLE");

    enum BatchStatus {
        Created,
        InTransit,
        PendingInspection,
        Settled,
        Disputed,
        Refunded
    }

    struct Batch {
        string batchId;
        address manufacturer;
        address pharmacy;
        int256 tempMin;       // Scaled by 100 (e.g., +2.00 C = 200)
        int256 tempMax;       // Scaled by 100 (e.g., +8.00 C = 800)
        uint256 escrowAmount;
        uint256 deadline;
        bytes32 deliveryHash;
        BatchStatus status;
    }

    mapping(string => Batch) private batches;
    mapping(string => bool) private batchExists;

    event BatchCreated(
        string indexed batchId,
        address indexed manufacturer,
        address indexed pharmacy,
        int256 tempMin,
        int256 tempMax,
        uint256 escrowAmount,
        uint256 deadline
    );
    event TelemetryLogged(string indexed batchId, int256 currentTemp, uint256 timestamp, bool breached);
    event DeliveryConfirmed(string indexed batchId, address indexed carrier, bytes32 deliveryHash);
    event PaymentReleased(string indexed batchId, address indexed manufacturer, uint256 amount);
    event BatchRefunded(string indexed batchId, address indexed pharmacy, uint256 amount);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @notice Pharmacy/Buyer or Manufacturer initiates a cold-chain batch with locked escrow funds.
     */
    function createBatch(
        string calldata batchId,
        address manufacturer,
        address pharmacy,
        int256 tempMin,
        int256 tempMax,
        uint256 durationSeconds
    ) external payable whenNotPaused onlyRole(MANUFACTURER_ROLE) {
        require(!batchExists[batchId], "Batch ID already exists");
        require(msg.value > 0, "Escrow value must be greater than zero");
        require(tempMin < tempMax, "Invalid temperature range");
        require(manufacturer != address(0) && pharmacy != address(0), "Invalid participant address");

        batches[batchId] = Batch({
            batchId: batchId,
            manufacturer: manufacturer,
            pharmacy: pharmacy,
            tempMin: tempMin,
            tempMax: tempMax,
            escrowAmount: msg.value,
            deadline: block.timestamp + durationSeconds,
            deliveryHash: bytes32(0),
            status: BatchStatus.Created
        });
        batchExists[batchId] = true;

        emit BatchCreated(
            batchId,
            manufacturer,
            pharmacy,
            tempMin,
            tempMax,
            msg.value,
            block.timestamp + durationSeconds
        );
    }

    /**
     * @notice IoT Gateway logs temperature telemetry. Breaching bounds automatically sets state to Disputed.
     */
    function logTelemetry(
        string calldata batchId,
        int256 currentTemp,
        uint256 timestamp
    ) external whenNotPaused onlyRole(IOT_GATEWAY_ROLE) {
        require(batchExists[batchId], "Batch does not exist");
        Batch storage batch = batches[batchId];
        require(
            batch.status == BatchStatus.Created || batch.status == BatchStatus.InTransit,
            "Batch not active in transit"
        );

        if (batch.status == BatchStatus.Created) {
            batch.status = BatchStatus.InTransit;
        }

        bool breached = (currentTemp < batch.tempMin || currentTemp > batch.tempMax);
        if (breached) {
            batch.status = BatchStatus.Disputed;
        }

        emit TelemetryLogged(batchId, currentTemp, timestamp, breached);
    }

    /**
     * @notice Carrier confirms arrival at pharmacy/hospital with off-chain proof hash.
     */
    function confirmDelivery(
        string calldata batchId,
        bytes32 deliveryHash
    ) external whenNotPaused onlyRole(CARRIER_ROLE) {
        require(batchExists[batchId], "Batch does not exist");
        Batch storage batch = batches[batchId];
        require(
            batch.status == BatchStatus.Created || batch.status == BatchStatus.InTransit,
            "Cannot confirm delivery in current state"
        );
        require(block.timestamp <= batch.deadline, "Delivery deadline exceeded");
        require(deliveryHash != bytes32(0), "Delivery proof hash required");

        batch.deliveryHash = deliveryHash;
        batch.status = BatchStatus.PendingInspection;

        emit DeliveryConfirmed(batchId, msg.sender, deliveryHash);
    }

    /**
     * @notice Pharmacy inspects goods and releases escrowed payment to manufacturer.
     */
    function releasePayment(
        string calldata batchId,
        bool inspectionPassed
    ) external nonReentrant whenNotPaused onlyRole(PHARMACY_ROLE) {
        require(batchExists[batchId], "Batch does not exist");
        Batch storage batch = batches[batchId];
        require(msg.sender == batch.pharmacy, "Caller is not designated pharmacy");
        require(batch.status == BatchStatus.PendingInspection, "Batch not pending inspection");

        if (!inspectionPassed) {
            batch.status = BatchStatus.Disputed;
            return;
        }

        uint256 payout = batch.escrowAmount;
        batch.escrowAmount = 0;
        batch.status = BatchStatus.Settled;

        (bool sent, ) = payable(batch.manufacturer).call{value: payout}("");
        require(sent, "Escrow transfer failed");

        emit PaymentReleased(batchId, batch.manufacturer, payout);
    }

    /**
     * @notice Refunds escrow to pharmacy if batch was disputed due to temperature breach or missed deadline.
     */
    function claimRefund(string calldata batchId) external nonReentrant whenNotPaused onlyRole(PHARMACY_ROLE) {
        require(batchExists[batchId], "Batch does not exist");
        Batch storage batch = batches[batchId];
        require(msg.sender == batch.pharmacy, "Caller is not designated pharmacy");

        bool expired = (block.timestamp > batch.deadline &&
            (batch.status == BatchStatus.Created || batch.status == BatchStatus.InTransit));
        require(batch.status == BatchStatus.Disputed || expired, "Batch not eligible for refund");

        uint256 refundAmount = batch.escrowAmount;
        require(refundAmount > 0, "No funds to refund");

        batch.escrowAmount = 0;
        batch.status = BatchStatus.Refunded;

        (bool sent, ) = payable(batch.pharmacy).call{value: refundAmount}("");
        require(sent, "Refund transfer failed");

        emit BatchRefunded(batchId, batch.pharmacy, refundAmount);
    }

    function getBatch(string calldata batchId) external view returns (Batch memory) {
        require(batchExists[batchId], "Batch does not exist");
        return batches[batchId];
    }
}
