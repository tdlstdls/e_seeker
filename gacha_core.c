#include <stdint.h>
#include <emscripten/emscripten.h>

// JavaScriptのxorshift32関数と同一ロジック
// C/C++ではビットシフト演算子 '>>' は算術右シフト（符号を維持）
// '>>>' に相当する論理右シフト（0を埋める）を行うには、
// 符号なし整数型（uint32_t）を使用する必要があります。
uint32_t EMSCRIPTEN_KEEPALIVE xorshift32(uint32_t seed) {
    uint32_t x = seed;
    
    // x ^= x << 13;
    x ^= x << 13;

    // x ^= x >>> 17; (JSのコード)
    // Cでは、uint32_tに対して >> 17 を実行すると論理右シフトになります。
    x ^= x >> 17;

    // x ^= x << 15;
    x ^= x << 15;

    // JavaScriptの >>> 0 に相当する「符号なし32ビット整数」として返す
    return x;
}