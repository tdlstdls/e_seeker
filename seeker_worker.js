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

function advanceOneStep_js(currentSeed, lastRelevantRareItemId) {
    let currentSeedInternal = currentSeed;
    let consumedCount = 0;

    const s1 = xorshift32_js(currentSeedInternal);
    currentSeedInternal = s1;
    consumedCount++;

    if ((s1 % 10000) < gachaData.featuredItemRate) {
        return { isFeatured: true, isRare: false, drawnItemId: FEAT_CODE, endSeed: s1, consumed: consumedCount };
    }

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
    
    let s3 = xorshift32_js(currentSeedInternal);
    currentSeedInternal = s3;
    consumedCount++;

    const rarityIdStr = rarityId.toString();
    let itemPool = gachaData.rarityItems[rarityIdStr];
    
    if (!itemPool || itemPool.length === 0) {
         return { isFeatured: false, isRare: rarityId === 1, drawnItemId: -99, endSeed: currentSeedInternal, consumed: consumedCount };
    }
    
    let drawnItemId = itemPool[s3 % itemPool.length];
    
    if (rarityId === 1 && lastRelevantRareItemId !== -1 && drawnItemId === lastRelevantRareItemId) {
        s3 = xorshift32_js(currentSeedInternal); 
        currentSeedInternal = s3;
        consumedCount++;
        const filteredPool = itemPool.filter(id => id !== drawnItemId); 
        if (filteredPool.length > 0) {
            drawnItemId = filteredPool[s3 % filteredPool.length];
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

function fullForwardVerification(startSeedCandidate, targetItemIds) {
    let currentSeed = startSeedCandidate;
    let lastRelevantRareItemId = -1;

    for (const targetItemId of targetItemIds) {
        const result = advanceOneStep_js(currentSeed, lastRelevantRareItemId);
        
        let match = false;
        if (targetItemId === FEAT_CODE) {
            if (result.isFeatured) match = true;
        } else if (result.drawnItemId === targetItemId) {
            match = true;
        }

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

/**
 * ALGORITHM 1: Forward Search (for Partial Search & Fallback)
 */
function performForwardSearch(initialStartSeed, count, targetItemIds, priorityChecks, stopOnFound, workerIndex, searchMode) {
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
            if (fullForwardVerification(currentSeedToTest, targetItemIds)) {
                postMessage({ type: 'found', seed: currentSeedToTest, workerIndex });
                if (stopOnFound) {
                    postMessage({ type: 'stop_found', seed: currentSeedToTest, workerIndex, processed: processedCount });
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

/**
 * ALGORITHM 2: Inverse Search (for Full Search)
 */
function performInverseSearch(initialPrioritySeed, count, targetItemIds, priorityChecks, stopOnFound, workerIndex) {
    const check = priorityChecks[0];
    const { seedIndex, mod, op, value1, totalSeedOffset } = check;
    const totalInverseSteps = totalSeedOffset + seedIndex;
    let processedCount = 0;
    const PROGRESS_INTERVAL = 10000000; // Larger interval for this faster loop

    // This worker is assigned a contiguous block of the *priority seed* space to check.
    for (let i = 0; i < count; i++) {
        const prioritySeedCandidate = initialPrioritySeed + i;

        if (checkCondition(prioritySeedCandidate % mod, op, value1)) {
            let startSeedCandidate = prioritySeedCandidate;
            for (let j = 0; j < totalInverseSteps; j++) {
                startSeedCandidate = inverse_xorshift32_js(startSeedCandidate);
            }

            if (fullForwardVerification(startSeedCandidate, targetItemIds)) {
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
        searchMode 
    } = e.data;

    gachaData = gachaDataFromMain;
    itemRarityMap = Object.fromEntries(Object.entries(gachaData.rarityItems).flatMap(([rarity, items]) => items.map(id => [id, parseInt(rarity, 10)])));

    // ROUTER: Decide which algorithm to use.
    if (searchMode === 'full_counter' && priorityChecks.length > 0) {
        // For full searches with a valid priority check, use the ultra-fast inverse algorithm.
        // The main thread provides a range of the *priority seed* space.
        performInverseSearch(initialStartSeed, count, targetItemIdsForWorker, priorityChecks, stopOnFound, workerIndex);
    } else {
        // For partial (xorshift) searches or searches without a safe priority check, 
        // use the reliable forward-search algorithm.
        performForwardSearch(initialStartSeed, count, targetItemIdsForWorker, priorityChecks, stopOnFound, workerIndex, searchMode);
    }
};