/// <reference types="vite/client" />

// whether this build has a module it may leave out (D-031): vite.config.ts sets
// each from the build's feature list, so code under a false one is dropped
declare const __LAUREL_REPEAT_PAYMENTS__: boolean;
declare const __LAUREL_PRICES__: boolean;
declare const __LAUREL_FOLDER_SYNC__: boolean;
declare const __LAUREL_OFFLINE_SIGNING__: boolean;

declare module "qr-scanner/qr-scanner-worker.min.js" {
	export function createWorker(): Worker;
}
