/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_chart.tsx -- the balance history chart
//
// Drawn as steps, not slopes: a balance doesn't drift between payments,
// it jumps at each one. The points come from the engine (w_history.rs);
// this file only frames and draws them. By pool, the same steps stacked:
// each pool's layer on the ones below it, their top the balance.

import { useEffect, useMemo, useState } from "react";
import { Layers, TrendingUp } from "lucide-react";

import { balancePoint_t, Com_DateTicks, Com_FormatDate, Com_FormatZec, Com_IsBool, Com_Options, Com_ReadPref, Com_SyncState, Com_WritePref, commands, pool_t, POOLS, poolInfo_t, poolZats_t, PREF_CHART_POOLS, priceRange_t, syncProgress_t } from "./ui_local";
import { Com_PoolName, T } from "./ui_text";
import { useQuery } from "@tanstack/react-query";
import { useAppSettings, useSize } from "./ui_hooks";
import { KEYS } from "./ui_query";
import { useStore } from "./ui_store";
import { PRICE_RANGES, UI_PriceView } from "./ui_price";
import type { dollars_t } from "./ui_price";
import { UI_Amount, UI_Empty, UI_LoadFailed, UI_Segmented, UI_Spinner, UI_Tip } from "./ui_widgets";

type range_t = "week" | "month" | "year" | "all";

const DAY_SECS = 86400;
const RANGE_SECS: Record< Exclude< range_t, "all" >, number > = {
	week:	7 * DAY_SECS,
	month:	30 * DAY_SECS,
	year:	365 * DAY_SECS,
};

const MIN_HEIGHT	= 150;		// shorter than this, the chart says nothing
const PAD_TOP		= 14;
const PAD_BOTTOM	= 26;		// room for the dates
const PAD_LEFT		= 52;		// room for the amounts
const PAD_RIGHT		= 8;
const GRID_LINES	= 3;
const HEADROOM		= 1.15;		// the top line sits a little below the top

type step_t = { time: number; zats: number; pools: poolZats_t };

type plot_t = {
	start:		number;			// unix seconds at the left edge
	end:		number;			// now, at the right edge
	steps:		step_t[];		// the first is at start
	max:		number;
};

const NO_POOLS: poolZats_t = { ironwood: 0, orchard: 0, sapling: 0, transparent: 0 };


/*
==================
Com_Plot

The points framed for one range: the balance already held when the range
starts, every change inside it, and the balance now at the right edge
==================
*/
export function Com_Plot( points: balancePoint_t[], range: range_t, now: number ): plot_t {
	const start = range === "all" ? ( points[0]?.time ?? now ) : now - RANGE_SECS[range];

	let before: Omit< step_t, "time" > = { zats: 0, pools: NO_POOLS };
	const inside: step_t[] = [];
	for ( const p of points ) {
		if ( p.time <= start ) {
			before = p;
		} else if ( p.time <= now ) {
			inside.push( { time: p.time, zats: p.zats, pools: p.pools } );
		}
	}

	const steps = [ { time: start, zats: before.zats, pools: before.pools }, ...inside ];
	const max = Math.max( 1, ...steps.map( ( s ) => s.zats ) );
	return { start, end: Math.max( now, start + 1 ), steps, max };
}

/*
==================
Com_StepAt

The balance at a moment: the last step at or before it
==================
*/
function Com_StepAt( plot: plot_t, time: number ): step_t {
	let v = plot.steps[0];
	for ( const s of plot.steps ) {
		if ( s.time > time ) {
			break;
		}
		v = s;
	}
	return v;
}

/*
==================
Com_Layers

The pools to stack, bottom first in the order the dashboard lists them
(Ironwood, where money belongs, at the base), leaving out any pool that
held nothing in the whole range: an empty layer is a line of noise
==================
*/
export function Com_Layers( plot: plot_t ): poolInfo_t[] {
	return POOLS.filter( ( p ) => plot.steps.some( ( s ) => s.pools[p.pool] > 0 ) );
}

/*
==================
Com_StepEdge

A stepped edge through the plot, as points: flat to each moment, then
up or down to its value, and flat again to the right edge
==================
*/
function Com_StepEdge( plot: plot_t, value: ( s: step_t ) => number, X: ( t: number ) => number, Y: ( z: number ) => number ): [ number, number ][] {
	const pts: [ number, number ][] = [ [ X( plot.start ), Y( value( plot.steps[0] ) ) ] ];
	for ( let i = 1; i < plot.steps.length; i++ ) {
		pts.push( [ X( plot.steps[i].time ), Y( value( plot.steps[i - 1] ) ) ], [ X( plot.steps[i].time ), Y( value( plot.steps[i] ) ) ] );
	}
	pts.push( [ X( plot.end ), Y( value( plot.steps[plot.steps.length - 1] ) ) ] );
	return pts;
}

const Com_Path = ( pts: [ number, number ][] ) => pts.map( ( [ x, y ], i ) => `${i ? "L" : "M"} ${x} ${y}` ).join( " " );

/*
==================
UI_Layers

Each pool's band, from the pools below it to itself on top of them, and
its top edge drawn in its colour
==================
*/
function UI_Layers( props: { plot: plot_t; layers: poolInfo_t[]; X: ( t: number ) => number; Y: ( z: number ) => number } ) {
	const below = ( s: step_t, i: number ) => props.layers.slice( 0, i ).reduce( ( n, l ) => n + s.pools[l.pool], 0 );
	return (
		<g className="chart-layers">
			{props.layers.map( ( l, i ) => {
				const top = Com_StepEdge( props.plot, ( s ) => below( s, i ) + s.pools[l.pool], props.X, props.Y );
				const base = Com_StepEdge( props.plot, ( s ) => below( s, i ), props.X, props.Y ).reverse();
				return (
					<g key={l.pool} className={"pool-" + l.pool}>
						<path className="chart-layer" d={`${Com_Path( [ ...top, ...base ] )} Z`} />
						<path className="chart-layer-edge" d={Com_Path( top )} />
					</g>
				);
			} )}
		</g>
	);
}

// a pool's dot, name and amount: in the legend and in the pointer's bubble
function UI_PoolAmount( props: { pool: pool_t; name: string; zats: number } ) {
	return (
		<span className={"chart-pool pool-" + props.pool}>
			<span className="chart-pool-dot" aria-hidden="true" />
			<span className="chart-pool-name">{props.name}</span>
			<UI_Amount zats={props.zats} unit />
		</span>
	);
}


/*
==================
Com_Ticks

Where the grid lines go: round amounts (1, 2, 2.5 or 5 times a power of
ten) under the top, at most count of them. A third of the top each once
labelled the axis 4.283, 8.566, 12.85. Never finer than one zatoshi.
==================
*/
export function Com_Ticks( max: number, count: number ): number[] {
	const mag = 10 ** Math.floor( Math.log10( max / count ) );
	const step = Math.max( 1, [ 1, 2, 2.5, 5, 10 ].map( ( m ) => m * mag ).find( ( s ) => s * count >= max ) ?? 10 * mag );
	return Array.from( { length: Math.floor( max / step ) }, ( _, i ) => ( i + 1 ) * step );
}

/*
==================
Com_AxisZec

Amounts on the axis: short, never more digits than they need
==================
*/
function Com_AxisZec( zats: number ): string {
	const s = Com_FormatZec( zats );
	const [ whole, frac = "" ] = s.split( "." );
	return whole.length >= 3 ? whole : `${whole}.${frac.slice( 0, 4 - whole.length ).padEnd( 2, "0" )}`;
}

/*
==================
UI_Plot
==================
*/
function UI_Plot( props: { plot: plot_t; width: number; height: number; hidden: boolean; split: boolean } ) {
	const { plot, width } = props;
	const [ hover, setHover ] = useState< number | null >( null );		// unix seconds under the pointer

	// by pool, the legend takes its own height over the plot: one line or two, as it wraps
	const legend = useSize< HTMLDivElement >();
	const height = Math.max( MIN_HEIGHT, props.height - legend.height );

	const w = Math.max( 0, width - PAD_LEFT - PAD_RIGHT );
	const h = height - PAD_TOP - PAD_BOTTOM;
	const top = plot.max * HEADROOM;
	const X = ( t: number ) => PAD_LEFT + ( t - plot.start ) / ( plot.end - plot.start ) * w;
	const Y = ( z: number ) => PAD_TOP + h - z / top * h;

	// each step runs flat to the next moment, then jumps
	let line = `M ${X( plot.start )} ${Y( plot.steps[0].zats )}`;
	for ( let i = 1; i < plot.steps.length; i++ ) {
		line += ` H ${X( plot.steps[i].time )} V ${Y( plot.steps[i].zats )}`;
	}
	line += ` H ${X( plot.end )}`;
	const area = `${line} V ${Y( 0 )} H ${X( plot.start )} Z`;

	const withYear = plot.end - plot.start > 200 * DAY_SECS;
	const dates = Com_DateTicks( plot.start, plot.end, w, withYear );
	const grid = Com_Ticks( plot.max, GRID_LINES );

	function Move( e: React.PointerEvent< SVGSVGElement > ) {
		const box = e.currentTarget.getBoundingClientRect();
		const x = Math.min( Math.max( e.clientX - box.left, PAD_LEFT ), PAD_LEFT + w );
		setHover( plot.start + ( x - PAD_LEFT ) / w * ( plot.end - plot.start ) );
	}

	const at = hover === null ? null : Com_StepAt( plot, hover );
	const hv = at?.zats ?? null;
	const layers = useMemo( () => props.split ? Com_Layers( plot ) : [], [ plot, props.split ] );
	const last = plot.steps[plot.steps.length - 1];

	return (
		<div className={"chart-plot" + ( props.hidden ? " hidden" : "" )}>
			{/* always there, so it's measured from the start; empty (not by pool), it takes no room */}
			<div className="chart-legend" ref={legend.ref} aria-label={layers.length ? T.chart.legend : undefined}>
				{layers.map( ( l ) => <UI_PoolAmount key={l.pool} pool={l.pool} name={Com_PoolName( l.pool )} zats={last.pools[l.pool]} /> )}
			</div>
			<svg
				width={width}
				height={height}
				role="img"
				aria-label={T.chart.title}
				onPointerMove={props.hidden ? undefined : Move}
				onPointerLeave={() => setHover( null )}
			>
				<defs>
					<linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0" className="chart-fill-top" />
						<stop offset="1" className="chart-fill-bottom" />
					</linearGradient>
				</defs>

				{grid.map( ( z ) => (
					<g key={z}>
						<line className="chart-grid" x1={PAD_LEFT} x2={PAD_LEFT + w} y1={Y( z )} y2={Y( z )} />
						{!props.hidden && <text className="chart-axis" x={PAD_LEFT - 8} y={Y( z ) + 4} textAnchor="end">{Com_AxisZec( z )}</text>}
					</g>
				) )}
				<line className="chart-base" x1={PAD_LEFT} x2={PAD_LEFT + w} y1={Y( 0 )} y2={Y( 0 )} />
				{dates.map( ( t, i ) => (
					<text key={i} className="chart-axis" x={X( t )} y={height - 6} textAnchor={i === 0 ? "start" : i === dates.length - 1 ? "end" : "middle"}>
						{Com_FormatDate( t, withYear ? "month" : "monthDay" )}
					</text>
				) )}

				{layers.length ? <UI_Layers plot={plot} layers={layers} X={X} Y={Y} /> : (
					<>
						<path className="chart-area" d={area} fill="url(#chart-fill)" />
						<path className="chart-line" d={line} />
					</>
				)}
				<circle className="chart-now" cx={X( plot.end )} cy={Y( last.zats )} r={4} />

				{hover !== null && hv !== null && (
					<g>
						<line className="chart-cursor" x1={X( hover )} x2={X( hover )} y1={PAD_TOP} y2={Y( 0 )} />
						<circle className="chart-dot" cx={X( hover )} cy={Y( hv )} r={4.5} />
					</g>
				)}
			</svg>

			{hover !== null && at !== null && hv !== null && (
				<div className="chart-bubble" style={{ left: Math.min( Math.max( X( hover ), 80 ), width - 80 ) }}>
					<span className="chart-bubble-amount"><UI_Amount zats={hv} unit /></span>
					{layers.filter( ( l ) => at.pools[l.pool] > 0 ).map( ( l ) => <UI_PoolAmount key={l.pool} pool={l.pool} name={Com_PoolName( l.pool )} zats={at.pools[l.pool]} /> )}
					<span className="chart-bubble-date">{Com_FormatDate( hover, "shortDay" )}</span>
				</div>
			)}

			{props.hidden && <div className="chart-veil">{T.chart.hidden}</div>}
		</div>
	);
}

/*
==================
UI_BalanceChart

Reloads whenever the balance or the sync state changes, so it never
shows a history that disagrees with the balance above it
==================
*/
export function UI_BalanceChart( props: { walletId: string; account: number; total: number; progress: syncProgress_t | undefined } ) {
	const hidden = useStore( ( s ) => s.hideAmounts );
	const state = Com_SyncState( props.progress );
	const settingsOn = useAppSettings().settings?.showPrice === true;
	const { ref, width, height } = useSize< HTMLDivElement >();

	const [ range, setRange ]			= useState< range_t >( "month" );
	const [ mode, setMode ]				= useState< "balance" | "value" | "price" >( "balance" );
	const [ priceRange, setPriceRange ]	= useState< priceRange_t >( "1d" );
	const [ split, setSplit ]			= useState( () => Com_ReadPref( PREF_CHART_POOLS, false, Com_IsBool ) );		// remembered on this device

	function ToggleSplit() {
		Com_WritePref( PREF_CHART_POOLS, !split );
		setSplit( !split );
	}

	const load = useQuery( {
		queryKey:	KEYS.balanceHistory( props.walletId, props.account ),
		queryFn:	() => commands.wBalanceHistoryF( props.walletId, props.account ),
	} );
	const points = load.data ?? null;

	// a new balance or sync state: read again, for this same key
	useEffect( () => {
		void load.refetch();
	}, [ props.total, state ] );

	const now = Math.floor( Date.now() / 1000 );
	const plot = useMemo( () => points && points.length ? Com_Plot( points, range, now ) : null, [ points, range, Math.floor( now / 60 ) ] );

	let body;
	if ( load.error ) {
		body = <UI_LoadFailed title={T.history.cantLoad} error={load.error} onRetry={() => void load.refetch()} />;
	} else if ( !points ) {
		body = <UI_Empty><UI_Spinner size={18} /></UI_Empty>;
	} else if ( !plot ) {
		body = <UI_Empty icon={<TrendingUp aria-hidden="true" />} title={T.chart.emptyTitle} text={T.chart.empty} />;
	} else {
		body = width > 0 && <UI_Plot plot={plot} width={width} height={Math.max( MIN_HEIGHT, height )} hidden={hidden} split={split} />;
	}

	if ( mode === "price" || mode === "value" ) {
		const of: dollars_t = mode === "price" ? { kind: "price" } : { kind: "value", walletId: props.walletId, account: props.account };
		body = width > 0 && <UI_PriceView of={of} range={priceRange} width={width} height={Math.max( MIN_HEIGHT, height )} />;
	}

	return (
		<section className="panel chart">
			<div className="chart-head">
				<div>
					<UI_Segmented small id="chart-mode" value={mode} onChange={setMode} options={Com_Options( [ "balance", "value", "price" ] as const, T.chart.modes )} />
					{mode === "balance" && state !== "synced" && <p className="chart-note">{T.history.syncing}</p>}
				</div>
				{mode === "balance" && plot && (
					<div className="chart-controls">
						<UI_Tip label={T.chart.byPoolTip}>
							<button className={"chart-split" + ( split ? " on" : "" )} aria-pressed={split} onClick={ToggleSplit}><Layers aria-hidden="true" />{T.chart.byPool}</button>
						</UI_Tip>
						<UI_Segmented small id="chart-range" value={range} onChange={setRange} options={Com_Options( [ "week", "month", "year", "all" ] as const, T.chart.ranges )} />
					</div>
				)}
				{mode !== "balance" && settingsOn && <UI_Segmented small id="price-range" value={priceRange} onChange={setPriceRange} options={PRICE_RANGES} />}
			</div>
			<div className="chart-body" ref={ref}>{body}</div>
		</section>
	);
}
