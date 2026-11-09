/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_scan.tsx -- reading a Zcash QR code: from the camera, a picture,
// or pasted text. The image is decoded here (qr-scanner); what the text
// means is the engine's call (w_scan.rs).

import { useEffect, useRef, useState } from "react";
import QrScanner from "./ui_qr";
import { ArrowUpRight, ClipboardPaste, Eye, ImageUp, ScanLine, ShieldCheck, TriangleAlert } from "lucide-react";

import { addrKind_t, commands, Com_ErrorString, Com_MemoAsksForSecrets, scanned_t } from "./ui_local";
import { T } from "./ui_text";
import { useAction } from "./ui_hooks";
import { sheetProps_t, UI_Alert, UI_Amount, UI_CopyButton, UI_Sheet, UI_SheetButtons, UI_SheetClose, UI_Spinner, UI_Waiting } from "./ui_widgets";
import { UI_AddressLine } from "./ui_receive";
import { UI_PayList } from "./ui_pays";

type camera_t = { kind: "starting" } | { kind: "on" } | { kind: "none" } | { kind: "failed"; why: string };

const PUBLIC_KINDS: addrKind_t[] = [ "transparent", "tex" ];


/*
==================
UI_Camera

The live view; reports the first code it sees. Stops the camera as soon
as it unmounts, so the light never stays on.
==================
*/
function UI_Camera( props: { onCode: ( text: string ) => void } ) {
	const video = useRef< HTMLVideoElement >( null );
	const [ cam, setCam ] = useState< camera_t >( { kind: "starting" } );
	const onCode = useRef( props.onCode );
	onCode.current = props.onCode;

	useEffect( () => {
		let scanner: QrScanner | null = null;
		let dead = false;

		QrScanner.hasCamera().then( ( has ) => {
			if ( dead || !video.current ) {
				return;
			}
			if ( !has ) {
				setCam( { kind: "none" } );
				return;
			}
			scanner = new QrScanner( video.current, ( r ) => onCode.current( r.data ), { returnDetailedScanResult: true, preferredCamera: "environment", maxScansPerSecond: 8 } );
			scanner.start().then(
				() => !dead && setCam( { kind: "on" } ),
				( e: unknown ) => !dead && setCam( { kind: "failed", why: Com_ErrorString( e ) } ),
			);
		} ).catch( ( e: unknown ) => !dead && setCam( { kind: "failed", why: Com_ErrorString( e ) } ) );

		return () => {
			dead = true;
			scanner?.stop();
			scanner?.destroy();
		};
	}, [] );

	let note = null;
	switch ( cam.kind ) {
	case "starting":	note = <div className="scan-note"><UI_Waiting text={T.scan.starting} size={16} /></div>; break;
	case "none":		note = <div className="scan-note">{T.scan.noCamera}</div>; break;
	case "failed":		note = <div className="scan-note">{T.scan.cameraFailed( cam.why )}</div>; break;
	case "on":			break;
	}

	return (
		<div className={"scan-view " + cam.kind}>
			<video ref={video} className="scan-video" muted playsInline />
			{cam.kind === "on" && <span className="scan-frame"><ScanLine aria-hidden="true" /></span>}
			{note}
		</div>
	);
}

/*
==================
UI_ScanResult
==================
*/
function UI_ScanResult( props: { result: scanned_t; onAgain: () => void; onPay: ( r: scanned_t ) => void } ) {
	const r			= props.result;
	const kind		= T.scan.kinds[r.kind];
	const isPublic	= PUBLIC_KINDS.includes( r.kind );

	return (
		<div className="scan-result">
			<div className={"scan-kind" + ( isPublic ? " public" : "" )}>
				<span className="scan-kind-icon">{isPublic ? <Eye aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}</span>
				<span>
					<span className="scan-kind-title">{kind.title}</span>
					<span className="scan-kind-text">{kind.text}</span>
				</span>
			</div>

			<UI_AddressLine address={r.address} />

			{( r.amount !== null || r.label || r.message || r.memo ) && (
				<dl className="facts">
					{r.amount !== null && <div className="fact"><dt>{T.scan.amount}</dt><dd><UI_Amount zats={r.amount} unit /></dd></div>}
					{r.label && <div className="fact"><dt>{T.scan.from}</dt><dd>{r.label}</dd></div>}
					{r.message && <div className="fact"><dt>{T.scan.message}</dt><dd>{r.message}</dd></div>}
					{r.memo && <div className="fact"><dt>{T.scan.memo}</dt><dd>{r.memo}</dd></div>}
				</dl>
			)}
			{[ r.label, r.message, r.memo ].some( ( t ) => t != null && Com_MemoAsksForSecrets( t ) ) && (
				<div className="warn-note"><TriangleAlert aria-hidden="true" /><span>{T.memo.asksForSecrets}</span></div>
			)}
			<UI_PayList pays={r.also.map( ( p ) => ( { to: p.to, amount: p.zats, memo: p.memo } ) )} />
			<UI_SheetButtons busy={false} action={{ label: T.scan.pay, onRun: () => props.onPay( r ), icon: <ArrowUpRight aria-hidden="true" /> }}>
				<button className="btn" onClick={props.onAgain}>{T.scan.again}</button>
				<UI_CopyButton text={r.address} label={T.scan.copy} />
			</UI_SheetButtons>
		</div>
	);
}

/*
==================
UI_ScanSheet
==================
*/
export function UI_ScanSheet( props: sheetProps_t & { onPay: ( r: scanned_t ) => void } ) {
	const [ result, setResult ]	= useState< scanned_t | null >( null );
	const [ text, setText ]		= useState( "" );
	const [ round, setRound ]	= useState( 0 );		// a new camera session per "Scan Another"
	const file = useRef< HTMLInputElement >( null );

	// action, not a load: it reads what the person scanned or typed, not a wallet's data
	const parse = useAction( async ( code: string ) => {
		setResult( await commands.wParseScanF( code ) );
	}, props.open );

	const picture = useAction( async ( blob: Blob ) => {
		let code: string;
		try {
			code = ( await QrScanner.scanImage( blob, { returnDetailedScanResult: true } ) ).data;
		} catch ( e ) {
			console.warn( "QR image decode failed", e );
			throw T.scan.noCode;
		}
		await parse.run( code );
	}, props.open );

	const paste = useAction( async () => {
		const clip = await navigator.clipboard.readText();
		setText( clip );
		if ( clip.trim() ) {
			await parse.run( clip );
		}
	}, props.open );

	function Again() {
		setResult( null );
		setText( "" );
		parse.setError( null );
		picture.setError( null );
		paste.setError( null );
		setRound( round + 1 );
	}

	useEffect( () => {
		if ( props.open ) {
			Again();
		}
	}, [ props.open ] );

	function Drop( e: React.DragEvent ) {
		const f = e.dataTransfer.files[0];
		if ( f && f.type.startsWith( "image/" ) ) {
			e.preventDefault();
			picture.run( f );
		}
	}

	const error = parse.error ?? picture.error ?? paste.error;

	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={T.scan.title} description={result ? undefined : T.scan.lede}>
			{result ? (
				<UI_ScanResult result={result} onAgain={Again} onPay={props.onPay} />
			) : (
				<div onDragOver={( e ) => e.preventDefault()} onDrop={Drop}>
					{parse.busy ? <div className="scan-view"><div className="scan-note"><UI_Spinner size={16} /></div></div> : <UI_Camera key={round} onCode={parse.run} />}

					{error && <UI_Alert title={T.scan.failed} message={error} />}

					<div className="scan-other">
						<button className="btn" onClick={() => file.current?.click()}>
							{picture.busy ? <UI_Spinner size={13} /> : <ImageUp aria-hidden="true" />} {T.scan.image}
						</button>
						<button className="btn" onClick={paste.run}><ClipboardPaste aria-hidden="true" /> {T.scan.paste}</button>
						<input
							ref={file}
							type="file"
							accept="image/*"
							hidden
							onChange={( e ) => { const f = e.target.files?.[0]; e.target.value = ""; if ( f ) picture.run( f ); }}
						/>
					</div>
					<div className="scan-type">
						<input
							className="field mono"
							placeholder={T.scan.pasteHint}
							value={text}
							spellCheck={false}
							onChange={( e ) => setText( e.target.value )}
							onKeyDown={( e ) => { if ( e.key === "Enter" && text.trim() ) parse.run( text ); }}
						/>
						{text.trim() && <button className="btn primary" disabled={parse.busy} onClick={() => parse.run( text )}>{T.scan.read}</button>}
					</div>
					<UI_SheetClose onClose={() => props.onOpenChange( false )} />
				</div>
			)}
		</UI_Sheet>
	);
}
