/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_update.tsx -- a newer Laurel, when the person asked to be told: the
// switch (Settings > About) and the banner on Home. Rust asks the store, at
// most once a day, only while the switch is on (w_update.rs); a build with no
// store to ask (constants.updateCheck) shows neither

import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { RefreshCw } from "lucide-react";
import { commands, update_t } from "./ui_local";
import { T } from "./ui_text";
import { KEYS } from "./ui_query";
import { useAppSettings } from "./ui_hooks";
import { useStore } from "./ui_store";
import { UI_SettingSwitch } from "./ui_widgets";

/*
==================
UI_UpdateSetting
==================
*/
export function UI_UpdateSetting() {
	const offered = useStore( ( s ) => s.constants?.updateCheck );
	if ( !offered ) {
		return null;
	}
	return <UI_SettingSwitch field="checkUpdates" icon={<RefreshCw aria-hidden="true" />} label={T.update.settingLabel} hint={T.update.settingHint} />;
}

/*
==================
useNewerLaurel

A newer Laurel, or none: off, no store, nothing newer, or not asked yet
==================
*/
export function useNewerLaurel(): update_t | null {
	const offered = useStore( ( s ) => s.constants?.updateCheck ) === true;
	const on = useAppSettings().settings?.checkUpdates === true;
	return useQuery( {
		queryKey:	KEYS.update( on ),
		queryFn:	() => commands.uNewerF(),
		enabled:	offered && on,
		staleTime:	3600_000,		// rust keeps the day's answer: this only looks again
	} ).data ?? null;
}

// the store's page, opened outside Laurel
export function Com_OpenStore( update: update_t ) {
	void Promise.resolve().then( () => openUrl( update.page ) ).catch( ( e: unknown ) => console.error( "openUrl", e ) );
}
