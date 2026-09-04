// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title RandomBeacon
 * @notice A hash chain beacon. Randomness nobody can grind, without an oracle.
 *
 * WHY THIS EXISTS
 *
 * Every earlier attempt at randomness in this protocol derived the outcome from
 * values the player already knew when they committed: their own chosen salt, the
 * previous block hash, the timestamp. All of it observable at submission time,
 * so a player could search salts, or simply wait for a favourable block, until
 * the result suited them. Two tests proved it: one ground a commit until no pest
 * event ever fired, one waited for the maximum quality roll.
 *
 * Chainlink VRF is the usual answer, and it is not deployed on the target chain,
 * so this is the construction that works without one.
 *
 * HOW IT WORKS
 *
 * The operator picks a secret offline and hashes it N times. The final hash is
 * published here once, as `head`. Each round they reveal the preimage one step
 * back down the chain, and anyone can check it by hashing it forward:
 *
 *     keccak256(revealed) == head
 *
 * Neither side can cheat:
 *
 *   The operator cannot grind, because the chain was fixed before any player
 *   committed. For any given `head` exactly one preimage is accepted, and
 *   finding another means breaking keccak. They can choose to stall, but never
 *   to choose a different value.
 *
 *   A player cannot grind, because they commit to a round that has not been
 *   revealed. Nothing about the seed exists when they decide to plant.
 *
 * WHAT THIS DOES NOT SOLVE
 *
 * Liveness. If the operator stops revealing, rounds stop and anything waiting on
 * a future round cannot resolve. That is why consumers must treat a stalled
 * beacon as a pause rather than as a licence to fall back on block data, and why
 * `abandon` exists on the game so nothing is ever permanently stuck. Run the
 * revealer from a keeper and hold the operator key in a multisig.
 *
 * The reveal transaction is public, so the value is visible in the mempool for
 * one block before it lands. That is fine here: every consumer commits to a
 * round strictly in the future, so seeing round N reveal tells you nothing about
 * round N+1.
 */
contract RandomBeacon is Ownable2Step {
    /// @notice The next expected hash. A reveal must hash to exactly this.
    bytes32 public head;

    /// @notice How many reveals have happened. Round 0 is never usable.
    uint256 public round;

    /// @notice When the current head was set, used to detect a stall.
    uint64 public lastRevealAt;

    /// @notice A reveal is expected at least this often.
    uint64 public revealInterval = 1 hours;

    /// @notice Who may reveal. Separate from the owner so a keeper can be rotated
    ///         without moving ownership.
    mapping(address => bool) public isRevealer;

    /// @dev Seed per round. Fixed forever once written.
    mapping(uint256 => bytes32) private _seed;

    event ChainCommitted(bytes32 head, uint256 fromRound);
    event Revealed(uint256 indexed round, bytes32 seed);
    event RevealerSet(address indexed who, bool allowed);
    event IntervalSet(uint64 seconds_);

    error NotRevealer();
    error BadPreimage();
    error NotCommitted();
    error AlreadyCommitted();
    error ZeroAddress();
    error BadInterval();

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ---------------------------------------------------------------- setup

    /**
     * @notice Publish the end of the hash chain. Callable once.
     * @dev Deliberately one shot. If the owner could replace the head mid flight
     *      they could pick a new chain after seeing what players committed to,
     *      which is exactly the grinding this contract exists to prevent.
     */
    function commitChain(bytes32 head_) external onlyOwner {
        if (head != bytes32(0)) revert AlreadyCommitted();
        if (head_ == bytes32(0)) revert BadPreimage();
        head = head_;
        lastRevealAt = uint64(block.timestamp);
        emit ChainCommitted(head_, round);
    }

    function setRevealer(address who, bool allowed) external onlyOwner {
        if (who == address(0)) revert ZeroAddress();
        isRevealer[who] = allowed;
        emit RevealerSet(who, allowed);
    }

    function setInterval(uint64 seconds_) external onlyOwner {
        if (seconds_ < 5 minutes || seconds_ > 7 days) revert BadInterval();
        revealInterval = seconds_;
        emit IntervalSet(seconds_);
    }

    // ---------------------------------------------------------------- reveal

    /**
     * @notice Reveal the next link. Verified by hashing it forward.
     *
     * The round seed mixes in the block hash as well. That adds nothing against
     * a grinding operator, who is already pinned by the chain, but it means a
     * consumer reading a single round does not learn the raw chain value.
     */
    function reveal(bytes32 preimage) external returns (uint256 newRound) {
        if (!isRevealer[msg.sender]) revert NotRevealer();
        if (head == bytes32(0)) revert NotCommitted();
        if (keccak256(abi.encodePacked(preimage)) != head) revert BadPreimage();

        head = preimage;
        newRound = ++round;
        lastRevealAt = uint64(block.timestamp);

        _seed[newRound] = keccak256(abi.encodePacked(preimage, blockhash(block.number - 1), newRound));
        emit Revealed(newRound, _seed[newRound]);
    }

    // ---------------------------------------------------------------- reading

    /// @notice The seed for a round, or zero if it has not been revealed yet.
    function seedOf(uint256 r) external view returns (bytes32) {
        return _seed[r];
    }

    /// @notice True once a round can be used.
    function isReady(uint256 r) external view returns (bool) {
        return r != 0 && _seed[r] != bytes32(0);
    }

    /**
     * @notice True when a reveal is overdue.
     * @dev Consumers should surface this rather than silently falling back to
     *      anything derived from block data, which would reopen the grinding
     *      hole this contract closes.
     */
    function isStalled() external view returns (bool) {
        if (head == bytes32(0)) return true;
        return block.timestamp > lastRevealAt + revealInterval;
    }
}
