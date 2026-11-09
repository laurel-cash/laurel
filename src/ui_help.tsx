/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_help.tsx -- Help & Support: the questions people ask, answered in
// plain words, searchable; and where to ask more

import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, ExternalLink, Search } from "lucide-react";

import { T } from "./ui_text";
import { useAction } from "./ui_hooks";
import { UI_Alert } from "./ui_widgets";

// where each help link goes; their words are T.help.links
const HELP_LINKS = [
	{ key: "forum",		url: "https://forum.zcashcommunity.com/" },
	{ key: "docs",		url: "https://zcash.readthedocs.io/" },
	{ key: "engine",	url: "https://github.com/zingolabs/zingolib" },
] as const;

/*
==================
UI_HelpSection
==================
*/
export function UI_HelpSection() {
	const [ query, setQuery ]	= useState( "" );
	const [ open, setOpen ]		= useState< number | null >( null );
	const openLink = useAction( ( url: string ) => openUrl( url ) );

	const shown = useMemo( () => {
		const q = query.trim().toLowerCase();
		return T.help.topics
			.map( ( t, i ) => ( { ...t, i } ) )
			.filter( ( t ) => !q || t.q.toLowerCase().includes( q ) || t.a.toLowerCase().includes( q ) );
	}, [ query ] );

	return (
		<>
			<section className="settings-section">
				<label className="history-search">
					<Search aria-hidden="true" />
					<input value={query} placeholder={T.help.search} spellCheck={false} onChange={( e ) => setQuery( e.target.value )} />
				</label>
				<ul className="pool-list help-list">
					{shown.map( ( t ) => {
						const isOpen = open === t.i || ( query.trim() !== "" && shown.length === 1 );
						return (
							<li key={t.i} className={"help-item" + ( isOpen ? " open" : "" )}>
								<button className="help-q" aria-expanded={isOpen} onClick={() => setOpen( isOpen ? null : t.i )}>
									<span>{t.q}</span>
									<ChevronDown className="help-chevron" aria-hidden="true" />
								</button>
								{isOpen && <p className="help-a">{t.a}</p>}
							</li>
						);
					} )}
				</ul>
				{shown.length === 0 && <p className="hint">{T.help.noMatch}</p>}
			</section>

			<section className="settings-section">
				<h2 className="section-title">{T.help.moreTitle}</h2>
				<ul className="pool-list settings-list">
					{HELP_LINKS.map( ( l ) => (
						<li key={l.url} className="set-row">
							<span className="set-text">
								<span className="set-label">{T.help.links[l.key].name}</span>
								<span className="set-sub">{T.help.links[l.key].what}</span>
							</span>
							<span className="set-actions">
								<button className="btn" disabled={openLink.busy} onClick={() => { openLink.run( l.url ); }}>
									{T.help.open}<ExternalLink aria-hidden="true" />
								</button>
							</span>
						</li>
					) )}
				</ul>
				{openLink.error && <UI_Alert title={T.help.cantOpen} message={openLink.error} />}
				<p className="hint">{T.help.support}</p>
			</section>
		</>
	);
}
