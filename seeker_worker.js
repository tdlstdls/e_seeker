
// seeker_worker.js - Rewritten for clarity and correct WASM integration.

let wasmModule = null;

// Immediately load the AssemblyScript loader and wasm module.
try {
    importScripts("gacha_core.js"); // Provides the `gacha` promise
    
    // The loader script (gacha_core.js) is expected to create a global promise
    // named after the entry file ("gacha.ts" -> "gacha").
    self.gacha.then(module => {
        wasmModule = module;
        // Signal to the main thread that the worker is ready.
        postMessage({ type: 'READY' });
    }).catch(e => {
        console.error("WASM Module instantiation failed:", e);
        postMessage({ type: 'ERROR', message: `WASMモジュールの初期化に失敗しました: ${e}` });
    });

} catch (e) {
    console.error("Failed to import gacha_core.js:", e);
    postMessage({ type: 'ERROR', message: `gacha_core.jsの読み込みに失敗しました: ${e}` });
}


// --- Main message handler ---
onmessage = (e) => {
    if (!wasmModule) {
        postMessage({ type: 'ERROR', message: "WASMモジュールが準備できていません。" });
        return;
    }
    // The main thread sends a single message to start the search.
    performSearch(e.data);
};


// --- Data marshalling functions to interact with WASM ---

function asFree(ptr) {
    if (wasmModule && wasmModule.exports.__unpin) {
        wasmModule.exports.__unpin(ptr);
    }
}

function copyArrayToWASM(sourceArray) {
    if (!wasmModule) return 0;
    const { __new, memory } = wasmModule.exports;
    
    const byteLength = sourceArray.byteLength;
    const ptr = __new(byteLength, 1); // ID=1 for ArrayBuffer
    
    const wasmByteView = new Uint8Array(memory.buffer, ptr, byteLength);
    wasmByteView.set(new Uint8Array(sourceArray.buffer));
    
    return ptr;
}

function setupASData(gacha, targetSequence, itemMaster) {
    const itemNameMap = Object.fromEntries(Object.entries(itemMaster).map(([id, { name }]) => [name, parseInt(id, 10)]));
    const SEQUENCE_MAX_LENGTH = 16;

    // 1. Gacha Master Data
    const GACHA_DATA_LENGTH = 12;
    const gachaData = new Uint32Array(GACHA_DATA_LENGTH);
    const cumulativeRates = gacha.cumulativeRarityRates;
    
    gachaData[0] = gacha.featuredItemRate || 0;
    for (let i = 0; i < 5; i++) {
        gachaData[1 + i] = gacha.rarityRates[i.toString()] || 0;
        gachaData[6 + i] = cumulativeRates[i] || 0;
    }
    gachaData[11] = gacha.canReroll === '1' ? 1 : 0;
    const gachaDataPtr = copyArrayToWASM(gachaData);

    // 2. Target Sequence
    const sequenceIds = targetSequence.slice(0, SEQUENCE_MAX_LENGTH).map(name => {
        if (name === '目玉(確定)') return 4294967295; // GUARANTEED_FEATURED_ID
        if (name === '目玉') return 4294967294;     // FEATURED_ID
        return itemNameMap[name] || 0;
    });
    const targetSequenceArray = new Uint32Array(sequenceIds);
    const targetSequencePtr = copyArrayToWASM(targetSequenceArray);
    
    // 3. Pool Data
    const poolDataItems = [];
    for (let i = 0; i <= 4; i++) {
        const items = gacha.rarityItems[i.toString()] || [];
        poolDataItems.push(items.length);
        poolDataItems.push(...items);
    }
    const poolDataArray = new Uint32Array(poolDataItems);
    const poolDataPtr = copyArrayToWASM(poolDataArray);
    
    return { 
        gachaDataPtr, 
        poolDataPtr, 
        targetSequencePtr, 
        targetSequenceLength: targetSequenceArray.length,
        pointersToFree: [gachaDataPtr, poolDataPtr, targetSequencePtr]
    };
}


// --- Core search logic ---

function performSearch(config) {
    const {
        initialStartSeed,
        workerIndex,
        rangePerWorker,
        count,
        gachaId,
        targetSequence,
        gachaMasterData,
        itemMasterData,
        isCounterSearch,
        stopOnFound
    } = config;

    const gacha = gachaMasterData[gachaId];

    // Pre-process gacha data for JS logic (cumulative rates, etc.)
    for (const id in gachaMasterData) {
        const currentGacha = gachaMasterData[id];
        if (currentGacha.rarityRates && !currentGacha.cumulativeRarityRates) {
            let cumulativeRate = 0;
            const cumulativeArray = [];
            for (let i = 0; i <= 4; i++) {
                cumulativeRate += currentGacha.rarityRates[i.toString()] || 0;
                cumulativeArray.push(cumulativeRate);
            }
            currentGacha.cumulativeRarityRates = cumulativeArray;
        }
        if (!currentGacha.rarityItems) {
            const rarityItems = { '0': [], '1': [], '2': [], '3': [], '4': [] };
            currentGacha.pool.forEach(itemId => {
                const item = itemMasterData[itemId];
                if (item) rarityItems[item.rarity].push(itemId);
            });
            currentGacha.rarityItems = rarityItems;
        }
    }
    
    const { performASSearch, memory } = wasmModule.exports;
    let dataPointers = null;
    let finalSeedForWorker = initialStartSeed;

    try {
        dataPointers = setupASData(gacha, targetSequence, itemMasterData);

        const BATCH_SIZE = 100000; // Process in batches to send progress updates
        const FOUND_SEEDS_BUFFER_PTR = 4 * 1024; // Must match AS
        const MAX_FOUND_SEEDS_PER_BATCH = 100;   // Must be reasonable

        let totalProcessed = 0;
        let currentSeed = initialStartSeed;

        // In xorshift mode, we need to advance the seed to the worker's starting point
        if (!isCounterSearch) {
            const offset = workerIndex * rangePerWorker;
            for (let i = 0; i < offset; i++) {
                currentSeed = wasmModule.exports.xorshift32(currentSeed);
            }
        } else {
            // In counter mode, the starting seed is a simple offset
            currentSeed += (workerIndex * rangePerWorker);
        }
        
        finalSeedForWorker = currentSeed;

        while (totalProcessed < count) {
            const remaining = count - totalProcessed;
            const currentBatchSize = Math.min(remaining, BATCH_SIZE);

            const foundCount = performASSearch(
                currentSeed,
                currentBatchSize,
                dataPointers.gachaDataPtr,
                dataPointers.poolDataPtr,
                dataPointers.targetSequencePtr,
                dataPointers.targetSequenceLength,
                isCounterSearch ? 1 : 0,
                FOUND_SEEDS_BUFFER_PTR,
                MAX_FOUND_SEEDS_PER_BATCH
            );

            if (foundCount > 0) {
                const resultView = new Uint32Array(memory.buffer, FOUND_SEEDS_BUFFER_PTR, foundCount);
                for (let i = 0; i < foundCount; i++) {
                    const foundSeed = resultView[i];
                    postMessage({ type: 'found', seed: foundSeed });

                    if (stopOnFound) {
                        // Calculate the final seed at the point of stopping
                        let finalSeed = foundSeed;
                        if (isCounterSearch) {
                            // This isn't perfect but gives a close approximation
                            const seedsProcessedInBatch = (i + 1);
                            finalSeed = currentSeed + seedsProcessedInBatch;
                        }
                        postMessage({ type: 'stop_found', processed: totalProcessed + i + 1, finalSeed: finalSeed });
                        return; // Terminate search for this worker
                    }
                }
            }

            // Advance seed for the next batch
            if (isCounterSearch) {
                currentSeed += currentBatchSize;
            } else {
                // In xorshift, we need to calculate the start of the next batch
                for (let i = 0; i < currentBatchSize; i++) {
                    currentSeed = wasmModule.exports.xorshift32(currentSeed);
                }
            }
            
            totalProcessed += currentBatchSize;
            finalSeedForWorker = currentSeed;

            postMessage({ type: 'progress', processed: currentBatchSize });
        }

    } catch (e) {
        console.error("Error during WASM search:", e);
        postMessage({ type: 'ERROR', message: `WASM実行中にエラーが発生: ${e}` });
    } finally {
        if (dataPointers) {
            dataPointers.pointersToFree.forEach(asFree);
        }
        // Signal that this worker is done
        postMessage({ type: 'done', processed: count, finalSeed: finalSeedForWorker });
    }
}
