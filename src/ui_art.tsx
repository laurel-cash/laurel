/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_art.tsx -- illustrations. inline svg, colored from css variables so
// they follow light and dark mode with the rest of the ui

/*
==================
UI_ArtGround

What every drawing stands on: the leaf gradient (url(#gradientId)) and
the shadow under the paper
==================
*/
function UI_ArtGround( props: { gradientId: string } ) {
	return (
		<>
			<defs>
				<linearGradient id={props.gradientId} x1="0" y1="0" x2="1" y2="1">
					<stop offset="0" stopColor="#3fd68a" />
					<stop offset="1" stopColor="#157a46" />
				</linearGradient>
			</defs>
			<ellipse cx="100" cy="130" rx="70" ry="6" className="art-shadow" />
		</>
	);
}

/*
==================
UI_ArtSheet

The sheet of paper a recovery phrase lives on, its shadow and the leaf
gradient (url(#gradientId)): shared by the backup and restore drawings.
typing: how many words are written back in (the rest faint, a cursor
after them); none, a plain written sheet.
==================
*/
function UI_ArtSheet( props: { tilt: number; gradientId: string; typing?: number } ) {
	const t = props.typing;
	return (
		<>
			<UI_ArtGround gradientId={props.gradientId} />
			<g transform={`rotate(${props.tilt} 100 70)`}>
				<rect x="50" y="14" width="100" height="112" rx="8" className="art-paper" />
				{[ 0, 1, 2, 3, 4, 5 ].map( ( i ) => (
					<g key={i} className={t != null && i >= t ? "art-faint" : undefined}>
						<rect x="62" y={32 + i * 14} width="8" height="4" rx="2" className="art-num" />
						<rect x="74" y={32 + i * 14} width={i % 2 ? 44 : 56} height="4" rx="2" className={t != null && i < t ? "art-line written" : "art-line"} />
					</g>
				) )}
				{t != null && <rect x="120" y={29 + t * 14} width="2" height="10" rx="1" className="art-cursor" />}
			</g>
		</>
	);
}

/*
==================
UI_ArtBackup

A sheet of paper with a phrase written on it, a pencil, and the leaf
==================
*/
export function UI_ArtBackup() {
	return (
		<svg className="art" width="200" height="140" viewBox="0 0 200 140" aria-hidden="true">
			<UI_ArtSheet tilt={-6} gradientId="artLeaf" />
			<g transform="translate(138 30) rotate(35)">
				<rect x="0" y="0" width="10" height="70" rx="2" className="art-pencil" />
				<rect x="0" y="0" width="10" height="10" rx="2" className="art-eraser" />
				<path d="M0 70 L5 82 L10 70 Z" className="art-tip" />
			</g>
			<circle cx="52" cy="112" r="20" fill="url(#artLeaf)" className="art-badge" />
			<path
				d="M60 102c-9 0-14 5-14 13 0 1 .2 2 .6 3 1.1-4 4-7.4 8.3-9.6-3.6 2.7-6 5.8-7.1 9.4 1 .3 1.9.4 2.9.4 6 0 9.6-6 9.3-16.2z"
				fill="#fff"
			/>
		</svg>
	);
}

/*
==================
UI_ArtRestore

The backup's sheet of paper again, tilted the other way: the first words
are written back in, the rest are being filled, and a leaf-green badge
turns back. The same drawing as UI_ArtBackup, so the two read as a pair.
==================
*/
export function UI_ArtRestore() {
	return (
		<svg className="art" width="200" height="140" viewBox="0 0 200 140" aria-hidden="true">
			<UI_ArtSheet tilt={6} gradientId="artRestore" typing={3} />
			<circle cx="148" cy="108" r="20" fill="url(#artRestore)" className="art-badge" />
			<g transform="translate(136 96)" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
				<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
				<path d="M3 3v5h5" />
			</g>
		</svg>
	);
}

/*
==================
UI_ArtWhen

A calendar page on the same paper as the phrase, its days in faint
lines, one of them ringed in the leaf green, and the leaf badge with a
magnifier: Laurel looking from that day on
==================
*/
export function UI_ArtWhen() {
	return (
		<svg className="art" width="200" height="140" viewBox="0 0 200 140" aria-hidden="true">
			<UI_ArtGround gradientId="artWhen" />
			<g transform="rotate(-5 100 70)">
				<rect x="50" y="14" width="100" height="112" rx="8" className="art-paper" />
				<path d="M50 22a8 8 0 0 1 8-8h84a8 8 0 0 1 8 8v12H50z" fill="url(#artWhen)" />
				<rect x="72" y="8" width="5" height="14" rx="2.5" className="art-num" />
				<rect x="123" y="8" width="5" height="14" rx="2.5" className="art-num" />
				{[ 0, 1, 2, 3 ].map( ( row ) => [ 0, 1, 2, 3, 4 ].map( ( col ) => (
					<rect key={row * 5 + col} x={60 + col * 17} y={46 + row * 18} width="12" height="10" rx="3" className={row * 5 + col > 15 ? "art-line art-faint" : "art-line"} />
				) ) )}
				<circle cx="83" cy="69" r="10" fill="none" stroke="url(#artWhen)" strokeWidth="2.5" />
			</g>
			<circle cx="150" cy="108" r="20" fill="url(#artWhen)" className="art-badge" />
			<g transform="translate(139 97)" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round">
				<circle cx="9.5" cy="9.5" r="6.5" />
				<path d="M14.5 14.5l5 5" />
			</g>
		</svg>
	);
}

/*
==================
UI_ArtDone

A check that draws itself
==================
*/
export function UI_ArtDone() {
	return (
		<svg className="art" width="96" height="96" viewBox="0 0 96 96" aria-hidden="true">
			<circle cx="48" cy="48" r="44" className="done-ring" />
			<path d="M29 49 L42 62 L67 35" className="done-check" />
		</svg>
	);
}

/*
==================
UI_ArtRule

The small round icons for the backup rules
==================
*/
export function UI_ArtRule( props: { kind: "paper" | "secret" | "noscreen" } ) {
	return (
		<svg className="rule-icon" viewBox="0 0 24 24" aria-hidden="true">
			{props.kind === "paper" && (
				<>
					<rect x="6" y="3" width="12" height="18" rx="2" />
					<path d="M9 8h6M9 12h6M9 16h4" />
				</>
			)}
			{props.kind === "secret" && (
				<>
					<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" />
					<circle cx="12" cy="12" r="2.5" />
					<path d="M4 20L20 4" />
				</>
			)}
			{props.kind === "noscreen" && (
				<>
					<rect x="4" y="6" width="16" height="12" rx="2" />
					<circle cx="12" cy="12" r="3" />
					<path d="M4 20L20 4" />
				</>
			)}
		</svg>
	);
}
