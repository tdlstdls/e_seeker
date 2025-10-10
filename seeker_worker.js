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
        // ありえないケースだが、安全のため
        return { isFeatured: false, drawnItemId: -2, endSeed: s3, lastItemId }; 
    }
    let drawnItemId = itemPool[s3 % itemPool.length];
    
    // レア被り判定 (レアリティ1のみ)
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


function performSearch_js(startSeed, count, gacha, targetSequence, stopOnFound, workerIndex, searchMode) {
    let currentSeedToTest = startSeed;
    let processedCount = 0;
    
    const FEAT_CODE = -1; 
    const G_FEAT_CODE = -2;

    for (let i = 0; i < count; i++) {
        
        processedCount++;

        let fullSequenceMatched = true;
        let simSeed = currentSeedToTest; 
        let simLastItemId = -1;
        
        for (let k = 0; k < targetSequence.length; k++) {
            const targetCode = targetSequence[k]; 
            
            let currentStepMatched = false;

            if (targetCode === G_FEAT_CODE) {
                // 目玉(確定)の場合: 常に成功。シードを消費しない。
                currentStepMatched = true;
                // simSeedとsimLastItemIdは更新されない
                
            } else {
                // 目玉または通常アイテムの場合、advanceOneStep_jsでシミュレーションを実行（SEEDを消費）
                const stepResult = advanceOneStep_js(simSeed, simLastItemId, gacha);
                
                if (targetCode === FEAT_CODE) {
                    currentStepMatched = stepResult.isFeatured; // 目玉
                } else {
                    currentStepMatched = !stepResult.isFeatured && stepResult.drawnItemId === targetCode; // 通常アイテム
                }
                
                // 次のループのためにsimSeedとsimLastItemIdを更新
                simSeed = stepResult.endSeed;
                simLastItemId = stepResult.lastItemId;
            }
            
            if (!currentStepMatched) {
                fullSequenceMatched = false;
                break;
            }
        }

        if (fullSequenceMatched) {
            postMessage({ type: 'found', seed: currentSeedToTest, workerIndex });
            if (stopOnFound) {
                const processedSinceLastUpdate = processedCount % 100000;
                if (processedSinceLastUpdate > 0) postMessage({ type: 'progress', processed: processedSinceLastUpdate, workerIndex });
                postMessage({ type: 'stop_found', processed: processedCount, finalSeed: currentSeedToTest, workerIndex }); 
                return;
            }
        }
        
        // Progress update logic
        if (processedCount % 100000 === 0) {
            postMessage({ type: 'progress', processed: 100000, workerIndex });
        }
        
        // Seedの更新ロジックをsearchModeに応じて分岐
        if (searchMode === 'partial_xorshift') { // full_xorshiftの言及を削除
            // (2) 近接検索（部分）: XORSHIFT32順で連鎖
            currentSeedToTest = xorshift32_js(currentSeedToTest);
        } else {
            // (1) 全件検索（連番） & (3) スピードテスト（連番）: カウンター式（連番）
            currentSeedToTest = (currentSeedToTest + 1) >>> 0;
        }
    }
    
    // Remaining progress update
    const remainingProgress = processedCount % 100000;
    if (remainingProgress > 0) postMessage({ type: 'progress', processed: remainingProgress, workerIndex });
    
    // 完了メッセージ: finalSeedは、最後にチェックしたSEED (currentSeedToTest)
    // 次の開始SEEDを引き継ぎに使うため、現在のcurrentSeedToTestを渡す
    postMessage({ type: 'done', processed: processedCount, finalSeed: currentSeedToTest, workerIndex });
}

function performSearch_wasm(startSeed, count, gacha, targetSequence, stopOnFound, workerIndex, searchMode) {
    // WASMが複雑なジョブチェーンに対応しないため、JS版にフォールバック
    performSearch_js(startSeed, count, gacha, targetSequence, stopOnFound, workerIndex, searchMode);
}


// --- Main Message Handler ---
self.onmessage = async function(e) {
    const wasmLoaded = false; 
    
    const {
        workerIndex, 
        initialStartSeed, count, gachaId,
        targetSequence, gachaData, stopOnFound, searchMode
    } = e.data;

    gachaMaster = { [gachaId]: gachaData }; 
    let actualStartSeed = initialStartSeed;


    if (wasmLoaded) {
        performSearch_wasm(actualStartSeed, count, gachaMaster[gachaId], targetSequence, stopOnFound, workerIndex, searchMode);
    } else {
        performSearch_js(actualStartSeed, count, gachaMaster[gachaId], targetSequence, stopOnFound, workerIndex, searchMode);
    }
};