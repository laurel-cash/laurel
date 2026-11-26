/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// vite.config.ts -- dev server and bundler setup for the ui

import { realpathSync } from "node:fs";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error: a plain node module of the release scripts, without types
import { Com_Features, Com_ModuleMark, Com_ModuleProblems } from "./scripts/release_rules.mjs";
// @ts-expect-error: a plain node module of the build, without types
import { TEXT_SCALE } from "./scripts/text_scale.mjs";		// an iPhone's text size: every px font size times --text-scale

// the modules a build may leave out (D-031), left out of the page as cargo leaves
// them out of the engine: one list, the build's --features, handed here by android.ps1
// and release.mjs (LAUREL_FEATURES; none named, none in). A module off is a false
// __LAUREL_<NAME>__, and what only it reached is dropped. The bundle is checked as it
// is written, so a stale dist/ can't pass: a module's code is in it where the bundler
// wrote any of its screens' files (their rendered length; a chunk of their own isn't a
// sign, as one is still made, holding nothing of theirs, for their imports)
export const UI_MODULES: Record< string, RegExp > = {
	"repeat-payments":	/\/src\/ui_repeat\.tsx$/,
	"prices":			/\/src\/ui_(price|alert)\.tsx$/,		// the balance chart (ui_chart) stays
	"folder-sync":		/\/src\/ui_folder\.tsx$/,
	"offline-signing":	/\/src\/ui_offline\.tsx$/,
};

export const Com_ModuleDefines = ( on: Set< string > ): Record< string, string > => Object.fromEntries(
	Object.keys( UI_MODULES ).map( ( m ) => [ `__LAUREL_${m.toUpperCase().replaceAll( "-", "_" )}__`, JSON.stringify( on.has( m ) ) ] ) );

const FEATURES: Set< string > = Com_Features( process.env.LAUREL_FEATURES );

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
	css: { postcss: { plugins: [ TEXT_SCALE ] } },
	plugins: [
		react(),
		{
			name:				"laurel-webview-floor",
			transformIndexHtml:	( html: string ) => html.replaceAll( "%WEBVIEW_FLOOR%", String( WEBVIEW_FLOOR ) ),
		},
		{
			name:	"laurel-modules",
			// the bundle this build writes holds the modules it turns on, and none it leaves out
			generateBundle( _options: unknown, bundle: Record< string, { type: string; code?: string; modules?: Record< string, { renderedLength: number } > } > ) {
				const written = Object.values( bundle ).flatMap( ( c ) => c.type === "chunk" ? Object.entries( c.modules ?? {} ) : [] )
					.filter( ( [ , m ] ) => m.renderedLength > 0 )
					.map( ( [ id ] ) => id.replaceAll( "\\", "/" ) );
				const marks = Object.entries( UI_MODULES )
					.filter( ( [ , files ] ) => written.some( ( id ) => files.test( id ) ) )
					.map( ( [ m ] ) => Com_ModuleMark( m ) )
					.join( " " );
				// and the code itself, for a module's hosts (release_rules MODULE_HOSTS)
				const code = Object.values( bundle ).map( ( c ) => c.code ?? "" ).join( "\n" );
				const problems: string[] = Com_ModuleProblems( `${marks}\n${code}`, FEATURES, "the ui bundle", Object.keys( UI_MODULES ) );
				if ( problems.length ) {
					throw new Error( `${problems.join( "\n" )}\n(LAUREL_FEATURES=${process.env.LAUREL_FEATURES ?? ""}: name the same modules as cargo's --features)` );
				}
			},
		},
	],

	define: Com_ModuleDefines( FEATURES ),

	build: {
		target:		[ `chrome${WEBVIEW_FLOOR}`, `edge${WEBVIEW_FLOOR}`, "safari16.4" ],
	},

	clearScreen: false,		// keep rust errors on screen

	server: {
		host:		DEV_HOST,
		port:		DEV_PORT,
		strictPort:	true,		// tauri expects this exact port
		// node_modules may be a link to another checkout's: vite asks for its files by their
		// real path, outside this folder, and refused them. Inter never loaded in a dev page,
		// so every layout check measured the system's narrower font (11-27)
		fs: {
			allow: [ searchForWorkspaceRoot( process.cwd() ), realpathSync( "node_modules" ) ],
		},
		watch: {
			ignored: [ "**/src-tauri/**" ],		// cargo handles rust changes
		},
	},
} ) );
