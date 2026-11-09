/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// main.tsx -- ui entry point

import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter/opsz.css";		// bundled, never fetched: no font cdn sees our users

import { UI_App } from "./ui_main";
import "./ui.css";

// a web view below the floor shows index.html's "update" screen instead (WEBVIEW_FLOOR)
if ( !( window as { __laurelOld?: boolean } ).__laurelOld ) {
	ReactDOM.createRoot( document.getElementById( "root" ) as HTMLElement ).render(
		<React.StrictMode>
			<UI_App />
		</React.StrictMode>,
	);
}
