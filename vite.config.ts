/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// vite.config.ts -- dev server and bundler setup for the ui

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ipv4 on purpose: "localhost" resolves to ::1 on windows, and tauri
// looks for the dev server on 127.0.0.1. must match devUrl in tauri.conf.json
const DEV_HOST	= process.env.TAURI_DEV_HOST || "127.0.0.1";
const DEV_PORT	= 1420;

// the oldest Chrome (an Android phone's System WebView) Laurel's page runs in. The
// stylesheet sets it, not the script: color-mix() over variables (111), container
// queries and :has() (105) can't be lowered. Below it index.html says what to update
// (its %WEBVIEW_FLOOR%), never a blank or colorless screen. Windows' WebView2 updates
// itself; Safari's 16.4 is the same year's
export const WEBVIEW_FLOOR = 111;

export default defineConfig( () => ( {
	plugins: [
		react(),
		{
			name:				"laurel-webview-floor",
			transformIndexHtml:	( html: string ) => html.replaceAll( "%WEBVIEW_FLOOR%", String( WEBVIEW_FLOOR ) ),
		},
	],

	build: {
		target:		[ `chrome${WEBVIEW_FLOOR}`, `edge${WEBVIEW_FLOOR}`, "safari16.4" ],
	},

	clearScreen: false,		// keep rust errors on screen

	server: {
		host:		DEV_HOST,
		port:		DEV_PORT,
		strictPort:	true,		// tauri expects this exact port
		watch: {
			ignored: [ "**/src-tauri/**" ],		// cargo handles rust changes
		},
	},
} ) );
