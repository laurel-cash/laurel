/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_qr.ts -- one portable decoder for camera frames and imported pictures
import QrScanner from "qr-scanner";

// Android WebView can advertise BarcodeDetector yet crash the whole process
// when Google Play Services is absent. Never enter that native service.
QrScanner.createQrEngine = async () => {
	const { createWorker } = await import( "qr-scanner/qr-scanner-worker.min.js" );
	return createWorker();
};

export default QrScanner;