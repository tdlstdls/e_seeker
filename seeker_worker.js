// seeker_worker.js

// --- Data will be received from the main thread ---
let gachaMaster;
let itemMaster;
let itemNameMap;

// --- WASM Integration ---
let xorshift32_wasm;
let useWASM = false;

try {
    // 1. gacha_core.js (EmscriptenラッパーとWASMバイナリ) をロード
    importScripts('gacha_core.js'); 
    
    // 2. モジュールを初期化
    const wasmModule = Module(); 

    // 3. C言語の関数をJSラッパーで包む
    xorshift32_wasm = wasmModule.cwrap('xorshift32', 'number', ['number']);
    
    // 4. WASM使用フラグを立てる
    useWASM = true;
    console.log("WASM: xorshift32 loaded and activated successfully.");
    
} catch (e) {
    // WASMのロードまたは初期化に失敗した場合
    console.warn(`WASM: Failed to load gacha_core.js. Using JavaScript fallback. ${e}`);
    useWASM = false;
}


// --- 共通乱数生成関数 ---
function xorshift32(seed) {
    if (useWASM) {
        // WASMが有効ならWASM関数を呼び出す
        return xorshift32_wasm(seed);
    }
    // WASMが無効ならJavaScript版をフォールバックとして使用
    let x = seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 15;
    return x >>> 0;
}

// --- Gacha Simulator with Caching ---
class GachaSimulator {
    constructor(startSeed, gacha) {
        this.startSeed = startSeed;
        this.gacha = gacha;
        this.canReRollRarity1 = gacha.rarityItems[1] && gacha.rarityItems[1].length >= 2;
        
        // FIFO cache for up to 60 simulation steps
        this.resultsCache = new Array(60);
        this.lastCalculatedStep = -1;
    }

    getStep(k) {
        if (k < 0) return { endSeed: this.startSeed, lastItemId: -1 };
        if (this.lastCalculatedStep >= k && this.resultsCache[k]) {
            return this.resultsCache[k];
        }

        // Calculate steps from the last known point
        for (let i = this.lastCalculatedStep + 1; i <= k; i++) {
            const prevState = (i === 0) ? { endSeed: this.startSeed, lastItemId: -1 } : this.resultsCache[i - 1];
            this.resultsCache[i] = this.advanceOneStep(prevState.endSeed, prevState.lastItemId);
        }
        
        this.lastCalculatedStep = k;
        return this.resultsCache[k];
    }

    advanceOneStep(currentSeed, lastItemId) {
        const s1 = xorshift32(currentSeed);
        const isFeaturedDraw = (s1 % 10000) < this.gacha.featuredItemRate;

        if (isFeaturedDraw) {
            return {
                rarityId: -1, // No rarity for featured
                drawnItemId: -1, // No specific item for featured
                isFeatured: true,
                endSeed: s1,
                lastItemId: -1 // Reset re-roll chain
            };
        }

        const s2 = xorshift32(s1);
        const rarityVal = s2 % 10000;
        
        // --- OPTIMIZED RARITY LOOKUP ---
        let rarityId = 0;
        const cumulativeRates = this.gacha.cumulativeRarityRates;
        for (let i = 0; i < cumulativeRates.length; i++) {
            if (rarityVal < cumulativeRates[i]) {
                rarityId = i;
                break;
            }
        }
        // --- END OPTIMIZATION ---

        const s3 = xorshift32(s2);
        const itemPool = this.gacha.rarityItems[rarityId];
        if (!itemPool || itemPool.length === 0) {
            return { rarityId, drawnItemId: -2, isFeatured: false, endSeed: s3, lastItemId }; // -2 for error
        }
        let drawnItemId = itemPool[s3 % itemPool.length];

        const isReRoll = this.canReRollRarity1 && rarityId === 1 && lastItemId === drawnItemId;

        if (isReRoll) {
            const s4 = xorshift32(s3);
            const reRollPool = itemPool.filter(id => id !== drawnItemId);
            if (reRollPool.length === 0) {
                return { rarityId, drawnItemId: -2, isFeatured: false, endSeed: s4, lastItemId };
            }
            drawnItemId = reRollPool[s4 % reRollPool.length];
            return { rarityId, drawnItemId, isFeatured: false, endSeed: s4, lastItemId: drawnItemId };
        } else {
            return { rarityId, drawnItemId, isFeatured: false, endSeed: s3, lastItemId: drawnItemId };
        }
    }
}


// --- Main search logic ---
function performSearch(startSeed, count, gachaId, targetSequence, isFullSearch, isCounterSearch, stopOnFound) {
    const gacha = gachaMaster[gachaId];
    if (!gacha) return;

    const progressUpdateInterval = 10000;
    let currentSeedToTest = startSeed;
    let processedCount = 0;
    const initialSeed = startSeed; // xorshift32順のループ検出用

    for (let i = 0; i < count; i++) {
        
        if (currentSeedToTest === 0) {
            // シードが0になったら強制停止（xorshift32は0を受け取ると0を返すため、シード0は不可）
            break;
        }
        
        // xorshift32順（部分検索およびSEED指定全件検索時）の場合の周期完了チェック
        if (!isCounterSearch && processedCount > 0 && currentSeedToTest === initialSeed) {
            break;
        }
        
        // カウンタ順（全件検索時）の場合の終了チェック
        // currentSeedToTestが4294967296 (0) になったら終了（4294967295の次が0）
        if (isCounterSearch && currentSeedToTest > 4294967295) { 
            break;
        }

        processedCount++;

        const simulator = new GachaSimulator(currentSeedToTest, gacha);

        // --- Full Sequence Check ---
        let fullSequenceMatched = true;
        for (let k = 0; k < targetSequence.length; k++) {
            const targetItemName = targetSequence[k];
            const stepResult = simulator.getStep(k);

            let currentStepMatched = false;
            if (targetItemName === '目玉(確定)') {
                currentStepMatched = true;
            } else if (targetItemName === '目玉') {
                currentStepMatched = stepResult.isFeatured;
            } else {
                const targetItemId = itemNameMap[targetItemName];
                currentStepMatched = !stepResult.isFeatured && stepResult.drawnItemId === targetItemId;
            }

            if (!currentStepMatched) {
                fullSequenceMatched = false;
                break;
            }
        }

        if (fullSequenceMatched) {
            // SEED発見
            postMessage({ type: 'found', seed: currentSeedToTest });

            if (stopOnFound) {
                // 停止する場合
                const processedSinceLastUpdate = processedCount % progressUpdateInterval;
                if (processedSinceLastUpdate > 0) {
                     postMessage({ type: 'progress', processed: processedSinceLastUpdate });
                }
                postMessage({ type: 'stop_found', finalSeed: currentSeedToTest, processed: processedSinceLastUpdate });
                return; // ワーカーを即時終了
            }
        }

        if (processedCount % progressUpdateInterval === 0) {
            postMessage({ type: 'progress', processed: progressUpdateInterval });
        }
        
        // 次のSEEDへの遷移ロジック
        if (isCounterSearch) {
            // カウンタ順: 1ずつ増加 (32bit unsignedでオーバーフローをシミュレート)
            currentSeedToTest = (currentSeedToTest + 1) >>> 0;
            // 0になった場合、次のループでbreakする
            if (currentSeedToTest === 0) currentSeedToTest = 4294967296; // 終了フラグとして使用
        } else {
            // xorshift32順
            currentSeedToTest = xorshift32(currentSeedToTest);
        }
    }

    // ループが最後まで完了した場合 (SEEDが見つからなかった場合)
    const remainingProgress = processedCount % progressUpdateInterval;
    if (remainingProgress > 0) {
        postMessage({ type: 'progress', processed: remainingProgress });
    }
    // 最後に処理したSEEDを finalSeed として報告
    postMessage({ type: 'done', finalSeed: currentSeedToTest });
}


self.onmessage = function(e) {
    const {
        initialStartSeed,
        workerIndex,
        rangePerWorker,
        count,
        gachaId,
        targetSequence,
        gachaMasterData,
        itemMasterData,
        isFullSearch,
        isCounterSearch,
        stopOnFound
    } = e.data;

    // Set up master data for this worker instance
    gachaMaster = gachaMasterData;
    itemMaster = itemMasterData;
    itemNameMap = Object.fromEntries(Object.entries(itemMaster).map(([id, { name }]) => [name, parseInt(id, 10)]));
    
    // Pre-process gacha data
    for (const id in gachaMaster) {
        const gacha = gachaMaster[id];

        // Pre-calculate cumulative rarity rates
        if (gacha.rarityRates && !gacha.cumulativeRarityRates) {
            let cumulativeRate = 0;
            const cumulativeArray = [];
            // Assuming rarities are '0', '1', '2', '3', '4' in order
            for (let i = 0; i <= 4; i++) {
                cumulativeRate += gacha.rarityRates[i.toString()] || 0;
                cumulativeArray.push(cumulativeRate);
            }
            gacha.cumulativeRarityRates = cumulativeArray;
        }

        if (!gacha.rarityItems) {
            const rarityItems = { '0': [], '1': [], '2': [], '3': [], '4': [] };
            gacha.pool.forEach(itemId => {
                const item = itemMaster[itemId];
                if (item) rarityItems[item.rarity].push(itemId);
            });
            gacha.rarityItems = rarityItems;
        }
    }

    let actualStartSeed = initialStartSeed;
    if (isCounterSearch) {
        actualStartSeed = (initialStartSeed + (workerIndex * rangePerWorker)) >>> 0;
    } else {
        const offset = workerIndex * rangePerWorker;
        for (let i = 0; i < offset; i++) {
            actualStartSeed = xorshift32(actualStartSeed);
        }
    }

    performSearch(actualStartSeed, count, gachaId, targetSequence, isFullSearch, isCounterSearch, stopOnFound);
};
