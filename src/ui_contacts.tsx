/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_contacts.tsx -- the address book, and choosing who to pay: a contact,
// or one of the person's own accounts (src-tauri/src/w_contacts.rs keeps
// the book, sealed, per network)

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { BookUser, ChevronDown, Eye, Plus, Search, ShieldCheck, Trash2, TriangleAlert, UserRound, WalletCards } from "lucide-react";

import { commands, Com_Abbrev, Com_Ago, Com_ErrorOf, contact_t, walletSummary_t } from "./ui_local";
import { T } from "./ui_text";
import { KEYS, QUERY } from "./ui_query";
import { useAction, useAddressCheck } from "./ui_hooks";
import { useStore } from "./ui_store";
import { sheetProps_t, UI_Alert, UI_Sheet, UI_SheetButtons, UI_Spinner, UI_Waiting } from "./ui_widgets";
import { UI_AddressLine } from "./ui_receive";

const PUBLIC_KINDS = [ "transparent", "tex" ];

/*
==================
useContacts

The book, shared by every view that shows it; refreshed after each change
==================
*/
export function useContacts() {
	return useQuery( { queryKey: KEYS.contacts(), queryFn: () => commands.ctListF() } );
}

function Com_Initials( name: string ): string {
	const words = name.trim().split( /\s+/ ).filter( Boolean );
	return ( words.length > 1 ? words[0][0] + words[words.length - 1][0] : name.trim().slice( 0, 2 ) ).toUpperCase();
}

/*
==================
UI_KindChip

Private or public, the way Send says it
==================
*/
function UI_KindChip( props: { kind: string } ) {
	const isPublic = PUBLIC_KINDS.includes( props.kind );
	return (
		<span className={"send-kind" + ( isPublic ? " public" : "" )}>
			{isPublic ? <Eye aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
			{isPublic ? T.contacts.public : T.contacts.private}
		</span>
	);
}

/*
==================
UI_ContactSheet

Adds a contact, or changes one. The address is checked as it's typed;
Delete asks once more, in place.
==================
*/
export function UI_ContactSheet( props: sheetProps_t & { contact: contact_t | null; address?: string } ) {
	const c = props.contact;
	const constants					= useStore( ( s ) => s.constants );
	const [ name, setName ]			= useState( "" );
	const [ address, setAddress ]	= useState( "" );
	const [ note, setNote ]			= useState( "" );
	const [ sure, setSure ]			= useState( false );
	const [ confirming, setConfirming ] = useState( false );		// a saved contact's address changing: shown whole, old and new
	const check = useAddressCheck( address );
	const addressChanged = c !== null && address !== c.address;

	useEffect( () => {
		if ( props.open ) {
			setName( c?.name ?? "" );
			setAddress( c?.address ?? props.address ?? "" );
			setNote( c?.note ?? "" );
			setSure( false );
			setConfirming( false );
		}
	}, [ props.open ] );

	const save = useAction( async () => {
		await commands.ctSaveF( { id: c?.id ?? null, name: name, address: address, note: note || null } );
		await QUERY.invalidateQueries( { queryKey: KEYS.contacts() } );
		props.onOpenChange( false );
	}, props.open );

	const remove = useAction( async () => {
		if ( c ) {
			await commands.ctRemoveF( c.id );
			await QUERY.invalidateQueries( { queryKey: KEYS.contacts() } );
		}
		props.onOpenChange( false );
	}, props.open );

	const busy = save.busy || remove.busy;

	// who gets paid is what the contact is for: a changed address is read in full before it counts
	if ( confirming && c ) {
		return (
			<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={T.contacts.changeTitle( c.name )} busy={busy}>
				<div className="warn-note"><TriangleAlert aria-hidden="true" /><span>{T.contacts.changeWarn( c.name )}</span></div>
				<div className="review-to">
					<span className="label">{T.contacts.before}</span>
					<UI_AddressLine address={c.address} />
				</div>
				<div className="review-to">
					<span className="label">{T.contacts.after}</span>
					<UI_AddressLine address={address} />
				</div>
				{save.error && <UI_Alert title={T.contacts.cantSave} message={save.error} />}
				<UI_SheetButtons busy={busy} onCancel={() => setConfirming( false )} cancel={T.common.back} action={{ label: T.contacts.changeAction, onRun: () => save.run(), running: save.busy }} />
			</UI_Sheet>
		);
	}

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={c ? T.contacts.editTitle : T.contacts.addTitle} busy={busy}>
			<div className="contact-form">
				<label className="label" htmlFor="contact-name">{T.contacts.name}</label>
				<input id="contact-name" className="field" value={name} maxLength={constants?.maxNameLen} autoFocus placeholder={T.contacts.namePlaceholder} onChange={( e ) => setName( e.target.value )} />

				<label className="label" htmlFor="contact-address">{T.contacts.address}</label>
				<textarea id="contact-address" className="field mono" rows={2} value={address} spellCheck={false} placeholder={T.send.toHint} onChange={( e ) => setAddress( e.target.value.replace( /\s+/g, "" ) )} />
				<div className="send-check" aria-live="polite">
					{check.checking && <UI_Waiting text={T.common.checking} size={11} />}
					{!check.checking && check.target && <UI_KindChip kind={check.target.kind} />}
					{!check.checking && check.error && <span className="send-bad">{check.error}</span>}
				</div>

				<label className="label" htmlFor="contact-note">{T.contacts.note}</label>
				<input id="contact-note" className="field" value={note} maxLength={constants?.noteMaxChars} placeholder={T.contacts.notePlaceholder} onChange={( e ) => setNote( e.target.value )} />
			</div>

			{save.error && <UI_Alert title={T.contacts.cantSave} message={save.error} />}
			{remove.error && <UI_Alert title={T.contacts.cantDelete} message={remove.error} />}

			{c && ( sure ? (
				<div className="warn-note contact-delete">
					<Trash2 aria-hidden="true" />
					<span>{T.contacts.deleteSure( c.name )}</span>
					<button className="btn danger small" disabled={busy} onClick={() => remove.run()}>{T.contacts.delete}</button>
				</div>
			) : (
				<button className="link quiet contact-delete-link" onClick={() => setSure( true )}><Trash2 aria-hidden="true" />{T.contacts.deleteContact}</button>
			) )}

			<UI_SheetButtons busy={busy} onCancel={() => props.onOpenChange( false )} action={{ label: T.contacts.save, onRun: () => { if ( addressChanged ) { setConfirming( true ); } else { save.run(); } }, running: save.busy }} />
		</UI_Sheet>
	);
}

/*
==================
UI_ContactRow
==================
*/
function UI_ContactRow( props: { contact: contact_t; onOpen: () => void } ) {
	const c = props.contact;
	return (
		<li>
			<button className="contact-row" onClick={props.onOpen}>
				<span className="contact-avatar" aria-hidden="true">{Com_Initials( c.name )}</span>
				<span className="contact-text">
					<span className="set-label">{c.name}</span>
					<span className="set-sub mono">{Com_Abbrev( c.address, 8 )}{c.note ? ` · ${c.note}` : ""}</span>
				</span>
				<span className="contact-side">
					<UI_KindChip kind={c.kind} />
					{c.lastPaid != null && <span className="contact-paid">{T.contacts.paid( Com_Ago( c.lastPaid ) )}</span>}
				</span>
			</button>
		</li>
	);
}

/*
==================
UI_ContactsSection

For Settings: the whole book, searchable, with Add
==================
*/
export function UI_ContactsSection() {
	const contacts = useContacts();
	const [ query, setQuery ]		= useState( "" );
	const [ editing, setEditing ]	= useState< contact_t | null >( null );
	const [ open, setOpen ]			= useState( false );

	const list = useMemo( () => {
		const q = query.trim().toLowerCase();
		return ( contacts.data ?? [] ).filter( ( c ) => !q || c.name.toLowerCase().includes( q ) || c.address.toLowerCase().includes( q ) || ( c.note ?? "" ).toLowerCase().includes( q ) );
	}, [ contacts.data, query ] );

	let body;
	if ( contacts.error ) {
		body = <UI_Alert title={T.contacts.cantLoad} message={Com_ErrorOf( contacts.error )} action={T.common.tryAgain} onAction={() => { contacts.refetch(); }} />;
	} else if ( !contacts.data ) {
		body = <div className="sheet-loading"><UI_Spinner size={16} /></div>;
	} else if ( contacts.data.length === 0 ) {
		body = (
			<div className="sheet-state contacts-empty">
				<span className="sheet-state-icon"><BookUser aria-hidden="true" /></span>
				<span className="sheet-state-title">{T.contacts.emptyTitle}</span>
				<span className="sheet-state-text">{T.contacts.empty}</span>
			</div>
		);
	} else {
		body = (
			<>
				{contacts.data.length > 5 && (
					<label className="history-search">
						<Search aria-hidden="true" />
						<input value={query} placeholder={T.contacts.search} spellCheck={false} onChange={( e ) => setQuery( e.target.value )} />
					</label>
				)}
				<ul className="pool-list contact-list">
					{list.map( ( c ) => <UI_ContactRow key={c.id} contact={c} onOpen={() => { setEditing( c ); setOpen( true ); }} /> )}
				</ul>
				{list.length === 0 && <p className="hint">{T.contacts.noMatch}</p>}
			</>
		);
	}

	return (
		<section className="settings-section">
			<div className="section-head">
				{contacts.data && contacts.data.length > 0 && <h2 className="section-title">{T.contacts.count( contacts.data.length )}</h2>}
				<button className="btn small" onClick={() => { setEditing( null ); setOpen( true ); }}><Plus aria-hidden="true" />{T.contacts.add}</button>
			</div>
			{body}
			<UI_ContactSheet open={open} onOpenChange={setOpen} contact={editing} />
		</section>
	);
}

/*
==================
UI_PayeeMenu

For Send's To field: the person's other accounts, then the address book.
An account is paid at its newest private address, asked of the engine
when chosen.
==================
*/
export function UI_PayeeMenu( props: { walletId: string; account: number; onPick: ( address: string, label: string ) => void; onManage: () => void } ) {
	const wallets	= useStore( ( s ) => s.wallets );
	const order		= useStore( ( s ) => s.order );
	const contacts	= useContacts();

	const own: { wallet: walletSummary_t; index: number; name: string }[] = order
		.map( ( id ) => wallets[id] )
		.filter( ( w ): w is walletSummary_t => !!w )
		.flatMap( ( w ) => w.accounts.map( ( a ) => ( { wallet: w, index: a.index, name: a.name } ) ) )
		.filter( ( a ) => !( a.wallet.id === props.walletId && a.index === props.account ) );

	// action, not a load: the person just chose this account
	const pickOwn = useAction( async ( walletId: string, index: number, label: string ) => {
		const r = await commands.wReceiveF( walletId, index, null );
		props.onPick( r.shielded, label );
	} );

	return (
		<Menu.Root>
			<Menu.Trigger className="btn small" disabled={pickOwn.busy}>
				{pickOwn.busy ? <UI_Spinner size={12} /> : <UserRound aria-hidden="true" />}{T.contacts.choose}<ChevronDown aria-hidden="true" />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Content className="menu payee-menu" align="end" sideOffset={6}>
					{own.length > 0 && <Menu.Label className="menu-group-head">{T.contacts.yourAccounts}</Menu.Label>}
					{own.map( ( a ) => {
						const label = `${a.name} · ${a.wallet.name}`;
						return (
							<Menu.Item key={`${a.wallet.id}:${a.index}`} className="menu-item" onSelect={() => { pickOwn.run( a.wallet.id, a.index, label ); }}>
								<WalletCards aria-hidden="true" /><span className="menu-text">{a.name}<span className="menu-sub">{a.wallet.name}</span></span>
							</Menu.Item>
						);
					} )}
					{own.length > 0 && <Menu.Separator className="menu-sep" />}
					<Menu.Label className="menu-group-head">{T.contacts.title}</Menu.Label>
					{( contacts.data ?? [] ).map( ( c ) => (
						<Menu.Item key={c.id} className="menu-item" onSelect={() => props.onPick( c.address, c.name )}>
							<span className="contact-avatar small" aria-hidden="true">{Com_Initials( c.name )}</span>
							<span className="menu-text">{c.name}<span className="menu-sub mono">{Com_Abbrev( c.address, 6 )}</span></span>
						</Menu.Item>
					) )}
					{contacts.data?.length === 0 && <div className="menu-empty">{T.contacts.menuEmpty}</div>}
					<Menu.Separator className="menu-sep" />
					<Menu.Item className="menu-item" onSelect={props.onManage}>
						<BookUser aria-hidden="true" /><span className="menu-text">{T.contacts.manage}</span>
					</Menu.Item>
				</Menu.Content>
			</Menu.Portal>
			{pickOwn.error && <span className="send-bad">{pickOwn.error.message}</span>}
		</Menu.Root>
	);
}
