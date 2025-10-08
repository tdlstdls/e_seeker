// seeker_worker.js (with WASM fallback)

// --- Global Data ---
let gachaMaster;
let itemMaster;
let itemNameMap;
let wasmExports = null;

// --- Standalone JS Simulation Logic ---
function xorshift32_js(seed) {
    let x = seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 15;
    return x >>> 0;
}

function advanceOneStep_js(currentSeed, lastItemId, gacha) {
    const s1 = xorshift32_js(currentSeed);
    if ((s1 % 10000) < gacha.featuredItemRate) {
        return { isFeatured: true, drawnItemId: -1, endSeed: s1, lastItemId: -1 };
    }
    const s2 = xorshift32_js(s1);
    const rarityVal = s2 % 10000;
    let rarityId = 0;
    const cumulativeRates = gacha.cumulativeRarityRates;
    for (let i = 0; i < cumulativeRates.length; i++) {
        if (rarityVal < cumulativeRates[i]) {
            rarityId = i;
            break;
        }
    }
    const s3 = xorshift32_js(s2);
    const itemPool = gacha.rarityItems[rarityId];
    if (!itemPool || itemPool.length === 0) {
        return { isFeatured: false, drawnItemId: -2, endSeed: s3, lastItemId };
    }
    let drawnItemId = itemPool[s3 % itemPool.length];
    const canReRollRarity1 = gacha.rarityItems[1] && gacha.rarityItems[1].length >= 2;
    if (canReRollRarity1 && rarityId === 1 && lastItemId === drawnItemId) {
        const s4 = xorshift32_js(s3);
        const reRollIndex = s4 % (itemPool.length - 1);
        let newDrawnItemId = -1;
        let nonMatchingCounter = 0;
        for (const itemId of itemPool) {
            if (itemId !== drawnItemId) {
                if (nonMatchingCounter === reRollIndex) {
                    newDrawnItemId = itemId;
                    break;
                }
                nonMatchingCounter++;
            }
        }
        drawnItemId = (newDrawnItemId !== -1) ? newDrawnItemId : drawnItemId;
        return { isFeatured: false, drawnItemId, endSeed: s4, lastItemId: drawnItemId };
    }
    return { isFeatured: false, drawnItemId, endSeed: s3, lastItemId: drawnItemId };
}

function performSearch_js(startSeed, count, gacha, targetSequence, isCounterSearch, stopOnFound) {
    let currentSeedToTest = startSeed;
    let processedCount = 0;
    const initialSeed = startSeed;
    for (let i = 0; i < count; i++) {
        if (currentSeedToTest === 0) break;
        if (!isCounterSearch && processedCount > 0 && currentSeedToTest === initialSeed) break;
        if (isCounterSearch && currentSeedToTest > 4294967295) break;
        processedCount++;

        let fullSequenceMatched = true;
        let simSeed = currentSeedToTest;
        let simLastItemId = -1;
        for (let k = 0; k < targetSequence.length; k++) {
            const targetItemName = targetSequence[k];
            const stepResult = advanceOneStep_js(simSeed, simLastItemId, gacha);
            let currentStepMatched = false;
            if (targetItemName === '目玉(確定)') currentStepMatched = true;
            else if (targetItemName === '目玉') currentStepMatched = stepResult.isFeatured;
            else {
                const targetItemId = itemNameMap[targetItemName];
                currentStepMatched = !stepResult.isFeatured && stepResult.drawnItemId === targetItemId;
            }
            if (!currentStepMatched) {
                fullSequenceMatched = false;
                break;
            }
            simSeed = stepResult.endSeed;
            simLastItemId = stepResult.lastItemId;
        }

        if (fullSequenceMatched) {
            postMessage({ type: 'found', seed: currentSeedToTest });
            if (stopOnFound) {
                const processedSinceLastUpdate = processedCount % 10000;
                if (processedSinceLastUpdate > 0) postMessage({ type: 'progress', processed: processedSinceLastUpdate });
                postMessage({ type: 'stop_found', finalSeed: currentSeedToTest, processed: processedSinceLastUpdate });
                return;
            }
        }
        if (processedCount % 10000 === 0) {
            postMessage({ type: 'progress', processed: 10000 });
        }
        currentSeedToTest = isCounterSearch ? ((currentSeedToTest + 1) >>> 0) : xorshift32_js(currentSeedToTest);
        if (isCounterSearch && currentSeedToTest === 0) currentSeedToTest = 4294967296;
    }
    const remainingProgress = processedCount % 10000;
    if (remainingProgress > 0) postMessage({ type: 'progress', processed: remainingProgress });
    postMessage({ type: 'done', finalSeed: currentSeedToTest });
}

// --- WASM Loading and Search Logic ---
const wasmReady = (async () => {
    try {
        const { instantiate } = await import('./build/gacha.js');
        const wasm = await instantiate(fetch('./build/gacha.wasm'));
        wasmExports = wasm.exports;
        console.log("WebAssembly module loaded successfully. Using high-speed mode.");
        return true;
    } catch (e) {
        console.warn("WebAssembly module failed to load, falling back to JavaScript mode.", e);
        return false;
    }
})();

function performSearch_wasm(startSeed, count, gacha, targetSequence, isCounterSearch, stopOnFound) {
    const { memory, __newArray, __getArray, __pin, __unpin, performASSearch } = wasmExports;
    
    const rarityRates = gacha.rarityRates;
    let cumulativeRate = 0;
    const cumulativeRates = [0, 1, 2, 3, 4].map(i => (cumulativeRate += rarityRates[i.toString()] || 0));
    const gachaDataArray = new Uint32Array([gacha.featuredItemRate, rarityRates['0'], rarityRates['1'], rarityRates['2'], rarityRates['3'], rarityRates['4'], ...cumulativeRates, 1]);

    const poolItemsByRarity = { '0': [], '1': [], '2': [], '3': [], '4': [] };
    gacha.pool.forEach(itemId => { if (itemMaster[itemId]) poolItemsByRarity[itemMaster[itemId].rarity].push(itemId); });
    const poolDataBuilder = [];
    for (let i = 0; i <= 4; i++) {
        const items = poolItemsByRarity[i.toString()];
        poolDataBuilder.push(items.length, ...items);
    }
    const poolDataArray = new Uint32Array(poolDataBuilder);

    const GUARANTEED_FEATURED_ID = 4294967295, FEATURED_ID = 4294967294;
    const targetIdSequence = targetSequence.map(name => name === '目玉(確定)' ? GUARANTEED_FEATURED_ID : (name === '目玉' ? FEATURED_ID : itemNameMap[name]));
    const targetSequenceArray = new Uint32Array(targetIdSequence);
    
    const maxFound = 100;
    const foundSeedsArray = new Uint32Array(maxFound);

    const gachaDataPtr = __pin(__newArray(gachaDataArray, wasmExports));
    const poolDataPtr = __pin(__newArray(poolDataArray, wasmExports));
    const targetSequencePtr = __pin(__newArray(targetSequenceArray, wasmExports));
    const foundSeedsPtr = __pin(__newArray(foundSeedsArray, wasmExports));

    // Note: Progress reporting from WASM is not implemented in this version.
    const foundCount = performASSearch(startSeed, count, gachaDataPtr, poolDataPtr, targetSequencePtr, targetSequenceArray.length, isCounterSearch ? 1 : 0, foundSeedsPtr, maxFound);

    if (foundCount > 0) {
        const resultArray = __getArray(foundSeedsPtr).slice(0, foundCount);
        resultArray.forEach(seed => postMessage({ type: 'found', seed }));
    }

    __unpin(gachaDataPtr);
    __unpin(poolDataPtr);
    __unpin(targetSequencePtr);
    __unpin(foundSeedsPtr);

    postMessage({ type: 'done', finalSeed: 0 }); // finalSeed is not implemented in wasm part
}

// --- Main Message Handler ---
self.onmessage = async function(e) {
    const wasmLoaded = await wasmReady;
    const {
        initialStartSeed, workerIndex, rangePerWorker, count, gachaId,
        targetSequence, gachaMasterData, itemMasterData, isFullSearch, 
        isCounterSearch, stopOnFound
    } = e.data;

    gachaMaster = gachaMasterData;
    itemMaster = itemMasterData;
    itemNameMap = Object.fromEntries(Object.entries(itemMaster).map(([id, { name }]) => [name, parseInt(id, 10)]));
    
    for (const id in gachaMaster) {
        const gacha = gachaMaster[id];
        if (gacha.rarityRates && !gacha.cumulativeRarityRates) {
            let cumulativeRate = 0;
            const cumulativeArray = [];
            for (let i = 0; i <= 4; i++) cumulativeArray.push(cumulativeRate += gacha.rarityRates[i.toString()] || 0);
            gacha.cumulativeRarityRates = cumulativeArray;
        }
        if (!gacha.rarityItems) {
            const rarityItems = { '0': [], '1': [], '2': [], '3': [], '4': [] };
            gacha.pool.forEach(itemId => { if (itemMaster[itemId]) rarityItems[itemMaster[itemId].rarity].push(itemId); });
            gacha.rarityItems = rarityItems;
        }
    }

    let actualStartSeed = initialStartSeed;
    if (isCounterSearch) {
        actualStartSeed = (initialStartSeed + (workerIndex * rangePerWorker)) >>> 0;
    } else {
        const offset = workerIndex * rangePerWorker;
        for (let i = 0; i < offset; i++) {
            actualStartSeed = xorshift32_js(actualStartSeed); // Use JS version for offset calculation
        }
    }

    if (wasmLoaded) {
        performSearch_wasm(actualStartSeed, count, gachaMaster[gachaId], targetSequence, isCounterSearch, stopOnFound);
    } else {
        performSearch_js(actualStartSeed, count, gachaMaster[gachaId], targetSequence, isCounterSearch, stopOnFound);
    }
};
