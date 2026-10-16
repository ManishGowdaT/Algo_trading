# Phase 0 market-data feasibility

## Findings

Current application output cannot establish session VWAP feasibility. Python removes volume from historical rows; Node removes it again; live ticks expose no volume. Missing volume here does not prove the broker returned zero volume. Sample the broker's original response before normalization to distinguish missing/zero volume from application data loss.

The official SmartAPI documentation reviewed during planning describes historical rows as timestamp, open, high, low, close, volume and shows a NIFTY example with volume zero: https://smartapi.angelone.in/docs. This is a documentation example, not actual three-index account evidence. Index/futures proxy selection remains a strategy decision.

## Required read-only sample capture

Current policy: calculate session VWAP internally from selected-index 1M OHLCV. Do not capture/use futures as the normal design. Only actual index-volume failure evidence permits considering a separately validated proxy design. A disconnected broker or volume stripped by application code does not qualify.

Normal VWAP compares the selected index close with its own internally calculated session VWAP. Futures selection and basis comparison are outside the normal design and only become relevant after a proven index-volume failure.

Using the existing authenticated account connection, obtain a completed ordinary session for each of NIFTY (NSE/99926000), BANKNIFTY (NSE/99926009), SENSEX (BSE/99919000). Verify token metadata against the broker instrument catalogue at collection time. No broker login bypass, environment-credential extraction, orders or account-setting mutation is needed.

Save sanitized raw historical candle arrays for 1M and 5M from 09:15 through at least 11:30 IST, plus corresponding CE/PE metadata and timestamped historical premium candles if available. Remove request headers, API keys, session tokens and account identifiers. Record session date, source, instrument identity, timeframe, retrieval time, timestamp convention, volume units, missing/zero-volume counts and hashes. Do not label synthetic fixture data as broker evidence.

If normalized application endpoints omit volume, their results cannot pass the raw-volume gate. A future read-only diagnostic path should be scoped to verified account context and strip credentials; it is not implemented in Phase 0.

## Validation checklist per index

1. Timestamps parse with explicit IST/UTC semantics, are monotonic and unique, and have correct duration/alignment.
2. OR contains all three real completed 5M candles (09:15, 09:20, 09:25 starts), equivalent to 15 complete 1M bars.
3. OHLC are finite, positive and internally consistent. Synthetic gaps and incomplete bars are explicitly rejected.
4. Volume is present, finite, nonnegative and has known per-bar or cumulative semantics. Zero total session volume fails VWAP. Genuine isolated zero-trade bars require a defined policy rather than automatic invention or rejection.
5. Sum-volume and OHLC aggregation from 1M matches 5M within documented precision. Do not count both streams in VWAP.
6. All bars from session open remain available beyond 200 minutes. Daily VWAP resets at the IST session boundary without incorporating yesterday's warm-up.
7. Historical/live overlap deduplicates and handles cumulative-volume resets/reconnects without double counting. REST LTP fallback cannot create real volume.
8. Distinguish real spot OHLC from proxy VWAP instrument values. No proxy in normal operation. Conditional fallback requires actual index-volume failure evidence and a separately documented validated design.
9. Matching option contract data retains expiry, exchange, option type, strike, lot metadata and timestamps. Option premiums are never the underlying risk reference.

## Capture status

| Index | Raw sample | Volume validity | Matching option evidence | Eligible |
|---|---|---|---|---|
| NIFTY | Not captured | Unknown | Not captured | No |
| BANKNIFTY | Not captured | Unknown | Not captured | No |
| SENSEX | Not captured | Unknown | Not captured | No |

Reason: no authenticated original-response market-data sample is available in this phase. The prior screenshot shows an offline empty chart; no market data was fabricated to fill this gap.

## Validation attempt and tool

Dashboard observation on 16 October 2026: Connect Angel One broker; all index feeds Offline. No actual index sample retrieved. Volume validity remains unknown, not failed. Run `python INDEX_VWAP_ORB_PHASE_0/validate_index_ohlcv.py sample.json --output report.json` on each sanitized raw index sample after reconnect. Source/hash metadata is not by itself authenticity proof; retain capture provenance. Unit fixtures are synthetic and must not be entered in the real capture table.
