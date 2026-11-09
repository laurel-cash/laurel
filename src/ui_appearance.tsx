/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_appearance.tsx -- Settings > General: light, dark or as the system
// is, and the text size. Lived in ui_security.tsx, which is about the key.

import { appearance_t } from "./ui_local";
import { T } from "./ui_text";
import { useAppSettings } from "./ui_hooks";
import { useStore } from "./ui_store";
import { UI_Alert, UI_Segmented } from "./ui_widgets";

const THEMES: { value: appearance_t; label: string }[] = [
	{ value: "system",	label: T.appearance.system },
	{ value: "light",	label: T.appearance.light },
	{ value: "dark",	label: T.appearance.dark },
];

/*
==================
UI_AppearanceSection

Light, dark, or as the system is, each shown as a small picture of Laurel
==================
*/
export function UI_AppearanceSection() {
	const appearance	= useStore( ( s ) => s.appearance );
	const setAppearance	= useStore( ( s ) => s.SetAppearance );
	const constants		= useStore( ( s ) => s.constants );
	const { settings, save } = useAppSettings();

	return (
		<section className="settings-section">
			<h2 className="section-title">{T.appearance.title}</h2>
			<div className="theme-picker" role="radiogroup" aria-label={T.appearance.title}>
				{THEMES.map( ( t ) => (
					<button key={t.value} role="radio" aria-checked={appearance === t.value} className={"theme-choice" + ( appearance === t.value ? " on" : "" )} onClick={() => setAppearance( t.value )}>
						<span className={"theme-preview tp-" + t.value} aria-hidden="true">
							<span className="tp-side" />
							<span className="tp-main"><span className="tp-card" /><span className="tp-line" /><span className="tp-line short" /></span>
						</span>
						<span className="theme-label">{t.label}</span>
					</button>
				) )}
			</div>
			<p className="hint">{T.appearance.hint}</p>

			<h2 className="section-title">{T.appearance.textSize}</h2>
			{settings && (
				<UI_Segmented
					id="text-size"
					value={settings.textScale}
					onChange={( textScale ) => void save.run( { textScale } )}
					options={( constants?.textScales ?? [] ).map( ( s ) => ( { value: s, label: T.appearance.scale( s ) } ) )}
				/>
			)}
			<p className="hint">{T.appearance.textHint}</p>
			{save.error && <UI_Alert title={T.common.cantSaveSetting} message={save.error} />}
		</section>
	);
}
