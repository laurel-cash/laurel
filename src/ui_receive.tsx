/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_receive.tsx -- getting paid: the receive sheet with QR codes, the
// fund sheet (testnet faucets for now), and the honest "not yet" sheet

import { ReactNode, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, ChevronDown, ExternalLink, KeyRound, Layers, ReceiptText, RefreshCw, TriangleAlert } from "lucide-react";

import { addressKind_t, Com_Abbrev, Com_AddressPool, Com_ErrorOf, Com_FormatZec, Com_ParseZec, commands, Com_Unreachable, freshAddress_t, receive_t } from "./ui_local";
import { UI_PoolBadge } from "./ui_pool";
import { T } from "./ui_text";
import { useStore } from "./ui_store";
import { useQuery } from "@tanstack/react-query";
import { useAction } from "./ui_hooks";
import { KEYS, QUERY } from "./ui_query";
import { sheetProps_t, UI_ActionTile, UI_Alert, UI_CopyButton, UI_Info, UI_Sheet, UI_SheetClose, UI_Spinner, UI_Tip, UI_Waiting } from "./ui_widgets";
import { UI_QR } from "./ui_chrome";
import { UI_AmountHint, UI_MemoField } from "./ui_payment";

// testnet faucets: names and addresses of other people's sites, not Laurel's words to translate
const FAUCETS = [
	{ name: "Fauzec",				by: "fauzec.com",	url: "https://fauzec.com/" },		// first: it paid Laurel's unified and Sapling addresses (2026-10-29); jinolabs answers again, no drip tried
	{ name: "Zcash Testnet Faucet",	by: "jinolabs",		url: "https://zcashfaucet.jinolabs.xyz/" },
] as const;

const QR_SIZE		= 232;
const SHORT_EDGE	= 14;		// characters kept at each end of a shortened address



/*
==================
UI_AddressLine

An address, shortened until clicked; the chevron says it opens
==================
*/
export function UI_AddressLine( props: { address: string } ) {
	const [ full, setFull ] = useState( false );

	useEffect( () => setFull( false ), [ props.address ] );

	// short enough to read whole: plain, selectable text, no button that does nothing
	if ( Com_Abbrev( props.address ) === props.address ) {
		return <span className="address-text whole">{props.address}</span>;
	}

	return (
		<UI_Tip label={full ? T.receive.showLess : T.receive.showFull} side="top">
			<button className={"address-text" + ( full ? " full" : "" )} aria-expanded={full} onClick={() => setFull( !full )}>
				<span>{full ? props.address : Com_Abbrev( props.address, SHORT_EDGE )}</span>
				<ChevronDown className="address-chevron" aria-hidden="true" />
			</button>
		</UI_Tip>
	);
}

/*
==================
UI_AddressCard

The QR, the address and copy
==================
*/
function UI_AddressCard( props: { address: string } ) {
	return (
		<div className="address-card">
			<div className="qr-frame"><UI_QR text={props.address} size={QR_SIZE} /></div>
			<UI_AddressLine address={props.address} />
			<UI_CopyButton text={props.address} />
		</div>
	);
}

/*
==================
UI_Request

A payment request for this account (ZIP-321): the amount, a memo on the
shielded sides, then the request as a QR and to copy. The engine builds
it from the account's own address (W_Request): nothing here names one.
==================
*/
function UI_Request( props: { walletId: string; account: number; to: addressKind_t; onBack: () => void } ) {
	const [ text, setText ]		= useState( "" );
	const [ memo, setMemo ]		= useState( "" );
	const [ nudge, setNudge ]	= useState( false );
	const [ made, setMade ]		= useState< { uri: string; zats: number } | null >( null );
	const amount = text.trim() ? Com_ParseZec( text ) : null;

	// action, not a load: it reads what was just typed
	const make = useAction( async ( zats: number ) => {
		setMade( { uri: await commands.wRequestF( props.walletId, props.account, props.to, zats, props.to === "public" ? null : memo || null ), zats: zats } );
	} );
	function Make() {
		setNudge( amount?.kind !== "ok" );
		if ( amount?.kind === "ok" ) {
			void make.run( amount.zats );
		}
	}

	if ( made ) {
		return (
			<>
				<p className="sheet-desc">{T.receive.requestFor( `${Com_FormatZec( made.zats )} ${T.common.zec}` )}</p>
				<div className="address-card">
					<div className="qr-frame"><UI_QR text={made.uri} size={QR_SIZE} /></div>
					<UI_CopyButton text={made.uri} label={T.receive.copyRequest} />
				</div>
				<div className="receive-new">
					<button className="link" onClick={() => setMade( null )}>{T.receive.changeRequest}</button>
				</div>
			</>
		);
	}

	return (
		<>
			<p className="sheet-desc">{T.receive.requestLede}</p>
			<label className="label" htmlFor="request-amount">{T.send.amount}</label>
			<div className={"send-amount" + ( nudge || ( amount && amount.kind !== "ok" ) ? " bad" : "" )}>
				<input id="request-amount" inputMode="decimal" placeholder="0.00" value={text} autoFocus onChange={( e ) => { setText( e.target.value ); setNudge( false ); }} onKeyDown={( e ) => { if ( e.key === "Enter" ) Make(); }} />
				<span className="send-unit">{T.common.zec}</span>
			</div>
			<UI_AmountHint text={text} amount={amount} onPick={setText} />
			{nudge && !amount && <p className="hint bad">{T.receive.noAmount}</p>}
			{props.to !== "public" && <UI_MemoField id="request-memo" value={memo} placeholder={T.receive.requestMemoHint} onChange={setMemo} />}
			{make.error && <UI_Alert title={T.receive.requestFailed} message={make.error} />}
			<div className="request-actions">
				<button className="btn" onClick={props.onBack}>{T.common.back}</button>
				<button className="btn primary" disabled={make.busy} onClick={Make}>{make.busy ? <UI_Spinner size={12} /> : null}{T.receive.makeRequest}</button>
			</div>
		</>
	);
}

/*
==================
UI_KindChooser

The kinds of address an account gives, as three cards: each its pool's
badge (UI_PoolBadge, the pool it pays into: Com_AddressPool), its name, a
short tag (the public one's in the warning colour), and the private one
marked Recommended. What each is for, in
full, is in its (i)
==================
*/
const KINDS: readonly addressKind_t[] = [ "private", "sapling", "public" ];

function Com_KindInfo( kind: addressKind_t ): ReactNode {
	switch ( kind ) {
	case "private":	return T.receive.privateLede;
	case "sapling":	return T.receive.saplingLede;
	case "public":	return <>{T.receive.publicLede} {T.receive.publicWarn}</>;
	default:		return Com_Unreachable( kind );
	}
}

function UI_KindChooser( props: { current: addressKind_t; onPick: ( kind: addressKind_t ) => void } ) {
	return (
		<>
			<p className="sheet-desc">{T.receive.choose}</p>
			<ul className="kind-list">
				{KINDS.map( ( k ) => (
					<li key={k} className={"kind-row" + ( k === props.current ? " current" : "" )}>
						<button className="kind-pick" aria-current={k === props.current} onClick={() => props.onPick( k )}>
							<UI_PoolBadge pool={Com_AddressPool( k )} />
							<span className="kind-text">
								<span className="kind-name">{T.receive[k]}</span>
								<span className={"kind-tag" + ( k === "public" ? " warn" : "" )}>{T.receive.kinds[k]}</span>
							</span>
							{k === "private" && <span className="kind-mark good">{T.receive.recommended}</span>}
							{k === props.current && <Check className="kind-check" aria-hidden="true" />}
						</button>
						<UI_Info title={T.receive.about( T.receive[k] )}>{Com_KindInfo( k )}</UI_Info>
					</li>
				) )}
			</ul>
		</>
	);
}

/*
==================
UI_ReceiveSheet

One address, then a row of tiles for what else can be done with it: a
new one, a request for an amount, another kind (UI_KindChooser). The
private address is where it opens; a pool asking for its own kind opens
straight on that one
==================
*/
type receiveView_t = "address" | "request" | "choose";

export function UI_ReceiveSheet( props: sheetProps_t & {
	walletId:		string;
	account:		number;
	accountName:	string;
	side?:			addressKind_t;		// the side it opens on (a pool asks for its own); private otherwise
	onSweep:		() => void;		// money at a single private key comes in through here too
} ) {
	const [ side, setSide ] = useState< addressKind_t >( props.side ?? "private" );
	const [ view, setView ] = useState< receiveView_t >( "address" );

	const key = KEYS.receive( props.walletId, props.account );
	const load = useQuery( {
		queryKey:	key,
		queryFn:	() => commands.wReceiveF( props.walletId, props.account, null ),
		enabled:	props.open,
	} );
	const addr: receive_t | null = load.data ?? null;

	// a new address belongs to the account it was made for, even if the sheet has moved on
	const fresh = useAction( async ( which: freshAddress_t ) => {
		const made = await commands.wReceiveF( props.walletId, props.account, which );
		QUERY.setQueryData( key, made );
	}, props.open );

	useEffect( () => {
		if ( props.open ) {
			setSide( props.side ?? "private" );
			setView( "address" );
		}
	}, [ props.open, props.walletId, props.account, props.side ] );

	// what this side gives, when the account has one to give
	const given = addr && { private: addr.shielded, sapling: addr.sapling, public: addr.transparent }[side];

	// the tiles under an address: what can be done with it, then the other kinds. The
	// public address is never made new (one per account), but money at a key comes in there
	const tiles = (
		<div className="tile-grid three">
			{given && side !== "public" && (
				<UI_ActionTile
					icon={fresh.busy ? <UI_Spinner size={14} /> : <RefreshCw aria-hidden="true" />}
					title={T.receive.newAddress}
					sub={fresh.busy ? T.receive.tile.making : T.receive.tile.newAddress}
					onClick={fresh.busy ? undefined : () => fresh.run( side )}
					info={{ title: T.receive.newTitle, body: T.receive.newHint }}
				/>
			)}
			{given && <UI_ActionTile icon={<ReceiptText aria-hidden="true" />} title={T.receive.request} sub={T.receive.tile.request} onClick={() => setView( "request" )} />}
			{given && side === "public" && <UI_ActionTile icon={<KeyRound aria-hidden="true" />} title={T.receive.tile.sweep} sub={T.receive.tile.sweepSub} onClick={props.onSweep} />}
			<UI_ActionTile icon={<Layers aria-hidden="true" />} title={T.receive.others} sub={T.receive.tile.others[side]} onClick={() => setView( "choose" )} />
		</div>
	);

	let body;
	const error = load.error ? Com_ErrorOf( load.error ) : fresh.error;
	const requesting = !error && !!addr && view === "request" && !!given;
	if ( error ) {
		body = <UI_Alert title={T.receive.failed} message={error} action={T.common.tryAgain} onAction={() => { fresh.setError( null ); void load.refetch(); }} />;
	} else if ( !addr ) {
		body = <div className="sheet-loading"><UI_Waiting text={T.receive.loading} size={20} /></div>;
	} else if ( view === "choose" ) {
		body = <UI_KindChooser current={side} onPick={( k ) => { setSide( k ); setView( "address" ); }} />;
	} else if ( requesting ) {
		body = <UI_Request walletId={props.walletId} account={props.account} to={side} onBack={() => setView( "address" )} />;
	} else {
		// the private address with the sentence a beginner needs; another kind named by its
		// badge and tag, the sentences in its (i)
		body = (
			<>
				{side === "private" ? <p className="sheet-desc">{T.receive.privateLede}</p> : (
					<div className="receive-kind">
						<UI_PoolBadge pool={Com_AddressPool( side )} small />
						<span className="kind-name">{T.receive[side]}</span>
						<span className={"kind-tag" + ( side === "public" ? " warn" : "" )}>{T.receive.kinds[side]}</span>
						<UI_Info title={T.receive.about( T.receive[side] )}>{Com_KindInfo( side )}</UI_Info>
					</div>
				)}
				{side === "public" && given && <div className="warn-note"><TriangleAlert aria-hidden="true" /><span>{T.receive.publicWarn}</span></div>}
				{given ? <UI_AddressCard address={given} /> : <p className="sheet-desc">{side === "sapling" ? T.receive.noSapling : T.receive.noPublic}</p>}
				{tiles}
			</>
		);
	}

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={T.receive.title} description={props.accountName}>
			{body}
			{!requesting && (		// the request has its own Back beside Make Request: a Close under them was a row of its own
				<UI_SheetClose onClose={() => props.onOpenChange( false )}>
					{view === "choose" && <button className="btn" onClick={() => setView( "address" )}>{T.common.back}</button>}
				</UI_SheetClose>
			)}
		</UI_Sheet>
	);
}

/*
==================
UI_FundSheet

On testnet: free coins from a faucet. On mainnet buying comes later,
after the legal review, and the sheet says so rather than pretending.
==================
*/
export function UI_FundSheet( props: sheetProps_t & { onReceive: () => void } ) {
	const testnet = useStore( ( s ) => s.network ) === "testnet";

	return (
		<UI_Sheet
			open={props.open}
			onOpenChange={props.onOpenChange}
			title={testnet ? T.fund.title : T.fund.soonTitle}
			description={testnet ? T.fund.lede : T.fund.soon}
		>
			{testnet && (
				<>
					<div className="fund-steps">
						<button className="btn" onClick={props.onReceive}>{T.receive.copyNext}</button>
					</div>
					<ul className="link-list">
						{FAUCETS.map( ( f ) => (
							<li key={f.url}>
								<button className="link-row" onClick={() => openUrl( f.url )}>
									<span>
										<span className="link-row-title">{f.name}</span>
										<span className="link-row-sub">{f.by}</span>
									</span>
									<ExternalLink aria-hidden="true" />
								</button>
							</li>
						) )}
					</ul>
					<p className="hint">{T.fund.arrives}</p>
				</>
			)}
			<UI_SheetClose onClose={() => props.onOpenChange( false )} />
		</UI_Sheet>
	);
}

