// assembly/gacha.ts
// AssemblyScriptによるガチャシミュレーションとSEED探索のコアロジック

// ------------------------------------------------
// |    予約ID (JS側との共通認識)                         |
// ------------------------------------------------
const GUARANTEED_FEATURED_ID: u32 = 4294967295; // u32最大値: 目玉(確定)
const FEATURED_ID: u32 = 4294967294;         // u32最大値 - 1: 目玉

// ------------------------------------------------
// |    結果バッファのインデックス (advanceOneStepの結果を格納)  |
// ------------------------------------------------
// メモリの先頭 16バイト (4要素 * 4バイト) を一時結果バッファとして利用
const RESULT_BUFFER_PTR: u32 = 0;
const RESULT_END_SEED_INDEX: u32 = 0;
const RESULT_LAST_ITEM_ID_INDEX: u32 = 1;
const RESULT_IS_FEATURED_INDEX: u32 = 2; // 0:false, 1:true
const RESULT_DRAWN_ITEM_ID_INDEX: u32 = 3;

// ------------------------------------------------
// |    Gacha Master Dataのインデックス (JSから渡される配列の構造)  |
// ------------------------------------------------
// GachaDataの構造: [featuredRate, rate_0..rate_4, cumulative_0..cumulative_4, canReRoll] (全12要素)
const FEATURED_RATE_INDEX: u32 = 0;
const CUMULATIVE_RATE_START_INDEX: u32 = 6;
const CAN_REROLL_INDEX: u32 = 11;

// ------------------------------------------------
// |    コア関数群                                      |
// ------------------------------------------------

/**
 * xorshift32 疑似乱数生成器
 * @param seed 現在のシード
 * @returns 次のシード
 */
function xorshift32(seed: u32): u32 {
    let x = seed;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 15;
    return x;
}

/**
 * 1回のガチャ抽選ステップを進める
 * @param currentSeed 現在のシード
 * @param lastItemId 前回のアイテムID (重複チェック用)
 * @param gachaDataPtr ガチャマスターデータのポインタ (u32配列)
 * @param poolDataPtr アイテムプールデータのポインタ (u32配列)
 * @returns 次のシード (結果はメモリバッファ RESULT_BUFFER_PTR に書き込まれる)
 */
function advanceOneStep(currentSeed: u32, lastItemId: u32, gachaDataPtr: u32, poolDataPtr: u32): u32 {
    let s1 = xorshift32(currentSeed);
    const featuredRate = load<u32>(gachaDataPtr + FEATURED_RATE_INDEX * sizeof<u32>());

    // 1. 目玉アイテム判定
    if ((s1 % 10000) < featuredRate) {
        // 結果をメモリに格納
        store<u32>(RESULT_BUFFER_PTR + RESULT_END_SEED_INDEX * sizeof<u32>(), s1);
        store<u32>(RESULT_BUFFER_PTR + RESULT_LAST_ITEM_ID_INDEX * sizeof<u32>(), 0); // lastItemIdリセット
        store<u32>(RESULT_BUFFER_PTR + RESULT_IS_FEATURED_INDEX * sizeof<u32>(), 1); // isFeatured = true
        store<u32>(RESULT_BUFFER_PTR + RESULT_DRAWN_ITEM_ID_INDEX * sizeof<u32>(), 0); // Drawn IDは無視
        return s1;
    }

    let s2 = xorshift32(s1);
    const rarityVal = s2 % 10000;

    // 2. レアリティ決定 (累積レートによる判定)
    let rarityId: u32 = 0; // 0, 1, 2, 3, 4
    for (let i: u32 = 0; i < 5; i++) {
        const cumulativeRate = load<u32>(gachaDataPtr + (CUMULATIVE_RATE_START_INDEX + i) * sizeof<u32>());
        if (rarityVal < cumulativeRate) {
            rarityId = i;
            break;
        }
    }

    let s3 = xorshift32(s2);
    let currentSeedFinal = s3;
    let finalDrawnItemId: u32 = 0;
    let finalLastItemId: u32 = 0;

    // 3. アイテム抽選
    
    // PoolDataの構造: [count_0, itemID_0_1, ..., count_1, itemID_1_1, ...]
    let poolDataCursor: u32 = 0;
    let itemPoolCount: u32 = 0;

    // 目的のレアリティのプール開始位置を計算
    for (let i: u32 = 0; i < rarityId; i++) {
        // レアリティiのアイテム数を読み込む
        const count = load<u32>(poolDataPtr + poolDataCursor * sizeof<u32>());
        // 次のレアリティのカウント位置までカーソルを進める (count + count個のアイテムID)
        poolDataCursor += 1 + count;
    }
    
    // 現在のレアリティのアイテム数を読み込む
    itemPoolCount = load<u32>(poolDataPtr + poolDataCursor * sizeof<u32>());
    
    // アイテムIDのリスト開始ポインタ
    const itemPoolStartPtr = poolDataPtr + (poolDataCursor + 1) * sizeof<u32>(); 

    if (itemPoolCount > 0) {
        let drawnItemId = load<u32>(itemPoolStartPtr + (s3 % itemPoolCount) * sizeof<u32>());
        finalDrawnItemId = drawnItemId;
        finalLastItemId = drawnItemId;

        // 4. レアリティ1の重複再抽選判定
        const canReRoll = load<u32>(gachaDataPtr + CAN_REROLL_INDEX * sizeof<u32>()) == 1;

        if (canReRoll && rarityId == 1 && lastItemId == drawnItemId && itemPoolCount > 1) {
            let s4 = xorshift32(s3);
            currentSeedFinal = s4;

            // 再抽選: 重複しないアイテムを抽選するロジック
            let reRollIndex = s4 % (itemPoolCount - 1);
            let indexCursor: u32 = 0;
            
            // ループ変数 i を u32 に変更
            for (let i: u32 = 0; i < itemPoolCount; i++) {
                let candidateId = load<u32>(itemPoolStartPtr + i * sizeof<u32>());
                if (candidateId != drawnItemId) {
                    if (indexCursor == reRollIndex) {
                        finalDrawnItemId = candidateId;
                        finalLastItemId = candidateId;
                        break;
                    }
                    indexCursor++;
                }
            }
        }
    }

    // 結果をメモリに格納
    store<u32>(RESULT_BUFFER_PTR + RESULT_END_SEED_INDEX * sizeof<u32>(), currentSeedFinal);
    store<u32>(RESULT_BUFFER_PTR + RESULT_LAST_ITEM_ID_INDEX * sizeof<u32>(), finalLastItemId);
    store<u32>(RESULT_BUFFER_PTR + RESULT_IS_FEATURED_INDEX * sizeof<u32>(), 0); // isFeatured = false
    store<u32>(RESULT_BUFFER_PTR + RESULT_DRAWN_ITEM_ID_INDEX * sizeof<u32>(), finalDrawnItemId);

    return currentSeedFinal;
}

// ------------------------------------------------
// |    エクスポート関数 (JSから呼び出される)                  |
// ------------------------------------------------

/**
 * 連続したSEED探索を実行するコア関数 (export)
 * @param startSeed 検索開始SEED
 * @param count 探索するSEED数
 * @param gachaDataPtr ガチャマスターデータのポインタ
 * @param poolDataPtr アイテムプールデータのポインタ
 * @param targetSequencePtr 目標シーケンスのポインタ
 * @param targetSequenceLength 目標シーケンスの長さ
 * @param isCounterSearch カウンタ順 (1) または xorshift順 (0) フラグ
 * @param foundSeedsPtr 発見したSEEDを書き込むメモリのポインタ
 * @param maxFoundSeeds 発見できるSEEDの最大数
 * @returns 発見したSEED数
 */
export function performASSearch(
    startSeed: u32,
    count: u32,
    gachaDataPtr: u32,
    poolDataPtr: u32,
    targetSequencePtr: u32,
    targetSequenceLength: u32,
    isCounterSearch: u32,
    foundSeedsPtr: u32,
    maxFoundSeeds: u32
): u32 {
    let currentSeedToTest = startSeed;
    let foundCount: u32 = 0;
    
    // シミュレーションのトラッキング変数
    let currentLastItemId: u32 = 0; // シミュレーションの初期 lastItemId は 0

    for (let i: u32 = 0; i < count; i++) {
        
        let initialSeed = currentSeedToTest; // 検索対象の開始シード
        let currentEndSeed = initialSeed;
        currentLastItemId = 0;
        let fullSequenceMatched = true;
        
        // ターゲットシーケンスの長さ分シミュレーション
        for (let k: u32 = 0; k < targetSequenceLength; k++) {
            
            // 1ステップ進める
            let newEndSeed = advanceOneStep(currentEndSeed, currentLastItemId, gachaDataPtr, poolDataPtr);
            
            // メモリから結果を読み取り
            let isFeatured = load<u32>(RESULT_BUFFER_PTR + RESULT_IS_FEATURED_INDEX * sizeof<u32>());
            let drawnItemId = load<u32>(RESULT_BUFFER_PTR + RESULT_DRAWN_ITEM_ID_INDEX * sizeof<u32>());
            currentLastItemId = load<u32>(RESULT_BUFFER_PTR + RESULT_LAST_ITEM_ID_INDEX * sizeof<u32>());
            currentEndSeed = newEndSeed;

            // ターゲットアイテムIDを取得
            let targetId = load<u32>(targetSequencePtr + k * sizeof<u32>());
            
            // 比較ロジック
            let currentStepMatched = false;

            if (targetId == GUARANTEED_FEATURED_ID) {
                // 目玉(確定)は常にOK
                currentStepMatched = true; 
            } else if (targetId == FEATURED_ID) {
                // 目玉判定
                currentStepMatched = isFeatured == 1;
            } else {
                // 通常アイテム判定 (目玉でなく、アイテムIDが一致)
                currentStepMatched = (isFeatured == 0) && (drawnItemId == targetId);
            }

            if (!currentStepMatched) {
                fullSequenceMatched = false;
                break; // 不一致なら即座にループを抜ける
            }
        }

        if (fullSequenceMatched) {
            if (foundCount < maxFoundSeeds) {
                // 発見したSEEDを結果バッファに書き込む
                store<u32>(foundSeedsPtr + foundCount * sizeof<u32>(), initialSeed);
                foundCount++;
            }
        }

        // 次のSEEDへの遷移ロジック
        if (isCounterSearch == 1) {
            // カウンタ順 (インクリメント)
            currentSeedToTest = (currentSeedToTest + 1) >>> 0;
            if (currentSeedToTest == 0) break; // オーバーフローで終了
        } else {
            // xorshift32順 (次の乱数)
            currentSeedToTest = xorshift32(currentSeedToTest);
            if (i > 0 && currentSeedToTest == startSeed) break; // 周期完了で終了
        }
    }

    return foundCount;
}
