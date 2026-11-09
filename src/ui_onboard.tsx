/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_onboard.tsx -- first run: the welcome screen

import { KeyRound, ShieldCheck, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { commands, created_t } from "./ui_local";
import { T } from "./ui_text";
import { useAction } from "./ui_hooks";
import { useStore } from "./ui_store";
import { UI_Alert, UI_Waiting } from "./ui_widgets";
import { UI_AppIcon } from "./ui_chrome";

// the welcome's points, in order; their words are T.welcome.features
const FEATURES = [ "shield", "zap", "key" ] as const;
const FEATURE_ICONS: Record< typeof FEATURES[number], LucideIcon > = {
	shield:	ShieldCheck,
	zap:	Zap,
	key:	KeyRound,
};


/*
==================
UI_Welcome
==================
*/
export function UI_Welcome( props: { onCreated: ( c: created_t ) => void; onRestore: () => void } ) {
	const defaultName = useStore( ( s ) => s.constants?.defaultWalletName ?? "" );
	const refresh = useStore( ( s ) => s.Refresh );
	const network = useStore( ( s ) => s.network );

	const create = useAction( async () => {
		const created = await commands.wCreateF( network, defaultName );
		await refresh();
		props.onCreated( created );
	} );

	return (
		<div className="onboard">
			<div className="onboard-card">
				<UI_AppIcon size={88} />
				<h1 className="onboard-title">{T.welcome.title}</h1>
				{network === "testnet" && <span className="pill">{T.common.testnetPill}</span>}

				<ul className="features">
					{FEATURES.map( ( key ) => {
						const Icon = FEATURE_ICONS[key];
						const f = T.welcome.features[key];
						return (
							<li key={key}>
								<Icon className="feature-icon" aria-hidden="true" />
								<div>
									<div className="feature-title">{f.title}</div>
									<div className="feature-text">{f.text}</div>
								</div>
							</li>
						);
					} )}
				</ul>

				{create.error && (
					<UI_Alert title={T.welcome.createFailed} message={create.error} action={T.common.tryAgain} onAction={create.run} />
				)}

				<div className="onboard-actions">
					<button className="btn primary large" disabled={create.busy} onClick={create.run}>
						{create.busy ? <><UI_Waiting text={T.welcome.creating} size={16} /></> : T.welcome.create}
					</button>
					<button className="link" disabled={create.busy} onClick={props.onRestore}>{T.welcome.restore}</button>
				</div>
				<p className="status">{create.busy ? T.welcome.contacting : " "}</p>
			</div>
		</div>
	);
}
