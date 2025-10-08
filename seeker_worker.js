// seeker_worker.js (with WASM fallback)

// --- Global Data ---
let gachaMaster; // gachaMasterには渡されたgachaDataを格納
let itemMaster; // advanceOneStep_jsでは使用しないため、空で保持
let itemNameMap; // targetSequenceを扱うために必要
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
    // 【修正】gachaオブジェクトにcumulativeRarityRatesが事前計算されている前提
    const cumulativeRates = gacha.cumulativeRarityRates;
    for (let i = 0; i < cumulativeRates.length; i++) {
        if (rarityVal < cumulativeRates[i]) {
            rarityId = i;
            break;
        }
    }
    const s3 = xorshift32_js(s2);
    // 【修正】gachaオブジェクトにrarityItemsが事前計算されている前提
    const itemPool = gacha.rarityItems[rarityId]; 
    if (!itemPool || itemPool.length === 0) {
        return { isFeatured: false, drawnItemId: -2, endSeed: s3, lastItemId };
    }
    let drawnItemId = itemPool[s3 % itemPool.length];
    
    // レア被り判定 (レアリティ1のみ)
    // 【修正】itemPoolの長さを参照する
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

function performSearch_js(startSeed, count, gacha, targetSequence, isCounterSearch, stopOnFound, nextJob) {
    let currentSeedToTest = startSeed;
    let processedCount = 0;
    const initialSeed = startSeed;
    
    // 【修正】targetSequenceはID(数値)または特殊コード(-1, -2)で渡されるため、itemNameMapはここでは不要
    
    for (let i = 0; i < count; i++) {
        // カウンタ検索の場合は43億を超えたら終了
        if (isCounterSearch && currentSeedToTest > 4294967295) break; 
        
        // xorshift32検索の場合は一周したら終了
        if (!isCounterSearch && processedCount > 0 && currentSeedToTest === initialSeed) break;

        processedCount++;

        let fullSequenceMatched = true;
        let simSeed = currentSeedToTest;
        let simLastItemId = -1;
        for (let k = 0; k < targetSequence.length; k++) {
            const targetCode = targetSequence[k]; // ID or 特殊コード(-1:目玉, -2:目玉(確定))
            const stepResult = advanceOneStep_js(simSeed, simLastItemId, gacha);
            let currentStepMatched = false;
            
            // targetCode が数値コードで渡されるため、判定ロジックを修正
            const FEAT_CODE = -1; // index.htmlと合わせる
            const G_FEAT_CODE = -2; // index.htmlと合わせる

            if (targetCode === G_FEAT_CODE) currentStepMatched = true; // 目玉(確定)は常にTrue
            else if (targetCode === FEAT_CODE) currentStepMatched = stepResult.isFeatured; // 目玉
            else {
                currentStepMatched = !stepResult.isFeatured && stepResult.drawnItemId === targetCode; // 通常アイテムはIDを比較
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
                const processedSinceLastUpdate = processedCount % 100000;
                if (processedSinceLastUpdate > 0) postMessage({ type: 'progress', processed: processedSinceLastUpdate });
                // finalSeedは不要
                postMessage({ type: 'stop_found', processed: processedCount }); 
                return;
            }
        }
        if (processedCount % 100000 === 0) {
            postMessage({ type: 'progress', processed: 100000 });
        }
        
        if (isCounterSearch) {
            currentSeedToTest = (currentSeedToTest + 1) >>> 0; 
            if (currentSeedToTest === 0) currentSeedToTest = 4294967296; // 43億の次のシードを表現
        } else {
            currentSeedToTest = xorshift32_js(currentSeedToTest);
        }
        
    }
    const remainingProgress = processedCount % 100000;
    if (remainingProgress > 0) postMessage({ type: 'progress', processed: remainingProgress });
    
    // nextJobがある場合は、カウンタ検索に移行
    if (nextJob) {
        performSearch_js(nextJob.initialStartSeed, nextJob.count, gacha, nextJob.targetSequence, nextJob.isCounterSearch, stopOnFound, null);
    } else {
        // finalSeedは不要
        postMessage({ type: 'done', processed: processedCount });
    }
}

function performSearch_wasm(startSeed, count, gacha, targetSequence, isCounterSearch, stopOnFound, nextJob) {
    // WASMが複雑なジョブチェーンに対応しないため、JS版にフォールバック
    performSearch_js(startSeed, count, gacha, targetSequence, isCounterSearch, stopOnFound, nextJob);
}


// --- Main Message Handler ---
self.onmessage = async function(e) {
    const wasmLoaded = false; 
    
    const {
        initialStartSeed, workerIndex, rangePerWorker, count, gachaId,
        targetSequence, gachaData, isCounterSearch, stopOnFound, nextJob 
    } = e.data;

    // --- データ初期化（全てのジョブで共通） ---
    // メインスレッドから渡された事前計算済みデータを使用
    gachaMaster = { [gachaId]: gachaData }; // gachaMaster[gachaId]で参照できるようにラップ
    // ----------------------------------------
    
    let actualStartSeed = initialStartSeed;


    if (wasmLoaded) {
        performSearch_wasm(actualStartSeed, count, gachaMaster[gachaId], targetSequence, isCounterSearch, stopOnFound, nextJob);
    } else {
        // gachaMaster[gachaId] には累積確率、アイテムプールが計算済みのオブジェクトが格納されている
        performSearch_js(actualStartSeed, count, gachaMaster[gachaId], targetSequence, isCounterSearch, stopOnFound, nextJob);
    }
};