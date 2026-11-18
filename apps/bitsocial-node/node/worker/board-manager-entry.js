// What the Worker takes from the 5chan board manager: its one-board manager, the function that turns a board's config and
// the global defaults into that manager's options, and the name of the page sort that carries the bump limit. The build
// bundles the package's TypeScript (build/board-manager.mjs); nothing else of the package is reached from the Worker.

export { startBoardManager } from '@bitsocial/5chan-board-manager/src/board-manager.ts'
export { resolveBoardManagerOptions } from '@bitsocial/5chan-board-manager/src/multi-config.ts'
export { ACTIVE_PAGE_SORT_NAME, runsActivePageSort } from '@bitsocial/5chan-board-manager/src/page-sorts.ts'
