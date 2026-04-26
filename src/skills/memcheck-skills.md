# msAgent Memory Error Fix Patterns

## Tooling Rules

Use OpenCode's native file and terminal capabilities available in the current session.

When applying a fix:

1. Read the relevant source before editing.
2. Make the smallest safe change at the failing location.
3. Preserve unrelated code, comments, whitespace, and formatting.
4. Prefer targeted edits over whole-file rewrites.
5. If the context is insufficient, return `CANNOT_FIX: <reason>` and do not modify files.

Do not:

- emit placeholder text such as `...` or `rest of file unchanged`
- rewrite large regions just for cleanup
- change unrelated APIs or refactor surrounding code without necessity

## Ascend C Memory Architecture

### Memory spaces

- `GM`: global memory
- `UB`: unified buffer
- `L1`: level-1 staging memory
- `L0A` / `L0B` / `L0C`: lower-level compute buffers

### Common APIs

```cpp
DataCopy(dst, src, size)
pipe.InitBuffer(queue, count, size)
queue.AllocTensor<T>()
pipe.Push(queue, count)
pipe.Pop(queue, count)
Add(dst, src1, src2, size)
Duplicate(src, dst, size)
```

## Repair Heuristics by Error Type

### `ILLEGAL_ADDR_READ` / `ILLEGAL_ADDR_WRITE`

- Check copy sizes against the real tensor capacity
- Check loop bounds and tail handling
- Check GM offset calculations for the last tile / block

### `OUT_OF_BOUNDS`

- Recompute destination range and tile math
- Verify multi-core addressing does not overlap

### `MISALIGNED_ACCESS`

- Check alignment assumptions on offsets and tensor base addresses
- Prefer alignment-safe buffer sizing and offset rounding

### `MEM_LEAK`

- Match every device allocation with a release path
- Verify early-return paths do not skip cleanup

### `ILLEGAL_FREE`

- Avoid double free
- Free only memory that was actually allocated

### `MEM_UNUSED`

- Remove dead allocations or connect them to the intended data path

### `UNINITIALIZED_READ`

- Ensure buffers are written before use
- Validate pipe ordering and producer/consumer synchronization

## Editing Strategy

Prefer fixes like:

- adjusting a `DataCopy` size
- correcting loop bounds
- fixing a GM offset
- adding missing initialization
- adding missing cleanup on all exit paths

Avoid fixes like:

- large formatting rewrites
- speculative refactors
- renaming unrelated symbols
