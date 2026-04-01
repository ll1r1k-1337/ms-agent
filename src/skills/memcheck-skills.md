# ms-agent Memory Error Fix Patterns

## IMPORTANT: edit_file Tool Usage

When using the edit_file tool, you MUST:
1. **Read the file first** using read_file to get the EXACT content
2. **Copy the EXACT text** from the file for oldText - do not modify it, do not add/remove spaces
3. **oldText must match exactly** - including all whitespace, comments, and formatting
4. **Only change what's necessary** - keep surrounding code identical

Example of CORRECT usage:
```
1. read_file shows line 30: "        DataCopy(zLocal, xLocal, 2 *  TILE_LENGTH);"
2. Use oldText: "        DataCopy(zLocal, xLocal, 2 *  TILE_LENGTH);"  (exact match!)
3. Use newText: "        DataCopy(zLocal, xLocal, TILE_LENGTH);"
```

Example of WRONG usage (will fail):
```
oldText: "DataCopy(zLocal, xLocal, 2 * TILE_LENGTH);"  (missing leading spaces!)
oldText: "// Line 30: BUG..." (modifying comments, not exact match)
```

## Ascend C Kernel Memory Architecture

### Memory Spaces
- **GM (Global Memory)**: Large, shared across blocks. Access via `GlobalTensor<T>`. Allocated via `GM_ADDR`.
- **UB (Unified Buffer)**: Per-block, medium size. Access via `LocalTensor<T>`. Used for intermediate computations.
- **L1 (Level 1)**: Small, per-AICore. Used for DMA staging.
- **L0A/L0B/L0C**: Even smaller buffers for scalar/vector operations.

### Key APIs
```cpp
DataCopy(dst, src, size)  // DMA copy between memory spaces
pipe.InitBuffer(queue, count, size)  // Initialize pipe buffer
queue.AllocTensor<T>()  // Allocate from pipe buffer
pipe.Push(queue, count)  // Push data into pipeline
pipe.Pop(queue, count)   // Pop data from pipeline
Add(dst, src1, src2, size)  // Element-wise add
Duplicate(src, dst, size)  // Data duplication
```

### Memory Size Rules
- `pipe.InitBuffer` size must match `AllocTensor` usage
- `DataCopy` size must NOT exceed the buffer capacity
- `DataCopy` destination address must be within valid allocation range
- GM addresses must be properly aligned (typically 32-byte aligned)

## Fix Strategies by Error Type

### ILLEGAL_ADDR_READ / ILLEGAL_ADDR_WRITE
- **Cause**: Reading/writing beyond buffer or GM allocation bounds
- **Fix**: Ensure `DataCopy` size parameter matches the actual buffer/destination capacity
- **Common pattern**: Loop boundary exceeds `TILE_LENGTH * num_tiles`, causing last iteration to overflow

### OUT_OF_BOUNDS
- **Cause**: Multiple cores writing to overlapping GM addresses without coordination
- **Fix**: Add synchronization (e.g., `pipe.InitBuffer` with proper data dependencies, or adjust addressing to avoid overlap)

### MISALIGNED_ACCESS
- **Cause**: Destination address not properly aligned for the data type (e.g., 32-byte alignment for half vectors)
- **Fix**: Align addresses using alignment macros or adjust buffer offsets to alignment boundaries

### MEM_LEAK
- **Cause**: GM memory allocated but never freed
- **Fix**: Add corresponding `free` call for every `malloc_device` allocation, or ensure all GM tensors are properly released

### ILLEGAL_FREE
- **Cause**: Free called on unallocated memory or double-free
- **Fix**: Track allocation/free pairs, ensure each allocation is freed exactly once

### MEM_UNUSED
- **Cause**: Allocated memory never read from or written to
- **Fix**: Remove unnecessary allocation, or use the allocated memory for its intended purpose

### UNINITIALIZED_READ
- **Cause**: Reading from a buffer that hasn't been written to first (e.g., reading before DataCopy)
- **Fix**: Ensure DataCopy completes before reading, add proper pipe synchronization (Push/Pop ordering)
