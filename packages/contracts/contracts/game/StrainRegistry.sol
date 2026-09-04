// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title StrainRegistry
 * @notice Genetics table. Every parameter that decides how a plant behaves lives
 *         here so balance changes are one timelocked transaction, not a redeploy.
 */
contract StrainRegistry is Ownable2Step {
    struct Strain {
        uint32 cycleSeconds; // plant to harvest
        uint16 baseYield; // units before any modifier
        uint16 geneticsBps; // yield multiplier, 10000 = 1.00x
        uint8 eventChance; // 0..255, probability threshold per event slot
        uint8 geneQuality; // 0..20 flat quality bonus
        uint128 seedPrice; // HESOYAM charged at planting
        bool active;
        string name;
    }

    Strain[] private _strains;

    event StrainAdded(uint32 indexed strainId, string name, uint32 cycleSeconds, uint128 seedPrice);
    event StrainUpdated(uint32 indexed strainId);
    event StrainActiveSet(uint32 indexed strainId, bool active);

    error BadParams();
    error UnknownStrain();

    constructor(address initialOwner) Ownable(initialOwner) {}

    function addStrain(
        string calldata name,
        uint32 cycleSeconds,
        uint16 baseYield,
        uint16 geneticsBps,
        uint8 eventChance,
        uint8 geneQuality,
        uint128 seedPrice
    ) external onlyOwner returns (uint32 strainId) {
        if (cycleSeconds < 1 hours || baseYield == 0 || geneticsBps == 0 || geneQuality > 20) revert BadParams();
        strainId = uint32(_strains.length);
        _strains.push(
            Strain({
                cycleSeconds: cycleSeconds,
                baseYield: baseYield,
                geneticsBps: geneticsBps,
                eventChance: eventChance,
                geneQuality: geneQuality,
                seedPrice: seedPrice,
                active: true,
                name: name
            })
        );
        emit StrainAdded(strainId, name, cycleSeconds, seedPrice);
    }

    function updateStrain(
        uint32 strainId,
        uint32 cycleSeconds,
        uint16 baseYield,
        uint16 geneticsBps,
        uint8 eventChance,
        uint8 geneQuality,
        uint128 seedPrice
    ) external onlyOwner {
        if (strainId >= _strains.length) revert UnknownStrain();
        if (cycleSeconds < 1 hours || baseYield == 0 || geneticsBps == 0 || geneQuality > 20) revert BadParams();
        Strain storage s = _strains[strainId];
        s.cycleSeconds = cycleSeconds;
        s.baseYield = baseYield;
        s.geneticsBps = geneticsBps;
        s.eventChance = eventChance;
        s.geneQuality = geneQuality;
        s.seedPrice = seedPrice;
        emit StrainUpdated(strainId);
    }

    function setActive(uint32 strainId, bool active) external onlyOwner {
        if (strainId >= _strains.length) revert UnknownStrain();
        _strains[strainId].active = active;
        emit StrainActiveSet(strainId, active);
    }

    function get(uint32 strainId) external view returns (Strain memory) {
        if (strainId >= _strains.length) revert UnknownStrain();
        return _strains[strainId];
    }

    /**
     * @notice Same data without the name. Callers in the hot path use this so they
     *         never load a string into memory, which is what keeps GrowGame inside
     *         the stack limit without resorting to via-IR.
     */
    function core(uint32 strainId)
        external
        view
        returns (
            uint32 cycleSeconds,
            uint16 baseYield,
            uint16 geneticsBps,
            uint8 eventChance,
            uint8 geneQuality,
            uint128 seedPrice,
            bool active
        )
    {
        if (strainId >= _strains.length) revert UnknownStrain();
        Strain storage s = _strains[strainId];
        return (s.cycleSeconds, s.baseYield, s.geneticsBps, s.eventChance, s.geneQuality, s.seedPrice, s.active);
    }

    /// @notice Cycle length only, for schedule maths.
    function cycleOf(uint32 strainId) external view returns (uint32) {
        if (strainId >= _strains.length) revert UnknownStrain();
        return _strains[strainId].cycleSeconds;
    }

    function count() external view returns (uint256) {
        return _strains.length;
    }
}
