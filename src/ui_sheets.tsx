/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_sheets.tsx -- the small dialogs: naming things and adding accounts

import { useEffect, useRef, useState } from "react";

import { commands, walletSummary_t } from "./ui_local";
import { T } from "./ui_text";
import { useAction } from "./ui_hooks";
import { useStore } from "./ui_store";
import { sheetProps_t, UI_Alert, UI_Info, UI_Segmented, UI_Sheet, UI_SheetButtons } from "./ui_widgets";


/*
==================
UI_NameField

A name input that knows the engine's limit and submits on Enter
==================
*/
export function UI_NameField( props: {
	value:		string;
	onChange:	( v: string ) => void;
	onSubmit?:	() => void;
	autoFocus?:	boolean;
	id?:		string;
} ) {
	const maxLen = useStore( ( s ) => s.constants?.maxNameLen ?? 40 );
	const ref = useRef< HTMLInputElement >( null );

	useEffect( () => {
		if ( props.autoFocus ) {
			ref.current?.select();		// ready to type over the suggested name
		}
	}, [] );

	return (
		<input
			ref={ref}
			id={props.id}
			className="field"
			value={props.value}
			maxLength={maxLen}
			autoFocus={props.autoFocus}
			spellCheck={false}
			onChange={( e ) => props.onChange( e.target.value )}
			onKeyDown={( e ) => { if ( e.key === "Enter" ) props.onSubmit?.(); }}
		/>
	);
}

/*
==================
UI_NameSheet

Asks for one name: a new wallet, or renaming a wallet or an account.
save gets the trimmed name; if it throws, the engine's reason is shown
and the sheet stays open.
==================
*/
export function UI_NameSheet( props: sheetProps_t & {
	title:			string;
	description?:	string;
	initial:		string;
	action:			string;
	save:			( name: string ) => Promise< unknown >;
} ) {
	const [ name, setName ] = useState( props.initial );
	const act = useAction( async () => {
		await props.save( name.trim() );
		props.onOpenChange( false );
	}, props.open );

	// a sheet opened again starts from the current name, not the last typing
	useEffect( () => {
		if ( props.open ) {
			setName( props.initial );
		}
	}, [ props.open ] );

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={props.title} description={props.description} busy={act.busy}>
			<label className="label" htmlFor="sheet-name">{T.sheets.name}</label>
			<UI_NameField id="sheet-name" value={name} onChange={setName} onSubmit={act.run} autoFocus />
			{act.error && <UI_Alert title={props.title} message={act.error} />}
			<UI_SheetButtons action={{ label: props.action, onRun: act.run }} busy={act.busy} onCancel={() => props.onOpenChange( false )} />
		</UI_Sheet>
	);
}

/*
==================
UI_AddAccountSheet

A new account in an existing wallet. Asks whether it was used before,
because an old account's payments are only found by scanning history.
==================
*/
export function UI_AddAccountSheet( props: sheetProps_t & {
	wallet:			walletSummary_t;
	onAdded:		( index: number ) => void;
} ) {
	const refresh = useStore( ( s ) => s.Refresh );
	const suggested = T.sheets.accountName( props.wallet.accounts.length + 1 );

	const [ name, setName ]	= useState( suggested );
	const [ used, setUsed ]	= useState( false );

	const act = useAction( async () => {
		const index = await commands.wAddAccountF( props.wallet.id, name.trim(), used );
		await refresh();
		props.onAdded( index );
		props.onOpenChange( false );
	}, props.open );

	useEffect( () => {
		if ( props.open ) {
			setName( suggested );
			setUsed( false );
		}
	}, [ props.open ] );

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={T.sheets.addAccountTitle} description={T.sheets.addAccount} busy={act.busy}>
			<label className="label" htmlFor="account-name">{T.sheets.name}</label>
			<UI_NameField id="account-name" value={name} onChange={setName} onSubmit={act.run} autoFocus />

			<div className="label">
				{T.sheets.newOrUsed} <UI_Info title={T.explain.accountsTitle}>{T.explain.accounts}</UI_Info>
			</div>
			<UI_Segmented
				full
				id="account-used"
				value={used ? "used" : "new"}
				onChange={( v ) => setUsed( v === "used" )}
				options={[
					{ value: "new",		label: T.sheets.isNew },
					{ value: "used",	label: T.sheets.isUsed },
				]}
			/>
			<p className="hint">{used ? T.sheets.isUsedHint : T.sheets.isNewHint}</p>

			{act.error && <UI_Alert title={T.sheets.addAccountTitle} message={act.error} />}
			<UI_SheetButtons action={{ label: T.sheets.add, onRun: act.run }} busy={act.busy} onCancel={() => props.onOpenChange( false )} />
		</UI_Sheet>
	);
}
