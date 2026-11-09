/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_switcher.tsx -- the menu at the top of the sidebar: every wallet,
// every account, and the ways to add more

import { useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronsUpDown, Ellipsis, Eye, FileKey, Key, KeyRound, Pencil, Plus, Settings2, ShieldAlert, Sparkles, UserPlus } from "lucide-react";

import { commands, Com_SyncState, walletSummary_t } from "./ui_local";
import { T } from "./ui_text";
import { useCurrent, useStore } from "./ui_store";
import { UI_Amount } from "./ui_widgets";
import { Com_SyncLabel, UI_Logo, UI_SyncDot } from "./ui_chrome";
import { UI_AddAccountSheet, UI_NameSheet } from "./ui_sheets";
import { KINDS } from "./ui_wallets";

export type addWalletKind_t = "create" | "restore" | "viewOnly" | "zcashd";


/*
==================
UI_WalletGroup

One wallet in the menu: its name, a badge if it needs attention, its
options, then its accounts with their balances
==================
*/
function UI_WalletGroup( props: {
	wallet:			walletSummary_t;
	onRename:		() => void;
	onAddAccount:	() => void;
	onBackup:		() => void;
} ) {
	const wallet	= props.wallet;
	const select	= useStore( ( s ) => s.Select );
	const current	= useCurrent();
	const isSeed	= wallet.kind === "seed";
	const state		= Com_SyncState( wallet.progress );

	return (
		<Menu.Group>
			<div className="menu-group-head">
				<span className="menu-group-name">{wallet.name}</span>
				{KINDS[wallet.kind].badge && <span className="menu-badge">{KINDS[wallet.kind].badge}</span>}
				{state !== "synced" && (
					<span className={"menu-sync " + state}><UI_SyncDot state={state} />{Com_SyncLabel( state, wallet.progress )}</span>
				)}
				{isSeed && !wallet.backedUp && (
					<Menu.Item className="menu-pill warn" onSelect={props.onBackup}>
						<ShieldAlert aria-hidden="true" />{T.switcher.notBackedUp}
					</Menu.Item>
				)}

				<Menu.Sub>
					<Menu.SubTrigger className="menu-more" aria-label={T.switcher.walletOptions}>
						<Ellipsis aria-hidden="true" />
					</Menu.SubTrigger>
					<Menu.Portal>
						<Menu.SubContent className="menu" sideOffset={6} collisionPadding={12}>
							<Menu.Item className="menu-item" onSelect={props.onRename}><Pencil /> {T.switcher.renameWallet}</Menu.Item>
							{wallet.can.addAccount && <Menu.Item className="menu-item" onSelect={props.onAddAccount}><UserPlus /> {T.switcher.addAccount}</Menu.Item>}
							{isSeed && <Menu.Item className="menu-item" onSelect={props.onBackup}><KeyRound /> {T.switcher.backUp}</Menu.Item>}
						</Menu.SubContent>
					</Menu.Portal>
				</Menu.Sub>
			</div>

			{wallet.accounts.map( ( a ) => {
				const on = current.wallet?.id === wallet.id && current.account?.index === a.index;
				return (
					<Menu.Item
						key={a.index}
						className={"menu-item account" + ( on ? " on" : "" )}
						onSelect={() => select( { walletId: wallet.id, account: a.index } )}
					>
						<span className="menu-check">{on && <Check />}</span>
						<span className="menu-account">{a.name}</span>
						<span className="menu-amount"><UI_Amount zats={a.balance.total} /></span>
					</Menu.Item>
				);
			} )}
		</Menu.Group>
	);
}

/*
==================
UI_Switcher

The trigger shows the account on screen. The menu lists everything.
Sheets for renaming and adding accounts open from here and belong to
the wallet they were opened for.
==================
*/
export function UI_Switcher( props: {
	onAddWallet:	( kind: addWalletKind_t ) => void;
	onBackup:		( walletId: string ) => void;
	onSweep:		() => void;		// into the current account
} ) {
	const wallets	= useStore( ( s ) => s.wallets );
	const order		= useStore( ( s ) => s.order );
	const refresh	= useStore( ( s ) => s.Refresh );
	const select	= useStore( ( s ) => s.Select );
	const go		= useStore( ( s ) => s.Go );
	const current	= useCurrent();

	// the wallet stays set after closing, so the sheet can animate out
	const [ renaming, setRenaming ]		= useState< walletSummary_t | null >( null );
	const [ renameOpen, setRenameOpen ]	= useState( false );
	const [ adding, setAdding ]			= useState< walletSummary_t | null >( null );
	const [ addOpen, setAddOpen ]		= useState( false );

	return (
		<>
			<Menu.Root>
				<Menu.Trigger className="switcher">
					<span className="switcher-mark"><UI_Logo size={22} /></span>
					<span className="switcher-text">
						<span className="switcher-account">{current.account?.name ?? "—"}</span>
						<span className="switcher-wallet">{current.wallet?.name ?? ""}</span>
					</span>
					<ChevronsUpDown className="switcher-chevron" aria-hidden="true" />
				</Menu.Trigger>

				<Menu.Portal>
					<Menu.Content className="menu switcher-menu" align="start" sideOffset={6} collisionPadding={12}>
						{order.map( ( id, i ) => wallets[id] && (
							<div key={id}>
								{i > 0 && <Menu.Separator className="menu-sep" />}
								<UI_WalletGroup
									wallet={wallets[id]}
									onRename={() => { setRenaming( wallets[id] ); setRenameOpen( true ); }}
									onAddAccount={() => { setAdding( wallets[id] ); setAddOpen( true ); }}
									onBackup={() => props.onBackup( id )}
								/>
							</div>
						) )}

						<Menu.Separator className="menu-sep" />
						<Menu.Sub>
							<Menu.SubTrigger className="menu-item"><Plus /> {T.switcher.addWallet}</Menu.SubTrigger>
							<Menu.Portal>
								<Menu.SubContent className="menu" sideOffset={6} collisionPadding={12}>
									<Menu.Item className="menu-item" onSelect={() => props.onAddWallet( "create" )}><Sparkles /> {T.switcher.createWallet}</Menu.Item>
									<Menu.Item className="menu-item" onSelect={() => props.onAddWallet( "restore" )}><KeyRound /> {T.switcher.restoreWallet}</Menu.Item>
									<Menu.Item className="menu-item" onSelect={() => props.onAddWallet( "viewOnly" )}><Eye /> {T.switcher.viewOnlyWallet}</Menu.Item>
									<Menu.Item className="menu-item" onSelect={() => props.onAddWallet( "zcashd" )}><FileKey /> {T.switcher.zcashdWallet}</Menu.Item>
									{order.length > 0 && <Menu.Separator className="menu-sep" />}
									{order.length > 0 && <Menu.Item className="menu-item" onSelect={props.onSweep}><Key /> {T.sweep.menu}</Menu.Item>}
								</Menu.SubContent>
							</Menu.Portal>
						</Menu.Sub>
						<Menu.Item className="menu-item" onSelect={() => go( "settings", "wallets" )}><Settings2 /> {T.switcher.manageWallets}</Menu.Item>
					</Menu.Content>
				</Menu.Portal>
			</Menu.Root>

			{renaming && (
				<UI_NameSheet
					open={renameOpen}
					onOpenChange={setRenameOpen}
					title={T.sheets.renameWalletTitle}
					initial={renaming.name}
					action={T.common.save}
					save={async ( name ) => { await commands.wRenameWalletF( renaming.id, name ); await refresh(); }}
				/>
			)}
			{adding && (
				<UI_AddAccountSheet
					open={addOpen}
					onOpenChange={setAddOpen}
					wallet={adding}
					onAdded={( index ) => select( { walletId: adding.id, account: index } )}
				/>
			)}
		</>
	);
}
