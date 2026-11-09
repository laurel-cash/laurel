/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_server.tsx -- which Zcash server Laurel talks to: chosen automatically,
// or the person's own (src-tauri/src/w_server.rs decides and checks)

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Server } from "lucide-react";

import { Com_ErrorString, commands, network_t, serverStatus_t } from "./ui_local";
import { Com_NetworkName, T } from "./ui_text";
import { KEYS, QUERY } from "./ui_query";
import { useAction } from "./ui_hooks";
import { useStore } from "./ui_store";
import { SECRET_FIELD, sheetProps_t, UI_Alert, UI_Info, UI_Segmented, UI_Sheet, UI_SheetButtons, UI_Spinner } from "./ui_widgets";

type serverMode_t = "auto" | "own";

const MODES = [
	{ value: "auto",	label: T.server.automatic },
	{ value: "own",		label: T.server.own },
] as const;

const NETWORKS = [
	{ value: "testnet",	label: Com_NetworkName( "testnet" ) },
	{ value: "mainnet",	label: Com_NetworkName( "mainnet" ) },
] as const;

/*
==================
UI_NetworkSwitchSheet

Before Laurel moves to the other network: what changes, what stays, and
for mainnet that it's real money in software not yet audited, said and
acknowledged. The switch closes this network's wallets and starts over.
==================
*/
function UI_NetworkSwitchSheet( props: sheetProps_t & { to: network_t } ) {
	const mainnet = props.to === "mainnet";
	const [ understood, setUnderstood ]	= useState( false );
	const [ nudge, setNudge ]			= useState( false );

	useEffect( () => {
		if ( props.open ) {
			setUnderstood( false );
			setNudge( false );
		}
	}, [ props.open ] );

	const change = useAction( async () => {
		await commands.wSetNetworkF( props.to );
		QUERY.clear();
		location.reload();		// starts over on the other network, as a launch does
	}, props.open );

	function Switch() {
		if ( mainnet && !understood ) {
			setNudge( true );		// never a silently grey button: say what's missing
			return;
		}
		change.run();
	}

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={T.network.switchTitle( Com_NetworkName( props.to ) )} busy={change.busy}>
			<p className="sheet-desc">{mainnet ? T.network.toMainnet : T.network.toTestnet}</p>
			<p className="hint">{T.network.stays}</p>
			{mainnet && (
				<label className={"check-row" + ( nudge && !understood ? " nudge" : "" )}>
					<input type="checkbox" checked={understood} onChange={( e ) => { setUnderstood( e.target.checked ); setNudge( false ); }} />
					<span>{T.network.understand}</span>
				</label>
			)}
			{nudge && !understood && <p className="hint bad">{T.network.understandFirst}</p>}
			{change.error && <UI_Alert title={T.network.cantSwitch} message={change.error} />}
			<UI_SheetButtons busy={change.busy} onCancel={() => props.onOpenChange( false )} action={{ label: T.network.switchAction( Com_NetworkName( props.to ) ), onRun: Switch, danger: false }} />
		</UI_Sheet>
	);
}

/*
==================
UI_NetworkChoice

Which network Laurel is on. Each keeps its own wallets, address book and
server choice; only one is open at a time. A build that opens one network
(the Play beta's, testnet alone) says so instead of offering a choice
==================
*/
export function UI_NetworkChoice() {
	const network = useStore( ( s ) => s.network );
	const offered = useStore( ( s ) => s.constants?.networks );
	const options = NETWORKS.filter( ( n ) => !offered || offered.includes( n.value ) );
	const [ to, setTo ]		= useState< network_t | null >( null );
	const [ open, setOpen ]	= useState( false );

	return (
		<section className="settings-section">
			{options.length > 1 && <UI_Segmented options={options} value={network} onChange={( n ) => { if ( n !== network ) { setTo( n ); setOpen( true ); } }} full />}
			<p className="hint">{options.length > 1 ? ( network === "mainnet" ? T.network.onMainnet : T.network.onTestnet ) : T.network.testOnly}</p>
			{to && <UI_NetworkSwitchSheet open={open} onOpenChange={setOpen} to={to} />}
		</section>
	);
}

/*
==================
Com_ServerLine

Where the wallets connect now, as a person reads it: the host, and how
quickly it answered
==================
*/
function Com_ServerLine( s: serverStatus_t ): string {
	if ( !s.current ) {
		return T.server.notYet;
	}
	const host = new URL( s.current ).host;
	return s.latencyMs != null ? T.server.line( host, s.latencyMs ) : host;
}

/*
==================
UI_ServerSheet
==================
*/
function UI_ServerSheet( props: sheetProps_t & { status: serverStatus_t } ) {
	const [ mode, setMode ] = useState< serverMode_t >( "auto" );
	const [ text, setText ] = useState( "" );

	const save = useAction( async () => {
		QUERY.setQueryData( KEYS.server(), await commands.wSetServerF( mode === "own" ? text : null ) );
		props.onOpenChange( false );
	}, props.open );

	useEffect( () => {
		if ( props.open ) {
			setMode( props.status.own ? "own" : "auto" );
			setText( props.status.own ?? "" );
		}
	}, [ props.open ] );

	let label;
	if ( mode === "auto" ) {
		label = T.server.useAuto;
	} else {
		label = save.busy ? T.common.checking : T.server.useOwn;
	}

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={T.server.sheetTitle} busy={save.busy}>
			<UI_Segmented options={MODES} value={mode} onChange={( m ) => { setMode( m ); save.setError( null ); }} full />
			{mode === "auto" ? (
				<p className="sheet-desc">{T.server.autoDesc}</p>
			) : (
				<>
					<p className="sheet-desc">{T.server.ownDesc}</p>
					<label className="label" htmlFor="server-uri">{T.server.address}</label>
					<input
						id="server-uri" className="field mono" value={text} placeholder={T.server.placeholder}
						{...SECRET_FIELD}
						onChange={( e ) => setText( e.target.value )}
						onKeyDown={( e ) => { if ( e.key === "Enter" ) save.run(); }}
					/>
				</>
			)}
			<p className="hint server-privacy">{T.server.privacy}</p>
			{save.error && <UI_Alert title={T.server.failed} message={save.error} />}
			<UI_SheetButtons busy={save.busy} onCancel={() => props.onOpenChange( false )} action={{ label: label, onRun: () => save.run() }} />
		</UI_Sheet>
	);
}

/*
==================
UI_ServerSection
==================
*/
export function UI_ServerSection() {
	const [ open, setOpen ] = useState( false );
	const status = useQuery( { queryKey: KEYS.server(), queryFn: () => commands.wServerStatusF(), refetchOnMount: "always" } );

	let sub;
	if ( status.error ) {
		sub = Com_ErrorString( status.error );
	} else if ( !status.data ) {
		sub = <UI_Spinner size={12} />;
	} else {
		sub = Com_ServerLine( status.data );
	}

	return (
		<section className="settings-section">
			<h2 className="section-title">{T.server.title} <UI_Info title={T.server.whatTitle}>{T.server.what}</UI_Info></h2>
			<ul className="pool-list settings-list">
				<li className="set-row">
					<span className="set-icon"><Server aria-hidden="true" /></span>
					<span className="set-text">
						<span className="set-label">{status.data?.own ? T.server.own : T.server.automatic}</span>
						<span className="set-sub">{sub}</span>
					</span>
					<span className="set-actions">
						<button className="btn" onClick={() => status.data ? setOpen( true ) : status.refetch()}>{status.data ? T.server.change : T.common.tryAgain}</button>
					</span>
				</li>
			</ul>
			{status.data && <UI_ServerSheet open={open} onOpenChange={setOpen} status={status.data} />}
		</section>
	);
}
