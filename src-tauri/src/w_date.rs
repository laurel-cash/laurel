/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_date.rs -- the clock and the calendar, in one place
//
// Seven places read the clock, three through a helper of their own; the
// calendar lived inside the CSV export. Both are here now (check_owners:
// SystemTime::now is read nowhere else). The calendar is the proleptic
// Gregorian one, in UTC, from Howard Hinnant's day algorithms: no date
// crate, and every step tested.

use std::sync::atomic::{ AtomicU64, Ordering };
use std::time::{ SystemTime, UNIX_EPOCH };

const DAY_SECS: u32 = 86_400;

// ids made this run, so two in the same millisecond still differ
static com_made: AtomicU64 = AtomicU64::new( 0 );

// now, in unix seconds and milliseconds
pub fn Com_Now() -> u64 {
	SystemTime::now().duration_since( UNIX_EPOCH ).map_or( 0, |d| d.as_secs() )
}

pub fn Com_NowMsec() -> u64 {
	SystemTime::now().duration_since( UNIX_EPOCH ).map_or( 0, |d| d.as_millis() as u64 )
}

/*
==================
Com_NewId

A new id for something the person adds (a contact, an alert, a repeating
payment): the clock, so ids sort by age, and a count, so two made in the
same millisecond differ. Alerts and repeats once used the clock alone,
and removing one would have removed its twin.
==================
*/
pub fn Com_NewId( kind: char ) -> String {
	format!( "{kind}{:x}{:x}", Com_NowMsec(), com_made.fetch_add( 1, Ordering::Relaxed ) )
}

/*
==================
Com_Every

A look every secs seconds, for as long as Laurel runs; a failed look is
logged under its name and the next one comes all the same. The one
loop the background watchers share (repeating payments, price alerts).
==================
*/
pub fn Com_Every< F, R >( name: &'static str, secs: u64, look: F )
where
	F: Fn() -> R + Send + 'static,
	R: std::future::Future< Output = crate::w_local::wresult_t< () > > + Send,
{
	tauri::async_runtime::spawn( async move {
		loop {
			if let Err( e ) = look().await {
				log::warn!( "{name}: {}", e.LogText() );
			}
			tokio::time::sleep( std::time::Duration::from_secs( secs ) ).await;
		}
	} );
}

/*
==================
Com_CivilFromDays / Com_DaysFromCivil

Days since 1970-01-01 and ( year, month 1-12, day 1-31 ), both ways
==================
*/
pub fn Com_CivilFromDays( days: i64 ) -> ( i64, u32, u32 ) {
	let z = days + 719_468;
	let era = z.div_euclid( 146_097 );
	let doe = z - era * 146_097;
	let yoe = ( doe - doe / 1_460 + doe / 36_524 - doe / 146_096 ) / 365;
	let doy = doe - ( 365 * yoe + yoe / 4 - yoe / 100 );
	let mp = ( 5 * doy + 2 ) / 153;
	let day = ( doy - ( 153 * mp + 2 ) / 5 + 1 ) as u32;
	let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
	( yoe + era * 400 + i64::from( month <= 2 ), month, day )
}

pub fn Com_DaysFromCivil( year: i64, month: u32, day: u32 ) -> i64 {
	let y = if month <= 2 { year - 1 } else { year };
	let era = y.div_euclid( 400 );
	let yoe = y - era * 400;
	let m = i64::from( month );
	let doy = ( 153 * ( if m > 2 { m - 3 } else { m + 9 } ) + 2 ) / 5 + i64::from( day ) - 1;
	let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
	era * 146_097 + doe - 719_468
}

fn Com_DaysInMonth( year: i64, month: u32 ) -> u32 {
	let next = if month == 12 { Com_DaysFromCivil( year + 1, 1, 1 ) } else { Com_DaysFromCivil( year, month + 1, 1 ) };
	( next - Com_DaysFromCivil( year, month, 1 ) ) as u32
}

/*
==================
Com_AddMonths

The same day of the month, n months on, at the same time of day; a day
the month doesn't have is its last ("the 31st" in April is the 30th).
Always from the anchor's own day, so a 31st doesn't drift to the 28th
after February: the caller keeps the anchor and counts months.
==================
*/
pub fn Com_AddMonths( unix: u32, months: u32, anchorDay: u32 ) -> u32 {
	let ( year, month, _ ) = Com_CivilFromDays( i64::from( unix / DAY_SECS ) );
	let total = i64::from( month - 1 ) + i64::from( months );
	let ( y, m ) = ( year + total.div_euclid( 12 ), ( total.rem_euclid( 12 ) + 1 ) as u32 );
	let d = anchorDay.min( Com_DaysInMonth( y, m ) );
	( Com_DaysFromCivil( y, m, d ) * i64::from( DAY_SECS ) ) as u32 + unix % DAY_SECS
}

pub fn Com_DayOfMonth( unix: u32 ) -> u32 {
	Com_CivilFromDays( i64::from( unix / DAY_SECS ) ).2
}

/*
==================
Com_IsoTime

Unix seconds as ISO 8601 UTC, "2026-09-27T10:00:00Z"
==================
*/
pub fn Com_IsoTime( unix: u32 ) -> String {
	let ( year, month, day ) = Com_CivilFromDays( i64::from( unix / DAY_SECS ) );
	let secs = unix % DAY_SECS;
	format!( "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", secs / 3_600, secs % 3_600 / 60, secs % 60 )
}


#[cfg( test )]
mod tests {
	use super::*;

	#[test]
	fn two_ids_made_at_once_differ() {
		let ( a, b ) = ( Com_NewId( 'a' ), Com_NewId( 'a' ) );
		assert_ne!( a, b );
		assert!( a.starts_with( 'a' ) );
	}

	#[test]
	fn days_and_dates_agree_both_ways() {
		for days in [ -719_468, -1, 0, 11_016, 20_723, 20_724, 20_725, 60_000 ] {
			let ( y, m, d ) = Com_CivilFromDays( days );
			assert_eq!( Com_DaysFromCivil( y, m, d ), days, "{y}-{m}-{d}" );
		}
		assert_eq!( Com_IsoTime( 0 ), "1970-01-01T00:00:00Z" );
		assert_eq!( Com_IsoTime( 951_782_400 ), "2000-02-29T00:00:00Z" );		// a leap day
	}

	/*
	==================
	a_month_on_is_the_same_day_or_the_months_last

	The 31st is the 30th in April and the 28th in February, and comes back
	to the 31st in March: the anchor day is kept, not the last result
	==================
	*/
	#[test]
	fn a_month_on_is_the_same_day_or_the_months_last() {
		let jan31 = ( Com_DaysFromCivil( 2027, 1, 31 ) * 86_400 + 12 * 3_600 ) as u32;		// noon
		let feb = Com_AddMonths( jan31, 1, 31 );
		assert_eq!( Com_IsoTime( feb ), "2027-02-28T12:00:00Z" );
		assert_eq!( Com_IsoTime( Com_AddMonths( jan31, 2, 31 ) ), "2027-03-31T12:00:00Z", "back to the 31st, not the 28th" );
		assert_eq!( Com_IsoTime( Com_AddMonths( jan31, 12, 31 ) ), "2028-01-31T12:00:00Z" );
		assert_eq!( Com_IsoTime( Com_AddMonths( ( Com_DaysFromCivil( 2027, 12, 15 ) * 86_400 ) as u32, 1, 15 ) ), "2028-01-15T00:00:00Z", "into the next year" );
		assert_eq!( Com_IsoTime( Com_AddMonths( ( Com_DaysFromCivil( 2028, 1, 29 ) * 86_400 ) as u32, 1, 29 ) ), "2028-02-29T00:00:00Z", "a leap February has its 29th" );
	}
}
