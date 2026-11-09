/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_qr.test.ts -- an advertised native detector must never reach Android's crashing service
import { expect, it, vi } from "vitest";
const decoder = vi.hoisted( () => ( { worker: { postMessage: vi.fn(), terminate: vi.fn() } } ) );
vi.mock( "qr-scanner/qr-scanner-worker.min.js", () => ( { createWorker: () => decoder.worker } ) );
it( "uses the bundled decoder even when a native detector is advertised", async () => {
	const native = vi.fn( () => { throw new Error( "native service crashes" ); } );
	vi.stubGlobal( "BarcodeDetector", { getSupportedFormats: native } );
	try {
		const { default: scanner } = await import( "./ui_qr" );
		expect( await scanner.createQrEngine() ).toBe( decoder.worker );
		expect( native ).not.toHaveBeenCalled();
	} finally {
		vi.unstubAllGlobals();
	}
} );