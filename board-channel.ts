/** The realtime channel a board publish is announced on; its payload is `{ threadId, id, kind }` (core/board.ts, boardSignal). */
export const BOARD_CHANNEL = "board";
/** Announced when a background copy for a thread starts or ends (copies.ts); its payload is `{ threadId }`. The tab then reads `board_get` again for its `copy`. */
export const BOARD_COPY_CHANNEL = "board-copy";
