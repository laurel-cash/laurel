/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_notifications.tsx -- how Laurel tells the person a payment arrived:
// in the app, and from the system while Laurel is in the background.
// Never with the amount outside the app (w_sync.rs, Sync_SystemNotice).

import { Bell, BellRing, MonitorSmartphone } from "lucide-react";

import { commands, Com_ErrorOf } from "./ui_local";
import { T } from "./ui_text";
import { useAction, useAppSettings } from "./ui_hooks";
import { UI_Alert, UI_Spinner, UI_Switch } from "./ui_widgets";

/*
==================
UI_NotificationsSection
==================
*/
export function UI_NotificationsSection() {
	const { settings, error, save } = useAppSettings();
	const test = useAction( () => commands.sTestNoticeF() );

	if ( error ) {
		return <UI_Alert title={T.notifications.cantLoad} message={Com_ErrorOf( error )} />;
	}
	if ( !settings ) {
		return <div className="sheet-loading"><UI_Spinner size={16} /></div>;
	}

	return (
		<section className="settings-section">
			<ul className="pool-list settings-list">
				<li className="set-row">
					<span className="set-icon"><Bell aria-hidden="true" /></span>
					<span className="set-text">
						<span className="set-label">{T.notifications.inApp}</span>
						<span className="set-sub">{T.notifications.inAppHint}</span>
					</span>
					<span className="set-actions">
						<UI_Switch label={T.notifications.inApp} checked={settings.notifyInApp} busy={save.busy} onChange={( on ) => { save.run( { notifyInApp: on } ); }} />
					</span>
				</li>
				<li className="set-row">
					<span className="set-icon"><MonitorSmartphone aria-hidden="true" /></span>
					<span className="set-text">
						<span className="set-label">{T.notifications.system}</span>
						<span className="set-sub">{T.notifications.systemHint}</span>
					</span>
					<span className="set-actions">
						<UI_Switch label={T.notifications.system} checked={settings.notifySystem} busy={save.busy} onChange={( on ) => { save.run( { notifySystem: on } ); }} />
					</span>
				</li>
				<li className="set-row">
					<span className="set-icon"><BellRing aria-hidden="true" /></span>
					<span className="set-text">
						<span className="set-label">{T.notifications.test}</span>
						<span className="set-sub">{T.notifications.testHint}</span>
					</span>
					<span className="set-actions">
						<button className="btn" disabled={test.busy} onClick={() => { test.run(); }}>{T.notifications.testAction}</button>
					</span>
				</li>
			</ul>
			{save.error && <UI_Alert title={T.common.cantSaveSetting} message={save.error} />}
			{test.error && <UI_Alert title={T.notifications.cantTest} message={test.error} />}
		</section>
	);
}
