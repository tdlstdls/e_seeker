#include <stdint.h>
#include <emscripten/emscripten.h>

uint32_t EMSCRIPTEN_KEEPALIVE xorshift32(uint32_t seed) {
    uint32_t x = seed;
    x ^= x << 13;
    x ^= x >> 17; 
    x ^= x << 15;
    return x;
}