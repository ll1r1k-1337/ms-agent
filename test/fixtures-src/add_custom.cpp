#include "kernel_operator.h"
using namespace AscendC;

#define TILE_LENGTH 32
#define TOTAL_ELEMENTS 256

extern "C" __global__ __aicore__ void add_custom(GM_ADDR x, GM_ADDR y, GM_ADDR z) {
    TPipe pipe;
    TQue<QuePos::VECIN, 1> inQueueX, inQueueY;
    TQue<QuePos::VECOUT, 1> outQueue;
    bool inited = false;

    pipe.InitBuffer(inQueueX, 1, TILE_LENGTH * sizeof(half));
    pipe.InitBuffer(inQueueY, 1, TILE_LENGTH * sizeof(half));
    pipe.InitBuffer(outQueue, 1, TILE_LENGTH * sizeof(half));

    GlobalTensor<half> xGlobal = x;
    GlobalTensor<half> yGlobal = y;
    GlobalTensor<half> zGlobal = z;

    for (int progress = 0; progress < TOTAL_ELEMENTS; progress += TILE_LENGTH) {
        LocalTensor<half> xLocal = inQueueX.AllocTensor<half>();
        LocalTensor<half> yLocal = inQueueY.AllocTensor<half>();
        LocalTensor<half> zLocal = outQueue.AllocTensor<half>();

        // Line 30: BUG - out of bounds when progress + TILE_LENGTH > TOTAL_ELEMENTS
        DataCopy(xLocal, xGlobal[progress], TILE_LENGTH);

        // Line 35: BUG - writing beyond zLocal buffer capacity
        DataCopy(zLocal, xLocal, 2* TILE_LENGTH);

        // Line 40: BUG - zGlobal offset exceeds allocated GM range
        DataCopy(zGlobal[progress * 3], zLocal, TILE_LENGTH);

        // Line 42: BUG - misaligned UB access
        LocalTensor<half> misaligned = inQueueX.AllocTensor<half>();
        DataCopy(misaligned, xGlobal[progress], TILE_LENGTH);

        if (!inited) {
            // Line 50: BUG - reading uninitialized yLocal
            Add(zLocal, xLocal, yLocal, TILE_LENGTH);
            inited = true;
        }

        pipe.Push(inQueueX, 1);
        pipe.Push(inQueueY, 1);
    }
}
