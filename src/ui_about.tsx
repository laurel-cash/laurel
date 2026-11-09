/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_about.tsx -- what Laurel is, its license, and the notices of the
// open-source software it's built from (scripts/make_notices.mjs)

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, FileText, Scale, Search, Sparkles } from "lucide-react";

import { APP_VERSION, Com_ErrorOf } from "./ui_local";
import { T } from "./ui_text";
import { sheetProps_t, UI_Alert, UI_Sheet, UI_SheetClose, UI_Spinner } from "./ui_widgets";
import { UI_AppIcon } from "./ui_chrome";
import { UI_ReleaseNotesSheet } from "./ui_notes";
import LAUREL_LICENSE from "../LICENSE?raw";

type notice_t	= { name: string; version: string; license: string; kind: "rust" | "ui"; text: number | null };
type notices_t	= { packages: notice_t[]; texts: string[] };


/*
==================
UI_LicensesSheet

Every package, searchable; one opens to its full license text. The
notices load only when the sheet opens: half a megabyte nobody needs
until they look.
==================
*/
function UI_LicensesSheet( props: sheetProps_t ) {
	const [ query, setQuery ]	= useState( "" );
	const [ shown, setShown ]	= useState< notice_t | null >( null );

	const notices = useQuery( {
		queryKey:	[ "notices" ],
		queryFn:	async () => ( await import( "./generated/notices.json" ) ).default as notices_t,
		enabled:	props.open,
	} );

	const list = useMemo( () => {
		const q = query.trim().toLowerCase();
		return ( notices.data?.packages ?? [] ).filter( ( p ) => !q || p.name.toLowerCase().includes( q ) || p.license.toLowerCase().includes( q ) );
	}, [ notices.data, query ] );

	let body;
	if ( notices.error ) {
		body = <UI_Alert title={T.about.failed} message={Com_ErrorOf( notices.error )} />;
	} else if ( !notices.data ) {
		body = <div className="sheet-loading"><UI_Spinner size={18} /></div>;
	} else if ( shown ) {
		body = (
			<div className="license-text">
				<button className="link small" onClick={() => setShown( null )}><ChevronLeft aria-hidden="true" />{T.about.allLicenses}</button>
				<h3 className="license-name">{shown.name} {shown.version}</h3>
				<p className="hint">{shown.license}</p>
				<pre>{shown.text != null ? notices.data.texts[shown.text] : shown.license}</pre>
			</div>
		);
	} else {
		body = (
			<>
				<p className="sheet-desc">{T.about.licensesLede( notices.data.packages.length )}</p>
				<label className="history-search">
					<Search aria-hidden="true" />
					<input value={query} placeholder={T.about.search} spellCheck={false} onChange={( e ) => setQuery( e.target.value )} />
				</label>
				<ul className="pool-list license-list">
					{list.map( ( p ) => (
						<li key={`${p.name}@${p.version}`}>
							<button className="license-row" onClick={() => setShown( p )}>
								<span className="set-label">{p.name}</span>
								<span className="set-sub">{p.version} · {p.license}</span>
							</button>
						</li>
					) )}
				</ul>
			</>
		);
	}

	return (
		<UI_Sheet open={props.open} onOpenChange={( o ) => { if ( !o ) setShown( null ); props.onOpenChange( o ); }} title={T.about.licenses}>
			{body}
			<UI_SheetClose onClose={() => props.onOpenChange( false )} primary />
		</UI_Sheet>
	);
}

/*
==================
UI_LaurelLicenseSheet
==================
*/
function UI_LaurelLicenseSheet( props: sheetProps_t ) {
	return (
		<UI_Sheet open={props.open} onOpenChange={props.onOpenChange} title={T.about.laurelLicense}>
			<div className="license-text"><pre>{LAUREL_LICENSE}</pre></div>
			<UI_SheetClose onClose={() => props.onOpenChange( false )} primary />
		</UI_Sheet>
	);
}

/*
==================
UI_AboutSection
==================
*/
export function UI_AboutSection() {
	const [ open, setOpen ] = useState< "none" | "licenses" | "laurel" | "notes" >( "none" );

	return (
		<section className="settings-section">
			<div className="about">
				<UI_AppIcon size={56} />
				<div className="about-text">
					<div className="about-name">{T.common.appName} <span className="about-version">{APP_VERSION}</span></div>
					<div className="set-sub">{T.about.tagline}</div>
				</div>
			</div>
			<p className="hint">{T.about.publisher}</p>
			<ul className="pool-list settings-list">
				<li className="set-row">
					<span className="set-icon"><Sparkles aria-hidden="true" /></span>
					<span className="set-text">
						<span className="set-label">{T.about.notes}</span>
						<span className="set-sub">{T.about.notesHint}</span>
					</span>
					<span className="set-actions"><button className="btn" onClick={() => setOpen( "notes" )}>{T.about.read}</button></span>
				</li>
				<li className="set-row">
					<span className="set-icon"><Scale aria-hidden="true" /></span>
					<span className="set-text">
						<span className="set-label">{T.about.laurelLicense}</span>
						<span className="set-sub">{T.about.laurelLicenseHint}</span>
					</span>
					<span className="set-actions"><button className="btn" onClick={() => setOpen( "laurel" )}>{T.about.read}</button></span>
				</li>
				<li className="set-row">
					<span className="set-icon"><FileText aria-hidden="true" /></span>
					<span className="set-text">
						<span className="set-label">{T.about.licenses}</span>
						<span className="set-sub">{T.about.licensesHint}</span>
					</span>
					<span className="set-actions"><button className="btn" onClick={() => setOpen( "licenses" )}>{T.about.read}</button></span>
				</li>
			</ul>
			<UI_LicensesSheet open={open === "licenses"} onOpenChange={( o ) => setOpen( o ? "licenses" : "none" )} />
			<UI_LaurelLicenseSheet open={open === "laurel"} onOpenChange={( o ) => setOpen( o ? "laurel" : "none" )} />
			<UI_ReleaseNotesSheet open={open === "notes"} onOpenChange={( o ) => setOpen( o ? "notes" : "none" )} />
		</section>
	);
}
