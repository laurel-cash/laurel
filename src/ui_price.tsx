/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_price.tsx -- the ZEC price in dollars, in the dashboard's chart, once
// the person said yes (w_price.rs asks CoinGecko, which sees this
// computer's IP address and nothing about its wallets)
//
// The headline follows the pointer: the price at that moment, when it was,
// and the change since the range began; the live price when it leaves.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell, CloudOff, EyeOff, FlaskConical, LineChart, TrendingDown, TrendingUp } from "lucide-react";

import { accountValue_t, commands, Com_Ago, Com_DateTicks, Com_FormatDate, Com_FormatUsd, pricePoint_t, priceRange_t, ZATS_PER_ZEC } from "./ui_local";
import { T } from "./ui_text";
import { KEYS } from "./ui_query";
import { useAppSettings } from "./ui_hooks";
import { useStore } from "./ui_store";
import { UI_Alert, UI_Empty, UI_LoadFailed, UI_SettingSwitch, UI_Spinner } from "./ui_widgets";
import { UI_PriceAlertSheet } from "./ui_alert";

// a point with its price: Rust's f64 may arrive as null (JSON has no NaN)
type point_t = { time: number; usd: number };

function Com_Priced( points: pricePoint_t[] ): point_t[] {
	return points.filter( ( p ): p is point_t => p.usd != null && Number.isFinite( p.usd ) );
}

export const PRICE_RANGES: { value: priceRange_t; label: string }[] = [
	{ value: "1h",	label: "1H" },
	{ value: "1d",	label: "1D" },
	{ value: "1w",	label: "1W" },
	{ value: "1m",	label: "1M" },
	{ value: "1y",	label: "1Y" },
	{ value: "all",	label: "ALL" },
];

// the short ranges move by the minute; Rust's cache keeps this from asking the source more
const LIVE_MSEC		= 60_000;
const SLOW_MSEC		= 10 * 60_000;

const EDGE_TOP		= 10;
const EDGE_BOTTOM	= 22;		// room for the times
const EDGE_RIGHT	= 50;		// room for the prices, on the right as markets show them
const HOUR_SECS		= 3600;


/*
==================
Com_Nearest

The point closest in time to t: the one the pointer is on
==================
*/
export function Com_Nearest( points: point_t[], t: number ): point_t {
	let lo = 0;
	let hi = points.length - 1;
	while ( lo < hi ) {
		const mid = ( lo + hi ) >> 1;
		if ( points[mid].time < t ) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	const after = points[lo];
	const before = points[Math.max( 0, lo - 1 )];
	return Math.abs( before.time - t ) <= Math.abs( after.time - t ) ? before : after;
}

/*
==================
Com_Change

From the range's first price to this one, as a signed percentage
==================
*/
export function Com_Change( first: number, now: number ): number {
	return first > 0 ? ( now - first ) / first * 100 : 0;
}

/*
==================
UI_PricePlot
==================
*/
function UI_PricePlot( props: { points: point_t[]; range: priceRange_t; width: number; height: number; onHover: ( p: point_t | null ) => void; up: boolean; label: string } ) {
	const { points, width, height } = props;
	const [ hover, setHover ] = useState< point_t | null >( null );

	const first = points[0].time;
	const last = points[points.length - 1].time;
	const low = Math.min( ...points.map( ( p ) => p.usd ) );
	const high = Math.max( ...points.map( ( p ) => p.usd ) );
	const pad = ( high - low ) * 0.08 || high * 0.01;
	const w = Math.max( 0, width - EDGE_RIGHT );
	const h = height - EDGE_TOP - EDGE_BOTTOM;
	const X = ( t: number ) => ( t - first ) / Math.max( 1, last - first ) * w;
	const Y = ( usd: number ) => EDGE_TOP + ( high + pad - usd ) / ( high - low + 2 * pad ) * h;

	const line = points.map( ( p, i ) => `${i ? "L" : "M"} ${X( p.time ).toFixed( 1 )} ${Y( p.usd ).toFixed( 1 )}` ).join( " " );
	const area = `${line} L ${X( last )} ${EDGE_TOP + h} L 0 ${EDGE_TOP + h} Z`;
	const short = last - first <= 2 * 24 * HOUR_SECS;
	const ticks = Com_DateTicks( first, last, w, props.range === "all" || props.range === "1y" );
	const levels = [ high, ( high + low ) / 2, low ];

	function Move( e: React.PointerEvent< SVGSVGElement > ) {
		const box = e.currentTarget.getBoundingClientRect();
		const x = Math.min( Math.max( e.clientX - box.left, 0 ), w );
		const p = Com_Nearest( points, first + x / Math.max( 1, w ) * ( last - first ) );
		setHover( p );
		props.onHover( p );
	}

	function Leave() {
		setHover( null );
		props.onHover( null );
	}

	return (
		<svg className={"price-plot" + ( props.up ? " up" : " down" )} width={width} height={height} role="img" aria-label={props.label} onPointerMove={Move} onPointerLeave={Leave}>
			<defs>
				<linearGradient id="price-fill" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" className="price-fill-top" />
					<stop offset="1" className="price-fill-bottom" />
				</linearGradient>
			</defs>
			{levels.map( ( v ) => (
				<g key={v}>
					<line className="chart-grid" x1={0} x2={w} y1={Y( v )} y2={Y( v )} />
					<text className="chart-axis" x={w + 6} y={Y( v ) + 4}>{Com_FormatUsd( v )}</text>
				</g>
			) )}
			{ticks.map( ( t, i ) => (
				<text key={i} className="chart-axis" x={X( t )} y={height - 6} textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}>
					{Com_FormatDate( t, short ? "time" : props.range === "all" || props.range === "1y" ? "month" : "monthDay" )}
				</text>
			) )}
			<path className="price-area" d={area} fill="url(#price-fill)" />
			<path className="price-line" d={line} />
			{hover && (
				<g>
					<line className="chart-cursor" x1={X( hover.time )} x2={X( hover.time )} y1={EDGE_TOP} y2={EDGE_TOP + h} />
					<circle className="chart-dot" cx={X( hover.time )} cy={Y( hover.usd )} r={4.5} />
				</g>
			)}
		</svg>
	);
}

// what the dollars are of: the ZEC price, or what an account was worth (W_ValueHistory)
export type dollars_t = { kind: "price" } | { kind: "value"; walletId: string; account: number };

/*
==================
UI_PriceView

The chart panel's Price and Value sides: a yes first, then the dollars.
A value is the balance in another unit: hidden with the amounts.
==================
*/
export function UI_PriceView( props: { of: dollars_t; range: priceRange_t; width: number; height: number } ) {
	const network = useStore( ( s ) => s.network );
	const hidden = useStore( ( s ) => s.hideAmounts );
	const { settings, save } = useAppSettings();
	const on = settings?.showPrice === true;
	const [ hover, setHover ] = useState< point_t | null >( null );
	const [ alerting, setAlerting ] = useState( false );
	const of = props.of;

	// the price is asked for only with prices on; a value is always asked, since the
	// engine says "no price" for test coins without asking anyone (W_ValueHistory)
	const series = useQuery( {
		queryKey:			of.kind === "price" ? KEYS.price( props.range ) : KEYS.value( of.walletId, of.account, props.range, on ),
		queryFn:			async (): Promise< accountValue_t > => of.kind === "price"
			? { kind: "series", series: await commands.pSeriesF( props.range ) }
			: commands.wValueHistoryF( of.walletId, of.account, props.range ),
		enabled:			!!settings && ( on || of.kind === "value" ),
		refetchInterval:	Com_RefetchFor( props.range ),
	} );
	const answer = series.data;
	const points = useMemo( () => answer?.kind === "series" ? Com_Priced( answer.series.points ) : null, [ answer ] );

	const shown = useMemo( () => {
		if ( !points || points.length < 2 ) {
			return null;
		}
		const at = hover ?? points[points.length - 1];
		return { at: at, change: Com_Change( points[0].usd, at.usd ), live: hover === null };
	}, [ points, hover ] );

	if ( !settings ) {
		return <UI_Empty><UI_Spinner size={18} /></UI_Empty>;
	}
	if ( answer?.kind === "noPrice" ) {
		return <UI_Empty icon={<FlaskConical aria-hidden="true" />} tone="quiet" title={T.price.noPriceTitle} text={T.price.noPrice} />;
	}
	if ( !on ) {
		return (
			<UI_Empty icon={<LineChart aria-hidden="true" />} title={T.price.askTitle} text={T.price.ask}>
				{save.error && <UI_Alert title={T.common.cantSaveSetting} message={save.error} />}
				<button className="btn primary" disabled={save.busy} onClick={() => { save.run( { showPrice: true } ); }}>{T.price.show}</button>
			</UI_Empty>
		);
	}
	if ( series.error ) {
		return <UI_LoadFailed icon={<CloudOff aria-hidden="true" />} title={of.kind === "price" ? T.price.failed : T.price.valueFailed} error={series.error} onRetry={() => void series.refetch()} />;
	}
	if ( of.kind === "value" && hidden ) {
		return <UI_Empty icon={<EyeOff aria-hidden="true" />} tone="quiet" text={T.chart.hidden} />;
	}
	if ( !points || !shown || answer?.kind !== "series" ) {
		return <UI_Empty><UI_Spinner size={18} /></UI_Empty>;
	}

	const up = shown.change >= 0;
	return (
		<div className="price-view">
			<div className="price-head">
				<span className="price-now">{Com_FormatUsd( shown.at.usd )}</span>
				<span className={"price-change" + ( up ? " up" : " down" )}>
					{up ? <TrendingUp aria-hidden="true" /> : <TrendingDown aria-hidden="true" />}
					{`${up ? "+" : ""}${shown.change.toFixed( 2 )}%`}
				</span>
				<span className="price-when">{shown.live ? T.price.now( network === "testnet" ) : Com_FormatDate( shown.at.time, props.range === "1h" || props.range === "1d" ? "time" : "shortDay" )}</span>
				{of.kind === "price" && <button className="link small" onClick={() => setAlerting( true )}><Bell aria-hidden="true" />{T.alerts.open}</button>}
			</div>
			{of.kind === "price" && <UI_PriceAlertSheet open={alerting} onOpenChange={setAlerting} price={points[points.length - 1].usd} />}
			<UI_PricePlot points={points} range={props.range} width={props.width} height={Math.max( 90, props.height - 44 )} onHover={setHover} up={up} label={of.kind === "price" ? T.price.title : T.price.valueTitle} />
			{of.kind === "value" && <p className="price-source">{T.price.valueNote}</p>}
			<p className="price-source">{T.price.source( Com_Ago( answer.series.fetchedAt ) )}</p>
		</div>
	);
}

/*
==================
usePricePoints / UI_UsdSaid

One range's prices, asked once for every reader (the chart's key, in its
shape), and only with prices on, on mainnet: test coins have none. Null
until answered. UI_UsdSaid says an amount in dollars in its sentence,
and nothing when there's no price or amounts are hidden.
==================
*/
function Com_RefetchFor( range: priceRange_t ): number {
	return range === "1h" || range === "1d" ? LIVE_MSEC : SLOW_MSEC;
}

function usePricePoints( range: priceRange_t ): pricePoint_t[] | null {
	const { settings } = useAppSettings();
	const network = useStore( ( s ) => s.network );
	const on = settings?.showPrice === true && network === "mainnet";
	const series = useQuery( {
		queryKey:			KEYS.price( range ),
		queryFn:			async (): Promise< accountValue_t > => ( { kind: "series", series: await commands.pSeriesF( range ) } ),
		enabled:			on,
		refetchInterval:	Com_RefetchFor( range ),
	} );
	// off is off at once: a query turned off keeps its last answer, which would go on saying dollars
	return on && series.data?.kind === "series" ? series.data.series.points : null;
}

function UI_UsdSaid( props: { zats: number; usd: number | null; say: ( usd: string ) => string; className: string; title?: string } ) {
	const hidden = useStore( ( s ) => s.hideAmounts );
	if ( props.usd === null || hidden ) {
		return null;
	}
	return <span className={props.className} title={props.title}>{props.say( Com_FormatUsd( props.zats / ZATS_PER_ZEC * props.usd ) )}</span>;
}

/*
==================
useZecUsd / UI_Usd

The newest dollar price of one ZEC, from the day's series (the one the
dashboard's chart shows), or null; and an amount at it, beside its ZEC
("≈ $36.80"). A price over an hour old is none: a failed refresh keeps
the last answer, and an old price said as today's is a wrong balance
==================
*/
export function Com_NowPrice( points: pricePoint_t[], now: number ): number | null {
	const priced = Com_Priced( points );
	const last = priced[priced.length - 1];
	return last && now - last.time <= HOUR_SECS ? last.usd : null;
}

export function useZecUsd(): number | null {
	return Com_NowPrice( usePricePoints( "1d" ) ?? [], Math.floor( Date.now() / 1000 ) );
}

export function UI_Usd( props: { zats: number; className?: string } ) {
	const usd = useZecUsd();
	return <UI_UsdSaid zats={props.zats} usd={usd} say={T.price.about} className={props.className ?? "usd"} title={usd === null ? undefined : T.price.per( Com_FormatUsd( usd ) )} />;
}

/*
==================
Com_RangeFor / Com_UsdAt / UI_UsdThen

What an amount was worth when it moved: the price nearest its time, from
the shortest range that still reaches back to it. A price more than
THEN_SECS from the time isn't that day's, and says nothing. The
constants live in the functions: a build without prices keeps nothing
of this file (D-031), and a module constant computed from another stays
in the bundle.
==================
*/
export function Com_RangeFor( age: number ): priceRange_t {
	const DAY_SECS = 86400;
	return age < DAY_SECS ? "1d" : age < 7 * DAY_SECS ? "1w" : age < 30 * DAY_SECS ? "1m" : age < 365 * DAY_SECS ? "1y" : "all";
}

export function Com_UsdAt( points: pricePoint_t[], time: number ): number | null {
	const THEN_SECS = 3 * 86400;
	let best: point_t | null = null;
	for ( const p of Com_Priced( points ) ) {
		if ( !best || Math.abs( p.time - time ) < Math.abs( best.time - time ) ) {
			best = p;
		}
	}
	return best && Math.abs( best.time - time ) <= THEN_SECS ? best.usd : null;
}

export function UI_UsdThen( props: { zats: number; time: number } ) {
	const points = usePricePoints( Com_RangeFor( Math.floor( Date.now() / 1000 ) - props.time ) );
	return <UI_UsdSaid zats={props.zats} usd={points ? Com_UsdAt( points, props.time ) : null} say={T.price.then} className="usd usd-then" />;
}

/*
==================
UI_PriceSetting

For Settings > General: the yes, taken back or given
==================
*/
export function UI_PriceSetting() {
	return <UI_SettingSwitch field="showPrice" icon={<LineChart aria-hidden="true" />} title={T.price.settingTitle} label={T.price.settingLabel} hint={T.price.settingHint} />;
}
