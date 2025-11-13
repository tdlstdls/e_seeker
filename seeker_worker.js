// seeker_worker.js

// --- Global Data (populated by main thread) ---
let gachaData;
let itemRarityMap;

// --- Constants ---
const FEAT_CODE = -1; // '目玉'

// --- Utilities ---

function xorshift32_js(seed) {
    let x = seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 15;
    return x >>> 0;
}

function inverse_xorshift32_js(y) {
    let x = y;
    x ^= x << 15;
    x ^= x << 30;
    x ^= x >>> 17;
    x ^= x << 13;
    x ^= x << 26;
    return x >>> 0;
}

function checkCondition(result, op, value1) {
    switch (op) {
        case "EQ": return result === value1;
        case "LT": return result < value1;
        case "LE": return result <= value1;
        case "GT": return result > value1;
        case "GE": return result >= value1;
        case "NE": return result !== value1;
        default: return false;
    }
}

// --- Forward Simulation Logic ---

function advanceOneStep_js(currentSeed, lastRelevantRareItemId, completionState) {
    let currentSeedInternal = currentSeed;
    let consumedCount = 0;
    const isCompleted = completionState === 'completed';

    // S0: 目玉判定 (未コンプの場合のみ)
    if (!isCompleted) {
        const s1 = xorshift32_js(currentSeedInternal);
        currentSeedInternal = s1;
        consumedCount++;
        if ((s1 % 10000) < gachaData.featuredItemRate) {
            return { isFeatured: true, isRare: false, drawnItemId: FEAT_CODE, endSeed: s1, consumed: consumedCount };
        }
    }

    // S1: レアリティ判定
    const s2 = xorshift32_js(currentSeedInternal);
    currentSeedInternal = s2;
    consumedCount++;

    const rarityVal = s2 % 10000;
    let rarityId = 0;
    const cumulativeRates = gachaData.cumulativeRarityRates;
    for (let i = 0; i < cumulativeRates.length; i++) {
        if (rarityVal < cumulativeRates[i]) {
            rarityId = i;
            break;
        }
    }
    
    // S2: アイテム判定
    let s3 = xorshift32_js(currentSeedInternal);
    currentSeedInternal = s3;
    consumedCount++;

    const rarityIdStr = rarityId.toString();
    let itemPool = gachaData.rarityItems[rarityIdStr];
    
    if (!itemPool || itemPool.length === 0) {
        return { isFeatured: false, isRare: rarityId === 1, drawnItemId: -99, endSeed: currentSeedInternal, consumed: consumedCount };
    }
    
    let drawnItemId = itemPool[s3 % itemPool.length];
    
    // S3: レア被り救済
    if (rarityId === 1 && lastRelevantRareItemId !== -1 && drawnItemId === lastRelevantRareItemId) {
        const s4 = xorshift32_js(currentSeedInternal); 
        currentSeedInternal = s4;
        consumedCount++;
        
        const filteredPool = itemPool.filter(id => id !== drawnItemId); 
        if (filteredPool.length > 0) {
            drawnItemId = filteredPool[s4 % filteredPool.length];
        }
    }

    return { 
        isFeatured: false, 
        isRare: rarityId === 1, 
        drawnItemId: drawnItemId, 
        endSeed: currentSeedInternal,
        consumed: consumedCount 
    };
}

function fullForwardVerification(startSeedCandidate, targetItemIds, completionState, initialLastRareId = -1, guaranteedSlot = 0) {
    let currentSeed = startSeedCandidate;
    let lastRelevantRareItemId = initialLastRareId;

    for (let i = 0; i < targetItemIds.length; i++) {
        const targetItemId = targetItemIds[i];
        const rollIndex = i + 1; // 1-based index
        const isGuaranteedRoll = guaranteedSlot > 0 && (rollIndex === guaranteedSlot || rollIndex === guaranteedSlot + 10);

        let result;
        // 確定枠の抽選 (コンプ済みモードでのみ発生)
        if (completionState === 'completed' && isGuaranteedRoll) {
            const uberRate = gachaData.uberGuaranteedFlag ? (gachaData.rarityRates['3'] || 0) : 0;
            const legendRate = gachaData.legendGuaranteedFlag ? (gachaData.rarityRates['4'] || 0) : 0;
            const totalGuaranteedRate = uberRate + legendRate;

            if (totalGuaranteedRate === 0) return false; // 矛盾

            const seed1 = xorshift32_js(currentSeed);
            const rarityRoll = seed1 % totalGuaranteedRate;
            
            let rarityId = (rarityRoll < uberRate) ? 3 : 4;

            const seed2 = xorshift32_js(seed1);
            const itemPool = gachaData.rarityItems[rarityId.toString()];

            if (!itemPool || itemPool.length === 0) return false;

            const itemSlot = seed2 % itemPool.length;
            const drawnItemId = itemPool[itemSlot];
            
            result = {
                isFeatured: false,
                isRare: false, // レア被り判定に影響させない
                drawnItemId: drawnItemId,
                endSeed: seed2,
            };
        } else {
            // 通常の抽選
            result = advanceOneStep_js(currentSeed, lastRelevantRareItemId, completionState);
        }

        // --- 判定 ---
        let match = (targetItemId === FEAT_CODE) ? result.isFeatured : (result.drawnItemId === targetItemId);

        if (!match) return false;
        
        currentSeed = result.endSeed;
        if (result.isRare) {
            lastRelevantRareItemId = result.drawnItemId;
        } else if (!result.isFeatured) {
            lastRelevantRareItemId = -1;
        }
    }
    return true;
}


// --- Search Algorithms ---

function performForwardSearch(initialStartSeed, count, targetItemIds, priorityChecks, stopOnFound, workerIndex, searchMode, completionState, guaranteedSlot) {
    let processedCount = 0;
    let currentSeedToTest = initialStartSeed;
    const isCounterSearch = (searchMode === 'full_counter');
    const PROGRESS_INTERVAL = 100000;

    for (let i = 0; i < count; i++) {
        let isSeedValid = true;
        if (priorityChecks.length > 0) {
            const check = priorityChecks[0];
            const { seedIndex, mod, op, value1, totalSeedOffset } = check;
            let rollStartSeed = currentSeedToTest;
            for (let j = 0; j < totalSeedOffset; j++) {
                rollStartSeed = xorshift32_js(rollStartSeed);
            }
            let checkSeed = rollStartSeed;
            for (let j = 0; j < seedIndex; j++) {
                checkSeed = xorshift32_js(checkSeed);
            }
            if (!checkCondition(checkSeed % mod, op, value1)) {
                isSeedValid = false;
            }
        }

        if (isSeedValid) {
            if (fullForwardVerification(currentSeedToTest, targetItemIds, completionState, -1, guaranteedSlot)) {
                postMessage({ type: 'found', seed: currentSeedToTest, workerIndex });
                if (stopOnFound) {
                    postMessage({ type: 'stop_found', seed: currentSeedToTest, finalSeed: currentSeedToTest, workerIndex, processed: processedCount });
                    return;
                }
            }
        }

        processedCount++;
        if (processedCount % PROGRESS_INTERVAL === 0) {
            postMessage({ type: 'progress', processed: PROGRESS_INTERVAL, workerIndex });
        }

        if (isCounterSearch) {
            currentSeedToTest = (currentSeedToTest + 1) >>> 0;
        } else {
            currentSeedToTest = xorshift32_js(currentSeedToTest);
        }
    }

    const remaining = processedCount % PROGRESS_INTERVAL;
    if (remaining > 0) {
        postMessage({ type: 'progress', processed: remaining, workerIndex });
    }
    postMessage({ type: 'done', processed: count, finalSeed: currentSeedToTest, workerIndex });
}

function performInverseSearch(initialPrioritySeed, count, targetItemIds, priorityChecks, stopOnFound, workerIndex, completionState, guaranteedSlot) {
    const check = priorityChecks[0];
    const { seedIndex, mod, op, value1, totalSeedOffset } = check;
    const totalInverseSteps = totalSeedOffset + seedIndex;
    let processedCount = 0;
    const PROGRESS_INTERVAL = 10000000;

    for (let i = 0; i < count; i++) {
        const prioritySeedCandidate = (initialPrioritySeed + i) >>> 0; 

        if (checkCondition(prioritySeedCandidate % mod, op, value1)) {
            let startSeedCandidate = prioritySeedCandidate;
            for (let j = 0; j < totalInverseSteps; j++) {
                startSeedCandidate = inverse_xorshift32_js(startSeedCandidate);
            }

            if (fullForwardVerification(startSeedCandidate, targetItemIds, completionState, -1, guaranteedSlot)) {
                postMessage({ type: 'found', seed: startSeedCandidate, workerIndex });
                if (stopOnFound) {
                    postMessage({ type: 'stop_found', seed: startSeedCandidate, finalSeed: startSeedCandidate, workerIndex, processed: processedCount });
                    return;
                }
            }
        }

        processedCount++;
        if (processedCount % PROGRESS_INTERVAL === 0) {
            postMessage({ type: 'progress', processed: PROGRESS_INTERVAL, workerIndex });
        }
    }

    const remaining = processedCount % PROGRESS_INTERVAL;
    if (remaining > 0) {
        postMessage({ type: 'progress', processed: remaining, workerIndex });
    }
    postMessage({ type: 'done', processed: count, workerIndex });
}

function performRareSalvageForwardSearch(initialStartSeed, count, targetItemIds, priorityChecks, stopOnFound, workerIndex, searchMode, completionState, guaranteedSlot) {
    let processedCount = 0;
    let currentSeedToTest = initialStartSeed;
    const isCounterSearch = (searchMode === 'full_counter');
    const PROGRESS_INTERVAL = 100000;

    for (let i = 0; i < count; i++) {
        let isSeedValid = true;
        if (priorityChecks.length > 0) {
            const check = priorityChecks[0];
            const { seedIndex, mod, op, value1, totalSeedOffset } = check;
            let rollStartSeed = currentSeedToTest;
            for (let j = 0; j < totalSeedOffset; j++) {
                rollStartSeed = xorshift32_js(rollStartSeed);
            }
            let checkSeed = rollStartSeed;
            for (let j = 0; j < seedIndex; j++) {
                checkSeed = xorshift32_js(checkSeed);
            }
            if (!checkCondition(checkSeed % mod, op, value1)) {
                isSeedValid = false;
            }
        }

        if (isSeedValid) {
            const verificationResult = rareSalvageForwardVerification(currentSeedToTest, targetItemIds, completionState, guaranteedSlot);
            if (verificationResult.verified) {
                postMessage({ type: 'found', seed: currentSeedToTest, workerIndex, lr: verificationResult.dupedItemId });
                if (stopOnFound) {
                    postMessage({ type: 'stop_found', seed: currentSeedToTest, finalSeed: currentSeedToTest, workerIndex, processed: processedCount, lr: verificationResult.dupedItemId });
                    return;
                }
            }
        }

        processedCount++;
        if (processedCount % PROGRESS_INTERVAL === 0) {
            postMessage({ type: 'progress', processed: PROGRESS_INTERVAL, workerIndex });
        }

        if (isCounterSearch) {
            currentSeedToTest = (currentSeedToTest + 1) >>> 0;
        } else {
            currentSeedToTest = xorshift32_js(currentSeedToTest);
        }
    }

    const remaining = processedCount % PROGRESS_INTERVAL;
    if (remaining > 0) {
        postMessage({ type: 'progress', processed: remaining, workerIndex });
    }
    postMessage({ type: 'done', processed: count, finalSeed: currentSeedToTest, workerIndex });
}

function rareSalvageForwardVerification(startSeed, targetItemIds, completionState, guaranteedSlot = 0) {
    let currentSeed = startSeed;
    const firstTargetItemId = targetItemIds[0];

    const isCompleted = completionState === 'completed';
    let consumedCount = 0;

    if (!isCompleted) {
        const s1 = xorshift32_js(currentSeed);
        currentSeed = s1;
        consumedCount++;
        if ((s1 % 10000) < gachaData.featuredItemRate) return { verified: false };
    }

    const s2 = xorshift32_js(currentSeed);
    currentSeed = s2;
    consumedCount++;
    const rarityVal = s2 % 10000;
    let rarityId = 0;
    const cumulativeRates = gachaData.cumulativeRarityRates;
    for (let i = 0; i < cumulativeRates.length; i++) {
        if (rarityVal < cumulativeRates[i]) { rarityId = i; break; }
    }
    if (rarityId !== 1) return { verified: false };

    const s3 = xorshift32_js(currentSeed);
    currentSeed = s3;
    consumedCount++;
    const itemPool = gachaData.rarityItems['1'];
    if (!itemPool || itemPool.length < 2) return { verified: false };
    
    const dupedItemId = itemPool[s3 % itemPool.length]; 
    
    const s4 = xorshift32_js(currentSeed);
    currentSeed = s4;
    consumedCount++;

    const filteredPool = itemPool.filter(id => id !== dupedItemId);
    if (filteredPool.length === 0) return { verified: false }; 
    
    const rerolledItemId = filteredPool[s4 % filteredPool.length]; 

    if (rerolledItemId !== firstTargetItemId) {
        return { verified: false }; 
    }
    
    const remainingTargetIds = targetItemIds.slice(1);
    if (remainingTargetIds.length > 0) {
        if (!fullForwardVerification(currentSeed, remainingTargetIds, completionState, rerolledItemId, guaranteedSlot)) {
            return { verified: false };
        }
    }

    return { verified: true, dupedItemId: dupedItemId };
}

function performRareSalvageSearch(initialPrioritySeed, count, targetItemIds, priorityChecks, stopOnFound, workerIndex, completionState, guaranteedSlot) {
    // If there are no priority checks, we must do a full forward search.
    if (priorityChecks.length === 0) {
        performRareSalvageForwardSearch(initialPrioritySeed, count, targetItemIds, [], stopOnFound, workerIndex, 'full_counter', completionState, guaranteedSlot);
        return;
    }

    const check = priorityChecks[0];
    const { seedIndex, mod, op, value1, totalSeedOffset } = check;
    const totalInverseSteps = totalSeedOffset + seedIndex;

    let processedCount = 0;
    const PROGRESS_INTERVAL = 10000000;

    for (let i = 0; i < count; i++) {
        const prioritySeedCandidate = (initialPrioritySeed + i) >>> 0;

        if (checkCondition(prioritySeedCandidate % mod, op, value1)) {
            let startSeedCandidate = prioritySeedCandidate;
            for (let j = 0; j < totalInverseSteps; j++) {
                startSeedCandidate = inverse_xorshift32_js(startSeedCandidate);
            }

            const verificationResult = rareSalvageForwardVerification(startSeedCandidate, targetItemIds, completionState, guaranteedSlot);
            if (verificationResult.verified) {
                postMessage({ type: 'found', seed: startSeedCandidate, workerIndex, lr: verificationResult.dupedItemId });
                if (stopOnFound) {
                    postMessage({ type: 'stop_found', seed: startSeedCandidate, finalSeed: startSeedCandidate, workerIndex, processed: processedCount, lr: verificationResult.dupedItemId });
                    return;
                }
            }
        }

        processedCount++;
        if (processedCount % PROGRESS_INTERVAL === 0) {
            postMessage({ type: 'progress', processed: PROGRESS_INTERVAL, workerIndex });
        }
    }

    const remaining = processedCount % PROGRESS_INTERVAL;
    if (remaining > 0) {
        postMessage({ type: 'progress', processed: remaining, workerIndex });
    }
    postMessage({ type: 'done', processed: count, workerIndex });
}


// --- Main Message Handler ---

self.onmessage = async function(e) {
    const {
        workerIndex, 
        initialStartSeed, 
        count, 
        gachaId,
        targetItemIdsForWorker, 
        priorityChecks, 
        gachaData: gachaDataFromMain, 
        stopOnFound, 
        searchMode, 
        baseMode, 
        completionState,
        guaranteedSlot
    } = e.data;

    gachaData = gachaDataFromMain;
    itemRarityMap = Object.fromEntries(Object.entries(gachaData.rarityItems).flatMap(([rarity, items]) => items.map(id => [id, parseInt(rarity, 10)])));

    if (searchMode === 'rare_salvage') {
        performRareSalvageForwardSearch(initialStartSeed, count, targetItemIdsForWorker, [], stopOnFound, workerIndex, baseMode, completionState, guaranteedSlot);
    } else if (searchMode === 'full_counter' && priorityChecks.length > 0) {
        performInverseSearch(initialStartSeed, count, targetItemIdsForWorker, priorityChecks, stopOnFound, workerIndex, completionState, guaranteedSlot);
    } else { 
        performForwardSearch(initialStartSeed, count, targetItemIdsForWorker, priorityChecks, stopOnFound, workerIndex, searchMode, completionState, guaranteedSlot);
    }
};