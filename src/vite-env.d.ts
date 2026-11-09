/// <reference types="vite/client" />

declare module "qr-scanner/qr-scanner-worker.min.js" {
	export function createWorker(): Worker;
}
