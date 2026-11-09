/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_documents.tsx -- a native file action resumes after the picker locks Laurel
import { useQuery } from "@tanstack/react-query";
import { commands, documentResult_t } from "./bindings";
import { Com_Unreachable } from "./ui_local";
import { useStore } from "./ui_store";
import { useAction } from "./ui_hooks";
import { KEYS, QUERY } from "./ui_query";
import { T } from "./ui_text";
import { UI_Alert, UI_Sheet, UI_SheetClose } from "./ui_widgets";
import { UI_StartSheet, UI_JoinSheet } from "./ui_folder";
import { UI_SavedFile, UI_SignSheet, UI_SentSheet } from "./ui_offline";

export function UI_Documents() {
	const mobile = useStore( ( s ) => s.constants?.mobile ?? false );
	const unlocked = useStore( ( s ) => s.vault?.state === "unlocked" );
	const result = useQuery( { queryKey: KEYS.document(), queryFn: () => commands.dResultF(), enabled: mobile && unlocked } );
	const clear = useAction( async () => {
		await commands.dClearF();
		await QUERY.invalidateQueries( { queryKey: KEYS.document() } );
	}, !!result.data );
	if ( !mobile || !unlocked || !result.data ) { return null; }
	const close = ( open: boolean ) => { if ( !open ) void clear.run(); };
	return <UI_DocumentSheet result={result.data} onOpenChange={close} />;
}

function UI_DocumentSheet( props: { result: documentResult_t; onOpenChange: ( open: boolean ) => void } ) {
	const r = props.result;
	const close = props.onOpenChange;
	switch ( r.kind ) {
	case "folder":
		return r.join
			? <UI_JoinSheet key={r.folder.path} open onOpenChange={close} initialFolder={r.folder} />
			: <UI_StartSheet key={r.folder.path} open onOpenChange={close} initialFolder={r.folder} />;
	case "review":
		return <UI_SignSheet open onOpenChange={close} review={r.review} />;
	case "sent":
		return <UI_SentSheet open onOpenChange={close} txids={r.txids} />;
	case "saved":
		return <UI_Sheet open onOpenChange={close} title={r.signed ? T.offline.signedTitle : T.offline.savedTitle}>
			<UI_SavedFile path={r.path} signed={r.signed} />
			<UI_SheetClose onClose={() => close( false )} primary />
		</UI_Sheet>;
	case "failed":
		return <UI_Sheet open onOpenChange={close} title={T.security.documentFailed}>
			<UI_Alert title={T.security.documentFailed} message={r.error} />
			<UI_SheetClose onClose={() => close( false )} />
		</UI_Sheet>;
	default:
		return Com_Unreachable( r );
	}
}
