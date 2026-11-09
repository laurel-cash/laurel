/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_settings.tsx -- Settings as a window of its own: categories down the
// side, one pane at a time. Any screen can open a pane (store.Go), so
// "Manage Wallets" in the switcher lands on the wallets.

import { Bell, BookUser, ChevronLeft, CircleHelp, FileSignature, FolderSync, HardDrive, Info, Palette, Server, ShieldCheck, Terminal, WalletCards } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { T } from "./ui_text";
import { Com_Unreachable } from "./ui_local";
import { settingsPane_t, useStore } from "./ui_store";
import { UI_SecuritySection } from "./ui_security";
import { UI_AppearanceSection } from "./ui_appearance";
import { UI_WalletsSection } from "./ui_wallets";
import type { walletActions_t } from "./ui_wallets";
import { UI_ContactsSection } from "./ui_contacts";
import { UI_FolderSection } from "./ui_folder";
import { UI_OfflineSection } from "./ui_offline";
import { UI_NetworkChoice, UI_ServerSection } from "./ui_server";
import { UI_StorageSection } from "./ui_storage";
import { UI_AboutSection } from "./ui_about";
import { UI_NotificationsSection } from "./ui_notifications";
import { UI_HelpSection } from "./ui_help";
import { UI_DeveloperSection } from "./ui_developer";
import { UI_PriceSetting } from "./ui_price";

type paneEntry_t = { pane: settingsPane_t; label: string; icon: LucideIcon };

// in groups, the way people look for them: the app, the money, the machine, Laurel
const PANES: paneEntry_t[][] = [
	[
		{ pane: "general",	label: T.settings.general,	icon: Palette },
		{ pane: "security",	label: T.settings.security,	icon: ShieldCheck },
		{ pane: "notifications",	label: T.settings.notifications,	icon: Bell },
	],
	[
		{ pane: "wallets",	label: T.settings.wallets,	icon: WalletCards },
		{ pane: "contacts",	label: T.settings.contacts,	icon: BookUser },
		{ pane: "folder",	label: T.settings.folder,	icon: FolderSync },
		{ pane: "offline",	label: T.settings.offline,	icon: FileSignature },
	],
	[
		{ pane: "network",	label: T.settings.network,	icon: Server },
		{ pane: "storage",	label: T.settings.storage,	icon: HardDrive },
	],
	[
		{ pane: "developer",	label: T.settings.developer,	icon: Terminal },
		{ pane: "help",		label: T.settings.help,		icon: CircleHelp },
		{ pane: "about",	label: T.settings.about,	icon: Info },
	],
];

/*
==================
UI_Pane

Every pane, decided here; a new one must be added to this switch
==================
*/
function UI_Pane( props: { pane: settingsPane_t; actions: walletActions_t } ) {
	switch ( props.pane ) {
	case "general":		return <><UI_AppearanceSection /><UI_PriceSetting /></>;
	case "security":	return <UI_SecuritySection />;
	case "notifications":	return <UI_NotificationsSection />;
	case "wallets":		return <UI_WalletsSection actions={props.actions} />;
	case "contacts":	return <UI_ContactsSection />;
	case "folder":		return <UI_FolderSection />;
	case "offline":		return <UI_OfflineSection />;
	case "network":		return <><UI_NetworkChoice /><UI_ServerSection /></>;
	case "storage":		return <UI_StorageSection />;
	case "developer":	return <UI_DeveloperSection />;
	case "help":		return <UI_HelpSection />;
	case "about":		return <UI_AboutSection />;
	default:			return Com_Unreachable( props.pane );
	}
}

/*
==================
UI_PaneHead

The pane's name, said once: its icon as in the list, the title, and
what the pane is for. Sections below it carry only group labels.
==================
*/
function UI_PaneHead( props: { pane: settingsPane_t } ) {
	const entry = PANES.flat().find( ( p ) => p.pane === props.pane );
	if ( !entry ) {
		return null;
	}
	return (
		<header className="pane-head">
			<span className={"pane-head-icon pane-" + props.pane}><entry.icon aria-hidden="true" /></span>
			<div className="pane-head-text">
				<h1 className="pane-title">{entry.label}</h1>
				<p className="pane-lede">{T.settings.ledes[props.pane]}</p>
			</div>
		</header>
	);
}

/*
==================
UI_Settings
==================
*/
export function UI_Settings( props: { actions: walletActions_t } ) {
	const pane		= useStore( ( s ) => s.settingsPane );
	const shown		= useStore( ( s ) => s.settingsShown );
	const mobile	= useStore( ( s ) => s.constants?.mobile );
	const go		= useStore( ( s ) => s.Go );
	// a phone has room for one: the list, or a pane with the way back to it
	const one: "list" | "pane" | null = mobile ? shown : null;

	return (
		<div className={"settings-window" + ( one ? " phone-" + one : "" )}>
			{one !== "pane" && <nav className="settings-nav" aria-label={T.settings.title}>
				<h1 className="settings-nav-title">{T.settings.title}</h1>
				{PANES.map( ( group, i ) => (
					<ul key={i} className="settings-nav-group">
						{group.map( ( p ) => (
							<li key={p.pane}>
								<button
									className={"settings-nav-item" + ( p.pane === pane ? " on" : "" )}
									aria-current={p.pane === pane ? "page" : undefined}
									onClick={() => go( "settings", p.pane )}
								>
									<span className={"settings-nav-icon pane-" + p.pane}><p.icon aria-hidden="true" /></span>
									{p.label}
								</button>
							</li>
						) )}
					</ul>
				) )}
			</nav>}
			{one !== "list" && (
				<div className="settings-pane" key={pane}>
					{one === "pane" && (
						<button className="nav-back" onClick={() => go( "settings" )}>
							<ChevronLeft aria-hidden="true" />{T.settings.title}
						</button>
					)}
					<UI_PaneHead pane={pane} />
					<UI_Pane pane={pane} actions={props.actions} />
				</div>
			)}
		</div>
	);
}
